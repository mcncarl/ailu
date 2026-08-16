import type {
  AgentId,
  ConversationContextCheckpointDraft,
  ConversationContextSummary,
} from '../types';
import type { VersionedStoredConversation } from '../storage/vaultStore';
import type { ConversationWindow } from '../storage/conversationRepositoryV2';
import { createId } from '../utils/id';
import {
  buildConversationHandoffPrompt,
  buildDeterministicFallbackSummary,
  DEFAULT_HARD_OUTPUT_RESERVE_TOKENS,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MODEL_OUTPUT_RESERVE_TOKENS,
  DEFAULT_RAW_TAIL_TOKENS,
  DEFAULT_UNKNOWN_CONTEXT_TOKENS,
  estimateContextBudget,
  estimateContextTokens,
  evaluateTargetSessionFreshness,
  projectCompletedConversation,
  sanitizeConversationContextSummary,
  selectRawTail,
  selectRawTailByTokenBudget,
  type CompletedConversationProjection,
  type ContextBudgetEstimate,
  type ContextTailSelection,
  type ProjectedContextTurn,
} from './contextCompression';

const DEFAULT_WINDOW_MESSAGES = 100;
const DEFAULT_SAFETY_FACTOR = 1.25;

export type ChatContextPreparationMode =
  | 'new-conversation'
  | 'native-resume'
  | 'fresh-handoff'
  | 'checkpoint-handoff';

export interface ChatContextPreparation {
  effectivePrompt: string;
  /** Canonical revision used to prepare this prompt; beginTurn must match it. */
  sourceRevision?: number;
  sessionId?: string;
  freshSessionPrompt?: string;
  allowFreshSessionFallback: boolean;
  contextCheckpointId?: string;
  /** Committed atomically with beginTurn; preparation itself is read-only. */
  contextCheckpointDraft?: ConversationContextCheckpointDraft;
  mode: ChatContextPreparationMode;
  notice: string;
}

export interface PrepareChatContextInput {
  conversationId: string;
  targetAgentId: AgentId;
  currentPrompt: string;
  /** A session already validated against the active runtime configuration. */
  resumeCandidate?: string;
  modelContextTokens?: number;
  modelOutputReserveTokens?: number;
  hardOutputReserveTokens?: number;
  /** System prompt and other caller-visible request components not in currentPrompt. */
  requestOverheadText?: readonly string[];
  /** Fixed hidden runtime/tool and binary-attachment allowance. */
  reservedInputTokens?: number;
  reservedRequestBytes?: number;
  maxRequestBytes?: number;
}

export interface ChatContextStore {
  loadConversationWindow(conversationId: string, limit?: number): Promise<ConversationWindow | null>;
  getConversation(conversationId: string): Promise<VersionedStoredConversation | null>;
}

export interface ChatContextServiceOptions {
  store: ChatContextStore;
  now?: () => number;
  createCheckpointId?: () => string;
  windowMessages?: number;
  /** Optional legacy cap; the default recent tail is token-bounded, not turn-bounded. */
  rawTailTurns?: number;
  rawTailTokens?: number;
  /** Disabled by default. Production checkpoints are budget-driven. */
  checkpointTurnLimit?: number;
  safetyFactor?: number;
  summaryTokenLimit?: number;
}

export class ChatContextOverflowError extends Error {
  constructor(message = '当前消息和上下文过长，无法在所选模型的安全范围内发送。请减少附件或输入长度后重试。') {
    super(message);
    this.name = 'ChatContextOverflowError';
  }
}

/**
 * Turns the canonical V2 transcript into a provider-neutral handoff only when
 * a native provider session can no longer be trusted as current. Provider
 * sessions are accelerators; they never become the source of conversation
 * truth.
 */
export class ChatContextService {
  private readonly now: () => number;
  private readonly createCheckpointId: () => string;
  private readonly windowMessages: number;
  private readonly rawTailTurnCap: number | null;
  private readonly rawTailTokens: number;
  private readonly checkpointTurnLimit: number | null;
  private readonly safetyFactor: number;
  private readonly summaryTokenLimit: number;

  constructor(private readonly options: ChatContextServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createCheckpointId = options.createCheckpointId ?? (() => createId('ctx'));
    this.windowMessages = positiveInteger(options.windowMessages, DEFAULT_WINDOW_MESSAGES);
    this.rawTailTurnCap = options.rawTailTurns === undefined
      ? null
      : nonNegativeInteger(options.rawTailTurns, 0);
    this.rawTailTokens = positiveInteger(options.rawTailTokens, DEFAULT_RAW_TAIL_TOKENS);
    this.checkpointTurnLimit = options.checkpointTurnLimit === undefined
      ? null
      : positiveInteger(options.checkpointTurnLimit, Number.MAX_SAFE_INTEGER);
    this.safetyFactor = positiveNumber(options.safetyFactor, DEFAULT_SAFETY_FACTOR);
    this.summaryTokenLimit = positiveInteger(options.summaryTokenLimit, 4_096);
  }

  async prepare(input: PrepareChatContextInput): Promise<ChatContextPreparation> {
    const conversationId = requireText(input.conversationId, 'conversationId');
    const currentPrompt = requireText(input.currentPrompt, 'currentPrompt');
    const budgetPolicy = resolveBudgetPolicy(input);
    const window = await this.options.store.loadConversationWindow(
      conversationId,
      this.windowMessages,
    );
    if (!window) throw new Error(`Conversation ${conversationId} was not found.`);

    const completedTurns = window.conversation.turns.filter(turn => turn.state === 'completed');
    if (completedTurns.length === 0) {
      this.assertCurrentPromptFits(currentPrompt, budgetPolicy);
      return {
        effectivePrompt: currentPrompt,
        sourceRevision: window.conversation.revision,
        allowFreshSessionFallback: false,
        mode: 'new-conversation',
        notice: '',
      };
    }

    const storedSession = window.conversation.sessionIds?.[input.targetAgentId]?.trim();
    const resumeCandidate = input.resumeCandidate?.trim();
    const freshness = evaluateTargetSessionFreshness(
      window.conversation,
      input.targetAgentId,
    );
    const canResume = Boolean(
      resumeCandidate
      && storedSession
      && resumeCandidate === storedSession
      && !freshness.stale,
    );
    const latestCompletedTurn = completedTurns
      .slice()
      .sort((left, right) => left.queueSequence - right.queueSequence || left.id.localeCompare(right.id))
      .at(-1);
    const agentSwitch = latestCompletedTurn?.agentId !== input.targetAgentId;
    const needsFreshHandoff = !canResume || agentSwitch;
    const postCheckpointTurnCount = countCompletedTurnsAfterCheckpoint(window.conversation);
    const turnLimitReached = this.checkpointTurnLimit !== null
      && postCheckpointTurnCount >= this.checkpointTurnLimit;

    let source = deriveWindowSource(window);
    const codexFallbackNeeded = canResume && input.targetAgentId === 'codex';
    // A bounded window cannot prove the complete request budget when an older
    // uncheckpointed prefix exists. Load canonical history instead of guessing.
    if (!source.safe) {
      const full = await this.options.store.getConversation(conversationId);
      if (!full) throw new Error(`Conversation ${conversationId} was not found.`);
      source = deriveFullSource(full);
    }

    const sourceBudget = estimateContextBudget({
      projection: source.projection,
      previousSummary: checkpointSummary(source.conversation),
      additionalText: [...budgetPolicy.requestOverheadText, currentPrompt],
      ...budgetEstimateOptions(budgetPolicy, this.safetyFactor),
    });
    const budgetCheckpointNeeded = sourceBudget.overSoftLimit;
    let checkpointNeeded = turnLimitReached || budgetCheckpointNeeded;

    if (checkpointNeeded && source.projection.turns.length === 0) {
      // A turn-count test hook may be irrelevant when nothing is projectable,
      // but a real budget overflow with no compressible prefix must fail here.
      if (budgetCheckpointNeeded) throw new ChatContextOverflowError();
      checkpointNeeded = false;
    }

    if (checkpointNeeded) {
      const compression = this.chooseSafeCompression(
        source.projection,
        checkpointSummary(source.conversation),
        currentPrompt,
        budgetPolicy,
        true,
        sourceBudget,
        true,
      );
      if (!compression.selection.summarySource.length
        || compression.selection.throughMessageSequence === null
        || !compression.selection.throughMessageId) {
        throw new ChatContextOverflowError();
      }
      const draft: ConversationContextCheckpointDraft = {
        version: 1,
        id: this.createCheckpointId(),
        createdAt: this.now(),
        sourceRevision: source.conversation.revision,
        throughMessageSequence: compression.selection.throughMessageSequence,
        throughMessageId: compression.selection.throughMessageId,
        projectionVersion: 1,
        summary: compression.summary,
        createdBy: 'local',
        ...(source.conversation.contextCheckpoint
          ? { previousCheckpointId: source.conversation.contextCheckpoint.id }
          : {}),
      };
      const freshSessionPrompt = appendCurrentPrompt(
        buildConversationHandoffPrompt({
          summary: draft.summary,
          rawTail: compression.selection.rawTail,
          targetAgentId: input.targetAgentId,
        }),
        currentPrompt,
      );
      return {
        effectivePrompt: freshSessionPrompt,
        sourceRevision: source.conversation.revision,
        freshSessionPrompt,
        allowFreshSessionFallback: false,
        contextCheckpointId: draft.id,
        contextCheckpointDraft: draft,
        mode: 'checkpoint-handoff',
        notice: '上下文接近上限，已整理较早对话；完整记录仍保留。',
      };
    }

    if (needsFreshHandoff) {
      const compression = this.chooseSafeCompression(
        source.projection,
        checkpointSummary(source.conversation),
        currentPrompt,
        budgetPolicy,
        false,
        sourceBudget,
        false,
      );
      const freshSessionPrompt = appendCurrentPrompt(
        buildConversationHandoffPrompt({
          summary: compression.summary,
          rawTail: compression.selection.rawTail,
          targetAgentId: input.targetAgentId,
        }),
        currentPrompt,
      );
      return {
        effectivePrompt: freshSessionPrompt,
        sourceRevision: source.conversation.revision,
        freshSessionPrompt,
        allowFreshSessionFallback: false,
        ...(source.conversation.contextCheckpoint
          ? { contextCheckpointId: source.conversation.contextCheckpoint.id }
          : {}),
        mode: 'fresh-handoff',
        notice: '',
      };
    }

    if (codexFallbackNeeded) {
      const compression = this.chooseSafeCompression(
        source.projection,
        checkpointSummary(source.conversation),
        currentPrompt,
        budgetPolicy,
        false,
        sourceBudget,
        false,
      );
      const freshSessionPrompt = appendCurrentPrompt(
        buildConversationHandoffPrompt({
          summary: compression.summary,
          rawTail: compression.selection.rawTail,
          targetAgentId: input.targetAgentId,
        }),
        currentPrompt,
      );
      return {
        effectivePrompt: currentPrompt,
        sourceRevision: source.conversation.revision,
        sessionId: resumeCandidate,
        freshSessionPrompt,
        allowFreshSessionFallback: true,
        ...(source.conversation.contextCheckpoint
          ? { contextCheckpointId: source.conversation.contextCheckpoint.id }
          : {}),
        mode: 'native-resume',
        notice: '',
      };
    }

    if (sourceBudget.overHardLimit) throw new ChatContextOverflowError();
    return {
      effectivePrompt: currentPrompt,
      sourceRevision: source.conversation.revision,
      sessionId: resumeCandidate,
      allowFreshSessionFallback: false,
      mode: 'native-resume',
      notice: '',
    };
  }

  private chooseSafeCompression(
    projection: CompletedConversationProjection,
    previousSummary: ConversationContextSummary | undefined,
    currentPrompt: string,
    budgetPolicy: ContextBudgetPolicy,
    requireCheckpointBoundary: boolean,
    sourceBudget: ContextBudgetEstimate,
    requireHeadroom: boolean,
  ): CompressionMaterial {
    const tokenBounded = selectRawTailByTokenBudget(projection, this.rawTailTokens);
    const maxTail = Math.min(
      tokenBounded.rawTail.length,
      this.rawTailTurnCap ?? projection.turns.length,
    );
    const target = requireHeadroom
      ? compactionTarget(sourceBudget)
      : { tokens: sourceBudget.softLimitTokens, bytes: sourceBudget.softLimitBytes };
    for (let tailTurns = maxTail; tailTurns >= 0; tailTurns -= 1) {
      const selection = selectCheckpointSafeTail(projection, tailTurns);
      if (requireCheckpointBoundary && selection.summarySource.length === 0) continue;
      const summaryDelta = buildDeterministicFallbackSummary({
        ...projection,
        turns: selection.summarySource,
      });
      const summary = trimSummaryToTokenBudget(
        mergeContextSummaries(previousSummary, summaryDelta),
        this.summaryTokenLimit,
      );
      const compactedProjection: CompletedConversationProjection = {
        ...projection,
        turns: selection.rawTail,
      };
      const budget = estimateContextBudget({
        projection: compactedProjection,
        previousSummary: summary,
        additionalText: [...budgetPolicy.requestOverheadText, currentPrompt],
        ...budgetEstimateOptions(budgetPolicy, this.safetyFactor),
      });
      if (
        !budget.overHardLimit
        && budget.estimatedTokens <= target.tokens
        && budget.estimatedBytes <= target.bytes
        && (!requireHeadroom || hasMeaningfulCompressionProgress(sourceBudget, budget, target))
      ) return { selection, summary, budget };
    }
    throw new ChatContextOverflowError();
  }

  private assertCurrentPromptFits(
    currentPrompt: string,
    budgetPolicy: ContextBudgetPolicy,
  ): void {
    const budget = estimateContextBudget({
      additionalText: [...budgetPolicy.requestOverheadText, currentPrompt],
      ...budgetEstimateOptions(budgetPolicy, this.safetyFactor),
    });
    if (budget.overSoftLimit) throw new ChatContextOverflowError();
  }
}

interface CanonicalProjectionSource {
  conversation: VersionedStoredConversation;
  projection: CompletedConversationProjection;
  safe: boolean;
}

interface CompressionMaterial {
  selection: ContextTailSelection;
  summary: ConversationContextSummary;
  budget: ContextBudgetEstimate;
}

interface ContextBudgetPolicy {
  modelContextTokens: number;
  outputReserveTokens: number;
  hardOutputReserveTokens: number;
  requestOverheadText: readonly string[];
  reservedTokens: number;
  reservedBytes: number;
  maxRequestBytes: number;
}

function resolveBudgetPolicy(input: PrepareChatContextInput): ContextBudgetPolicy {
  return {
    modelContextTokens: positiveInteger(
      input.modelContextTokens,
      DEFAULT_UNKNOWN_CONTEXT_TOKENS,
    ),
    outputReserveTokens: positiveInteger(
      input.modelOutputReserveTokens,
      DEFAULT_MODEL_OUTPUT_RESERVE_TOKENS,
    ),
    hardOutputReserveTokens: positiveInteger(
      input.hardOutputReserveTokens,
      DEFAULT_HARD_OUTPUT_RESERVE_TOKENS,
    ),
    requestOverheadText: input.requestOverheadText?.filter(Boolean) ?? [],
    reservedTokens: nonNegativeInteger(input.reservedInputTokens, 0),
    reservedBytes: nonNegativeInteger(input.reservedRequestBytes, 0),
    maxRequestBytes: positiveInteger(input.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES),
  };
}

function budgetEstimateOptions(
  policy: ContextBudgetPolicy,
  safetyFactor: number,
): Pick<
  Parameters<typeof estimateContextBudget>[0],
  | 'modelContextTokens'
  | 'outputReserveTokens'
  | 'hardOutputReserveTokens'
  | 'reservedTokens'
  | 'reservedBytes'
  | 'maxRequestBytes'
  | 'safetyFactor'
> {
  return {
    modelContextTokens: policy.modelContextTokens,
    outputReserveTokens: policy.outputReserveTokens,
    hardOutputReserveTokens: policy.hardOutputReserveTokens,
    reservedTokens: policy.reservedTokens,
    reservedBytes: policy.reservedBytes,
    maxRequestBytes: policy.maxRequestBytes,
    safetyFactor,
  };
}

function compactionTarget(budget: ContextBudgetEstimate): { tokens: number; bytes: number } {
  const tokenHeadroom = Math.min(
    Math.max(1, Math.floor(budget.softLimitTokens / 3)),
    Math.max(8_000, Math.floor(budget.contextWindowTokens * 0.1)),
  );
  const byteHeadroom = Math.min(
    Math.max(1, Math.floor(budget.softLimitBytes / 4)),
    128 * 1024,
  );
  return {
    tokens: Math.max(1, budget.softLimitTokens - tokenHeadroom),
    bytes: Math.max(1, budget.softLimitBytes - byteHeadroom),
  };
}

function hasMeaningfulCompressionProgress(
  source: ContextBudgetEstimate,
  compacted: ContextBudgetEstimate,
  target: { tokens: number; bytes: number },
): boolean {
  const tokenReduction = source.estimatedTokens - compacted.estimatedTokens;
  const byteReduction = source.estimatedBytes - compacted.estimatedBytes;
  const requiredTokenReduction = Math.min(
    4_000,
    Math.max(1, source.estimatedTokens - target.tokens),
  );
  const requiredByteReduction = Math.min(
    64 * 1024,
    Math.max(1, source.estimatedBytes - target.bytes),
  );
  if (source.overSoftTokenLimit && tokenReduction < requiredTokenReduction) return false;
  if (source.overSoftByteLimit && byteReduction < requiredByteReduction) return false;
  if (!source.overSoftTokenLimit && !source.overSoftByteLimit) {
    return tokenReduction > 0 || byteReduction > 0;
  }
  return true;
}

function trimSummaryToTokenBudget(
  summary: ConversationContextSummary,
  maxTokens: number,
): ConversationContextSummary {
  const trimmed: ConversationContextSummary = {
    facts: [...summary.facts],
    decisions: [...summary.decisions],
    userPreferences: [...summary.userPreferences],
    constraints: [...summary.constraints],
    openLoops: [...summary.openLoops],
    filesMentioned: [...summary.filesMentioned],
    lastIntent: summary.lastIntent,
  };
  // Discard lower-value/older material first. Constraints, open work and the
  // latest intent are the last things a continuation should lose.
  const discardOrder = [
    'facts',
    'filesMentioned',
    'decisions',
    'userPreferences',
    'openLoops',
    'constraints',
  ] as const;
  while (estimateContextTokens(JSON.stringify(trimmed)) > maxTokens) {
    const candidate = discardOrder.find(key => trimmed[key].length > 0);
    if (candidate) {
      trimmed[candidate].shift();
      continue;
    }
    if (!trimmed.lastIntent) break;
    const characters = Array.from(trimmed.lastIntent);
    trimmed.lastIntent = characters.slice(Math.ceil(characters.length / 4)).join('');
  }
  return trimmed;
}

function deriveWindowSource(window: ConversationWindow): CanonicalProjectionSource {
  const loadedCount = window.conversation.messages.length;
  const offset = Math.max(0, window.totalMessageCount - loadedCount);
  const checkpointBoundary = window.conversation.contextCheckpoint?.throughMessageSequence ?? 0;
  const safe = offset === 0 || checkpointBoundary >= offset;
  const projected = projectCompletedConversation(window.conversation);
  const projection: CompletedConversationProjection = {
    ...projected,
    turns: projected.turns.flatMap<ProjectedContextTurn>(turn => {
      const messages = turn.messages
        .map(message => ({ ...message, sequence: message.sequence + offset }))
        .filter(message => message.sequence > checkpointBoundary);
      return messages.length > 0 ? [{ ...turn, messages }] : [];
    }),
  };
  return { conversation: window.conversation, projection, safe };
}

function deriveFullSource(conversation: VersionedStoredConversation): CanonicalProjectionSource {
  const projected = projectCompletedConversation(conversation);
  const checkpointBoundary = conversation.contextCheckpoint?.throughMessageSequence ?? 0;
  return {
    conversation,
    projection: {
      ...projected,
      turns: projected.turns.flatMap<ProjectedContextTurn>(turn => {
        const messages = turn.messages.filter(message => message.sequence > checkpointBoundary);
        return messages.length > 0 ? [{ ...turn, messages }] : [];
      }),
    },
    safe: true,
  };
}

function countCompletedTurnsAfterCheckpoint(conversation: VersionedStoredConversation): number {
  const completed = conversation.turns
    .filter(turn => turn.state === 'completed')
    .sort((left, right) => left.queueSequence - right.queueSequence || left.id.localeCompare(right.id));
  const boundaryId = conversation.contextCheckpoint?.throughMessageId;
  if (!boundaryId) return completed.length;
  const boundaryIndex = completed.findIndex(turn => turn.assistantMessageId === boundaryId);
  return boundaryIndex < 0 ? completed.length : completed.length - boundaryIndex - 1;
}

function selectCheckpointSafeTail(
  projection: CompletedConversationProjection,
  maxTurns: number,
): ContextTailSelection {
  const initial = selectRawTail(projection, maxTurns);
  if (initial.summarySource.length === 0) return initial;
  let boundary = initial.summarySource.length;
  while (boundary > 0) {
    const turn = projection.turns[boundary - 1];
    const last = turn?.messages.at(-1);
    if (turn && last?.role === 'assistant') break;
    boundary -= 1;
  }
  const summarySource = projection.turns.slice(0, boundary);
  const rawTail = projection.turns.slice(boundary);
  const boundaryMessage = summarySource.at(-1)?.messages.at(-1);
  return {
    summarySource,
    rawTail,
    throughMessageSequence: boundaryMessage?.sequence ?? null,
    throughMessageId: boundaryMessage?.id ?? null,
  };
}

function mergeContextSummaries(
  previous: ConversationContextSummary | undefined,
  current: ConversationContextSummary,
): ConversationContextSummary {
  if (!previous) return current;
  return {
    facts: mergeSummaryItems(previous.facts, current.facts),
    decisions: mergeSummaryItems(previous.decisions, current.decisions),
    userPreferences: mergeSummaryItems(previous.userPreferences, current.userPreferences),
    constraints: mergeSummaryItems(previous.constraints, current.constraints),
    openLoops: mergeSummaryItems(previous.openLoops, current.openLoops),
    filesMentioned: mergeSummaryItems(previous.filesMentioned, current.filesMentioned),
    lastIntent: current.lastIntent || previous.lastIntent,
  };
}

function checkpointSummary(
  conversation: VersionedStoredConversation,
): ConversationContextSummary | undefined {
  return conversation.contextCheckpoint
    ? sanitizeConversationContextSummary(conversation.contextCheckpoint.summary)
    : undefined;
}

function mergeSummaryItems(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].slice(-32);
}

function appendCurrentPrompt(handoff: string, currentPrompt: string): string {
  return `${handoff}\n\n当前回合输入：\n${currentPrompt}`;
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must not be empty.`);
  return normalized;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}
