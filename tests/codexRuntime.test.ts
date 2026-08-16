import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

import { CodexJsonRpcError, type CodexAppServerClient } from '../src/runtime/codexAppServer';
import {
  CodexAppServerRuntime,
  CODEX_MAX_RUNTIME_EVENT_BYTES,
  CODEX_MAX_TURN_OUTPUT_BYTES,
  orderedSupportedCodexReasoningEfforts,
  reconcileCodexReasoningEffort,
} from '../src/runtime/codexRuntime';
import type { ChatTurnRequest, RuntimeTurnEvent } from '../src/types';
import { freezeVerifiedImageAttachment } from '../src/runtime/frozenAttachments';

class FakeAppServerClient extends EventEmitter {
  isReady = false;
  connectedExecutablePath: string | null = null;
  requests: Array<{ method: string; params: unknown }> = [];
  responses: Array<{ id: number | string; result: unknown }> = [];
  connectPaths: string[] = [];
  disconnectCount = 0;
  imageGeneration = true;
  emitWarning = false;
  emitInterruptCompletion = true;
  interruptError: Error | null = null;
  canonicalThreadId: string | null = null;
  modelListGate: Promise<void> | null = null;
  markModelListEntered: (() => void) | null = null;
  threadStartGate: Promise<void> | null = null;
  threadResumeError: Error | null = null;
  disconnectGate: Promise<void> | null = null;
  disconnectError: Error | null = null;
  private threadNumber = 0;

  async connect(options: { executablePath: string }): Promise<void> {
    this.connectPaths.push(options.executablePath);
    this.isReady = true;
    this.connectedExecutablePath = options.executablePath;
  }

  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    if (this.disconnectGate) await this.disconnectGate;
    if (this.disconnectError) throw this.disconnectError;
    this.isReady = false;
    this.connectedExecutablePath = null;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    const value = params as Record<string, unknown>;
    if (method === 'model/list') {
      this.markModelListEntered?.();
      if (this.modelListGate) await this.modelListGate;
      if (value.cursor === 'page-2') {
        return {
          data: [{
            id: 'model-b',
            model: 'model-b',
            displayName: 'Model B',
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast' },
              { reasoningEffort: 'medium', description: 'Balanced' },
            ],
          }],
          nextCursor: null,
        };
      }
      return {
        data: [{
          id: 'model-a',
          model: 'model-a',
          displayName: 'Model A',
          isDefault: false,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'high', description: 'Deep' },
            { reasoningEffort: 'ultra', description: 'Automatic delegation' },
          ],
        }],
        nextCursor: 'page-2',
      };
    }
    if (method === 'config/read') return {
      config: {
        model: 'model-a',
        model_context_window: 353_400,
        model_auto_compact_token_limit: 334_800,
      },
    };
    if (method === 'account/read') return { account: { type: 'chatgpt' }, authMode: 'chatgpt' };
    if (method === 'modelProvider/capabilities/read') return { imageGeneration: this.imageGeneration, webSearch: false };
    if (method === 'thread/start') {
      this.threadNumber += 1;
      if (this.threadStartGate) await this.threadStartGate;
      return {
        thread: {
          id: this.canonicalThreadId ?? `thread-${this.threadNumber}`,
          model: 'model-a',
          reasoningEffort: 'high',
        },
      };
    }
    if (method === 'thread/resume') {
      if (this.threadResumeError) throw this.threadResumeError;
      return { thread: { id: value.threadId, model: 'model-a', reasoningEffort: 'high' } };
    }
    if (method === 'turn/start') {
      const threadId = String(value.threadId);
      const turnId = `turn-${threadId}`;
      const input = value.input as Array<Record<string, string>>;
      const prompt = input.find(item => item.type === 'text')?.text ?? '';
      if (this.emitWarning) {
        process.nextTick(() => this.emit('notification', 'warning', {
          threadId,
          message: 'Model metadata fallback warning',
        }));
      }
      if (!prompt.startsWith('HOLD')) {
        process.nextTick(() => this.emitCompletedTurn(threadId, turnId, prompt));
      }
      return { turn: { id: turnId, status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') {
      if (this.interruptError) throw this.interruptError;
      if (this.emitInterruptCompletion) {
        process.nextTick(() => {
          this.emit('notification', 'turn/completed', {
            threadId: value.threadId,
            turn: { id: value.turnId, status: 'interrupted' },
          });
        }, 0);
      }
      return {};
    }
    return {};
  }

  respond(id: number | string, result: unknown): void {
    this.responses.push({ id, result });
  }
  reject(): void {}

  completeHeldTurn(threadId: string, prompt = 'released'): void {
    this.emitCompletedTurn(threadId, `turn-${threadId}`, prompt);
  }

  simulateUnexpectedClose(reason = 'unexpected test close'): void {
    this.isReady = false;
    this.connectedExecutablePath = null;
    this.emit('close', reason);
  }

  private emitCompletedTurn(threadId: string, turnId: string, prompt: string): void {
    const messageId = `message-${threadId}`;
    const reply = `reply:${prompt}`;
    this.emit('notification', 'item/agentMessage/delta', { threadId, turnId, itemId: messageId, delta: reply });
    this.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: messageId, text: reply },
    });
    this.emit('notification', 'item/started', {
      threadId,
      turnId,
      item: { type: 'commandExecution', id: `command-${threadId}`, command: 'pwd', status: 'inProgress' },
    });
    this.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: { type: 'commandExecution', id: `command-${threadId}`, command: 'pwd', status: 'completed', aggregatedOutput: '/vault' },
    });
    this.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: {
        type: 'imageGeneration',
        id: `image-${threadId}`,
        status: 'completed',
        savedPath: `/tmp/${threadId}.png`,
        revisedPrompt: `revised:${prompt}`,
      },
    });
    this.emit('notification', 'turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed' },
    });
  }
}

const connection = {
  binaryPath: '/fake/codex',
  binarySource: 'desktopApp' as const,
  version: 'codex-cli 1.0.0',
  env: {},
};

function request(prompt: string): ChatTurnRequest {
  return {
    conversationId: prompt,
    agentId: 'codex',
    prompt,
    cwd: '/vault',
    configSource: 'localCli',
    attachments: [],
  };
}

interface CanonicalSessionAdmissionRequest {
  admitCanonicalSession: (sessionId: string) => Promise<void>;
}

describe('CodexAppServerRuntime', () => {
  const temporaryDirectories: string[] = [];
  let previousAiluHome: string | undefined;

  beforeEach(() => {
    previousAiluHome = process.env.AILU_HOME;
  });

  afterEach(() => {
    if (previousAiluHome === undefined) delete process.env.AILU_HOME;
    else process.env.AILU_HOME = previousAiluHome;
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('keeps all six advertised reasoning levels in the studio order', () => {
    const supportedReasoningEfforts = [
      'ultra',
      'medium',
      'xhigh',
      'low',
      'max',
      'high',
    ].map(reasoningEffort => ({ reasoningEffort, description: '' }));
    expect(orderedSupportedCodexReasoningEfforts({
      id: 'gpt-5.6-sol',
      model: 'gpt-5.6-sol',
      displayName: 'GPT-5.6-Sol',
      description: 'Six-level model',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'max',
      supportedReasoningEfforts,
      inputModalities: ['text', 'image'],
    })).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  test('reads paginated models and gives config/read precedence over the default model', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);

    const status = await runtime.refreshStatus(connection);

    expect(status.state).toBe('ready');
    expect(status.currentModelId).toBe('model-a');
    expect(status.contextWindowTokens).toBe(353_400);
    expect(status.autoCompactTokenLimit).toBe(334_800);
    expect(status.currentModel?.displayName).toBe('Model A');
    expect(status.models.map(model => model.id)).toEqual(['model-a', 'model-b']);
    expect(status.currentModel?.supportedReasoningEfforts).toEqual([
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'high', description: 'Deep' },
      { reasoningEffort: 'ultra', description: 'Automatic delegation' },
    ]);
    expect(status.authenticated).toBe(true);
    expect(status.imageGeneration).toBe(true);
    expect(status.webSearch).toBe(false);
    await runtime.shutdown();
  });

  test('memoizes concurrent shutdown and never reconnects after closing', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    await runtime.refreshStatus(connection);

    await Promise.all([runtime.shutdown(), runtime.shutdown(), runtime.shutdown()]);
    expect(client.disconnectCount).toBe(1);

    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(request('AFTER_MEMOIZED_SHUTDOWN'), connection, event => events.push(event));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_runtime_closed',
    }));
    expect(client.connectPaths).toEqual([connection.binaryPath]);
  });

  test('isolates concurrent threads, deduplicates completed text, and emits tools and image artifacts', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const first: RuntimeTurnEvent[] = [];
    const second: RuntimeTurnEvent[] = [];
    const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-codex-attachment-')));
    temporaryDirectories.push(fixtureRoot);
    const vaultRoot = path.join(fixtureRoot, 'vault');
    const ailuHome = path.join(fixtureRoot, 'home');
    fs.mkdirSync(vaultRoot);
    process.env.AILU_HOME = ailuHome;
    const attachment = freezeVerifiedImageAttachment({
      vaultPath: 'image.png',
      vaultRoot,
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
      mimeType: 'image/png',
    });

    await Promise.all([
      runtime.runTurn({ ...request('FIRST'), cwd: vaultRoot, attachments: [attachment] }, connection, event => first.push(event)),
      runtime.runTurn({ ...request('SECOND'), cwd: vaultRoot, attachments: [attachment] }, connection, event => second.push(event)),
    ]);

    expect(first.filter(event => event.type === 'text')).toEqual([{ type: 'text', content: 'reply:FIRST' }]);
    expect(second.filter(event => event.type === 'text')).toEqual([{ type: 'text', content: 'reply:SECOND' }]);
    expect(first.filter(event => event.type === 'tool')).toHaveLength(3);
    const firstSession = first.find((event): event is Extract<RuntimeTurnEvent, { type: 'session' }> => event.type === 'session');
    const firstThreadId = firstSession?.sessionId ?? '';
    expect(first.find(event => event.type === 'artifact')).toMatchObject({
      type: 'artifact',
      artifact: {
        itemId: `image-${firstThreadId}`,
        kind: 'image',
        sourcePath: `/tmp/${firstThreadId}.png`,
        revisedPrompt: 'revised:FIRST',
      },
    });
    const threadStart = client.requests.find(entry => entry.method === 'thread/start');
    const turnStart = client.requests.find(entry => {
      if (entry.method !== 'turn/start') return false;
      const params = entry.params as { input?: Array<{ type: string; text?: string }> };
      return params.input?.some(item => item.type === 'text' && item.text === 'FIRST');
    });
    expect(threadStart?.params).not.toHaveProperty('model');
    expect(threadStart?.params).toMatchObject({ approvalPolicy: 'never', sandbox: 'workspace-write' });
    expect(turnStart?.params).not.toHaveProperty('model');
    expect(turnStart?.params).toMatchObject({
      input: [
        { type: 'text', text: 'FIRST' },
        { type: 'localImage', path: attachment.absolutePath },
      ],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [vaultRoot], networkAccess: false },
    });
    await runtime.shutdown();
  });

  test.each([
    {
      name: 'exact',
      delta: 'Hello',
      snapshot: 'Hello',
      expectedText: 'Hello',
      expectedDiagnostics: 0,
      expectedErrors: 0,
    },
    {
      name: 'extended',
      delta: 'Hello',
      snapshot: 'Hello world',
      expectedText: 'Hello world',
      expectedDiagnostics: 0,
      expectedErrors: 0,
    },
    {
      name: 'divergent',
      delta: 'Hello',
      snapshot: 'Hallo world',
      expectedText: 'Hello',
      expectedDiagnostics: 0,
      expectedErrors: 1,
    },
    {
      name: 'whitespace-normalized',
      delta: 'imagegen Skill生成；读取 Skill说明',
      snapshot: 'imagegen Skill 生成；读取 Skill 说明',
      expectedText: 'imagegen Skill生成；读取 Skill说明',
      expectedDiagnostics: 1,
      expectedErrors: 0,
    },
  ])('reconciles $name streamed text against the completed snapshot', async scenario => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const threadId = `snapshot-${scenario.name}`;
    const turnId = `turn-${threadId}`;
    const itemId = `message-${threadId}`;
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: threadId,
    }, connection, event => events.push(event));
    await waitForRequestCount(client, 'turn/start', 1);

    client.emit('notification', 'item/agentMessage/delta', {
      threadId,
      turnId,
      itemId,
      delta: scenario.delta,
    });
    const completed = {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: itemId, text: scenario.snapshot },
    };
    client.emit('notification', 'item/completed', completed);
    client.emit('notification', 'item/completed', completed);
    client.emit('notification', 'turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed' },
    });
    await run;

    expect(events.flatMap(event => event.type === 'text' ? [event.content] : []).join('')).toBe(
      scenario.expectedText,
    );
    expect(events.filter(event => (
      event.type === 'diagnostic' && event.code === 'codex_stream_snapshot_diverged'
    ))).toHaveLength(scenario.expectedDiagnostics);
    expect(events.filter(event => event.type === 'error')).toHaveLength(scenario.expectedErrors);
    await runtime.shutdown();
  });

  test('continues to deliver an image artifact after a divergent text snapshot', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const threadId = 'snapshot-before-image';
    const turnId = `turn-${threadId}`;
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: threadId,
    }, connection, event => events.push(event));
    await waitForRequestCount(client, 'turn/start', 1);

    client.emit('notification', 'item/agentMessage/delta', {
      threadId,
      turnId,
      itemId: 'intro',
      delta: 'Skill生成',
    });
    client.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: 'intro', text: 'Skill 生成' },
    });
    client.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: {
        type: 'imageGeneration',
        id: 'generated-image',
        savedPath: '/tmp/generated-image.png',
      },
    });
    client.emit('notification', 'turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed' },
    });
    await run;

    expect(events).toContainEqual(expect.objectContaining({
      type: 'diagnostic',
      code: 'codex_stream_snapshot_diverged',
    }));
    const artifact = events.find(
      (event): event is Extract<RuntimeTurnEvent, { type: 'artifact' }> => event.type === 'artifact',
    );
    expect(artifact?.artifact.itemId).toBe('generated-image');
    expect(events.some(event => event.type === 'error')).toBe(false);
    await runtime.shutdown();
  });

  test('defers a material snapshot error until after a following image artifact', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const threadId = 'material-snapshot-before-image';
    const turnId = `turn-${threadId}`;
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: threadId,
    }, connection, event => events.push(event));
    await waitForRequestCount(client, 'turn/start', 1);

    client.emit('notification', 'item/agentMessage/delta', {
      threadId,
      turnId,
      itemId: 'intro',
      delta: '原始内容',
    });
    client.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: 'intro', text: '不同内容' },
    });
    client.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: {
        type: 'imageGeneration',
        id: 'generated-image',
        savedPath: '/tmp/generated-image.png',
      },
    });
    client.emit('notification', 'turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed' },
    });
    await run;

    const artifactIndex = events.findIndex(event => event.type === 'artifact');
    const errorIndex = events.findIndex(event => (
      event.type === 'error' && event.diagnostic === 'codex_stream_snapshot_diverged'
    ));
    expect(artifactIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThan(artifactIndex);
    expect(client.requests.some(entry => entry.method === 'turn/interrupt')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: threadId });
    await runtime.shutdown();
  });

  test('keeps a turn alive when App Server reports a retryable stream error', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const threadId = 'retryable-stream-thread';
    const turnId = `turn-${threadId}`;
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: threadId,
    }, connection, event => events.push(event));
    await waitForRequestCount(client, 'turn/start', 1);

    client.emit('notification', 'error', {
      threadId,
      turnId,
      willRetry: true,
      error: {
        message: 'Reconnecting... 2/5',
        additionalDetails: 'stream disconnected before completion',
      },
    });
    await delay(0);

    expect(events).toContainEqual({
      type: 'diagnostic',
      code: 'codex_stream_retrying',
      message: 'Reconnecting... 2/5',
      detail: 'stream disconnected before completion',
    });
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(client.requests.some(entry => entry.method === 'turn/interrupt')).toBe(false);

    client.emit('notification', 'item/agentMessage/delta', {
      threadId,
      turnId,
      itemId: 'retry-result',
      delta: '重连后继续完成。',
    });
    client.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: 'retry-result', text: '重连后继续完成。' },
    });
    client.emit('notification', 'turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed' },
    });
    await run;

    expect(events).toContainEqual({ type: 'text', content: '重连后继续完成。' });
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: threadId });
    expect(client.requests.some(entry => entry.method === 'turn/interrupt')).toBe(false);
    await runtime.shutdown();
  });

  test('keeps a non-retryable App Server error terminal', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const threadId = 'terminal-stream-thread';
    const turnId = `turn-${threadId}`;
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: threadId,
    }, connection, event => events.push(event));
    await waitForRequestCount(client, 'turn/start', 1);

    client.emit('notification', 'error', {
      threadId,
      turnId,
      willRetry: false,
      error: {
        message: 'Codex stream failed.',
        additionalDetails: 'retry budget exhausted',
        codexErrorInfo: { httpStatusCode: 503 },
      },
    });
    client.emit('notification', 'turn/completed', {
      threadId,
      turn: { id: turnId, status: 'failed' },
    });
    await run;

    expect(events.filter(event => event.type === 'error')).toEqual([{
      type: 'error',
      message: 'Codex stream failed.',
      detail: 'retry budget exhausted',
      statusCode: 503,
    }]);
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: threadId });
    await runtime.shutdown();
  });

  test('emits one terminal error when a retryable stream ultimately fails', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const threadId = 'retry-exhausted-stream-thread';
    const turnId = `turn-${threadId}`;
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: threadId,
    }, connection, event => events.push(event));
    await waitForRequestCount(client, 'turn/start', 1);

    client.emit('notification', 'error', {
      threadId,
      turnId,
      willRetry: true,
      error: { message: 'Reconnecting...' },
    });
    client.emit('notification', 'turn/completed', {
      threadId,
      turn: {
        id: turnId,
        status: 'failed',
        error: {
          message: 'Codex stream failed after retry.',
          additionalDetails: 'retry budget exhausted',
        },
      },
    });
    await run;

    expect(events.filter(event => event.type === 'diagnostic')).toEqual([
      expect.objectContaining({ code: 'codex_stream_retrying' }),
    ]);
    expect(events.filter(event => event.type === 'error')).toEqual([{
      type: 'error',
      message: 'Codex stream failed after retry.',
      detail: 'retry budget exhausted',
    }]);
    expect(client.requests.some(entry => entry.method === 'turn/interrupt')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: threadId });
    await runtime.shutdown();
  });

  test('emits a repeated terminal error notification only once', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const threadId = 'duplicate-terminal-error-thread';
    const turnId = `turn-${threadId}`;
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: threadId,
    }, connection, event => events.push(event));
    await waitForRequestCount(client, 'turn/start', 1);

    const notification = {
      threadId,
      turnId,
      willRetry: false,
      error: { message: 'Terminal once.' },
    };
    client.emit('notification', 'error', notification);
    client.emit('notification', 'error', notification);
    client.emit('notification', 'turn/completed', {
      threadId,
      turn: { id: turnId, status: 'failed' },
    });
    await run;

    expect(events.filter(event => event.type === 'error')).toEqual([{
      type: 'error',
      message: 'Terminal once.',
      detail: undefined,
      statusCode: undefined,
    }]);
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: threadId });
    await runtime.shutdown();
  });

  test('cancels one concurrent conversation without interrupting the other', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const controller = new AbortController();
    const first: RuntimeTurnEvent[] = [];
    const second: RuntimeTurnEvent[] = [];
    let secondSettled = false;

    const firstRun = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'thread-a',
      signal: controller.signal,
    }, connection, event => first.push(event));
    const secondRun = runtime.runTurn({
      ...request('HOLD_SECOND'),
      sessionId: 'thread-b',
    }, connection, event => second.push(event)).then(() => {
      secondSettled = true;
    });

    await delay(10);
    controller.abort();
    await firstRun;

    expect(first.filter(event => event.type === 'text')).toEqual([]);
    expect(first.at(-1)).toEqual({ type: 'done', sessionId: 'thread-a' });
    expect(secondSettled).toBe(false);
    const interrupts = client.requests.filter(entry => entry.method === 'turn/interrupt');
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]?.params).toMatchObject({ threadId: 'thread-a' });

    client.completeHeldTurn('thread-b', 'SECOND');
    await secondRun;
    expect(second).toContainEqual({ type: 'text', content: 'reply:SECOND' });
    expect(second.at(-1)).toEqual({ type: 'done', sessionId: 'thread-b' });
    await runtime.shutdown();
  });

  test('rejects a second active turn on the same Codex thread without overwriting the first', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const controller = new AbortController();
    const first: RuntimeTurnEvent[] = [];
    const second: RuntimeTurnEvent[] = [];

    const firstRun = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'shared-thread',
      signal: controller.signal,
    }, connection, event => first.push(event));
    await delay(10);
    await runtime.runTurn({
      ...request('SECOND'),
      sessionId: 'shared-thread',
    }, connection, event => second.push(event));

    expect(second).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_thread_already_active',
    }));
    expect(second.at(-1)).toEqual({ type: 'done', sessionId: 'shared-thread' });
    expect(client.requests.filter(entry => entry.method === 'turn/start')).toHaveLength(1);

    controller.abort();
    await firstRun;
    expect(first.at(-1)).toEqual({ type: 'done', sessionId: 'shared-thread' });
    await runtime.shutdown();
  });

  test('does not start a turn when the session callback synchronously aborts ownership', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const controller = new AbortController();
    const events: RuntimeTurnEvent[] = [];

    await runtime.runTurn({
      ...request('MUST_NOT_START_TURN'),
      signal: controller.signal,
    }, connection, event => {
      events.push(event);
      if (event.type === 'session') controller.abort();
    });

    expect(events.some(event => event.type === 'session')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'thread-1' });
    expect(client.requests.filter(entry => entry.method === 'turn/start')).toHaveLength(0);
    expect(client.requests.filter(entry => entry.method === 'turn/interrupt')).toHaveLength(0);
    await runtime.shutdown();
  });

  test('awaits durable canonical-session admission before exposing the session or starting the turn', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const admissionGate = deferred<void>();
    const admissionEntered = deferred<void>();
    const events: RuntimeTurnEvent[] = [];

    const run = runtime.runTurn({
      ...request('ADMISSION_BARRIER'),
      admitCanonicalSession: async sessionId => {
        expect(sessionId).toBe('thread-1');
        admissionEntered.resolve();
        await admissionGate.promise;
      },
    } as ChatTurnRequest & CanonicalSessionAdmissionRequest, connection, event => events.push(event));

    await admissionEntered.promise;
    expect(client.requests.filter(entry => entry.method === 'turn/start')).toHaveLength(0);
    expect(events.filter(event => event.type === 'session')).toHaveLength(0);

    admissionGate.resolve();
    await run;
    expect(client.requests.filter(entry => entry.method === 'turn/start')).toHaveLength(1);
    expect(events.filter(event => event.type === 'session')).toEqual([
      { type: 'session', sessionId: 'thread-1' },
    ]);
    await runtime.shutdown();
  });

  test('lets only one conversation cross turn/start when durable ownership rejects a canonical-session race', async () => {
    const client = new FakeAppServerClient();
    client.canonicalThreadId = 'durable-canonical';
    const threadGate = deferred<void>();
    client.threadStartGate = threadGate.promise;
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const claimGate = deferred<void>();
    const firstEvents: RuntimeTurnEvent[] = [];
    const secondEvents: RuntimeTurnEvent[] = [];
    let durableOwner: string | null = null;
    let claimsEntered = 0;
    const admit = (conversationId: string) => async (sessionId: string): Promise<void> => {
      expect(sessionId).toBe('durable-canonical');
      claimsEntered += 1;
      await claimGate.promise;
      if (durableOwner !== null && durableOwner !== conversationId) {
        throw new Error(`owned by ${durableOwner}`);
      }
      durableOwner = conversationId;
    };

    const firstRun = runtime.runTurn({
      ...request('HOLD_DURABLE_FIRST'),
      signal: firstController.signal,
      admitCanonicalSession: admit('first'),
    } as ChatTurnRequest & CanonicalSessionAdmissionRequest, connection, event => firstEvents.push(event));
    const secondRun = runtime.runTurn({
      ...request('HOLD_DURABLE_SECOND'),
      signal: secondController.signal,
      admitCanonicalSession: admit('second'),
    } as ChatTurnRequest & CanonicalSessionAdmissionRequest, connection, event => secondEvents.push(event));
    await waitForRequestCount(client, 'thread/start', 2);
    threadGate.resolve();
    await vi.waitFor(() => expect(claimsEntered).toBe(2));
    expect(client.requests.filter(entry => entry.method === 'turn/start')).toHaveLength(0);

    claimGate.resolve();
    await vi.waitFor(() => expect([
      ...firstEvents,
      ...secondEvents,
    ].filter(event => event.type === 'error'
      && event.diagnostic === 'codex_session_admission_failed')).toHaveLength(1));
    expect(client.requests.filter(entry => entry.method === 'turn/start')).toHaveLength(1);
    expect([...firstEvents, ...secondEvents].filter(event => event.type === 'session')).toHaveLength(1);
    const rejected = firstEvents.some(event => event.type === 'error'
      && event.diagnostic === 'codex_session_admission_failed') ? firstEvents : secondEvents;
    expect(rejected.at(-1)).toEqual({ type: 'done' });

    firstController.abort();
    secondController.abort();
    await Promise.all([firstRun, secondRun]);
    await runtime.shutdown();
  });

  test('protects the canonical thread id when two thread starts resolve concurrently', async () => {
    const client = new FakeAppServerClient();
    client.canonicalThreadId = 'canonical-thread';
    const threadGate = deferred<void>();
    client.threadStartGate = threadGate.promise;
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first: RuntimeTurnEvent[] = [];
    const second: RuntimeTurnEvent[] = [];

    const firstRun = runtime.runTurn({
      ...request('HOLD_FIRST'),
      signal: firstController.signal,
    }, connection, event => first.push(event));
    const secondRun = runtime.runTurn({
      ...request('HOLD_SECOND'),
      signal: secondController.signal,
    }, connection, event => second.push(event));
    await waitForRequestCount(client, 'thread/start', 2);
    threadGate.resolve();
    await delay(20);

    const reservedErrors = [...first, ...second].filter(event => (
      event.type === 'error' && event.diagnostic === 'codex_thread_already_active'
    ));
    expect(reservedErrors).toHaveLength(1);
    expect(client.requests.filter(entry => entry.method === 'turn/start')).toHaveLength(1);

    firstController.abort();
    secondController.abort();
    await Promise.all([firstRun, secondRun]);
    expect([...first, ...second].filter(event => event.type === 'session')).toHaveLength(1);
    await runtime.shutdown();
  });

  test('shutdown waits for a slow status preflight and prevents a late thread spawn', async () => {
    const client = new FakeAppServerClient();
    const modelGate = deferred<void>();
    const modelEntered = deferred<void>();
    client.modelListGate = modelGate.promise;
    client.markModelListEntered = () => modelEntered.resolve();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn(request('MUST_NOT_START'), connection, event => events.push(event));

    await modelEntered.promise;
    let shutdownSettled = false;
    const shutdown = runtime.shutdown().then(() => {
      shutdownSettled = true;
    });
    await delay(30);
    expect(shutdownSettled).toBe(false);
    expect(client.requests.some(entry => entry.method === 'thread/start')).toBe(false);

    modelGate.resolve();
    await Promise.all([run, shutdown]);
    expect(client.requests.some(entry => entry.method === 'thread/start')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });

    const afterClose: RuntimeTurnEvent[] = [];
    await runtime.runTurn(request('AFTER_CLOSE'), connection, event => afterClose.push(event));
    expect(afterClose).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_runtime_closed',
    }));
    expect(client.connectPaths).toEqual([connection.binaryPath]);
  });

  test('does not connect when the queued execution fingerprint is already stale', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];

    await runtime.runTurn(request('STALE_BEFORE_CONNECT'), {
      ...connection,
      executionIsCurrent: () => false,
    }, event => events.push(event));

    expect(client.connectPaths).toHaveLength(0);
    expect(client.requests).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'runtime_execution_config_changed',
    }));
    await runtime.shutdown();
  });

  test('rechecks the queued execution fingerprint after slow preflight and skips thread start', async () => {
    const client = new FakeAppServerClient();
    const modelGate = deferred<void>();
    const modelEntered = deferred<void>();
    client.modelListGate = modelGate.promise;
    client.markModelListEntered = () => modelEntered.resolve();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];
    let executionCurrent = true;
    const run = runtime.runTurn(request('STALE_AFTER_PREFLIGHT'), {
      ...connection,
      executionIsCurrent: () => executionCurrent,
    }, event => events.push(event));

    await modelEntered.promise;
    executionCurrent = false;
    modelGate.resolve();
    await run;

    expect(client.connectPaths).toEqual([connection.binaryPath]);
    expect(client.requests.some(entry => entry.method === 'thread/start')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'runtime_execution_config_changed',
    }));
    await runtime.shutdown();
  });

  test('keeps the active binary frozen while two held turns are running', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    await runtime.refreshStatus(connection);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstRun = runtime.runTurn({
      ...request('HOLD_FIRST'),
      sessionId: 'binary-thread-a',
      signal: firstController.signal,
    }, connection, () => {});
    const secondRun = runtime.runTurn({
      ...request('HOLD_SECOND'),
      sessionId: 'binary-thread-b',
      signal: secondController.signal,
    }, connection, () => {});
    await waitForRequestCount(client, 'turn/start', 2);

    const nextConnection = { ...connection, binaryPath: '/fake/codex-next' };
    const blocked = await runtime.refreshStatus(nextConnection);
    expect(blocked.error).toContain('未切换');
    expect(client.connectedExecutablePath).toBe(connection.binaryPath);
    expect(client.disconnectCount).toBe(0);

    const rejectedTurn: RuntimeTurnEvent[] = [];
    await runtime.runTurn(request('WRONG_BINARY'), nextConnection, event => rejectedTurn.push(event));
    expect(rejectedTurn).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_binary_change_blocked',
    }));
    expect(client.requests.filter(entry => entry.method === 'thread/start')).toHaveLength(0);

    firstController.abort();
    secondController.abort();
    await Promise.all([firstRun, secondRun]);

    const switched = await runtime.refreshStatus(nextConnection);
    expect(switched.state).toBe('ready');
    expect(switched.binaryPath).toBe(nextConnection.binaryPath);
    expect(client.connectedExecutablePath).toBe(nextConnection.binaryPath);
    expect(client.connectPaths).toEqual([connection.binaryPath, nextConnection.binaryPath]);
    await runtime.shutdown();
  });

  test('settles active turns on an unexpected App Server close and can reconnect', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'unexpected-close-thread',
    }, connection, event => events.push(event));
    await waitForRequestCount(client, 'turn/start', 1);

    client.simulateUnexpectedClose('server crashed');
    await run;
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      message: 'Codex App Server 连接已中断。',
    }));
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'unexpected-close-thread' });

    const recovered: RuntimeTurnEvent[] = [];
    await runtime.runTurn(request('RECOVERED'), connection, event => recovered.push(event));
    expect(recovered).toContainEqual({ type: 'text', content: 'reply:RECOVERED' });
    expect(client.connectPaths).toEqual([connection.binaryPath, connection.binaryPath]);
    await runtime.shutdown();
  });

  test('isolates a throwing status listener while an unexpected close settles the active turn', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'throwing-status-listener-thread',
    }, connection, event => events.push(event));
    await waitForRequestCount(client, 'turn/start', 1);

    const listenerError = new Error('status observer failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unsubscribe = runtime.onStatusChange(() => {
      throw listenerError;
    });
    try {
      client.simulateUnexpectedClose('listener isolation close');
      await run;

      expect(consoleError).toHaveBeenCalledWith(
        'Ailu Codex status listener failed.',
        listenerError,
      );
      expect(events).toContainEqual(expect.objectContaining({
        type: 'error',
        message: 'Codex App Server 连接已中断。',
      }));
      expect(events.at(-1)).toEqual({
        type: 'done',
        sessionId: 'throwing-status-listener-thread',
      });
    } finally {
      unsubscribe();
      consoleError.mockRestore();
      await runtime.shutdown();
    }
  });

  test('includes markUnavailable disconnect in its completion barrier', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];
    let runSettled = false;
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'unavailable-thread',
    }, connection, event => events.push(event)).then(() => {
      runSettled = true;
    });
    await waitForRequestCount(client, 'turn/start', 1);

    const disconnectGate = deferred<void>();
    client.disconnectGate = disconnectGate.promise;
    let unavailableSettled = false;
    const unavailable = runtime.markUnavailable('binary disappeared').then(() => {
      unavailableSettled = true;
    });
    await delay(20);
    expect(unavailableSettled).toBe(false);
    expect(runSettled).toBe(false);
    expect(events.some(event => event.type === 'done')).toBe(false);

    disconnectGate.resolve();
    await Promise.all([run, unavailable]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_runtime_unavailable_disconnected',
    }));
    expect(runtime.getStatus()).toMatchObject({
      state: 'error',
      connected: false,
      error: 'binary disappeared',
    });
    client.disconnectGate = null;
    await runtime.shutdown();
  });

  test('disconnects the shared server before settling an interrupt RPC failure and its parallel turn', async () => {
    const client = new FakeAppServerClient();
    client.interruptError = new Error('interrupt transport failed');
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const controller = new AbortController();
    const failedEvents: RuntimeTurnEvent[] = [];
    const parallelEvents: RuntimeTurnEvent[] = [];
    let failedSettled = false;
    let parallelSettled = false;
    const failedRun = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'interrupt-failed-thread',
      signal: controller.signal,
    }, connection, event => failedEvents.push(event)).then(() => {
      failedSettled = true;
    });
    const parallelRun = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'interrupt-parallel-thread',
    }, connection, event => parallelEvents.push(event)).then(() => {
      parallelSettled = true;
    });
    await waitForRequestCount(client, 'turn/start', 2);
    const disconnectGate = deferred<void>();
    client.disconnectGate = disconnectGate.promise;
    controller.abort();
    await waitForDisconnectCount(client, 1);
    await delay(20);
    expect(failedSettled).toBe(false);
    expect(parallelSettled).toBe(false);
    expect(failedEvents.some(event => event.type === 'done')).toBe(false);
    expect(parallelEvents.some(event => event.type === 'done')).toBe(false);

    disconnectGate.resolve();
    await Promise.all([failedRun, parallelRun]);
    expect(failedEvents).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_interrupt_failed',
    }));
    expect(parallelEvents).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_shared_server_disconnected_for_safety',
    }));
    expect(client.disconnectCount).toBe(1);
    expect(failedEvents.at(-1)).toEqual({ type: 'done', sessionId: 'interrupt-failed-thread' });
    expect(parallelEvents.at(-1)).toEqual({ type: 'done', sessionId: 'interrupt-parallel-thread' });
    client.disconnectGate = null;
    await runtime.shutdown();
  });

  test('does not treat an interrupt acknowledgement as turn completion', async () => {
    const client = new FakeAppServerClient();
    client.emitInterruptCompletion = false;
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const controller = new AbortController();
    const events: RuntimeTurnEvent[] = [];
    let settled = false;
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'ack-only-thread',
      signal: controller.signal,
    }, connection, event => events.push(event)).then(() => {
      settled = true;
    });

    await delay(10);
    controller.abort();
    await delay(20);

    expect(client.requests.some(entry => entry.method === 'turn/interrupt')).toBe(true);
    expect(settled).toBe(false);
    client.emit('notification', 'item/agentMessage/delta', {
      threadId: 'ack-only-thread',
      turnId: 'turn-ack-only-thread',
      itemId: 'late-message',
      delta: 'must-not-render',
    });
    expect(events.some(event => event.type === 'text')).toBe(false);

    client.emit('notification', 'turn/completed', {
      threadId: 'ack-only-thread',
      turn: { id: 'turn-ack-only-thread', status: 'interrupted' },
    });
    await run;
    expect(settled).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'ack-only-thread' });

    const eventCount = events.length;
    client.emit('notification', 'item/agentMessage/delta', {
      threadId: 'ack-only-thread',
      turnId: 'turn-ack-only-thread',
      itemId: 'later-message',
      delta: 'also-must-not-render',
    });
    expect(events).toHaveLength(eventCount);
    await runtime.shutdown();
  });

  test('disconnects the shared server before settling an interrupt timeout and its parallel turn', async () => {
    const client = new FakeAppServerClient();
    client.emitInterruptCompletion = false;
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient, 30);
    const controller = new AbortController();
    const timeoutEvents: RuntimeTurnEvent[] = [];
    const parallelEvents: RuntimeTurnEvent[] = [];
    let timeoutSettled = false;
    let parallelSettled = false;
    const timeoutRun = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'uncertain-thread',
      signal: controller.signal,
    }, connection, event => timeoutEvents.push(event)).then(() => {
      timeoutSettled = true;
    });
    const parallelRun = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'timeout-parallel-thread',
    }, connection, event => parallelEvents.push(event)).then(() => {
      parallelSettled = true;
    });
    await waitForRequestCount(client, 'turn/start', 2);
    const disconnectGate = deferred<void>();
    client.disconnectGate = disconnectGate.promise;
    controller.abort();
    await waitForDisconnectCount(client, 1);
    await delay(20);
    expect(timeoutSettled).toBe(false);
    expect(parallelSettled).toBe(false);

    disconnectGate.resolve();
    await Promise.all([timeoutRun, parallelRun]);
    expect(timeoutEvents).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_interrupt_completion_timeout',
    }));
    expect(parallelEvents).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_shared_server_disconnected_for_safety',
    }));
    expect(client.disconnectCount).toBe(1);
    client.disconnectGate = null;
    await runtime.shutdown();
  });

  test('does not falsely settle when safety disconnect fails and lets global shutdown retry', async () => {
    const client = new FakeAppServerClient();
    client.interruptError = new Error('interrupt transport failed');
    client.disconnectError = new Error('disconnect transport failed');
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const controller = new AbortController();
    const failedEvents: RuntimeTurnEvent[] = [];
    const parallelEvents: RuntimeTurnEvent[] = [];
    let failedSettled = false;
    let parallelSettled = false;
    const failedRun = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'disconnect-failed-thread',
      signal: controller.signal,
    }, connection, event => failedEvents.push(event)).then(() => {
      failedSettled = true;
    });
    const parallelRun = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'disconnect-failed-parallel-thread',
    }, connection, event => parallelEvents.push(event)).then(() => {
      parallelSettled = true;
    });
    await waitForRequestCount(client, 'turn/start', 2);

    controller.abort();
    await waitForDisconnectCount(client, 1);
    await delay(20);
    expect(failedSettled).toBe(false);
    expect(parallelSettled).toBe(false);
    expect(failedEvents).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_safety_disconnect_failed',
    }));
    expect(parallelEvents).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_safety_disconnect_failed',
    }));
    expect(failedEvents.some(event => event.type === 'done')).toBe(false);
    expect(parallelEvents.some(event => event.type === 'done')).toBe(false);

    const blocked: RuntimeTurnEvent[] = [];
    await runtime.runTurn(request('MUST_NOT_RECONNECT'), connection, event => blocked.push(event));
    expect(blocked).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_safety_disconnect_required',
    }));
    expect(client.requests.filter(entry => entry.method === 'turn/start')).toHaveLength(2);

    client.interruptError = null;
    client.disconnectError = null;
    await Promise.all([runtime.shutdown(), failedRun, parallelRun]);
    expect(client.disconnectCount).toBe(2);
    expect(failedSettled).toBe(true);
    expect(parallelSettled).toBe(true);
    expect(failedEvents.at(-1)).toEqual({ type: 'done', sessionId: 'disconnect-failed-thread' });
    expect(parallelEvents.at(-1)).toEqual({
      type: 'done',
      sessionId: 'disconnect-failed-parallel-thread',
    });
  });

  test('resumes an existing thread, sends plan collaboration mode, and interrupts through AbortSignal', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const controller = new AbortController();
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn({
      ...request('HOLD'),
      sessionId: 'existing-thread',
      planMode: true,
      fullAccess: true,
      model: 'model-b',
      reasoningEffort: 'medium',
      signal: controller.signal,
    }, connection, event => events.push(event));

    await delay(10);
    controller.abort();
    await run;

    expect(client.requests.find(entry => entry.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'existing-thread',
      sandbox: 'read-only',
    });
    expect(client.requests.find(entry => entry.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'model-b', reasoning_effort: 'medium', developer_instructions: null },
      },
    });
    expect(client.requests.some(entry => entry.method === 'turn/interrupt')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'existing-thread' });
    await runtime.shutdown();
  });

  test('does not replace a missing resumed thread unless canonical fallback is explicitly allowed', async () => {
    const client = new FakeAppServerClient();
    client.threadResumeError = new CodexJsonRpcError('thread/resume', {
      code: -32600,
      message: 'no rollout found for thread id stale-thread',
    });
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];

    await runtime.runTurn({
      ...request('ORIGINAL PROMPT'),
      sessionId: 'stale-thread',
      freshSessionPrompt: 'CANONICAL HANDOFF',
      allowFreshSessionFallback: false,
    }, connection, event => events.push(event));

    expect(client.requests.filter(entry => entry.method === 'thread/resume')).toHaveLength(1);
    expect(client.requests.filter(entry => entry.method === 'thread/start')).toHaveLength(0);
    expect(client.requests.filter(entry => entry.method === 'turn/start')).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      message: 'Codex 会话启动失败。',
      detail: 'no rollout found for thread id stale-thread',
    }));
    await runtime.shutdown();
  });

  test('requires a canonical fresh-session prompt before falling back from a missing thread', async () => {
    const client = new FakeAppServerClient();
    client.threadResumeError = new CodexJsonRpcError('thread/resume', {
      code: -32600,
      message: 'thread/read failed: thread not loaded: stale-thread',
    });
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];

    await runtime.runTurn({
      ...request('ORIGINAL PROMPT'),
      sessionId: 'stale-thread',
      allowFreshSessionFallback: true,
    }, connection, event => events.push(event));

    expect(client.requests.filter(entry => entry.method === 'thread/start')).toHaveLength(0);
    expect(events.some(event => event.type === 'error')).toBe(true);
    await runtime.shutdown();
  });

  test('uses the canonical handoff prompt when an explicitly allowed missing-thread fallback starts fresh', async () => {
    const client = new FakeAppServerClient();
    client.threadResumeError = new CodexJsonRpcError('thread/resume', {
      code: -32600,
      message: 'thread stale-thread not found',
      data: { kind: 'thread_not_found' },
    });
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];

    await runtime.runTurn({
      ...request('ORIGINAL PROMPT'),
      sessionId: 'stale-thread',
      freshSessionPrompt: 'CANONICAL HANDOFF',
      allowFreshSessionFallback: true,
    }, connection, event => events.push(event));

    expect(client.requests.filter(entry => entry.method === 'thread/start')).toHaveLength(1);
    const turnStart = client.requests.find(entry => entry.method === 'turn/start');
    const input = (turnStart?.params as { input?: unknown[] } | undefined)?.input;
    expect(input?.[0]).toMatchObject({ type: 'text', text: 'CANONICAL HANDOFF' });
    expect(JSON.stringify(turnStart?.params)).not.toContain('ORIGINAL PROMPT');
    expect(events).toContainEqual({ type: 'session', sessionId: 'thread-1' });
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'thread-1' });
    await runtime.shutdown();
  });

  test('never falls back from a configuration error that shares the missing-thread JSON-RPC code', async () => {
    const client = new FakeAppServerClient();
    client.threadResumeError = new CodexJsonRpcError('thread/resume', {
      code: -32600,
      message: 'failed to load configuration: .codex/config.toml: invalid type',
    });
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];

    await runtime.runTurn({
      ...request('ORIGINAL PROMPT'),
      sessionId: 'existing-thread',
      freshSessionPrompt: 'CANONICAL HANDOFF',
      allowFreshSessionFallback: true,
    }, connection, event => events.push(event));

    expect(client.requests.filter(entry => entry.method === 'thread/start')).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      detail: 'failed to load configuration: .codex/config.toml: invalid type',
    }));
    await runtime.shutdown();
  });

  test('hardens direct context-compression requests even when callers supply unsafe options', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];

    await runtime.runTurn({
      ...request('COMPRESS THIS'),
      purpose: 'contextCompression',
      sessionId: 'must-not-resume',
      fullAccess: true,
      planMode: true,
      attachments: [{
        vaultPath: 'secret.png',
        absolutePath: '/tmp/must-not-attach.png',
        mimeType: 'image/png',
      }],
      freshSessionPrompt: 'MUST NOT FALL BACK',
      allowFreshSessionFallback: true,
    }, connection, event => events.push(event));

    expect(client.requests.filter(entry => entry.method === 'thread/resume')).toHaveLength(0);
    expect(client.requests.find(entry => entry.method === 'thread/start')?.params).toMatchObject({
      ephemeral: true,
      sandbox: 'read-only',
      dynamicTools: [],
      environments: [],
      selectedCapabilityRoots: [],
    });
    expect(client.requests.find(entry => entry.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      input: [{ type: 'text', text: 'COMPRESS THIS' }],
    });
    expect(JSON.stringify(client.requests.find(entry => entry.method === 'turn/start')?.params))
      .not.toContain('/tmp/must-not-attach.png');
    expect(events.some(event => event.type === 'session')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });
    await runtime.shutdown();
  });

  test('hardens direct text-only requests with the same ephemeral no-session contract', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];

    await runtime.runTurn({
      ...request('TEXT ONLY'),
      textOnly: true,
      sessionId: 'must-not-resume',
      fullAccess: true,
      planMode: true,
      attachments: [{
        vaultPath: 'secret.png',
        absolutePath: '/tmp/must-not-attach.png',
        mimeType: 'image/png',
      }],
      freshSessionPrompt: 'MUST NOT FALL BACK',
      allowFreshSessionFallback: true,
    }, connection, event => events.push(event));

    expect(client.requests.filter(entry => entry.method === 'thread/resume')).toHaveLength(0);
    expect(client.requests.find(entry => entry.method === 'thread/start')?.params).toMatchObject({
      ephemeral: true,
      sandbox: 'read-only',
      dynamicTools: [],
      environments: [],
      selectedCapabilityRoots: [],
    });
    expect(client.requests.find(entry => entry.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      input: [{ type: 'text', text: 'TEXT ONLY' }],
    });
    expect(JSON.stringify(client.requests.find(entry => entry.method === 'turn/start')?.params))
      .not.toContain('/tmp/must-not-attach.png');
    expect(events.some(event => event.type === 'session')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });
    await runtime.shutdown();
  });

  test('uses danger-full-access and limits unexpected approval grants to the current turn', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const controller = new AbortController();
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn({
      ...request('HOLD'),
      fullAccess: true,
      signal: controller.signal,
    }, connection, event => events.push(event));

    await delay(10);
    client.emit('serverRequest', 7, 'item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-thread-1',
      itemId: 'command-1',
    });
    client.emit('serverRequest', 8, 'item/permissions/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-thread-1',
      itemId: 'permission-1',
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ['/outside'], write: ['/outside'] },
      },
    });
    client.emit('serverRequest', 9, 'execCommandApproval', {
      conversationId: 'thread-1',
      callId: 'legacy-command-1',
    });

    expect(client.requests.find(entry => entry.method === 'thread/start')?.params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    expect(client.requests.find(entry => entry.method === 'turn/start')?.params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    expect(client.responses).toEqual([
      { id: 7, result: { decision: 'accept' } },
      {
        id: 8,
        result: {
          permissions: {
            network: { enabled: true },
            fileSystem: { read: ['/outside'], write: ['/outside'] },
          },
          scope: 'turn',
        },
      },
      { id: 9, result: { decision: 'approved' } },
    ]);
    expect(events.some(event => event.type === 'error')).toBe(false);

    controller.abort();
    await run;
    await runtime.shutdown();
  });

  test('starts a fresh Codex thread when access drops after a full-access turn', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);

    await runtime.runTurn({ ...request('FULL'), fullAccess: true }, connection, () => {});
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn({
      ...request('RESTRICTED CURRENT INPUT'),
      sessionId: 'thread-1',
      fullAccess: false,
      freshSessionPrompt: 'RESTRICTED CANONICAL HANDOFF',
      allowFreshSessionFallback: true,
    }, connection, event => events.push(event));

    expect(client.requests.filter(entry => entry.method === 'thread/resume')).toHaveLength(0);
    expect(client.requests.filter(entry => entry.method === 'thread/start')).toHaveLength(2);
    const restrictedTurn = client.requests.filter(entry => entry.method === 'turn/start').at(-1);
    expect(restrictedTurn?.params).toMatchObject({
      threadId: 'thread-2',
      input: [{ type: 'text', text: 'RESTRICTED CANONICAL HANDOFF' }],
      sandboxPolicy: { type: 'workspaceWrite' },
    });
    expect(JSON.stringify(restrictedTurn?.params)).not.toContain('RESTRICTED CURRENT INPUT');
    expect(events).toContainEqual({ type: 'session', sessionId: 'thread-2' });
    await runtime.shutdown();
  });

  test('fails closed when a Codex privilege downgrade lacks a verified fresh handoff', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);

    await runtime.runTurn({ ...request('FULL'), fullAccess: true }, connection, () => {});
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn({
      ...request('RESTRICTED'),
      sessionId: 'thread-1',
      fullAccess: false,
    }, connection, event => events.push(event));

    expect(client.requests.filter(entry => entry.method === 'turn/start')).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'codex_privilege_downgrade_requires_fresh_session',
    }));
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'thread-1' });
    await runtime.shutdown();
  });

  test('passes selected model and effort at the top level for a normal turn', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);

    await runtime.runTurn({
      ...request('CUSTOM_REASONING'),
      model: 'model-b',
      reasoningEffort: 'low',
    }, connection, () => {});

    const turnStart = client.requests.find(entry => {
      if (entry.method !== 'turn/start') return false;
      const params = entry.params as { input?: Array<{ type: string; text?: string }> };
      return params.input?.some(item => item.text === 'CUSTOM_REASONING');
    });
    expect(turnStart?.params).toMatchObject({ model: 'model-b', effort: 'low' });
    expect(turnStart?.params).not.toHaveProperty('collaborationMode');
    await runtime.shutdown();
  });

  test('switches the selected model on a resumed App Server thread', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);

    await runtime.runTurn({
      ...request('MODEL_A_TURN'),
      model: 'model-a',
    }, connection, () => {});
    await runtime.runTurn({
      ...request('MODEL_B_ON_EXISTING_THREAD'),
      sessionId: 'thread-1',
      model: 'model-b',
      reasoningEffort: 'low',
    }, connection, () => {});

    const resumedThread = client.requests.find(entry => entry.method === 'thread/resume');
    expect(resumedThread?.params).toMatchObject({ threadId: 'thread-1' });
    const switchedTurn = client.requests.find(entry => {
      if (entry.method !== 'turn/start') return false;
      const params = entry.params as { input?: Array<{ text?: string }> };
      return params.input?.some(item => item.text === 'MODEL_B_ON_EXISTING_THREAD');
    });
    expect(switchedTurn?.params).toMatchObject({
      threadId: 'thread-1',
      model: 'model-b',
      effort: 'low',
    });
    await runtime.shutdown();
  });

  test('falls back to the selected model default when an effort is unsupported', () => {
    const model = {
      id: 'model-b',
      model: 'model-b',
      displayName: 'Model B',
      description: '',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '' },
        { reasoningEffort: 'medium', description: '' },
      ],
      inputModalities: ['text'],
    };

    expect(reconcileCodexReasoningEffort(model, 'ultra')).toBe('medium');
    expect(reconcileCodexReasoningEffort(model, 'low')).toBe('low');
    expect(reconcileCodexReasoningEffort(model, '')).toBe('');
  });

  test('keeps normal chat available when image generation capability is missing', async () => {
    const client = new FakeAppServerClient();
    client.imageGeneration = false;
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);

    const status = await runtime.refreshStatus(connection);
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(request('CHAT_ONLY'), connection, event => events.push(event));

    expect(status.imageGeneration).toBe(false);
    expect(events).toContainEqual({ type: 'text', content: 'reply:CHAT_ONLY' });
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'thread-1' });
    await runtime.shutdown();
  });

  test('does not turn non-fatal App Server warnings into chat errors', async () => {
    const client = new FakeAppServerClient();
    client.emitWarning = true;
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];

    await runtime.runTurn(request('WARNING_ONLY'), connection, event => events.push(event));

    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: 'text', content: 'reply:WARNING_ONLY' });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    await runtime.shutdown();
  });

  test('disconnects with one terminal error before delivering an oversized App Server event', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn(request('HOLD_OVERSIZED_EVENT'), connection, event => events.push(event));
    await waitForRequestCount(client, 'turn/start', 1);

    client.emit('notification', 'item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-thread-1',
      itemId: 'oversized-message',
      delta: 'x'.repeat(CODEX_MAX_RUNTIME_EVENT_BYTES),
    });
    await run;

    expect(client.disconnectCount).toBe(1);
    expect(events.filter(event => event.type === 'error')).toEqual([
      expect.objectContaining({ diagnostic: 'codex_output_limit_exceeded' }),
    ]);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.some(event => event.type === 'text')).toBe(false);
    await runtime.shutdown();
  });

  test('bounds a turn made of many individually small App Server events', async () => {
    const client = new FakeAppServerClient();
    const runtime = new CodexAppServerRuntime(client as unknown as CodexAppServerClient);
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn(request('HOLD_MANY_SMALL_EVENTS'), connection, event => events.push(event));
    await waitForRequestCount(client, 'turn/start', 1);

    const params = {
      threadId: 'thread-1',
      turnId: 'turn-thread-1',
      message: 'x'.repeat(64 * 1_024),
    };
    const eventBytes = Buffer.byteLength(JSON.stringify({ method: 'warning', params }), 'utf8');
    const count = Math.floor(CODEX_MAX_TURN_OUTPUT_BYTES / eventBytes) + 1;
    for (let index = 0; index < count; index += 1) {
      client.emit('notification', 'warning', params);
    }
    await run;

    expect(client.disconnectCount).toBe(1);
    expect(events.filter(event => event.type === 'error')).toEqual([
      expect.objectContaining({ diagnostic: 'codex_output_limit_exceeded' }),
    ]);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    await runtime.shutdown();
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForRequestCount(
  client: FakeAppServerClient,
  method: string,
  count: number,
): Promise<void> {
  for (
    let attempt = 0;
    attempt < 100 && client.requests.filter(entry => entry.method === method).length < count;
    attempt += 1
  ) await delay(10);
  expect(client.requests.filter(entry => entry.method === method)).toHaveLength(count);
}

async function waitForDisconnectCount(client: FakeAppServerClient, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && client.disconnectCount < count; attempt += 1) {
    await delay(10);
  }
  expect(client.disconnectCount).toBe(count);
}
