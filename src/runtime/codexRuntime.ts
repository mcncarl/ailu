import { EventEmitter } from 'events';
import { clearTimeout as cancelTimeout, setTimeout as scheduleTimeout } from 'timers';

import type {
  ChatTurnRequest,
  CodexModelDescriptor,
  CodexRuntimeStatus,
  RuntimeBinarySource,
  RuntimeTurnEvent,
  ToolCallEvent,
} from '../types';
import { PLUGIN_NAME, PROTOCOL_IDS } from '../ids';
import { CodexAppServerClient, CodexJsonRpcError } from './codexAppServer';
import { MAX_PERSISTABLE_ASSISTANT_OUTPUT_BYTES } from './outputLimits';
import { assertManagedFrozenAttachments } from './frozenAttachments';

export interface CodexRuntimeConnection {
  binaryPath: string;
  binarySource: RuntimeBinarySource | null;
  version: string | null;
  env: NodeJS.ProcessEnv;
  clientVersion?: string;
  /** Final synchronous queue-snapshot check, evaluated before connection and RPC side effects. */
  executionIsCurrent?: () => boolean;
}

interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  fullAccess: boolean;
  exposeSession: boolean;
  listener: (event: RuntimeTurnEvent) => void;
  resolve: () => void;
  settled: Promise<void>;
  emittedDeltas: Map<string, string>;
  emittedItems: Set<string>;
  bufferedNotifications: Array<{ method: string; params: unknown }>;
  interrupted: boolean;
  finished: boolean;
  errorEmitted: boolean;
  pendingSnapshotError: Extract<RuntimeTurnEvent, { type: 'error' }> | null;
  cleanupAbort: () => void;
  interruptPromise: Promise<void> | null;
  interruptCompletionTimer: ReturnType<typeof scheduleTimeout> | null;
  notificationBytes: number;
  outputLimitExceeded: boolean;
}

type RuntimeLifecycle = 'running' | 'shuttingDown' | 'closed';

interface RunRegistration {
  epoch: number;
  controller: AbortController;
  detachCallerAbort: () => void;
  settled: Promise<void>;
  resolve: () => void;
}

interface CanonicalSessionAdmissionRequest {
  admitCanonicalSession?: (sessionId: string) => Promise<void>;
}

const EMPTY_STATUS: CodexRuntimeStatus = {
  state: 'idle',
  binaryPath: null,
  binarySource: null,
  version: null,
  connected: false,
  authenticated: null,
  authMode: null,
  currentModelId: null,
  currentModel: null,
  models: [],
  contextWindowTokens: null,
  autoCompactTokenLimit: null,
  imageGeneration: null,
  webSearch: null,
  error: null,
};

export const CODEX_REASONING_EFFORT_ORDER = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

/**
 * An interrupt RPC acknowledgement only means the request was accepted. Keep
 * the thread reserved until `turn/completed`; disconnect the shared App Server
 * if terminal confirmation never arrives within this bound.
 */
export const CODEX_INTERRUPT_COMPLETION_TIMEOUT_MS = 10_000;
export const CODEX_MAX_RUNTIME_EVENT_BYTES = 512 * 1_024;
export const CODEX_MAX_TURN_OUTPUT_BYTES = MAX_PERSISTABLE_ASSISTANT_OUTPUT_BYTES;

export function orderedSupportedCodexReasoningEfforts(model: CodexModelDescriptor | null): string[] {
  if (!model) return [];
  const advertised = new Set(model.supportedReasoningEfforts.map(option => option.reasoningEffort));
  return CODEX_REASONING_EFFORT_ORDER.filter(effort => advertised.has(effort));
}

/** Keeps an explicit effort when the model supports it, otherwise uses that model's advertised default. */
export function reconcileCodexReasoningEffort(
  model: CodexModelDescriptor | null,
  selectedEffort: string,
): string {
  const selected = selectedEffort.trim();
  if (!selected || !model || model.supportedReasoningEfforts.length === 0) return selected;
  const supported = new Set(model.supportedReasoningEfforts.map(option => option.reasoningEffort));
  if (supported.has(selected)) return selected;
  const fallback = model.defaultReasoningEffort?.trim() ?? '';
  return fallback && supported.has(fallback) ? fallback : '';
}

export class CodexAppServerRuntime extends EventEmitter {
  private status: CodexRuntimeStatus = { ...EMPTY_STATUS };
  private connection: CodexRuntimeConnection | null = null;
  private connecting: Promise<void> | null = null;
  private disconnecting: Promise<void> | null = null;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  /** Threads that received a full-access turn on the current App Server connection. */
  private readonly fullAccessThreadIds = new Set<string>();
  private readonly inflightRuns = new Set<RunRegistration>();
  private readonly statusOperations = new Set<Promise<CodexRuntimeStatus>>();
  private lifecycle: RuntimeLifecycle = 'running';
  private lifecycleEpoch = 0;
  private connectionGeneration = 0;
  private cancelAllBarrier: Promise<void> | null = null;
  private shutdownBarrier: Promise<void> | null = null;
  private safetyDisconnectRequired = false;
  private safetyDisconnectBarrier: Promise<void> | null = null;
  private safetyDisconnectDefaultError: Extract<RuntimeTurnEvent, { type: 'error' }> | null = null;
  private readonly safetyDisconnectErrors = new Map<
    string,
    Extract<RuntimeTurnEvent, { type: 'error' }>
  >();
  private readonly safetyDisconnectFailureNotified = new Set<string>();

  constructor(
    private readonly client = new CodexAppServerClient(),
    private readonly interruptCompletionTimeoutMs = CODEX_INTERRUPT_COMPLETION_TIMEOUT_MS,
  ) {
    super();
    client.on('notification', (method: string, params: unknown) => this.handleNotification(method, params));
    client.on('serverRequest', (id: number | string, method: string, params: unknown) => {
      this.handleServerRequest(id, method, params);
    });
    client.on('close', (reason: string) => this.handleClose(reason));
  }

  getStatus(): CodexRuntimeStatus {
    return {
      ...this.status,
      models: this.status.models.map(model => ({
        ...model,
        supportedReasoningEfforts: model.supportedReasoningEfforts.map(option => ({ ...option })),
        inputModalities: [...model.inputModalities],
      })),
      currentModel: this.status.currentModel
        ? {
          ...this.status.currentModel,
          supportedReasoningEfforts: this.status.currentModel.supportedReasoningEfforts.map(option => ({ ...option })),
          inputModalities: [...this.status.currentModel.inputModalities],
        }
        : null,
    };
  }

  onStatusChange(listener: (status: CodexRuntimeStatus) => void): () => void {
    this.on('status', listener);
    return () => this.off('status', listener);
  }

  async refreshStatus(connection: CodexRuntimeConnection): Promise<CodexRuntimeStatus> {
    if (this.lifecycle !== 'running') return this.closedStatus();
    if (this.safetyDisconnectRequired) return this.safetyStopStatus();
    const blocked = this.connectionChangeBlocked(connection.binaryPath);
    if (blocked) return { ...this.getStatus(), error: blocked };

    const epoch = this.lifecycleEpoch;
    const operation = this.refreshStatusInternal(connection, epoch);
    this.statusOperations.add(operation);
    try {
      return await operation;
    } finally {
      this.statusOperations.delete(operation);
    }
  }

  async markUnavailable(error: string): Promise<void> {
    this.connectionGeneration += 1;
    for (const registration of this.inflightRuns) registration.controller.abort();
    if (
      this.activeTurns.size > 0
      || this.client.isReady
      || this.client.connectedExecutablePath !== null
      || this.connecting !== null
      || this.safetyDisconnectRequired
    ) {
      await this.disconnectForSafety({
        type: 'error',
        message: 'Codex CLI 当前不可用；共享 App Server 已安全断开。',
        detail: error,
        diagnostic: 'codex_runtime_unavailable_disconnected',
      });
    }
    this.connection = null;
    if (this.lifecycle === 'running') this.setStatus({ ...EMPTY_STATUS, state: 'error', error });
  }

  async runTurn(
    request: ChatTurnRequest,
    connection: CodexRuntimeConnection,
    listener: (event: RuntimeTurnEvent) => void,
  ): Promise<void> {
    if (this.lifecycle !== 'running') {
      this.emitLifecycleClosed(listener);
      return;
    }
    if (this.safetyDisconnectRequired) {
      this.emitSafetyStopRequired(listener);
      return;
    }
    const registration = this.registerRun(request.signal);
    try {
      await this.executeRunTurn(
        { ...request, signal: registration.controller.signal },
        connection,
        listener,
        registration,
      );
    } finally {
      registration.detachCallerAbort();
      this.inflightRuns.delete(registration);
      registration.resolve();
    }
  }

  private async executeRunTurn(
    incomingRequest: ChatTurnRequest,
    connection: CodexRuntimeConnection,
    listener: (event: RuntimeTurnEvent) => void,
    registration: RunRegistration,
  ): Promise<void> {
    let request = isolatedCodexRequest(incomingRequest);
    const executionIsCurrent = (): boolean => {
      try {
        return connection.executionIsCurrent?.() ?? true;
      } catch (error) {
        console.error('Ailu execution fingerprint check failed.', error);
        return false;
      }
    };
    try {
      request = {
        ...request,
        attachments: assertManagedFrozenAttachments(request.attachments ?? [], request.cwd),
      };
    } catch (error) {
      listener({
        type: 'error',
        message: '附件隔离检查失败，Codex 运行时未启动。',
        detail: errorMessage(error),
        diagnostic: 'runtime_attachment_isolation_failed',
      });
      listener({ type: 'done', sessionId: request.sessionId?.trim() || undefined });
      return;
    }
    const isolatedTurn = request.purpose === 'contextCompression' || request.textOnly === true;
    const fullAccess = request.fullAccess === true && !request.planMode && !request.textOnly;
    const readOnly = isolatedTurn || request.planMode === true;
    let requestedThreadId = request.sessionId?.trim();
    let turnPrompt = request.prompt;
    if (requestedThreadId && !fullAccess && this.fullAccessThreadIds.has(requestedThreadId)) {
      const freshSessionPrompt = request.freshSessionPrompt?.trim();
      if (request.allowFreshSessionFallback !== true || !freshSessionPrompt) {
        listener({
          type: 'error',
          message: 'Codex 权限已降级，旧的高权限会话不会继续。',
          detail: '缺少经过验证的新会话交接内容，本次已阻止。',
          diagnostic: 'codex_privilege_downgrade_requires_fresh_session',
        });
        listener({ type: 'done', sessionId: requestedThreadId });
        return;
      }
      requestedThreadId = undefined;
      turnPrompt = freshSessionPrompt;
    }
    if (!executionIsCurrent()) {
      this.emitExecutionConfigChanged(listener, request.sessionId?.trim() || undefined);
      return;
    }
    const connectionConflict = this.connectionChangeBlocked(connection.binaryPath, registration);
    if (connectionConflict) {
      listener({
        type: 'error',
        message: '正在运行 Codex 任务，暂不能切换 CLI。',
        detail: connectionConflict,
        diagnostic: 'codex_binary_change_blocked',
      });
      listener({ type: 'done', sessionId: request.sessionId?.trim() || undefined });
      return;
    }
    if (!this.canContinue(registration)) {
      listener({ type: 'done' });
      return;
    }

    if (
      this.status.state !== 'ready'
      || this.status.binaryPath !== connection.binaryPath
      || !this.status.connected
    ) {
      await this.refreshStatusInternal(
        connection,
        registration.epoch,
        () => this.canContinue(registration) && executionIsCurrent(),
      );
    }
    if (!this.canContinue(registration)) {
      listener({ type: 'done', sessionId: request.sessionId?.trim() || undefined });
      return;
    }
    if (!executionIsCurrent()) {
      this.emitExecutionConfigChanged(listener, request.sessionId?.trim() || undefined);
      return;
    }
    if (this.status.state !== 'ready') {
      listener({ type: 'error', message: 'Codex App Server 启动失败。', detail: this.status.error ?? undefined });
      listener({ type: 'done' });
      return;
    }

    if (requestedThreadId && this.isThreadReserved(requestedThreadId)) {
      this.emitThreadReservedError(listener, requestedThreadId);
      return;
    }

    let threadResult: unknown;
    const threadOptions: Record<string, unknown> = {
      cwd: request.cwd,
      approvalPolicy: 'never',
      sandbox: readOnly
        ? 'read-only'
        : fullAccess ? 'danger-full-access' : 'workspace-write',
      developerInstructions: request.systemPrompt?.trim() || undefined,
      serviceName: PROTOCOL_IDS.codexServiceName,
      ...(isolatedTurn
        ? {
          ephemeral: true,
          dynamicTools: [],
          environments: [],
          selectedCapabilityRoots: [],
        }
        : {}),
    };
    try {
      if (requestedThreadId) {
        try {
          if (!executionIsCurrent()) {
            this.emitExecutionConfigChanged(listener, requestedThreadId);
            return;
          }
          threadResult = await this.client.request('thread/resume', {
            threadId: requestedThreadId,
            ...threadOptions,
          });
        } catch (error) {
          if (!this.canContinue(registration)) {
            listener({ type: 'done', sessionId: requestedThreadId });
            return;
          }
          if (!executionIsCurrent()) {
            this.emitExecutionConfigChanged(listener, requestedThreadId);
            return;
          }
          const freshSessionPrompt = request.freshSessionPrompt?.trim();
          if (
            request.allowFreshSessionFallback !== true
            || !freshSessionPrompt
            || !isMissingCodexResumeThreadError(error)
          ) throw error;
          turnPrompt = freshSessionPrompt;
          threadResult = await this.client.request('thread/start', threadOptions);
        }
      } else {
        if (!executionIsCurrent()) {
          this.emitExecutionConfigChanged(listener);
          return;
        }
        threadResult = await this.client.request('thread/start', threadOptions);
      }
    } catch (error) {
      if (!this.canContinue(registration)) {
        listener({ type: 'done', sessionId: request.sessionId?.trim() || undefined });
        return;
      }
      listener({ type: 'error', message: 'Codex 会话启动失败。', detail: errorMessage(error) });
      listener({ type: 'done' });
      return;
    }

    if (!this.canContinue(registration)) {
      listener({ type: 'done', sessionId: request.sessionId?.trim() || undefined });
      return;
    }
    if (!executionIsCurrent()) {
      this.emitExecutionConfigChanged(listener, request.sessionId?.trim() || undefined);
      return;
    }

    const threadId = stringAt(threadResult, 'thread', 'id');
    if (!threadId) {
      listener({ type: 'error', message: 'Codex App Server 未返回 threadId。' });
      listener({ type: 'done' });
      return;
    }
    // The canonical thread returned by App Server is the final authority. This
    // second check covers two concurrent resumes that raced through the early
    // request.sessionId guard; never overwrite the existing ActiveTurn.
    if (this.isThreadReserved(threadId)) {
      this.emitThreadReservedError(listener, threadId);
      return;
    }

    const admitCanonicalSession = isolatedTurn
      ? undefined
      : (request as ChatTurnRequest & CanonicalSessionAdmissionRequest).admitCanonicalSession;
    if (admitCanonicalSession) {
      try {
        await admitCanonicalSession(threadId);
      } catch (error) {
        listener({
          type: 'error',
          message: 'Codex 会话归属保存失败，本次未执行。',
          detail: errorMessage(error),
          diagnostic: 'codex_session_admission_failed',
        });
        // A rejected canonical session is intentionally not exposed to the
        // coordinator/UI. It never crossed the durable ownership barrier.
        listener({ type: 'done' });
        return;
      }
    }
    if (fullAccess) this.fullAccessThreadIds.add(threadId);
    if (!this.canContinue(registration)) {
      listener(isolatedTurn ? { type: 'done' } : { type: 'done', sessionId: threadId });
      return;
    }
    // Admission can be asynchronous. Re-check the in-process reservation after
    // it settles so a concurrent caller cannot register the same canonical
    // App Server thread while this request is waiting on durable storage.
    if (this.isThreadReserved(threadId)) {
      this.emitThreadReservedError(listener, threadId);
      return;
    }

    let resolveSettled!: () => void;
    const settled = new Promise<void>(resolve => {
      resolveSettled = resolve;
    });
    const active: ActiveTurn = {
      threadId,
      turnId: null,
      fullAccess,
      exposeSession: !isolatedTurn,
      listener,
      resolve: resolveSettled,
      settled,
      emittedDeltas: new Map(),
      emittedItems: new Set(),
      bufferedNotifications: [],
      interrupted: false,
      finished: false,
      errorEmitted: false,
      pendingSnapshotError: null,
      cleanupAbort: () => undefined,
      interruptPromise: null,
      interruptCompletionTimer: null,
      notificationBytes: 0,
      outputLimitExceeded: false,
    };
    const abort = (): void => {
      active.interrupted = true;
      if (active.turnId) void this.interruptTurn(active);
    };
    active.cleanupAbort = () => request.signal?.removeEventListener('abort', abort);
    this.activeTurns.set(threadId, active);
    request.signal?.addEventListener('abort', abort, { once: true });
    if (!isolatedTurn) listener({ type: 'session', sessionId: threadId });
    // The coordinator can reject a newly learned canonical session owner from
    // inside the session callback and synchronously abort this request. Never
    // cross the turn/start side-effect boundary after that decision.
    const executionStillCurrent = executionIsCurrent();
    if (!this.canContinue(registration) || active.interrupted || !executionStillCurrent) {
      if (!executionStillCurrent && !active.interrupted) {
        try {
          active.listener({
            type: 'error',
            message: '排队期间运行配置已改变，本次未发送。',
            diagnostic: 'runtime_execution_config_changed',
          });
        } catch (listenerError) {
          console.error('Ailu Codex runtime error listener failed.', listenerError);
        }
      }
      if (!active.finished) this.finishTurn(active);
      await settled;
      return;
    }

    const input: Array<Record<string, unknown>> = [{ type: 'text', text: turnPrompt, text_elements: [] }];
    for (const attachment of request.attachments ?? []) {
      if (attachment.mimeType?.startsWith('image/')) {
        input.push({ type: 'localImage', path: attachment.absolutePath });
      }
    }
    const params: Record<string, unknown> = {
      threadId,
      input,
      cwd: request.cwd,
      approvalPolicy: 'never',
      sandboxPolicy: readOnly
        ? { type: 'readOnly', networkAccess: false }
        : fullAccess
          ? { type: 'dangerFullAccess' }
          : {
            type: 'workspaceWrite',
            writableRoots: [request.cwd],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
    };
    const selectedModel = request.model?.trim() || undefined;
    const selectedEffort = request.reasoningEffort?.trim() || undefined;
    if (request.planMode) {
      const planModel = selectedModel
        ?? stringAt(threadResult, 'thread', 'model')
        ?? this.status.currentModelId
        ?? this.status.models.find(model => model.isDefault)?.id;
      if (planModel) {
        const modelDefaultEffort = this.status.models.find(model => (
          model.id === planModel || model.model === planModel
        ))?.defaultReasoningEffort ?? undefined;
        const planEffort = selectedEffort
          ?? (selectedModel ? undefined : stringAt(threadResult, 'thread', 'reasoningEffort'))
          ?? modelDefaultEffort;
        params.collaborationMode = {
          mode: 'plan',
          settings: {
            model: planModel,
            reasoning_effort: planEffort ?? null,
            developer_instructions: null,
          },
        };
      }
    } else {
      if (selectedModel) params.model = selectedModel;
      if (selectedEffort) params.effort = selectedEffort;
    }

    try {
      if (!executionIsCurrent()) {
        this.finishTurn(active, {
          type: 'error',
          message: '排队期间运行配置已改变，本次未发送。',
          diagnostic: 'runtime_execution_config_changed',
        });
        await settled;
        return;
      }
      const result = await this.client.request('turn/start', params);
      if (active.finished) {
        await settled;
        return;
      }
      active.turnId = stringAt(result, 'turn', 'id');
      if (!active.turnId) {
        this.finishTurn(active, {
          type: 'error',
          message: 'Codex App Server 未返回 turnId。',
        });
      } else {
        const buffered = active.bufferedNotifications.splice(0);
        for (const notification of buffered) {
          this.deliverNotification(active, notification.method, notification.params);
        }
        if (active.interrupted) void this.interruptTurn(active);
      }
    } catch (error) {
      if (!active.finished) {
        this.finishTurn(active, {
          type: 'error',
          message: 'Codex 回合启动失败。',
          detail: errorMessage(error),
        });
      }
    }

    await settled;
  }

  async cancelAll(): Promise<void> {
    if (this.cancelAllBarrier) return this.cancelAllBarrier;
    const barrier = (async () => {
      const failures: unknown[] = [];
      const registrations = [...this.inflightRuns];
      for (const registration of registrations) registration.controller.abort();

      const turns = [...this.activeTurns.values()];
      for (const turn of turns) turn.interrupted = true;

      // A global stop has a stronger contract than a targeted AbortSignal: no
      // unacknowledged App Server turn may continue mutating
      // files after the barrier resolves. Disconnecting the shared server is
      // the only authoritative teardown primitive available here.
      if (
        turns.length > 0
        || this.client.isReady
        || this.client.connectedExecutablePath !== null
        || this.connecting !== null
        || this.safetyDisconnectRequired
      ) {
        try {
          await this.disconnectForSafety({
            type: 'error',
            message: 'Codex 回合已通过断开共享 App Server 全部停止。',
            diagnostic: 'codex_global_cancel_disconnected',
          });
        } catch (error) {
          failures.push(error);
        }
      }
      // A failed disconnect leaves the server capable of continuing file
      // mutations. Never emit done or wait forever on turns we cannot prove
      // stopped; retain them so a later global shutdown can retry.
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Codex global cancellation could not confirm server shutdown.');
      }
      const settlements = await Promise.allSettled([
        ...turns.map(turn => turn.settled),
        ...registrations.map(registration => registration.settled),
      ]);
      for (const result of settlements) {
        if (result.status === 'rejected') failures.push(result.reason);
      }

      if (this.lifecycle === 'running' && this.status.connected) {
        this.setStatus({ ...this.status, state: 'idle', connected: false, error: null });
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Codex global cancellation did not fully converge.');
      }
    })();
    this.cancelAllBarrier = barrier;
    try {
      await barrier;
    } finally {
      if (this.cancelAllBarrier === barrier) this.cancelAllBarrier = null;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownBarrier) return this.shutdownBarrier;
    if (this.lifecycle === 'closed') return;

    this.lifecycle = 'shuttingDown';
    this.lifecycleEpoch += 1;
    this.connectionGeneration += 1;
    for (const registration of this.inflightRuns) registration.controller.abort();

    const barrier = (async () => {
      const failures: unknown[] = [];
      try {
        await this.cancelAll();
      } catch {
        // A failed targeted/global disconnect is retried below after pending
        // connection and status operations have crossed their barriers.
      }
      const statusResults = await Promise.allSettled([...this.statusOperations]);
      for (const result of statusResults) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
      if (this.connecting) {
        try {
          await this.connecting;
        } catch (error) {
          failures.push(error);
        }
      }
      if (
        this.activeTurns.size > 0
        || this.client.isReady
        || this.client.connectedExecutablePath !== null
        || this.connecting !== null
        || this.safetyDisconnectRequired
      ) {
        try {
          await this.disconnectForSafety({
            type: 'error',
            message: 'Codex runtime 已通过断开共享 App Server 安全关闭。',
            diagnostic: 'codex_shutdown_disconnected',
          });
        } catch (error) {
          failures.push(error);
        }
      }
      if (this.safetyDisconnectRequired || this.activeTurns.size > 0) {
        throw new AggregateError(failures, 'Codex runtime shutdown could not confirm server shutdown.');
      }
      const runResults = await Promise.allSettled(
        [...this.inflightRuns].map(registration => registration.settled),
      );
      for (const result of runResults) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
      this.connection = null;
      this.lifecycle = 'closed';
      this.setStatus({ ...EMPTY_STATUS });
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Codex runtime shutdown did not fully converge.');
      }
    })();
    this.shutdownBarrier = barrier;
    void barrier.catch(() => {
      // Keep concurrent shutdown callers memoized, but allow a later explicit
      // global shutdown to retry a failed physical disconnect.
      if (this.shutdownBarrier === barrier && this.lifecycle !== 'closed') {
        this.shutdownBarrier = null;
      }
    });
    return barrier;
  }

  private async refreshStatusInternal(
    connection: CodexRuntimeConnection,
    epoch: number,
    runIsCurrent?: () => boolean,
  ): Promise<CodexRuntimeStatus> {
    const isCurrent = (generation: number): boolean => (
      this.operationIsCurrent(epoch, generation) && (runIsCurrent?.() ?? true)
    );
    if (runIsCurrent && !runIsCurrent()) return this.getStatus();
    if (this.lifecycle !== 'running' || epoch !== this.lifecycleEpoch) return this.closedStatus();

    const currentPath = this.currentBinaryPath();
    const switchingBinary = Boolean(currentPath && currentPath !== connection.binaryPath);
    let generation: number;
    if (switchingBinary) {
      this.connectionGeneration += 1;
      generation = this.connectionGeneration;
      this.connection = connection;
      await this.disconnectSharedServer();
      if (!isCurrent(generation)) return this.getStatus();
    } else if (!this.connection || this.connection.binaryPath !== connection.binaryPath) {
      this.connectionGeneration += 1;
      generation = this.connectionGeneration;
    } else {
      generation = this.connectionGeneration;
    }
    this.connection = connection;
    this.setStatus({
      ...this.status,
      state: 'connecting',
      binaryPath: connection.binaryPath,
      binarySource: connection.binarySource,
      version: connection.version,
      connected: false,
      error: null,
    });
    try {
      await this.ensureConnected(epoch, generation, () => isCurrent(generation));
      if (!isCurrent(generation)) return this.getStatus();
      const [models, config, account, capabilities] = await Promise.all([
        this.readAllModels(() => isCurrent(generation)),
        this.tryRequest('config/read', { includeLayers: false }),
        this.tryRequest('account/read', { refreshToken: false }),
        this.tryRequest('modelProvider/capabilities/read', {}),
      ]);
      if (!isCurrent(generation)) return this.getStatus();
      const currentModelId = stringAt(config, 'config', 'model')
        ?? models.find(model => model.isDefault)?.id
        ?? null;
      const currentModel = models.find(model => model.id === currentModelId || model.model === currentModelId) ?? null;
      const contextWindowTokens = positiveIntegerAt(config, 'config', 'model_context_window')
        ?? positiveIntegerAt(config, 'config', 'modelContextWindow')
        ?? currentModel?.contextWindowTokens
        ?? null;
      const autoCompactTokenLimit = positiveIntegerAt(
        config,
        'config',
        'model_auto_compact_token_limit',
      )
        ?? positiveIntegerAt(config, 'config', 'modelAutoCompactTokenLimit')
        ?? currentModel?.autoCompactTokenLimit
        ?? null;
      const accountValue = recordAt(account, 'account');
      const authMode = stringAt(account, 'authMode')
        ?? stringAt(accountValue, 'type')
        ?? stringAt(accountValue, 'authMode');
      this.setStatus({
        state: 'ready',
        binaryPath: connection.binaryPath,
        binarySource: connection.binarySource,
        version: connection.version,
        connected: true,
        authenticated: account === null
          ? null
          : accountValue !== null || valueAt(account, 'requiresOpenaiAuth') === false,
        authMode,
        currentModelId,
        currentModel,
        models,
        contextWindowTokens,
        autoCompactTokenLimit,
        imageGeneration: readCapability(capabilities, 'imageGeneration'),
        webSearch: readCapability(capabilities, 'webSearch'),
        error: null,
      });
    } catch (error) {
      if (!isCurrent(generation)) return this.getStatus();
      const message = errorMessage(error);
      this.setStatus({
        ...this.status,
        state: 'error',
        connected: false,
        error: message,
      });
    }
    return this.getStatus();
  }

  private async ensureConnected(
    epoch: number,
    generation: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    const connection = this.connection;
    if (!connection) throw new Error('Codex CLI path is unavailable');
    if (!this.operationIsCurrent(epoch, generation) || !isCurrent()) throw new Error('Codex runtime is shutting down');
    if (this.disconnecting) await this.disconnecting;
    if (!this.operationIsCurrent(epoch, generation) || !isCurrent()) throw new Error('Codex runtime is shutting down');
    if (this.client.isReady && this.client.connectedExecutablePath === connection.binaryPath) return;
    if (this.client.connectedExecutablePath && this.client.connectedExecutablePath !== connection.binaryPath) {
      await this.disconnectSharedServer();
      if (!this.operationIsCurrent(epoch, generation) || !isCurrent()) throw new Error('Codex runtime is shutting down');
    }
    if (!this.connecting) {
      const connecting = this.client.connect({
        executablePath: connection.binaryPath,
        env: connection.env,
        clientVersion: connection.clientVersion,
      });
      this.connecting = connecting;
      void connecting.finally(() => {
        if (this.connecting === connecting) this.connecting = null;
      }).catch(() => undefined);
    }
    await this.connecting;
    if (!this.operationIsCurrent(epoch, generation) || !isCurrent()) throw new Error('Codex runtime is shutting down');
    if (!this.client.isReady || this.client.connectedExecutablePath !== connection.binaryPath) {
      throw new Error('Codex App Server connected with an unexpected executable path');
    }
  }

  private disconnectSharedServer(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    if (
      this.connecting === null
      && !this.client.isReady
      && this.client.connectedExecutablePath === null
    ) {
      this.fullAccessThreadIds.clear();
      return Promise.resolve();
    }
    const barrier = (async () => {
      const pendingConnection = this.connecting;
      // Disconnect once immediately so real pending JSON-RPC initialization is
      // rejected, then wait for a custom/slow client to settle and disconnect
      // again. The second pass prevents a late connect from resurrecting the
      // server after shutdown has already crossed its gate.
      await this.client.disconnect();
      if (pendingConnection) await pendingConnection.catch(() => undefined);
      if (this.client.isReady || this.client.connectedExecutablePath !== null) {
        await this.client.disconnect();
      }
      if (this.client.isReady || this.client.connectedExecutablePath !== null) {
        throw new Error('Codex App Server disconnect returned while the shared server was still connected.');
      }
      this.fullAccessThreadIds.clear();
    })();
    this.disconnecting = barrier;
    void barrier.finally(() => {
      if (this.disconnecting === barrier) this.disconnecting = null;
    }).catch(() => undefined);
    return barrier;
  }

  private async readAllModels(isCurrent?: () => boolean): Promise<CodexModelDescriptor[]> {
    const models: CodexModelDescriptor[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.client.request('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      if (isCurrent && !isCurrent()) throw new Error('Codex runtime operation became stale');
      const data = arrayAt(result, 'data');
      for (const value of data) {
        const model = toModelDescriptor(value);
        if (model) models.push(model);
      }
      cursor = stringAt(result, 'nextCursor');
    } while (cursor);
    return models;
  }

  private async tryRequest(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.client.request(method, params, 10_000);
    } catch {
      return null;
    }
  }

  private registerRun(callerSignal?: AbortSignal): RunRegistration {
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    let resolveSettled!: () => void;
    const settled = new Promise<void>(resolve => {
      resolveSettled = resolve;
    });
    const registration: RunRegistration = {
      epoch: this.lifecycleEpoch,
      controller,
      detachCallerAbort: () => callerSignal?.removeEventListener('abort', abortFromCaller),
      settled,
      resolve: resolveSettled,
    };
    this.inflightRuns.add(registration);
    return registration;
  }

  private canContinue(registration: RunRegistration): boolean {
    return this.lifecycle === 'running'
      && registration.epoch === this.lifecycleEpoch
      && !registration.controller.signal.aborted;
  }

  private operationIsCurrent(epoch: number, generation: number): boolean {
    return this.lifecycle === 'running'
      && epoch === this.lifecycleEpoch
      && generation === this.connectionGeneration;
  }

  private currentBinaryPath(): string | null {
    return this.connection?.binaryPath
      ?? this.client.connectedExecutablePath
      ?? this.status.binaryPath;
  }

  private connectionChangeBlocked(binaryPath: string, excludedRun?: RunRegistration): string | null {
    const currentPath = this.currentBinaryPath();
    if (!currentPath || currentPath === binaryPath) return null;
    const hasOtherInflightRun = [...this.inflightRuns].some(registration => registration !== excludedRun);
    if (
      this.activeTurns.size === 0
      && !hasOtherInflightRun
      && this.statusOperations.size === 0
    ) return null;
    return `当前 ${currentPath} 仍有回合或连接检查未收敛；本次保持原连接，未切换到 ${binaryPath}。`;
  }

  private closedStatus(): CodexRuntimeStatus {
    return {
      ...this.getStatus(),
      state: 'error',
      connected: false,
      error: this.lifecycle === 'closed'
        ? 'Codex runtime 已关闭，需重载插件后才能重新启动。'
        : 'Codex runtime 正在关闭。',
    };
  }

  private safetyStopStatus(): CodexRuntimeStatus {
    return {
      ...this.getStatus(),
      state: 'error',
      connected: false,
      error: 'Codex 上一批回合尚未完成安全断开，请先执行全局停止。',
    };
  }

  private emitSafetyStopRequired(listener: (event: RuntimeTurnEvent) => void): void {
    listener({
      type: 'error',
      message: 'Codex 上一批回合尚未确认停止，本次未启动。',
      detail: '请执行全局停止；共享 App Server 成功断开后才能开始新回合。',
      diagnostic: 'codex_safety_disconnect_required',
    });
    listener({ type: 'done' });
  }

  private emitExecutionConfigChanged(
    listener: (event: RuntimeTurnEvent) => void,
    sessionId?: string,
  ): void {
    listener({
      type: 'error',
      message: '排队期间运行配置已改变，本次未发送。',
      detail: '请重新发送，Codex 不会混用旧会话快照与新的本地执行配置。',
      diagnostic: 'runtime_execution_config_changed',
    });
    listener({ type: 'done', sessionId });
  }

  private emitLifecycleClosed(listener: (event: RuntimeTurnEvent) => void): void {
    const status = this.closedStatus();
    listener({
      type: 'error',
      message: status.error ?? 'Codex runtime 不可用。',
      diagnostic: 'codex_runtime_closed',
    });
    listener({ type: 'done' });
  }

  private handleNotification(method: string, params: unknown): void {
    const threadId = stringAt(params, 'threadId') ?? stringAt(params, 'thread', 'id');
    if (!threadId) return;
    const active = this.activeTurns.get(threadId);
    if (this.safetyDisconnectRequired) return;
    if (!active || active.finished) return;
    const eventBytes = jsonByteLength({ method, params });
    if (!Number.isFinite(eventBytes) || eventBytes > CODEX_MAX_RUNTIME_EVENT_BYTES) {
      this.disconnectForOutputLimit(active, 'event');
      return;
    }
    if (active.notificationBytes + eventBytes > CODEX_MAX_TURN_OUTPUT_BYTES) {
      this.disconnectForOutputLimit(active, 'turn');
      return;
    }
    active.notificationBytes += eventBytes;
    if (!active.turnId) {
      active.bufferedNotifications.push({ method, params });
      return;
    }
    this.deliverNotification(active, method, params);
  }

  private disconnectForOutputLimit(active: ActiveTurn, kind: 'event' | 'turn'): void {
    if (active.finished || active.outputLimitExceeded) return;
    active.outputLimitExceeded = true;
    active.interrupted = true;
    void this.disconnectForSafety(
      {
        type: 'error',
        message: 'Codex 共享连接因输出超过安全上限而已断开。',
        detail: '另一个并行 Codex 回合也已停止，避免后台继续修改文件。',
        diagnostic: 'codex_shared_server_disconnected_for_output_limit',
      },
      active,
      {
        type: 'error',
        message: 'Codex 输出超过安全上限，已终止本次回合。',
        detail: kind === 'event'
          ? '单个 App Server 事件过大。'
          : '本回合累计 App Server 事件过大。',
        diagnostic: 'codex_output_limit_exceeded',
      },
    ).catch(() => undefined);
  }

  private deliverNotification(active: ActiveTurn, method: string, params: unknown): void {
    const turnId = stringAt(params, 'turnId') ?? stringAt(params, 'turn', 'id');
    if (turnId && turnId !== active.turnId) return;
    // Once cancellation starts, only the terminal notification is meaningful.
    // Ignore teardown deltas/tools/artifacts so a late App Server event cannot
    // mutate a conversation the coordinator has already stopped.
    if (active.interrupted && method !== 'turn/completed') return;

    if (method === 'item/agentMessage/delta') {
      const itemId = stringAt(params, 'itemId') ?? 'agent-message';
      const delta = stringAt(params, 'delta');
      if (delta) {
        active.emittedDeltas.set(itemId, `${active.emittedDeltas.get(itemId) ?? ''}${delta}`);
        active.listener({ type: 'text', content: delta });
      }
      return;
    }
    if (method === 'item/plan/delta') {
      const itemId = stringAt(params, 'itemId') ?? 'plan';
      const delta = stringAt(params, 'delta');
      if (delta) {
        active.emittedDeltas.set(itemId, `${active.emittedDeltas.get(itemId) ?? ''}${delta}`);
        active.listener({ type: 'text', content: delta });
      }
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      this.deliverItem(active, recordAt(params, 'item'), method === 'item/completed');
      return;
    }
    if (method === 'error') {
      const error = recordAt(params, 'error');
      const message = stringAt(error, 'message') ?? 'Codex 回合失败。';
      const detail = stringAt(error, 'additionalDetails') ?? undefined;
      const statusCode = numberAt(error, 'codexErrorInfo', 'httpStatusCode') ?? undefined;
      if (valueAt(params, 'willRetry') === true) {
        // App Server uses the same `error` notification for transient stream
        // failures and terminal failures. `willRetry=true` means Codex still
        // owns the turn and will keep producing events. Forwarding it as a
        // terminal runtime error makes the coordinator abort that retry.
        active.listener({
          type: 'diagnostic',
          code: 'codex_stream_retrying',
          message,
          detail,
        });
        return;
      }
      if (active.errorEmitted) return;
      active.errorEmitted = true;
      active.listener({
        type: 'error',
        message,
        detail,
        statusCode,
      });
      return;
    }
    if (method === 'warning') {
      // App Server warnings are non-fatal diagnostics (for example an
      // unavailable service tier or fallback model metadata). Rendering them
      // as a red assistant error makes a successful turn look failed.
      return;
    }
    if (method === 'turn/completed') {
      const turn = recordAt(params, 'turn');
      let terminalError: Extract<RuntimeTurnEvent, { type: 'error' }> | undefined;
      if (stringAt(turn, 'status') === 'failed' && !active.errorEmitted) {
        const error = recordAt(turn, 'error');
        active.errorEmitted = true;
        terminalError = {
          type: 'error',
          message: stringAt(error, 'message') ?? 'Codex 回合失败。',
          detail: stringAt(error, 'additionalDetails') ?? undefined,
        };
      } else if (!active.errorEmitted && active.pendingSnapshotError) {
        active.errorEmitted = true;
        terminalError = active.pendingSnapshotError;
      }
      // Mark the turn finished and detach its abort handler before delivering
      // a terminal error. The coordinator aborts synchronously on error; doing
      // this first prevents an interrupt RPC for a turn the server has already
      // completed.
      this.finishTurn(active, terminalError);
    }
  }

  private deliverItem(active: ActiveTurn, item: Record<string, unknown> | null, completed: boolean): void {
    if (!item) return;
    const id = stringAt(item, 'id') ?? `${stringAt(item, 'type') ?? 'item'}-${active.emittedItems.size}`;
    const type = stringAt(item, 'type') ?? 'tool';
    if (completed && active.emittedItems.has(id)) return;

    if (type === 'agentMessage' || type === 'plan') {
      if (!completed) return;
      active.emittedItems.add(id);
      const text = stringAt(item, 'text');
      if (!text) return;
      const streamed = active.emittedDeltas.get(id);
      if (streamed === undefined) {
        active.listener({ type: 'text', content: text });
        return;
      }
      if (text === streamed) return;
      if (text.startsWith(streamed)) {
        const suffix = text.slice(streamed.length);
        if (suffix) active.listener({ type: 'text', content: suffix });
        return;
      }
      const detail = `itemId=${id}; streamedLength=${streamed.length}; snapshotLength=${text.length}`;
      if (differsOnlyByWhitespace(streamed, text)) {
        // Codex can normalize spaces in a completed snapshot. Preserve the
        // already-rendered stream and keep the turn alive for later tools and
        // image artifacts.
        active.listener({
          type: 'diagnostic',
          code: 'codex_stream_snapshot_diverged',
          message: 'Codex 流式文本与最终快照仅排版空白不同，已保留已接收内容。',
          detail,
        });
        return;
      }
      // A material mismatch can mean a missed or replayed stream fragment.
      // Do not append the snapshot (which would duplicate/interleave text),
      // but defer the terminal error until turn/completed so any following
      // tool or image artifact is still delivered.
      active.pendingSnapshotError ??= {
        type: 'error',
        message: 'Codex 流式文本与最终快照内容不一致，已保留已接收内容。',
        detail,
        diagnostic: 'codex_stream_snapshot_diverged',
      };
      return;
    }

    const toolCall = toolCallFromItem(item, completed);
    if (toolCall) active.listener({ type: 'tool', toolCall });
    if (!completed) return;
    active.emittedItems.add(id);

    if (type === 'imageGeneration') {
      const sourcePath = stringAt(item, 'savedPath');
      if (sourcePath) {
        active.listener({
          type: 'artifact',
          artifact: {
            itemId: id,
            kind: 'image',
            sourcePath,
            mimeType: stringAt(item, 'mimeType') ?? undefined,
            revisedPrompt: stringAt(item, 'revisedPrompt') ?? stringAt(item, 'revised_prompt') ?? undefined,
          },
        });
      } else {
        const failed = stringAt(item, 'status') === 'failed';
        active.listener({
          type: 'error',
          message: failed ? 'Codex 图片生成失败。' : 'Codex 图片生成没有返回 savedPath。',
          detail: stringAt(item, 'error') ?? stringAt(item, 'result') ?? undefined,
        });
      }
    }
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const active = this.activeTurns.get(
      stringAt(params, 'threadId') ?? stringAt(params, 'conversationId') ?? '',
    );
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const approved = active?.fullAccess === true && !active.interrupted;
      this.client.respond(id, { decision: approved ? 'accept' : 'decline' });
      if (!approved && active && !active.interrupted) {
        active.listener({ type: 'error', message: `Codex 请求了交互确认，${PLUGIN_NAME} 已按受限模式拒绝。` });
      }
      return;
    }
    if (method === 'item/permissions/requestApproval') {
      const approved = active?.fullAccess === true && !active.interrupted;
      const requested = recordAt(params, 'permissions');
      const permissions: Record<string, unknown> = {};
      const network = recordAt(requested, 'network');
      const fileSystem = recordAt(requested, 'fileSystem');
      if (approved && network) permissions.network = network;
      if (approved && fileSystem) permissions.fileSystem = fileSystem;
      this.client.respond(id, { permissions, scope: 'turn' });
      if (!approved && active && !active.interrupted) {
        active.listener({ type: 'error', message: `Codex 请求了额外权限，${PLUGIN_NAME} 已按受限模式拒绝。` });
      }
      return;
    }
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      const approved = active?.fullAccess === true && !active.interrupted;
      this.client.respond(id, {
        decision: approved
          ? 'approved'
          : { denied: { rejection: 'Ailu is running this turn in restricted mode.' } },
      });
      if (!approved && active && !active.interrupted) {
        active.listener({ type: 'error', message: `Codex 请求了交互确认，${PLUGIN_NAME} 已按受限模式拒绝。` });
      }
      return;
    }
    this.client.reject(id, -32601, `Unsupported Codex server request: ${method}`);
    if (active && !active.interrupted) {
      active.listener({ type: 'error', message: `Codex 发出了未支持的服务端请求：${method}` });
    }
  }

  private interruptTurn(active: ActiveTurn): Promise<void> {
    if (!active.turnId || active.finished) return Promise.resolve();
    if (this.safetyDisconnectRequired) return this.safetyDisconnectBarrier ?? Promise.resolve();
    if (active.interruptPromise) return active.interruptPromise;
    const turnId = active.turnId;
    active.interruptPromise = this.client.request('turn/interrupt', {
      threadId: active.threadId,
      turnId,
    }, 5_000).then(() => {
      if (
        active.finished
        || this.safetyDisconnectRequired
        || active.interruptCompletionTimer !== null
      ) return;
      active.interruptCompletionTimer = scheduleTimeout(() => {
        active.interruptCompletionTimer = null;
        if (active.finished) return;
        void this.disconnectForSafety(
          {
            type: 'error',
            message: 'Codex 共享连接因取消终态不确定而已安全断开。',
            detail: '另一个并行 Codex 回合也已停止，避免后台继续修改文件。',
            diagnostic: 'codex_shared_server_disconnected_for_safety',
          },
          active,
          {
            type: 'error',
            message: 'Codex 取消已确认，但回合未在限时内完成；共享 App Server 已安全断开。',
            detail: `等待 turn/completed 超过 ${this.interruptCompletionTimeoutMs} 毫秒。`,
            diagnostic: 'codex_interrupt_completion_timeout',
          },
        ).catch(() => undefined);
      }, this.interruptCompletionTimeoutMs);
    }).catch(error => {
      if (active.finished) return;
      return this.disconnectForSafety(
        {
          type: 'error',
          message: 'Codex 共享连接因取消失败而已安全断开。',
          detail: '另一个并行 Codex 回合也已停止，避免后台继续修改文件。',
          diagnostic: 'codex_shared_server_disconnected_for_safety',
        },
        active,
        {
          type: 'error',
          message: 'Codex 取消请求失败；共享 App Server 已安全断开。',
          detail: errorMessage(error),
          diagnostic: 'codex_interrupt_failed',
        },
      ).catch(() => undefined);
    });
    return active.interruptPromise;
  }

  private disconnectForSafety(
    defaultError: Extract<RuntimeTurnEvent, { type: 'error' }>,
    trigger?: ActiveTurn,
    triggerError?: Extract<RuntimeTurnEvent, { type: 'error' }>,
  ): Promise<void> {
    this.safetyDisconnectDefaultError ??= defaultError;
    if (trigger && triggerError) this.safetyDisconnectErrors.set(trigger.threadId, triggerError);
    if (this.safetyDisconnectBarrier) return this.safetyDisconnectBarrier;

    if (!this.safetyDisconnectRequired) this.connectionGeneration += 1;
    this.safetyDisconnectRequired = true;
    for (const active of this.activeTurns.values()) {
      active.interrupted = true;
      if (active.interruptCompletionTimer !== null) {
        cancelTimeout(active.interruptCompletionTimer);
        active.interruptCompletionTimer = null;
      }
    }
    for (const registration of this.inflightRuns) registration.controller.abort();

    const barrier = (async () => {
      try {
        await this.disconnectSharedServer();
      } catch (error) {
        this.reportSafetyDisconnectFailure(error);
        throw error;
      }

      const fallback = this.safetyDisconnectDefaultError ?? defaultError;
      const activeTurns = [...this.activeTurns.values()];
      if (this.lifecycle === 'running') {
        this.setStatus({ ...this.status, state: 'idle', connected: false, error: null });
      }
      for (const active of activeTurns) {
        this.finishTurn(active, this.safetyDisconnectErrors.get(active.threadId) ?? fallback, true);
      }
      this.safetyDisconnectRequired = false;
      this.safetyDisconnectErrors.clear();
      this.safetyDisconnectFailureNotified.clear();
      this.safetyDisconnectDefaultError = null;
    })();
    this.safetyDisconnectBarrier = barrier;
    void barrier.finally(() => {
      if (this.safetyDisconnectBarrier === barrier) this.safetyDisconnectBarrier = null;
    }).catch(() => undefined);
    return barrier;
  }

  private reportSafetyDisconnectFailure(error: unknown): void {
    for (const active of this.activeTurns.values()) {
      if (this.safetyDisconnectFailureNotified.has(active.threadId)) continue;
      this.safetyDisconnectFailureNotified.add(active.threadId);
      try {
        active.listener({
          type: 'error',
          message: 'Codex 安全断开失败，尚未确认回合已经停止。',
          detail: errorMessage(error),
          diagnostic: 'codex_safety_disconnect_failed',
        });
      } catch (listenerError) {
        console.error('Ailu Codex runtime error listener failed.', listenerError);
      }
    }
  }

  private finishTurn(
    active: ActiveTurn,
    error?: Extract<RuntimeTurnEvent, { type: 'error' }>,
    stopConfirmed = false,
  ): void {
    if (this.safetyDisconnectRequired && !stopConfirmed) return;
    if (active.finished) return;
    active.finished = true;
    active.cleanupAbort();
    if (active.interruptCompletionTimer !== null) {
      cancelTimeout(active.interruptCompletionTimer);
      active.interruptCompletionTimer = null;
    }
    if (this.activeTurns.get(active.threadId) === active) {
      this.activeTurns.delete(active.threadId);
    }
    if (error) {
      try {
        active.listener(error);
      } catch (listenerError) {
        console.error('Ailu Codex runtime error listener failed.', listenerError);
      }
    }
    try {
      active.listener(active.exposeSession
        ? { type: 'done', sessionId: active.threadId }
        : { type: 'done' });
    } catch (listenerError) {
      console.error('Ailu Codex runtime completion listener failed.', listenerError);
    } finally {
      active.resolve();
    }
  }

  private handleClose(reason: string): void {
    this.fullAccessThreadIds.clear();
    if (this.lifecycle === 'running') {
      this.setStatus({ ...this.status, state: 'error', connected: false, error: `Codex App Server 已退出：${reason}` });
    }
    if (this.safetyDisconnectRequired) return;
    for (const active of [...this.activeTurns.values()]) {
      this.finishTurn(active, { type: 'error', message: 'Codex App Server 连接已中断。', detail: reason });
    }
  }

  private isThreadReserved(threadId: string): boolean {
    return this.activeTurns.has(threadId);
  }

  private emitThreadReservedError(
    listener: (event: RuntimeTurnEvent) => void,
    threadId: string,
  ): void {
    listener({
      type: 'error',
      message: 'Codex 同一会话已有回合在运行。',
      detail: '请等待当前回合完成，不会覆盖正在跟踪的 ActiveTurn。',
      diagnostic: 'codex_thread_already_active',
    });
    listener({ type: 'done', sessionId: threadId });
  }

  private setStatus(status: CodexRuntimeStatus): void {
    this.status = status;
    const snapshot = this.getStatus();
    for (const listener of this.rawListeners('status')) {
      try {
        listener.call(this, snapshot);
      } catch (error) {
        // Status observers are UI integrations. One broken observer must not
        // interrupt connection teardown or leave active turns unresolved.
        console.error('Ailu Codex status listener failed.', error);
      }
    }
  }
}

function toolCallFromItem(item: Record<string, unknown>, completed: boolean): ToolCallEvent | null {
  const type = stringAt(item, 'type') ?? '';
  const id = stringAt(item, 'id') ?? `${type}-${Date.now()}`;
  const status: ToolCallEvent['status'] = completed
    ? (stringAt(item, 'status') === 'failed' ? 'error' : 'completed')
    : 'started';
  if (type === 'commandExecution') {
    return { id, name: 'Command', status, input: { command: item.command, cwd: item.cwd }, output: item.aggregatedOutput, error: stringAt(item, 'error') ?? undefined };
  }
  if (type === 'fileChange') {
    return { id, name: 'File changes', status, input: item.changes, output: completed ? item.changes : undefined };
  }
  if (type === 'mcpToolCall') {
    return { id, name: `${stringAt(item, 'server') ?? 'MCP'}:${stringAt(item, 'tool') ?? 'tool'}`, status, input: item.arguments, output: item.result, error: stringAt(item, 'error') ?? undefined };
  }
  if (type === 'dynamicToolCall') {
    return { id, name: stringAt(item, 'tool') ?? 'Tool', status, input: item.arguments, output: item.contentItems, error: stringAt(item, 'error') ?? undefined };
  }
  if (type === 'webSearch') {
    return { id, name: 'Web search', status, input: item.query ?? item.action, output: completed ? item.action : undefined };
  }
  if (type === 'imageGeneration') {
    return { id, name: 'Image generation', status, input: item.prompt, output: completed ? item.savedPath : undefined, error: stringAt(item, 'error') ?? undefined };
  }
  return null;
}

function toModelDescriptor(value: unknown): CodexModelDescriptor | null {
  if (!isRecord(value)) return null;
  const id = stringAt(value, 'id') ?? stringAt(value, 'model');
  if (!id) return null;
  const modalities = Array.isArray(value.inputModalities)
    ? value.inputModalities.filter((entry): entry is string => typeof entry === 'string')
    : ['text', 'image'];
  const supportedReasoningEfforts = arrayAt(value, 'supportedReasoningEfforts').flatMap(entry => {
    if (typeof entry === 'string' && entry.trim()) {
      return [{ reasoningEffort: entry.trim(), description: '' }];
    }
    if (!isRecord(entry)) return [];
    const reasoningEffort = stringAt(entry, 'reasoningEffort');
    if (!reasoningEffort) return [];
    return [{ reasoningEffort, description: stringAt(entry, 'description') ?? '' }];
  });
  return {
    id,
    model: stringAt(value, 'model') ?? id,
    displayName: stringAt(value, 'displayName') ?? id,
    description: stringAt(value, 'description') ?? '',
    hidden: Boolean(value.hidden),
    isDefault: Boolean(value.isDefault),
    defaultReasoningEffort: stringAt(value, 'defaultReasoningEffort'),
    supportedReasoningEfforts,
    inputModalities: modalities,
    contextWindowTokens: positiveIntegerAt(value, 'contextWindow')
      ?? positiveIntegerAt(value, 'context_window')
      ?? positiveIntegerAt(value, 'modelContextWindow'),
    autoCompactTokenLimit: positiveIntegerAt(value, 'autoCompactTokenLimit')
      ?? positiveIntegerAt(value, 'auto_compact_token_limit')
      ?? positiveIntegerAt(value, 'modelAutoCompactTokenLimit'),
  };
}

function readCapability(value: unknown, key: string): boolean | null {
  const direct = valueAt(value, key);
  if (typeof direct === 'boolean') return direct;
  const supported = valueAt(value, 'capabilities', key);
  if (typeof supported === 'boolean') return supported;
  const nested = valueAt(value, 'capabilities', key, 'supported');
  if (typeof nested === 'boolean') return nested;
  return null;
}

function recordAt(value: unknown, ...path: string[]): Record<string, unknown> | null {
  const resolved = valueAt(value, ...path);
  return isRecord(resolved) ? resolved : null;
}

function arrayAt(value: unknown, ...path: string[]): unknown[] {
  const resolved = valueAt(value, ...path);
  return Array.isArray(resolved) ? resolved : [];
}

function stringAt(value: unknown, ...path: string[]): string | null {
  const resolved = valueAt(value, ...path);
  return typeof resolved === 'string' && resolved.trim() ? resolved : null;
}

function numberAt(value: unknown, ...path: string[]): number | null {
  const resolved = valueAt(value, ...path);
  return typeof resolved === 'number' ? resolved : null;
}

function positiveIntegerAt(value: unknown, ...path: string[]): number | null {
  const resolved = numberAt(value, ...path);
  return Number.isSafeInteger(resolved) && Number(resolved) > 0 ? Number(resolved) : null;
}

function valueAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function differsOnlyByWhitespace(streamed: string, snapshot: string): boolean {
  return streamed.replace(/\s+/gu, '') === snapshot.replace(/\s+/gu, '');
}

function isolatedCodexRequest(request: ChatTurnRequest): ChatTurnRequest {
  if (request.purpose !== 'contextCompression' && request.textOnly !== true) return request;
  return {
    ...request,
    sessionId: undefined,
    attachments: [],
    fullAccess: false,
    planMode: false,
    textOnly: true,
    systemPrompt: undefined,
    freshSessionPrompt: undefined,
    allowFreshSessionFallback: false,
  };
}

/**
 * App Server currently overloads -32600 for both missing rollouts and broken
 * project configuration. Recovery is therefore intentionally limited to the
 * documented missing-thread messages on thread/resume.
 */
export function isMissingCodexResumeThreadError(error: unknown): boolean {
  if (!(error instanceof CodexJsonRpcError)) return false;
  if (error.method !== 'thread/resume' || String(error.code) !== '-32600') return false;
  const message = error.message.toLowerCase();
  if (message.includes('failed to load configuration')) return false;
  const kind = stringAt(error.data, 'kind')?.toLowerCase();
  if (kind && ['no_rollout', 'thread_not_found', 'thread_not_loaded'].includes(kind)) return true;
  return message.includes('no rollout found')
    || message.includes('thread not loaded')
    || /\bthread\b.*\bnot found\b/u.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
