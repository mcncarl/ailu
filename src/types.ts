import type { WeChatThemeId } from './wechat/themes';
import type { FeishuDestinationKind } from './feishu/destination';
import {
  DEFAULT_PUBLISHING_SETTINGS,
  type PublishingSettings,
} from './settings/publishingSettings';
import {
  DEFAULT_X_PUBLISHING_SETTINGS,
  type XPublishingSettings,
} from './settings/xPublishingSettings';

export type AgentId = 'claude' | 'codex';

export type RuntimeConfigSource = 'localCli' | 'ccSwitchCurrent' | 'providerProfile';

export type RuntimeBinarySource = 'configured' | 'desktopApp' | 'managed' | 'path';

export type AgentStatusState = 'ready' | 'missing' | 'unsupported';

export type ProviderWireApi = 'responses' | 'chat';

export type AnthropicAuthMode = 'apiKey' | 'authToken';

export interface AgentDescriptor {
  id: AgentId;
  displayName: string;
  shortName: string;
  packageName: string;
  binaryName: string;
  bestFor: string;
  supportsImages: boolean;
  supportsInlineEdit: boolean;
  supportsProviderProfiles: boolean;
  docsUrl: string;
}

export interface AgentStatus {
  agentId: AgentId;
  descriptor: AgentDescriptor;
  state: AgentStatusState;
  found: boolean;
  binaryPath: string | null;
  source: RuntimeBinarySource | null;
  version: string | null;
  configuredPath: string;
  managedDir: string;
  configSource: RuntimeConfigSource;
  localConfigFound: boolean;
  error: string | null;
}

export interface ProviderProfile {
  id: string;
  agentId: AgentId;
  name: string;
  apiKey: string;
  baseUrl: string;
  /** Backward-compatible alias for `defaultModel`. */
  model: string;
  /** Default model used for runs. Always present in `models` when set. */
  defaultModel: string;
  /** All models available on this provider (fetched or hand-entered). */
  models: string[];
  /** Codex provider protocol. Defaults to chat for OpenAI-compatible endpoints. */
  wireApi: ProviderWireApi;
  /** Authentication header used by Claude Code for Anthropic-compatible endpoints. */
  anthropicAuthMode?: AnthropicAuthMode;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  /** Present only for a legacy/invalid profile kept visible for repair. */
  configurationError?: string;
}

export type ExportedProviderProfile = Omit<ProviderProfile, 'apiKey'> & {
  apiKey?: string;
  apiKeyRedacted?: boolean;
};

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'error';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  agentId?: AgentId;
  metadata?: ChatMessageMetadata;
}

export interface ChatImageArtifact {
  id: string;
  type: 'image';
  vaultPath: string;
  mimeType: string;
  createdAt: number;
  revisedPrompt?: string;
}

export type ChatArtifact = ChatImageArtifact;

export interface ChatToolLifecycleContentSpan {
  /** UTF-16 offsets into ChatMessage.content, matching String.slice(). */
  start: number;
  end: number;
  /** Binds the UI-only marker to the exact plugin-appended fragment. */
  sha256: string;
}

export interface ChatToolLifecycleContentMetadata {
  version: 1;
  spans: ChatToolLifecycleContentSpan[];
}

export interface ChatMessageMetadata extends Record<string, unknown> {
  artifacts?: ChatArtifact[];
  /** Total elapsed time of the assistant turn in milliseconds. */
  durationMs?: number;
  /** Verified pointers only; canonical memory excerpts are never persisted in chat history. */
  memoryReferences?: MemorySnapshotReference[];
  /** UI-only tool progress spans; tool arguments and results never belong here. */
  ailuToolLifecycleContentV1?: ChatToolLifecycleContentMetadata;
}

export interface MemorySnapshotReference {
  channel: 'creative' | 'project';
  relativePath: string;
  /** Added in Ailu 0.2; optional while existing chat-store snapshots age out. */
  appId?: string;
  projectId?: string;
  sha256: string;
  verifiedAt: string;
  gitHead: string;
  queryHash: string;
  retrievedAt: string;
  stale: boolean;
  liveVerificationRequired: boolean;
  policyWarnings: string[];
}

/**
 * Provider-neutral, shareable context distilled from the canonical transcript.
 * Hidden reasoning, provider metadata, credentials, and permission grants do
 * not belong in this structure.
 */
export interface ConversationContextSummary {
  facts: string[];
  decisions: string[];
  userPreferences: string[];
  constraints: string[];
  openLoops: string[];
  filesMentioned: string[];
  lastIntent: string;
}

/** A completed context-compression checkpoint bound to an exact message prefix. */
export interface ConversationContextCheckpoint {
  version: 1;
  id: string;
  createdAt: number;
  /** Conversation revision from which the summary was produced. */
  sourceRevision: number;
  throughMessageSequence: number;
  throughMessageId: string;
  /** Repository-computed hash of messages 1..throughMessageSequence. */
  prefixSha256: string;
  projectionVersion: 1;
  summary: ConversationContextSummary;
  createdBy: AgentId | 'local';
  previousCheckpointId?: string;
}

/** The repository computes prefixSha256 after reading and validating the full prefix. */
export type ConversationContextCheckpointDraft = Omit<
  ConversationContextCheckpoint,
  'prefixSha256'
>;

export interface ToolCallEvent {
  id: string;
  name: string;
  status: 'started' | 'completed' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface FileAttachment {
  vaultPath: string;
  absolutePath: string;
  mimeType?: string;
  /** SHA-256 identity of the immutable, private managed copy used at execution time. */
  contentSha256?: string;
  /** Exact byte length paired with `contentSha256`. */
  byteLength?: number;
}

export interface RuntimeExecutionFingerprint {
  /** Opaque, process-local HMAC; it contains no reusable provider or environment secret. */
  executionFingerprint: string;
  /** Exact provider revision captured with the queued request, when applicable. */
  providerProfileUpdatedAt?: number;
}

export interface ChatTurnRequest {
  conversationId: string;
  agentId: AgentId;
  prompt: string;
  cwd: string;
  configSource: RuntimeConfigSource;
  providerProfileId?: string;
  /**
   * Process-local execution stamp captured when a request enters a queue.
   * Immediate callers may omit it; queued chat submissions must supply it.
   */
  executionFingerprint?: string;
  /** Provider revision paired with `executionFingerprint`; never contains a key. */
  providerProfileUpdatedAt?: number;
  /** CC Switch provider observed by the caller; runtime rechecks it before spawn. */
  ccSwitchProviderId?: string;
  /** Non-secret CC Switch route fingerprint observed by the caller. */
  ccSwitchRouteFingerprint?: string;
  /** Effective global CC Switch model-session fingerprint observed by the caller. */
  ccSwitchSessionFingerprint?: string;
  /** Model override for localCli runs (for example a Claude alias such as "sonnet"). */
  model?: string;
  /** Reasoning-effort override. Empty or omitted follows the selected runtime's local configuration. */
  reasoningEffort?: string;
  /** Runtime session to resume, captured from a previous turn's session event. */
  sessionId?: string;
  systemPrompt?: string;
  planMode?: boolean;
  /** Runs an ordinary interactive turn without file, command, or sandbox approval prompts. */
  fullAccess?: boolean;
  attachments?: FileAttachment[];
  /** Runs generation without tools, project customizations, or session persistence. */
  textOnly?: boolean;
  /** Separates ordinary chat from provider-neutral context compression. */
  purpose?: 'chat' | 'contextCompression';
  /**
   * Process-local bootstrap prompt used only after a resume target is verified missing.
   * It must never be copied into persisted conversation metadata or checkpoints.
   */
  freshSessionPrompt?: string;
  /** Allows a verified stale native session to fall back to a fresh provider session. */
  allowFreshSessionFallback?: boolean;
  /** Process-local diagnostic binding to the checkpoint used for this request. */
  contextCheckpointId?: string;
  /** Cancels only this runtime turn without stopping other active agents. */
  signal?: AbortSignal;
}

export type RuntimeTurnEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; content: string }
  | { type: 'tool'; toolCall: ToolCallEvent }
  | {
    type: 'artifact';
    artifact: {
      itemId: string;
      kind: 'image';
      sourcePath: string;
      mimeType?: string;
      revisedPrompt?: string;
    };
  }
  | {
    type: 'error';
    message: string;
    detail?: string;
    statusCode?: number;
    retryAfterSeconds?: number;
    requestId?: string;
    providerProfileId?: string;
    /** Diagnostic-only context that should not be rendered in chat. */
    diagnostic?: string;
  }
  | {
    /** Non-fatal runtime telemetry. It must never alter or abort chat output. */
    type: 'diagnostic';
    code: string;
    message: string;
    detail?: string;
  }
  | { type: 'done'; sessionId?: string | null };

export interface CodexReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface CodexModelDescriptor {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  inputModalities: string[];
  /** Effective catalog values when the installed App Server exposes them. */
  contextWindowTokens?: number | null;
  autoCompactTokenLimit?: number | null;
}

export interface CodexRuntimeStatus {
  state: 'idle' | 'connecting' | 'ready' | 'error';
  binaryPath: string | null;
  binarySource: RuntimeBinarySource | null;
  version: string | null;
  connected: boolean;
  authenticated: boolean | null;
  authMode: string | null;
  currentModelId: string | null;
  currentModel: CodexModelDescriptor | null;
  models: CodexModelDescriptor[];
  /** Effective config/catalog values used for Ailu's preflight context budget. */
  contextWindowTokens?: number | null;
  autoCompactTokenLimit?: number | null;
  imageGeneration: boolean | null;
  webSearch: boolean | null;
  error: string | null;
}

export interface StoredConversation {
  id: string;
  title: string;
  agentId: AgentId;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** Last runtime session id per agent, used to resume multi-turn context. */
  sessionIds?: Partial<Record<AgentId, string>>;
  /**
   * Non-secret runtime configuration fingerprint captured with each session.
   * Claude sessions are resumed only when this still matches the active
   * source/model selection, because `--resume` otherwise keeps the old model.
   */
  sessionConfigKeys?: Partial<Record<AgentId, string>>;
  /** Latest completed provider-neutral context checkpoint. Full messages remain canonical. */
  contextCheckpoint?: ConversationContextCheckpoint;
}

export type ConfigSourcesByAgent = Record<AgentId, RuntimeConfigSource>;
export type ConfiguredPathsByAgent = Record<AgentId, string>;
export type ProfileSelectionByAgent = Record<AgentId, string>;
export type LocalModelByAgent = Record<AgentId, string>;
export type ReasoningEffortByAgent = Record<AgentId, string>;
export type FullAccessByAgent = Record<AgentId, boolean>;

export interface AiluSettings {
  schemaVersion: 1;
  defaultAgentId: AgentId;
  configSources: ConfigSourcesByAgent;
  configuredPaths: ConfiguredPathsByAgent;
  providerProfileByAgent: ProfileSelectionByAgent;
  /** Model override per agent when running through the local CLI. Empty = CLI default. */
  localModelByAgent: LocalModelByAgent;
  /** Reasoning effort per agent. Empty = follow the local runtime or provider. */
  reasoningEffortByAgent: ReasoningEffortByAgent;
  /** Full host access for ordinary interactive turns. Plan and text-only turns stay restricted. */
  fullAccessByAgent: FullAccessByAgent;
  /** Names of locally discovered Skills explicitly enabled by this user. */
  creativeSkillNames: string[];
  systemPrompt: string;
  planModeDefault: boolean;
  maxContextFileChars: number;
  /** Optional user-selected Feishu Drive folder for newly created documents. */
  feishuFolderToken: string;
  /** Browser URL returned for a selected Drive folder, when available. */
  feishuFolderUrl: string;
  /** Typed parent location used for newly created Feishu documents. */
  feishuDestinationKind: FeishuDestinationKind;
  /** Short display name for the selected Feishu parent location. */
  feishuDestinationName: string;
  /** Stable user-facing breadcrumb for the selected Feishu parent location. */
  feishuDestinationPath: string;
  /** Wiki space containing the selected node; empty for Drive destinations. */
  feishuDestinationSpaceId: string;
  /** Theme used by the WeChat preview and draft publisher. */
  wechatThemeId: WeChatThemeId;
  /** Local-first article preview, preflight, and publishing configuration. */
  publishing: PublishingSettings;
  /** Local X Article preview and draft-upload configuration. */
  xPublishing: XPublishingSettings;
}

export const DEFAULT_CONFIG_SOURCES: ConfigSourcesByAgent = {
  claude: 'localCli',
  codex: 'localCli',
};

export const DEFAULT_CONFIGURED_PATHS: ConfiguredPathsByAgent = {
  claude: '',
  codex: '',
};

export const DEFAULT_PROFILE_SELECTION: ProfileSelectionByAgent = {
  claude: '',
  codex: '',
};

export const DEFAULT_LOCAL_MODELS: LocalModelByAgent = {
  claude: '',
  codex: '',
};

export const DEFAULT_REASONING_EFFORTS: ReasoningEffortByAgent = {
  claude: '',
  codex: '',
};

export const DEFAULT_FULL_ACCESS: FullAccessByAgent = {
  claude: false,
  codex: false,
};

export function normalizeFullAccessByAgent(
  value: Partial<FullAccessByAgent> | null | undefined,
): FullAccessByAgent {
  return {
    claude: typeof value?.claude === 'boolean' ? value.claude : DEFAULT_FULL_ACCESS.claude,
    codex: typeof value?.codex === 'boolean' ? value.codex : DEFAULT_FULL_ACCESS.codex,
  };
}

export const DEFAULT_SETTINGS: AiluSettings = {
  schemaVersion: 1,
  defaultAgentId: 'claude',
  configSources: DEFAULT_CONFIG_SOURCES,
  configuredPaths: DEFAULT_CONFIGURED_PATHS,
  providerProfileByAgent: DEFAULT_PROFILE_SELECTION,
  localModelByAgent: DEFAULT_LOCAL_MODELS,
  reasoningEffortByAgent: DEFAULT_REASONING_EFFORTS,
  fullAccessByAgent: DEFAULT_FULL_ACCESS,
  creativeSkillNames: [],
  systemPrompt: '',
  planModeDefault: false,
  maxContextFileChars: 40_000,
  feishuFolderToken: '',
  feishuFolderUrl: '',
  feishuDestinationKind: 'my-library-root',
  feishuDestinationName: '个人文档库',
  feishuDestinationPath: '个人文档库',
  feishuDestinationSpaceId: 'my_library',
  wechatThemeId: 'paper-ink',
  publishing: DEFAULT_PUBLISHING_SETTINGS,
  xPublishing: DEFAULT_X_PUBLISHING_SETTINGS,
};
