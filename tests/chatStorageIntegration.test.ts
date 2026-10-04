import type { DataAdapter } from 'obsidian';

import {
  ChatContextOverflowError,
  ChatContextService,
  ChatRunCoordinator,
  type ChatRunCoordinatorDependencies,
  type ChatRunSubmission,
} from '../src/chat';
import {
  ConversationSessionConflictError,
  VaultStore,
} from '../src/storage/vaultStore';
import type {
  ChatMessage,
  ChatTurnRequest,
  RuntimeTurnEvent,
} from '../src/types';
import {
  buildClaudeSessionConfigKey,
  shouldResumeClaudeSession,
} from '../src/ui/chatAgentSelection';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class IntegrationDataAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly removed: string[] = [];
  private readonly processTails = new Map<string, Promise<void>>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path.replace(/\/$/, '')}/`;
    return {
      files: [...this.files.keys()].filter(item => (
        item.startsWith(prefix) && !item.slice(prefix.length).includes('/')
      )),
      folders: [...this.directories].filter(item => (
        item.startsWith(prefix) && !item.slice(prefix.length).includes('/')
      )),
    };
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing ${path}`);
    return value;
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }

  async copy(source: string, target: string): Promise<void> {
    if (this.files.has(target) || this.directories.has(target)) {
      throw new Error(`Copy target exists: ${target}`);
    }
    const value = this.files.get(source);
    if (value === undefined) throw new Error(`Missing ${source}`);
    this.files.set(target, value);
  }

  async process(path: string, update: (raw: string) => string): Promise<string> {
    const previous = this.processTails.get(path) ?? Promise.resolve();
    let result = '';
    const operation = previous.then(() => {
      const current = this.files.get(path);
      if (current === undefined) throw new Error(`Missing ${path}`);
      result = update(current);
      this.files.set(path, result);
    });
    this.processTails.set(path, operation.then(() => undefined, () => undefined));
    await operation;
    return result;
  }

  async remove(path: string): Promise<void> {
    this.removed.push(path);
    throw new Error('Integration tests prohibit deletion.');
  }

  getResourcePath(path: string): string {
    return `app://vault/${path}`;
  }
}

interface RuntimeInvocation {
  prompt: string;
  request: ChatTurnRequest;
  onEvent: (event: RuntimeTurnEvent) => void;
  completion: Deferred<void>;
  aborted: boolean;
}

class HoldRuntime {
  readonly invocations: RuntimeInvocation[] = [];

  readonly runTurn = (
    request: ChatTurnRequest,
    onEvent: (event: RuntimeTurnEvent) => void,
  ): Promise<void> => {
    const invocation: RuntimeInvocation = {
      prompt: request.prompt,
      request,
      onEvent,
      completion: deferred<void>(),
      aborted: request.signal?.aborted ?? false,
    };
    request.signal?.addEventListener('abort', () => {
      invocation.aborted = true;
      invocation.completion.resolve();
    }, { once: true });
    this.invocations.push(invocation);
    return invocation.completion.promise;
  };

  get(prompt: string): RuntimeInvocation {
    const invocation = this.invocations.find(item => item.prompt === prompt);
    if (!invocation) throw new Error(`Runtime prompt did not start: ${prompt}`);
    return invocation;
  }

  emit(prompt: string, event: RuntimeTurnEvent): void {
    this.get(prompt).onEvent(event);
  }

  finish(prompt: string, ...events: RuntimeTurnEvent[]): void {
    const invocation = this.get(prompt);
    for (const event of events) invocation.onEvent(event);
    invocation.completion.resolve();
  }
}

function chatMessage(
  id: string,
  role: ChatMessage['role'],
  content: string,
): ChatMessage {
  return { id, role, content, createdAt: 1, agentId: 'codex' };
}

function submission(conversationId: string, runId: string, sessionId?: string): ChatRunSubmission {
  return {
    runId,
    conversationId,
    runtimeRequest: {
      conversationId,
      agentId: 'codex',
      prompt: runId,
      cwd: '/vault',
      configSource: 'localCli',
      model: 'test-model',
      sessionId,
      fullAccess: true,
    },
    userMessage: chatMessage(`${runId}-user`, 'user', `Prompt ${runId}`),
    assistantMessage: chatMessage(`${runId}-assistant`, 'assistant', ''),
  };
}

function coordinatorDependencies(
  store: VaultStore,
  runtime: HoldRuntime,
): ChatRunCoordinatorDependencies {
  return {
    runTurn: runtime.runTurn,
    loadConversation: async conversationId => (
      (await store.loadConversationWindow(conversationId, 100))?.conversation ?? null
    ),
    persistStart: async input => {
      await store.beginTurn({
        conversationId: input.conversationId,
        agentId: input.runtimeRequest.agentId,
        turnId: input.runId,
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage,
        runtime: {
          configSource: input.runtimeRequest.configSource,
          model: input.runtimeRequest.model,
          reasoningEffort: input.runtimeRequest.reasoningEffort,
          planMode: input.runtimeRequest.planMode === true,
          fullAccess: input.runtimeRequest.fullAccess === true,
        },
        initialState: input.initialState,
        contextCheckpointDraft: input.contextCheckpointDraft,
        expectedRevision: input.expectedRevision,
      });
    },
    persistActivate: async input => {
      await store.activateTurn({
        conversationId: input.conversationId,
        turnId: input.runId,
      });
    },
    persistSession: async input => {
      await store.patchSession({
        conversationId: input.conversationId,
        turnId: input.runId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        configKey: input.sessionConfigKey,
      });
    },
    claimSessionOwnership: async ownership => {
      try {
        await store.claimSessionOwnership({
          conversationId: ownership.conversationId,
          agentId: ownership.agentId,
          sessionId: ownership.sessionId,
          runId: ownership.runId,
          sessionConfigKey: ownership.sessionConfigKey,
        });
        return { status: 'claimed', owner: ownership };
      } catch (error) {
        if (error instanceof ConversationSessionConflictError) {
          return { status: 'duplicate', owner: { ...error.existingOwner } };
        }
        throw error;
      }
    },
    persistCheckpoint: async input => {
      await store.checkpointAssistantMessage({
        conversationId: input.conversationId,
        turnId: input.runId,
        messageId: input.assistantMessage.id,
        patch: {
          role: input.assistantMessage.role,
          content: input.assistantMessage.content,
          metadata: input.assistantMessage.metadata ?? null,
        },
      });
    },
    persistCancellationRequested: async input => {
      await store.requestTurnCancellation({
        conversationId: input.conversationId,
        turnId: input.runId,
      });
    },
    persistFinal: async input => {
      const assistantPatch = {
        role: input.assistantMessage.role,
        content: input.assistantMessage.content,
        metadata: input.assistantMessage.metadata ?? null,
      };
      if (input.status === 'cancelled') {
        await store.cancelTurn({
          conversationId: input.conversationId,
          turnId: input.runId,
          assistantPatch,
        });
      } else {
        await store.finalizeTurn({
          conversationId: input.conversationId,
          turnId: input.runId,
          outcome: input.status === 'failed' ? 'failed' : 'completed',
          assistantPatch,
          error: input.error,
        });
      }
    },
    materializeArtifact: async input => ({
      artifact: {
        id: input.artifact.itemId,
        type: 'image',
        vaultPath: `generated/${input.artifact.itemId}.png`,
        mimeType: input.artifact.mimeType ?? 'image/png',
        createdAt: 1,
      },
      byteLength: 8,
    }),
    loadSessionOwnerships: async () => (await store.listSessionOwnerships()).map(owner => ({
      sessionId: owner.sessionId,
      conversationId: owner.conversationId,
      agentId: owner.agentId,
      runId: owner.runId,
      claimedAt: owner.claimedAt,
    })),
    loadSessionOwner: async sessionId => {
      const owner = await store.loadSessionOwner(sessionId);
      return owner ? {
        sessionId: owner.sessionId,
        conversationId: owner.conversationId,
        agentId: owner.agentId,
        runId: owner.runId,
        claimedAt: owner.claimedAt,
      } : null;
    },
    checkpointScheduler: {
      setTimeout: () => 1,
      clearTimeout: () => {},
    },
  };
}

async function waitForPrompts(runtime: HoldRuntime, prompts: readonly string[]): Promise<void> {
  await vi.waitFor(() => {
    const started = runtime.invocations.map(item => item.prompt);
    for (const prompt of prompts) expect(started).toContain(prompt);
  }, { timeout: 2_000, interval: 1 });
}

describe('chat coordinator with the v2 VaultStore', () => {
  test('atomically admits a Codex handoff checkpoint from completed Claude history', async () => {
    const adapter = new IntegrationDataAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'atomic-handoff-integration',
      requireWriteLease: true,
    });
    expect((await store.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    for (let index = 0; index < 8; index += 1) {
      const turnId = `claude-history-${index}`;
      await store.beginTurn({
        conversationId: 'cross-agent-atomic',
        turnId,
        agentId: 'claude',
        userMessage: {
          ...chatMessage(`${turnId}-user`, 'user', `Claude prompt ${index}`),
          agentId: 'claude',
        },
        assistantMessage: {
          ...chatMessage(`${turnId}-assistant`, 'assistant', ''),
          agentId: 'claude',
        },
        runtime: {
          configSource: 'localCli',
          model: 'claude-test',
          planMode: false,
          fullAccess: false,
        },
      });
      await store.finalizeTurn({
        conversationId: 'cross-agent-atomic',
        turnId,
        assistantPatch: { content: `Claude result ${index}` },
      });
    }
    const before = await store.getConversation('cross-agent-atomic');
    if (!before) throw new Error('Expected completed Claude history.');
    const context = await new ChatContextService({
      store,
      checkpointTurnLimit: 8,
      createCheckpointId: () => 'cross-agent-atomic-checkpoint',
      now: () => 50_000,
    }).prepare({
      conversationId: before.id,
      targetAgentId: 'codex',
      currentPrompt: 'Codex continues from Claude.',
    });
    expect(context.mode).toBe('checkpoint-handoff');
    expect(context.sourceRevision).toBe(before.revision);
    expect(context.contextCheckpointDraft?.sourceRevision).toBe(before.revision);
    expect((await store.getConversation(before.id))?.contextCheckpoint).toBeUndefined();

    const runtime = new HoldRuntime();
    const persistenceFailures: Array<{ stage: string; failureKind: string }> = [];
    const dependencies = coordinatorDependencies(store, runtime);
    dependencies.onPersistenceFailure = failure => persistenceFailures.push(failure);
    const coordinator = new ChatRunCoordinator(dependencies);
    const next = submission(before.id, 'codex-atomic-turn');
    next.contextCheckpointDraft = context.contextCheckpointDraft;
    next.expectedRevision = context.sourceRevision;
    next.runtimeRequest.prompt = context.effectivePrompt;
    const handle = await coordinator.submit(next);
    const admitted = await store.getConversation(before.id);
    expect(admitted?.contextCheckpoint).toMatchObject({
      id: 'cross-agent-atomic-checkpoint',
      sourceRevision: before.revision,
    });
    expect(admitted?.turns.at(-1)).toMatchObject({
      id: 'codex-atomic-turn',
      agentId: 'codex',
      state: 'active',
    });
    await waitForPrompts(runtime, [context.effectivePrompt]);
    runtime.finish(
      context.effectivePrompt,
      { type: 'session', sessionId: 'codex-atomic-session' },
      { type: 'text', content: 'Codex continued safely.' },
      { type: 'done' },
    );
    await expect(handle.completion).resolves.toMatchObject({ status: 'completed', finalPersisted: true });

    expect(persistenceFailures).toEqual([]);
    expect(() => coordinator.assertContextPreparationAllowed(before.id)).not.toThrow();
    const followupContext = await new ChatContextService({ store }).prepare({
      conversationId: before.id,
      targetAgentId: 'codex',
      currentPrompt: 'codex-followup-turn',
      resumeCandidate: 'codex-atomic-session',
      modelContextTokens: 1_000_000,
      modelOutputReserveTokens: 20_000,
      reservedInputTokens: 8_000,
    });
    expect(followupContext.mode).toBe('native-resume');
    expect(followupContext.contextCheckpointDraft).toBeUndefined();
    expect(followupContext.notice).toBe('');
    const followup = submission(before.id, 'codex-followup-turn');
    followup.expectedRevision = followupContext.sourceRevision;
    followup.runtimeRequest.prompt = followupContext.effectivePrompt;
    followup.runtimeRequest.sessionId = followupContext.sessionId;
    const followupHandle = await coordinator.submit(followup);
    await waitForPrompts(runtime, [followup.runtimeRequest.prompt]);
    runtime.finish(
      followup.runtimeRequest.prompt,
      { type: 'text', content: 'The second turn also persisted safely.' },
      { type: 'done' },
    );
    await expect(followupHandle.completion).resolves.toMatchObject({
      status: 'completed',
      finalPersisted: true,
    });
    expect(persistenceFailures).toEqual([]);
    await coordinator.shutdown();
    await store.releaseWriteLease();
  });

  test('rejects a short cross-Agent handoff when canonical history changes after preparation', async () => {
    const adapter = new IntegrationDataAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'revision-bound-handoff-integration',
      requireWriteLease: true,
    });
    expect((await store.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    await store.beginTurn({
      conversationId: 'revision-bound-handoff',
      turnId: 'claude-source-turn',
      agentId: 'claude',
      userMessage: {
        ...chatMessage('claude-source-user', 'user', 'Claude source prompt'),
        agentId: 'claude',
      },
      assistantMessage: {
        ...chatMessage('claude-source-assistant', 'assistant', ''),
        agentId: 'claude',
      },
      runtime: {
        configSource: 'localCli',
        model: 'claude-test',
        planMode: false,
        fullAccess: false,
      },
    });
    await store.finalizeTurn({
      conversationId: 'revision-bound-handoff',
      turnId: 'claude-source-turn',
      assistantPatch: { content: 'Claude source result.' },
    });
    const context = await new ChatContextService({ store }).prepare({
      conversationId: 'revision-bound-handoff',
      targetAgentId: 'codex',
      currentPrompt: 'Codex continues safely.',
    });
    expect(context.mode).toBe('fresh-handoff');
    expect(typeof context.sourceRevision).toBe('number');
    expect(context.contextCheckpointDraft).toBeUndefined();

    await store.appendMessage(
      'revision-bound-handoff',
      chatMessage('intervening-durable-message', 'assistant', 'Another durable writer changed history.'),
    );
    const runtime = new HoldRuntime();
    const coordinator = new ChatRunCoordinator(coordinatorDependencies(store, runtime));
    const next = submission('revision-bound-handoff', 'stale-short-handoff');
    next.runtimeRequest.prompt = context.effectivePrompt;
    next.expectedRevision = context.sourceRevision;

    await expect(coordinator.submit(next)).rejects.toThrow('revision');
    expect(runtime.invocations).toHaveLength(0);
    expect(() => coordinator.assertContextPreparationAllowed('revision-bound-handoff')).not.toThrow();
    const after = await store.getConversation('revision-bound-handoff');
    expect(after?.turns.some(turn => turn.id === 'stale-short-handoff')).toBe(false);
    expect(after?.messages.some(message => message.id === 'stale-short-handoff-user')).toBe(false);
    await coordinator.shutdown();
    await store.releaseWriteLease();
  });

  test('switches a model session and then continues consecutive turns without repeated checkpoints', async () => {
    const adapter = new IntegrationDataAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'model-switch-continuity-integration',
      requireWriteLease: true,
    });
    expect((await store.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    const runtime = new HoldRuntime();
    const persistenceFailures: Array<{ stage: string; failureKind: string }> = [];
    const dependencies = coordinatorDependencies(store, runtime);
    dependencies.onPersistenceFailure = failure => persistenceFailures.push(failure);
    const coordinator = new ChatRunCoordinator(dependencies);

    const modelAConfigKey = buildClaudeSessionConfigKey({
      configSource: 'localCli',
      effectiveModel: 'model-a',
    });
    const first = submission('model-switch-continuity', 'model-a-turn');
    first.runtimeRequest.agentId = 'claude';
    first.runtimeRequest.model = 'model-a';
    first.userMessage.agentId = 'claude';
    first.assistantMessage.agentId = 'claude';
    first.sessionConfigKey = modelAConfigKey;
    const firstHandle = await coordinator.submit(first);
    await waitForPrompts(runtime, ['model-a-turn']);
    runtime.finish(
      'model-a-turn',
      { type: 'session', sessionId: 'model-a-session' },
      { type: 'text', content: 'First model completed.' },
      { type: 'done' },
    );
    await expect(firstHandle.completion).resolves.toMatchObject({
      status: 'completed',
      finalPersisted: true,
    });

    const afterFirst = await store.getConversation('model-switch-continuity');
    expect(afterFirst?.sessionIds?.claude).toBe('model-a-session');
    expect(afterFirst?.sessionConfigKeys?.claude).toBe(modelAConfigKey);
    const modelBConfigKey = buildClaudeSessionConfigKey({
      configSource: 'localCli',
      effectiveModel: 'model-b',
    });
    const storedModelASession = afterFirst?.sessionIds?.claude;
    const switchedResumeCandidate = shouldResumeClaudeSession(
      storedModelASession,
      afterFirst?.sessionConfigKeys?.claude,
      modelBConfigKey,
    ) ? storedModelASession : undefined;
    expect(switchedResumeCandidate).toBeUndefined();

    const contextService = new ChatContextService({ store });
    const switched = await contextService.prepare({
      conversationId: 'model-switch-continuity',
      targetAgentId: 'claude',
      currentPrompt: 'model-b-turn',
      resumeCandidate: switchedResumeCandidate,
      modelContextTokens: 1_000_000,
      modelOutputReserveTokens: 128_000,
      reservedInputTokens: 8_000,
    });
    expect(switched.mode).toBe('fresh-handoff');
    expect(switched.contextCheckpointDraft).toBeUndefined();
    expect(switched.notice).toBe('');

    const second = submission('model-switch-continuity', 'model-b-turn');
    second.runtimeRequest.agentId = 'claude';
    second.runtimeRequest.model = 'model-b';
    second.runtimeRequest.prompt = switched.effectivePrompt;
    second.userMessage.agentId = 'claude';
    second.assistantMessage.agentId = 'claude';
    second.sessionConfigKey = modelBConfigKey;
    second.expectedRevision = switched.sourceRevision;
    const secondHandle = await coordinator.submit(second);
    await waitForPrompts(runtime, [switched.effectivePrompt]);
    runtime.finish(
      switched.effectivePrompt,
      { type: 'session', sessionId: 'model-b-session' },
      { type: 'text', content: 'Second model completed.' },
      { type: 'done' },
    );
    await expect(secondHandle.completion).resolves.toMatchObject({
      status: 'completed',
      finalPersisted: true,
    });

    const afterSecond = await store.getConversation('model-switch-continuity');
    const storedModelBSession = afterSecond?.sessionIds?.claude;
    const consecutiveResumeCandidate = shouldResumeClaudeSession(
      storedModelBSession,
      afterSecond?.sessionConfigKeys?.claude,
      modelBConfigKey,
    ) ? storedModelBSession : undefined;
    expect(consecutiveResumeCandidate).toBe('model-b-session');
    const consecutive = await contextService.prepare({
      conversationId: 'model-switch-continuity',
      targetAgentId: 'claude',
      currentPrompt: 'model-b-followup',
      resumeCandidate: consecutiveResumeCandidate,
      modelContextTokens: 1_000_000,
      modelOutputReserveTokens: 128_000,
      reservedInputTokens: 8_000,
    });
    expect(consecutive.mode).toBe('native-resume');
    expect(consecutive.sessionId).toBe('model-b-session');
    expect(consecutive.contextCheckpointDraft).toBeUndefined();

    const third = submission('model-switch-continuity', 'model-b-followup');
    third.runtimeRequest.agentId = 'claude';
    third.runtimeRequest.model = 'model-b';
    third.runtimeRequest.prompt = consecutive.effectivePrompt;
    third.runtimeRequest.sessionId = consecutive.sessionId;
    third.userMessage.agentId = 'claude';
    third.assistantMessage.agentId = 'claude';
    third.sessionConfigKey = modelBConfigKey;
    third.expectedRevision = consecutive.sourceRevision;
    const thirdHandle = await coordinator.submit(third);
    await waitForPrompts(runtime, ['model-b-followup']);
    runtime.finish(
      'model-b-followup',
      { type: 'text', content: 'Consecutive turn completed.' },
      { type: 'done' },
    );
    await expect(thirdHandle.completion).resolves.toMatchObject({
      status: 'completed',
      finalPersisted: true,
    });

    const stored = await store.getConversation('model-switch-continuity');
    expect(stored?.turns.map(turn => turn.state)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(stored?.contextCheckpoint).toBeUndefined();
    expect(stored?.sessionConfigKeys?.claude).toBe(modelBConfigKey);
    expect(persistenceFailures).toEqual([]);
    await coordinator.shutdown();
    await store.releaseWriteLease();
  });

  test('blocks a no-progress overflow before runtime start or durable turn creation', async () => {
    const adapter = new IntegrationDataAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'context-overflow-preflight-integration',
      requireWriteLease: true,
    });
    expect((await store.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    const runtime = new HoldRuntime();
    const coordinator = new ChatRunCoordinator(coordinatorDependencies(store, runtime));

    const seed = submission('context-overflow-preflight', 'seed-turn');
    const seedHandle = await coordinator.submit(seed);
    await waitForPrompts(runtime, ['seed-turn']);
    runtime.finish(
      'seed-turn',
      { type: 'session', sessionId: 'overflow-preflight-session' },
      { type: 'text', content: 'Seed completed.' },
      { type: 'done' },
    );
    await expect(seedHandle.completion).resolves.toMatchObject({
      status: 'completed',
      finalPersisted: true,
    });
    const before = await store.getConversation('context-overflow-preflight');

    const prepareThenSubmit = async () => {
      const prepared = await new ChatContextService({ store }).prepare({
        conversationId: 'context-overflow-preflight',
        targetAgentId: 'claude',
        currentPrompt: 'a'.repeat(800_000),
        resumeCandidate: 'overflow-preflight-session',
        modelContextTokens: 1_000_000,
        modelOutputReserveTokens: 128_000,
        maxRequestBytes: 1024 * 1024,
      });
      const next = submission('context-overflow-preflight', 'must-not-start');
      next.expectedRevision = prepared.sourceRevision;
      next.runtimeRequest.prompt = prepared.effectivePrompt;
      next.runtimeRequest.sessionId = prepared.sessionId;
      return coordinator.submit(next);
    };

    await expect(prepareThenSubmit()).rejects.toBeInstanceOf(ChatContextOverflowError);
    expect(runtime.invocations.map(invocation => invocation.prompt)).toEqual(['seed-turn']);
    const after = await store.getConversation('context-overflow-preflight');
    expect(after?.revision).toBe(before?.revision);
    expect(after?.turns).toHaveLength(1);
    expect(after?.turns[0]?.state).toBe('completed');
    expect(after?.contextCheckpoint).toBeUndefined();

    await coordinator.shutdown();
    await store.releaseWriteLease();
  });

  test('runs concurrent lanes, preserves FIFO/targeted stop/checkpoints, and recovers without replay', async () => {
    const adapter = new IntegrationDataAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'integration',
      requireWriteLease: true,
    });
    expect((await store.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    const runtime = new HoldRuntime();
    const coordinator = new ChatRunCoordinator(coordinatorDependencies(store, runtime));
    await coordinator.recover();

    const parallel = await Promise.all(Array.from({ length: 6 }, (_, index) => (
      coordinator.submit(submission(`parallel-${index}`, `parallel-run-${index}`))
    )));
    await waitForPrompts(runtime, parallel.map(handle => handle.runId));
    expect(runtime.invocations).toHaveLength(6);

    const fifoFirst = await coordinator.submit(submission('fifo', 'fifo-first'));
    const fifoSecond = await coordinator.submit(submission('fifo', 'fifo-second'));
    await waitForPrompts(runtime, ['fifo-first']);
    expect(runtime.invocations.map(item => item.prompt)).not.toContain('fifo-second');
    runtime.finish('fifo-first', { type: 'text', content: 'first done' }, { type: 'done' });
    await fifoFirst.completion;
    await waitForPrompts(runtime, ['fifo-second']);

    runtime.emit('parallel-run-1', { type: 'text', content: 'durable partial' });
    await coordinator.flushCheckpoints('parallel-1');
    expect((await store.loadConversationWindow('parallel-1', 100))?.conversation.messages.at(-1)?.content)
      .toBe('durable partial');

    runtime.emit('parallel-run-2', { type: 'session', sessionId: 'owned-session' });
    await vi.waitFor(() => expect(coordinator.getSessionOwner('owned-session')).not.toBeNull());

    const stopped = coordinator.stopConversation('parallel-0');
    expect(stopped.cancelledRunIds).toEqual(['parallel-run-0']);
    await stopped.completions;
    expect(runtime.get('parallel-run-0').aborted).toBe(true);
    expect(runtime.get('parallel-run-1').aborted).toBe(false);

    for (const index of [1, 2, 3, 4, 5]) {
      runtime.finish(`parallel-run-${index}`, { type: 'done' });
    }
    runtime.finish('fifo-second', { type: 'text', content: 'second done' }, { type: 'done' });
    const completedRuns = await Promise.all([
      ...parallel.map(handle => handle.completion),
      fifoSecond.completion,
    ]);
    expect(completedRuns.map(result => ({
      runId: result.runId,
      persistenceError: result.persistenceError,
      finalPersisted: result.finalPersisted,
    }))).toEqual(completedRuns.map(result => ({
      runId: result.runId,
      persistenceError: null,
      finalPersisted: true,
    })));

    const invocationCount = runtime.invocations.length;
    const duplicate = await coordinator.submit(
      submission('parallel-3', 'must-not-resume', 'owned-session'),
    );
    const duplicateResult = await duplicate.completion;
    expect(duplicateResult).toMatchObject({
      status: 'failed',
      sessionId: null,
      persistenceError: null,
      finalPersisted: true,
    });
    expect(runtime.invocations).toHaveLength(invocationCount);

    const summaries = await store.listConversationSummaries(null, 50, 'active');
    expect(summaries.items.map(item => item.id)).toEqual(expect.arrayContaining([
      'parallel-0',
      'parallel-1',
      'parallel-2',
      'parallel-3',
      'parallel-4',
      'parallel-5',
      'fifo',
    ]));

    for (let index = 0; index < 120; index += 1) {
      await store.appendMessage('long-history', chatMessage(
        `history-${index}`,
        index % 2 === 0 ? 'user' : 'assistant',
        `message ${index}`,
      ));
    }
    const window = await store.loadConversationWindow('long-history', 100);
    expect(window?.conversation.messages).toHaveLength(100);
    expect(window?.nextBeforeSequence).not.toBeNull();
    const earlier = await store.loadMessages('long-history', window?.nextBeforeSequence ?? null, 100);
    expect(earlier.messages).toHaveLength(20);
    expect(earlier.nextBeforeSequence).toBeNull();

    const longHistoryRun = await coordinator.submit(submission('long-history', 'long-history-run'));
    await waitForPrompts(runtime, ['long-history-run']);
    const liveLongHistory = await coordinator.snapshotConversation('long-history');
    expect(liveLongHistory.messages).toHaveLength(102);
    expect(liveLongHistory.messages.slice(0, 100).map(message => message.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `history-${index + 20}`),
    );
    expect(liveLongHistory.messages.slice(-2).map(message => message.id)).toEqual([
      'long-history-run-user',
      'long-history-run-assistant',
    ]);
    runtime.finish('long-history-run', { type: 'done' });
    await longHistoryRun.completion;

    await store.beginTurn({
      conversationId: 'restart-active',
      turnId: 'restart-active-turn',
      agentId: 'codex',
      userMessage: chatMessage('restart-active-user', 'user', 'active'),
      assistantMessage: chatMessage('restart-active-assistant', 'assistant', 'partial'),
      runtime: {
        configSource: 'localCli',
        model: 'test-model',
        planMode: false,
        fullAccess: true,
      },
      initialState: 'active',
    });
    await store.beginTurn({
      conversationId: 'restart-queued',
      turnId: 'restart-queued-turn',
      agentId: 'codex',
      userMessage: chatMessage('restart-queued-user', 'user', 'queued'),
      assistantMessage: chatMessage('restart-queued-assistant', 'assistant', ''),
      runtime: {
        configSource: 'localCli',
        model: 'test-model',
        planMode: false,
        fullAccess: true,
      },
      initialState: 'queued',
    });
    await coordinator.shutdown();
    await store.releaseWriteLease();

    // A restart must rebuild both objects from disk. Reusing either one can
    // accidentally hide recovery/session bugs behind warm in-memory state.
    const restartedStore = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'integration-restarted',
      requireWriteLease: true,
    });
    expect((await restartedStore.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await restartedStore.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    const recovered = await restartedStore.recoverInterruptedTurns();
    expect(recovered.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: 'restart-active-turn', to: 'interrupted' }),
      expect.objectContaining({ turnId: 'restart-queued-turn', to: 'paused' }),
    ]));
    const restartedRuntime = new HoldRuntime();
    const restartedCoordinator = new ChatRunCoordinator(
      coordinatorDependencies(restartedStore, restartedRuntime),
    );
    await restartedCoordinator.recover();
    expect(restartedRuntime.invocations).toHaveLength(0);
    expect(restartedCoordinator.getSessionOwner('owned-session')).toBeNull();
    expect(await restartedStore.loadSessionOwner('owned-session')).toMatchObject({
      conversationId: 'parallel-2',
    });
    expect((await restartedStore.getConversation('restart-active'))?.turns[0]?.state)
      .toBe('interrupted');
    expect((await restartedStore.getConversation('restart-queued'))?.turns[0]?.state)
      .toBe('paused');
    expect(adapter.removed).toEqual([]);
    await restartedCoordinator.shutdown();
    await restartedStore.releaseWriteLease();
  });
});
