import { describe, expect, it } from 'vitest';

import {
  ChatContextOverflowError,
  ChatContextService,
  type ChatContextStore,
} from '../src/chat/chatContextService';
import type {
  ContextCheckpointMutationResult,
  StoredConversationTurn,
  VersionedStoredConversation,
} from '../src/storage/vaultStore';
import type {
  AgentId,
  ChatMessage,
  ConversationContextCheckpoint,
  ConversationContextCheckpointDraft,
  ConversationContextSummary,
} from '../src/types';

const EMPTY_SUMMARY: ConversationContextSummary = {
  facts: [],
  decisions: [],
  userPreferences: [],
  constraints: [],
  openLoops: [],
  filesMentioned: [],
  lastIntent: '',
};

interface TurnSpec {
  agentId?: AgentId;
  user?: string;
  assistant?: string;
  state?: StoredConversationTurn['state'];
}

function conversationFrom(
  specs: readonly TurnSpec[],
  overrides: Partial<VersionedStoredConversation> = {},
): VersionedStoredConversation {
  const messages: ChatMessage[] = [];
  const turns: StoredConversationTurn[] = [];
  specs.forEach((spec, index) => {
    const number = index + 1;
    const agentId = spec.agentId ?? 'claude';
    const turnId = `turn-${number}`;
    const userMessageId = `${turnId}-user`;
    const assistantMessageId = `${turnId}-assistant`;
    messages.push({
      id: userMessageId,
      role: 'user',
      content: spec.user ?? `用户消息 ${number}`,
      createdAt: number * 10,
      agentId,
      metadata: { privateRuntimeField: `/private/metadata-${number}.json` },
    });
    messages.push({
      id: assistantMessageId,
      role: 'assistant',
      content: spec.assistant ?? `助手回答 ${number}`,
      createdAt: number * 10 + 1,
      agentId,
      metadata: { toolTranscript: `hidden-tool-${number}` },
    });
    const state = spec.state ?? 'completed';
    turns.push({
      id: turnId,
      agentId,
      userMessageId,
      assistantMessageId,
      state,
      queueSequence: 100 + number * 7,
      createdAt: number * 10,
      updatedAt: number * 10 + 2,
      ...(state === 'completed' ? { completedAt: number * 10 + 2 } : {}),
    });
  });
  return {
    id: 'conversation-1',
    title: 'Service test',
    agentId: specs.at(-1)?.agentId ?? 'claude',
    createdAt: 1,
    updatedAt: 2,
    revision: 9,
    messages,
    turns,
    ...overrides,
  };
}

function withFreshSession(
  conversation: VersionedStoredConversation,
  agentId: AgentId,
  sessionId = `${agentId}-session`,
): VersionedStoredConversation {
  const latest = conversation.turns
    .filter(turn => turn.state === 'completed')
    .sort((left, right) => left.queueSequence - right.queueSequence)
    .at(-1);
  if (!latest) throw new Error('A completed turn is required.');
  return {
    ...conversation,
    sessionIds: { ...conversation.sessionIds, [agentId]: sessionId },
    sessionOwnerships: {
      ...conversation.sessionOwnerships,
      [agentId]: {
        sessionId,
        conversationId: conversation.id,
        agentId,
        claimedAt: 100,
        runId: latest.id,
      },
    },
  };
}

function checkpointAt(
  conversation: VersionedStoredConversation,
  turnNumber: number,
  summary: ConversationContextSummary,
  id = 'checkpoint-old',
): ConversationContextCheckpoint {
  const turn = conversation.turns[turnNumber - 1];
  if (!turn) throw new Error('Missing checkpoint turn.');
  return {
    version: 1,
    id,
    createdAt: 50,
    sourceRevision: conversation.revision - 1,
    throughMessageSequence: turnNumber * 2,
    throughMessageId: turn.assistantMessageId,
    prefixSha256: 'a'.repeat(64),
    projectionVersion: 1,
    summary,
    createdBy: 'local',
  };
}

class FakeContextStore implements ChatContextStore {
  windowCalls = 0;
  fullCalls = 0;
  commitCalls: ConversationContextCheckpointDraft[] = [];
  commitError: Error | null = null;

  constructor(public conversation: VersionedStoredConversation) {}

  async loadConversationWindow(_conversationId: string, limit = 100) {
    this.windowCalls += 1;
    const totalMessageCount = this.conversation.messages.length;
    const start = Math.max(0, totalMessageCount - limit);
    return {
      conversation: cloneConversation({
        ...this.conversation,
        messages: this.conversation.messages.slice(start),
      }),
      nextBeforeSequence: start > 0 ? start + 1 : null,
      totalMessageCount,
    };
  }

  async getConversation(_conversationId: string) {
    this.fullCalls += 1;
    return cloneConversation(this.conversation);
  }

  async commitContextCheckpoint(input: {
    conversationId: string;
    checkpoint: ConversationContextCheckpointDraft;
    expectedRevision?: number;
  }): Promise<ContextCheckpointMutationResult> {
    if (this.commitError) throw this.commitError;
    if (input.expectedRevision !== this.conversation.revision
      || input.checkpoint.sourceRevision !== this.conversation.revision) {
      throw new Error('revision conflict');
    }
    this.commitCalls.push(structuredClone(input.checkpoint));
    const checkpoint: ConversationContextCheckpoint = {
      ...structuredClone(input.checkpoint),
      prefixSha256: 'b'.repeat(64),
    };
    this.conversation = {
      ...this.conversation,
      revision: this.conversation.revision + 1,
      contextCheckpoint: checkpoint,
    };
    return {
      applied: true,
      revision: this.conversation.revision,
      checkpoint,
    };
  }
}

function cloneConversation(value: VersionedStoredConversation): VersionedStoredConversation {
  return structuredClone(value);
}

function service(store: FakeContextStore, overrides: Partial<ConstructorParameters<typeof ChatContextService>[0]> = {}) {
  return new ChatContextService({
    store,
    now: () => 1_000,
    createCheckpointId: () => 'checkpoint-new',
    ...overrides,
  });
}

function readHandoff(prompt: string): {
  checkpoint: ConversationContextSummary;
  recentCompletedTurns: unknown[];
} {
  const prefix = 'AILU_HANDOFF_JSON:\n';
  const start = prompt.indexOf(prefix);
  const end = prompt.indexOf('\n\n当前回合输入：\n');
  if (start < 0 || end < 0) throw new Error('Missing handoff payload.');
  return JSON.parse(prompt.slice(start + prefix.length, end)) as {
    checkpoint: ConversationContextSummary;
    recentCompletedTurns: unknown[];
  };
}

describe('ChatContextService native-session handoff', () => {
  it('hands A to B and then back to A without treating either native session as canonical', async () => {
    let conversation = withFreshSession(conversationFrom([{
      agentId: 'claude',
      user: '决定把插件改成 Ailu。',
      assistant: '已经记录。',
    }]), 'claude');
    const store = new FakeContextStore(conversation);

    const toCodex = await service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'codex',
      currentPrompt: '请 Codex 继续。',
    });
    expect(toCodex.mode).toBe('fresh-handoff');
    expect(toCodex.sessionId).toBeUndefined();
    expect(toCodex.effectivePrompt).toContain('决定把插件改成 Ailu');

    conversation = conversationFrom([
      { agentId: 'claude', user: '决定把插件改成 Ailu。', assistant: '已经记录。' },
      { agentId: 'codex', user: '请 Codex 继续。', assistant: 'Codex 已继续。' },
    ], {
      sessionIds: { claude: 'claude-session', codex: 'codex-session' },
      sessionOwnerships: {
        claude: {
          sessionId: 'claude-session',
          conversationId: 'conversation-1',
          agentId: 'claude',
          claimedAt: 100,
          runId: 'turn-1',
        },
        codex: {
          sessionId: 'codex-session',
          conversationId: 'conversation-1',
          agentId: 'codex',
          claimedAt: 200,
          runId: 'turn-2',
        },
      },
    });
    store.conversation = conversation;
    const backToClaude = await service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'claude',
      currentPrompt: 'Claude Code 接着做。',
      resumeCandidate: 'claude-session',
    });
    expect(backToClaude.mode).toBe('fresh-handoff');
    expect(backToClaude.sessionId).toBeUndefined();
    expect(backToClaude.effectivePrompt).toContain('Codex 已继续');
    expect(store.fullCalls).toBe(0);
  });

  it('forces a handoff when a stored session exists but the runtime config rejected its resume candidate', async () => {
    const conversation = withFreshSession(conversationFrom([
      { agentId: 'codex', user: '当前模型配置已改变。', assistant: '收到。' },
    ]), 'codex');
    const store = new FakeContextStore(conversation);

    const prepared = await service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'codex',
      currentPrompt: '从新配置继续。',
      // No candidate means the caller found the persisted session incompatible.
    });

    expect(prepared.mode).toBe('fresh-handoff');
    expect(prepared.sessionId).toBeUndefined();
    expect(prepared.allowFreshSessionFallback).toBe(false);
    expect(prepared.effectivePrompt).toContain('当前模型配置已改变');
  });

  it('builds a complete long handoff without a durable checkpoint while budget is roomy', async () => {
    const conversation = conversationFrom(Array.from({ length: 10 }, (_, index) => ({
      user: index === 0 ? '决定长期保留这个结论。' : `用户消息 ${index + 1}`,
      assistant: `助手回答 ${index + 1}`,
    })));
    const store = new FakeContextStore(conversation);

    const prepared = await service(store, { checkpointTurnLimit: 100 }).prepare({
      conversationId: conversation.id,
      targetAgentId: 'codex',
      currentPrompt: '请接手。',
    });

    expect(prepared.mode).toBe('fresh-handoff');
    expect(store.commitCalls).toHaveLength(0);
    expect(prepared.contextCheckpointDraft).toBeUndefined();
    expect(prepared.notice).toBe('');
    expect(prepared.effectivePrompt).toContain('决定长期保留这个结论。');
  });

  it('keeps a normal resume bounded and leaves the checkpoint store untouched', async () => {
    const conversation = withFreshSession(conversationFrom([
      { user: '第一轮', assistant: '回答一' },
      { user: '第二轮', assistant: '回答二' },
    ]), 'claude');
    const store = new FakeContextStore(conversation);

    const prepared = await service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'claude',
      currentPrompt: '第三轮',
      resumeCandidate: 'claude-session',
    });

    expect(prepared).toMatchObject({
      effectivePrompt: '第三轮',
      sessionId: 'claude-session',
      allowFreshSessionFallback: false,
      mode: 'native-resume',
    });
    expect(store.windowCalls).toBe(1);
    expect(store.fullCalls).toBe(0);
    expect(store.commitCalls).toHaveLength(0);
  });

  it('keeps a long 1M native session continuous without fixed-turn compaction', async () => {
    const conversation = withFreshSession(conversationFrom(Array.from(
      { length: 80 },
      (_, index) => ({ user: `短问题 ${index + 1}`, assistant: `短回答 ${index + 1}` }),
    )), 'claude');
    const store = new FakeContextStore(conversation);

    const prepared = await service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'claude',
      currentPrompt: '继续第 81 轮。',
      resumeCandidate: 'claude-session',
      modelContextTokens: 1_000_000,
      modelOutputReserveTokens: 128_000,
      reservedInputTokens: 8_000,
    });

    expect(prepared.mode).toBe('native-resume');
    expect(prepared.contextCheckpointDraft).toBeUndefined();
    expect(prepared.notice).toBe('');
    expect(store.fullCalls).toBe(1);
  });

  it('starts a fresh model session without checkpointing a roomy transcript', async () => {
    const conversation = withFreshSession(conversationFrom(Array.from(
      { length: 30 },
      (_, index) => ({ user: `问题 ${index + 1}`, assistant: `回答 ${index + 1}` }),
    )), 'claude');
    const store = new FakeContextStore(conversation);

    const prepared = await service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'claude',
      currentPrompt: '使用刚切换的模型继续。',
      // Missing resumeCandidate means the model/config fingerprint changed.
      modelContextTokens: 1_000_000,
      modelOutputReserveTokens: 20_000,
    });

    expect(prepared.mode).toBe('fresh-handoff');
    expect(prepared.contextCheckpointDraft).toBeUndefined();
    expect(prepared.sessionId).toBeUndefined();
    expect(prepared.notice).toBe('');
    expect(prepared.effectivePrompt).toContain('问题 1');
    expect(prepared.effectivePrompt).toContain('回答 30');
  });

  it('prepares a provider-neutral fallback for a valid Codex resume without changing its ordinary prompt', async () => {
    const conversation = withFreshSession(conversationFrom([
      { agentId: 'codex', user: '记住文章标题。', assistant: '标题已记住。' },
    ]), 'codex');
    const store = new FakeContextStore(conversation);

    const prepared = await service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'codex',
      currentPrompt: '继续写正文。',
      resumeCandidate: 'codex-session',
    });

    expect(prepared.effectivePrompt).toBe('继续写正文。');
    expect(prepared.sessionId).toBe('codex-session');
    expect(prepared.allowFreshSessionFallback).toBe(true);
    expect(prepared.freshSessionPrompt).toContain('记住文章标题');
    expect(store.fullCalls).toBe(0);
    expect(store.commitCalls).toHaveLength(0);
  });

  it('never carries a secret or absolute path from a stored checkpoint across Agents', async () => {
    let conversation = conversationFrom([
      { agentId: 'claude', user: '第一轮', assistant: '第一轮完成' },
      { agentId: 'claude', user: '第二轮', assistant: '第二轮完成' },
    ]);
    conversation = {
      ...conversation,
      contextCheckpoint: checkpointAt(conversation, 1, {
        ...EMPTY_SUMMARY,
        facts: ['FEISHU_APP_SECRET=stored-secret-value'],
        filesMentioned: ['/Users/example/private.md'],
        lastIntent: '继续处理 token=stored-token-value',
      }),
    };
    const store = new FakeContextStore(conversation);

    const prepared = await service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'codex',
      currentPrompt: '请接手。',
    });

    expect(prepared.mode).toBe('fresh-handoff');
    expect(prepared.effectivePrompt).not.toContain('stored-secret-value');
    expect(prepared.effectivePrompt).not.toContain('stored-token-value');
    expect(prepared.effectivePrompt).not.toContain('/Users/example');
    expect(prepared.effectivePrompt).toContain('[REDACTED_SECRET]');
    expect(prepared.effectivePrompt).toContain('[REDACTED_ABSOLUTE_PATH]');
  });
});

describe('ChatContextService checkpoints', () => {
  it('creates post-compaction headroom so the next completed turn does not compact again', async () => {
    const specs = Array.from({ length: 12 }, (_, index) => ({
      user: `${index + 1}:${'中'.repeat(300)}`,
      assistant: `${index + 1}:${'答'.repeat(300)}`,
    }));
    const conversation = withFreshSession(conversationFrom(specs), 'claude');
    const store = new FakeContextStore(conversation);
    const contextService = service(store, { summaryTokenLimit: 1_000 });

    const compacted = await contextService.prepare({
      conversationId: conversation.id,
      targetAgentId: 'claude',
      currentPrompt: '继续。',
      resumeCandidate: 'claude-session',
      modelContextTokens: 32_000,
      modelOutputReserveTokens: 20_000,
      reservedInputTokens: 4_000,
    });
    expect(compacted.mode).toBe('checkpoint-handoff');
    expect(compacted.contextCheckpointDraft).toBeDefined();
    expect(compacted.notice).toBe('上下文接近上限，已整理较早对话；完整记录仍保留。');

    const nextConversation = conversationFrom([
      ...specs,
      { user: '继续。', assistant: '这一轮已经完成。' },
    ], {
      revision: conversation.revision + 3,
      contextCheckpoint: {
        ...compacted.contextCheckpointDraft!,
        prefixSha256: 'c'.repeat(64),
      },
      sessionIds: { claude: 'claude-after-checkpoint' },
      sessionOwnerships: {
        claude: {
          sessionId: 'claude-after-checkpoint',
          conversationId: conversation.id,
          agentId: 'claude',
          claimedAt: 2_000,
          runId: 'turn-13',
        },
      },
    });
    store.conversation = nextConversation;

    const followup = await contextService.prepare({
      conversationId: conversation.id,
      targetAgentId: 'claude',
      currentPrompt: '再继续一轮。',
      resumeCandidate: 'claude-after-checkpoint',
      modelContextTokens: 32_000,
      modelOutputReserveTokens: 20_000,
      reservedInputTokens: 4_000,
    });
    expect(followup.mode).toBe('native-resume');
    expect(followup.contextCheckpointDraft).toBeUndefined();
    expect(followup.notice).toBe('');
  });

  it('extends an existing checkpoint atomically and does not duplicate its summary', async () => {
    let conversation = conversationFrom(Array.from({ length: 10 }, (_, index) => ({
      agentId: 'claude' as const,
      user: index === 2 ? '决定继续使用现有架构。' : `用户消息 ${index + 1}`,
      assistant: `助手回答 ${index + 1}`,
    })));
    const oldSummary: ConversationContextSummary = {
      ...EMPTY_SUMMARY,
      decisions: ['保留完整聊天记录'],
      lastIntent: '继续实现',
    };
    conversation = {
      ...conversation,
      contextCheckpoint: checkpointAt(conversation, 2, oldSummary),
    };
    const store = new FakeContextStore(conversation);

    const prepared = await service(store, {
      checkpointTurnLimit: 8,
      rawTailTurns: 6,
    }).prepare({
      conversationId: conversation.id,
      targetAgentId: 'codex',
      currentPrompt: '请继续。',
    });

    expect(prepared.mode).toBe('checkpoint-handoff');
    expect(store.commitCalls).toHaveLength(0);
    const draft = prepared.contextCheckpointDraft;
    expect(draft?.previousCheckpointId).toBe('checkpoint-old');
    expect(draft?.throughMessageSequence).toBeGreaterThan(4);
    expect(draft?.throughMessageId).toBe(
      conversation.messages[(draft?.throughMessageSequence ?? 1) - 1]?.id,
    );
    expect(draft?.summary.decisions.filter(value => value === '保留完整聊天记录')).toHaveLength(1);
    expect(draft?.summary.decisions).toContain('决定继续使用现有架构。');
    expect(readHandoff(prepared.effectivePrompt).recentCompletedTurns.length).toBeLessThanOrEqual(6);
  });

  it('uses an existing checkpoint directly when it already covers all completed turns', async () => {
    let conversation = conversationFrom([
      { user: '决定保留完整记录。', assistant: '已记录。' },
    ]);
    conversation = {
      ...conversation,
      contextCheckpoint: checkpointAt(conversation, 1, {
        ...EMPTY_SUMMARY,
        decisions: ['决定保留完整记录。'],
        lastIntent: '等待继续',
      }),
    };
    const store = new FakeContextStore(conversation);

    const prepared = await service(store, { checkpointTurnLimit: 1 }).prepare({
      conversationId: conversation.id,
      targetAgentId: 'codex',
      currentPrompt: '现在继续。',
    });

    expect(prepared.mode).toBe('fresh-handoff');
    expect(prepared.contextCheckpointId).toBe('checkpoint-old');
    expect(store.commitCalls).toHaveLength(0);
    expect(readHandoff(prepared.effectivePrompt).checkpoint.decisions).toContain('决定保留完整记录。');
  });

  it('loads complete legacy history to prove the budget without forcing a turn-count checkpoint', async () => {
    const specs = Array.from({ length: 60 }, (_, index) => ({
      user: `旧消息 ${index + 1}`,
      assistant: `旧回答 ${index + 1}`,
    }));
    const conversation = withFreshSession(conversationFrom(specs), 'claude');
    const store = new FakeContextStore(conversation);

    const prepared = await service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'claude',
      currentPrompt: '继续长期对话。',
      resumeCandidate: 'claude-session',
    });

    expect(prepared.mode).toBe('native-resume');
    expect(store.windowCalls).toBe(1);
    expect(store.fullCalls).toBe(1);
    expect(store.commitCalls).toHaveLength(0);
    expect(prepared.contextCheckpointDraft).toBeUndefined();
    expect(store.conversation.messages).toHaveLength(120);
  });

  it('uses canonical sequence offsets for checkpoint 900 plus bounded messages 901 through 1000', async () => {
    const specs = Array.from({ length: 500 }, (_, index) => ({
      user: `消息 ${index + 1}`,
      assistant: `回答 ${index + 1}`,
    }));
    let conversation = conversationFrom(specs);
    conversation = {
      ...withFreshSession(conversation, 'claude'),
      contextCheckpoint: checkpointAt(conversation, 450, {
        ...EMPTY_SUMMARY,
        facts: ['前 450 轮已整理'],
      }),
    };
    const store = new FakeContextStore(conversation);

    const prepared = await service(store, {
      checkpointTurnLimit: 50,
      rawTailTurns: 6,
    }).prepare({
      conversationId: conversation.id,
      targetAgentId: 'claude',
      currentPrompt: '继续。',
      resumeCandidate: 'claude-session',
    });

    expect(prepared.mode).toBe('checkpoint-handoff');
    expect(store.fullCalls).toBe(0);
    expect(prepared.contextCheckpointDraft?.previousCheckpointId).toBe('checkpoint-old');
    expect(prepared.contextCheckpointDraft?.throughMessageSequence).toBe(988);
    expect(prepared.contextCheckpointDraft?.throughMessageId).toBe('turn-494-assistant');
    const payload = readHandoff(prepared.effectivePrompt);
    expect(payload.recentCompletedTurns).toHaveLength(6);
    expect(JSON.stringify(payload)).toContain('"sequence":989');
    expect(JSON.stringify(payload)).toContain('"sequence":1000');
  });

  it('reduces the exact raw tail until a hard context boundary is safe', async () => {
    const long = '需要继续处理。'.repeat(400);
    const conversation = conversationFrom(Array.from({ length: 8 }, (_, index) => ({
      user: `${index + 1}:${long}`,
      assistant: `${index + 1}:${long}`,
    })));
    const store = new FakeContextStore(conversation);

    const prepared = await service(store, {
      summaryTokenLimit: 2_000,
    }).prepare({
      conversationId: conversation.id,
      targetAgentId: 'codex',
      currentPrompt: '继续。',
      modelContextTokens: 12_000,
      modelOutputReserveTokens: 1_000,
      hardOutputReserveTokens: 500,
    });

    expect(prepared.mode).toBe('checkpoint-handoff');
    const rawTail = readHandoff(prepared.effectivePrompt).recentCompletedTurns;
    expect(rawTail.length).toBeLessThan(6);
    expect(store.commitCalls).toHaveLength(0);
    expect(prepared.contextCheckpointDraft).toBeDefined();
  });

  it('fails closed when even a zero-tail checkpoint cannot fit the current request', async () => {
    const conversation = conversationFrom([{ user: '旧问题', assistant: '旧回答' }]);
    const store = new FakeContextStore(conversation);

    await expect(service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'codex',
      currentPrompt: '中'.repeat(5_000),
      modelContextTokens: 1_000,
      modelOutputReserveTokens: 200,
      hardOutputReserveTokens: 50,
    })).rejects.toBeInstanceOf(ChatContextOverflowError);
    expect(store.commitCalls).toHaveLength(0);
  });

  it('does not write a no-progress checkpoint when the current request alone exceeds the byte envelope', async () => {
    const conversation = conversationFrom([
      { user: '旧问题一', assistant: '旧回答一' },
      { user: '旧问题二', assistant: '旧回答二' },
    ]);
    const store = new FakeContextStore(conversation);

    await expect(service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'codex',
      currentPrompt: 'a'.repeat(800_000),
      modelContextTokens: 1_000_000,
      modelOutputReserveTokens: 20_000,
      maxRequestBytes: 1024 * 1024,
    })).rejects.toBeInstanceOf(ChatContextOverflowError);
    expect(store.commitCalls).toHaveLength(0);
    expect(store.conversation.contextCheckpoint).toBeUndefined();
  });

  it('fails closed when an oversized request has no projectable history to compress', async () => {
    const conversation = withFreshSession(conversationFrom([
      { user: '   ', assistant: '   ' },
    ]), 'claude');
    const store = new FakeContextStore(conversation);

    await expect(service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'claude',
      currentPrompt: '中'.repeat(1_200),
      resumeCandidate: 'claude-session',
      modelContextTokens: 1_000,
      modelOutputReserveTokens: 200,
      hardOutputReserveTokens: 50,
    })).rejects.toBeInstanceOf(ChatContextOverflowError);
    expect(store.commitCalls).toHaveLength(0);
  });

  it('prepares a revision-bound checkpoint without mutating canonical storage', async () => {
    const conversation = conversationFrom(Array.from({ length: 8 }, (_, index) => ({
      user: `消息 ${index + 1}`,
      assistant: `回答 ${index + 1}`,
    })));
    const store = new FakeContextStore(conversation);
    const prepared = await service(store, { checkpointTurnLimit: 8 }).prepare({
      conversationId: conversation.id,
      targetAgentId: 'codex',
      currentPrompt: '继续。',
    });

    expect(prepared.contextCheckpointDraft).toMatchObject({
      id: 'checkpoint-new',
      sourceRevision: conversation.revision,
    });
    expect(store.commitCalls).toHaveLength(0);
    expect(store.conversation.revision).toBe(conversation.revision);
  });

  it('keeps provider metadata, errors, secrets, and absolute paths out of handoff material', async () => {
    const conversation = conversationFrom([
      {
        user: 'token=very-secret-value。\n读取 /Users/example/private.txt。',
        assistant: '普通回答',
      },
      {
        user: '失败输入不应出现',
        assistant: '失败输出不应出现',
        state: 'failed',
      },
    ]);
    const store = new FakeContextStore(conversation);

    const prepared = await service(store).prepare({
      conversationId: conversation.id,
      targetAgentId: 'codex',
      currentPrompt: '继续。',
    });
    const serialized = prepared.effectivePrompt;

    expect(serialized).toContain('[REDACTED_ABSOLUTE_PATH]');
    expect(serialized).toContain('[REDACTED_SECRET]');
    expect(serialized).not.toContain('/Users/example');
    expect(serialized).not.toContain('very-secret-value');
    expect(serialized).not.toContain('失败输入不应出现');
    expect(serialized).not.toContain('privateRuntimeField');
    expect(serialized).not.toContain('toolTranscript');
    expect(serialized).not.toContain('hidden-tool');
  });
});
