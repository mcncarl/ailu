import { Editor, ItemView, MarkdownRenderer, MarkdownView, Menu, Notice, setIcon, TFile, WorkspaceLeaf } from 'obsidian';

import { getAgentDescriptor, SELECTABLE_AGENT_IDS } from '../agents';
import {
  DEFAULT_ATTACHMENT_RESERVE_TOKENS,
  DEFAULT_NATIVE_RUNTIME_OVERHEAD_TOKENS,
  ChatContextOverflowError,
  ChatPersistenceBackpressureError,
  estimateContextBudget,
  resolveModelContextCapacity,
  type ChatContextPreparation,
  type ChatContextService,
  type ChatConversationSnapshot,
  type ChatConversationWatch,
  type ChatRunCoordinator,
} from '../chat';
import { AILU_IDS, DEFAULT_CONVERSATION_TITLE, PLUGIN_NAME, VIEW_IDS } from '../ids';
import {
  buildChatMemoryQuery,
  VerifiedMemoryReadService,
} from '../memory/verifiedMemory';
import { VerifiedMemoryWriteService } from '../memory/verifiedMemoryWrite';
import { ProviderStore } from '../storage/providerStore';
import {
  VaultStore,
  type ConversationArchiveFilter,
  type ConversationSummary,
} from '../storage/vaultStore';
import type {
  AgentId,
  ChatImageArtifact,
  ChatMessage,
  CodexModelDescriptor,
  FileAttachment,
  ProviderProfile,
  RuntimeConfigSource,
  StoredConversation,
  AiluSettings,
} from '../types';
import { createId } from '../utils/id';
import { runtimeEnvironment } from '../utils/env';
import { resolveMentions, findMentionQuery, findSlashQuery } from '../utils/context';
import {
  ManagedPreviewUrlStore,
  sanitizeManagedPreviewMarkdown,
} from '../utils/previewSecurity';
import { userFacingErrorMessage, userFacingErrorText } from '../utils/userFacingError';
import { filterSlashCommands, loadChatSkills, type SlashCommand } from '../utils/slashCommands';
import { getVaultBasePath, guessMimeType, readVerifiedVaultFile } from '../utils/vault';
import { RuntimeDiscovery } from '../runtime/discovery';
import {
  freezeVerifiedImageAttachment,
  MAX_FROZEN_ATTACHMENT_COUNT,
  MAX_FROZEN_ATTACHMENTS_TOTAL_BYTES,
} from '../runtime/frozenAttachments';
import { RuntimeManager } from '../runtime/runtimeManager';
import {
  ccSwitchGlobalSnapshot,
  ccSwitchSnapshotLabel,
  type CcSwitchSnapshot,
} from '../runtime/ccSwitch';
import {
  orderedSupportedCodexReasoningEfforts,
  reconcileCodexReasoningEffort,
} from '../runtime/codexRuntime';
import {
  getClaudeDetectedLocalModel,
  listLocalModels,
  resolveClaudeCcSwitchSessionConfig,
  resolveClaudeLocalModel,
} from '../runtime/localModels';
import {
  reconcileClaudeReasoningEffort,
  resolveClaudeReasoningCapability,
  type ClaudeReasoningCapability,
} from '../runtime/reasoningCapabilities';
import { RuntimeSetupModal } from './runtimeSetupModal';
import { MemoryWriteModal } from './memoryWriteModal';
import { renderStudioChrome } from './studioChrome';
import { brandAiluWorkspaceTab, restoreWorkspaceTabIcon } from './ailuBrandMark';
import {
  applyChatAgentSelection,
  applyLocalCliSelection,
  buildClaudeSessionConfigKey,
  buildCodexSessionConfigKey,
  conversationHandoffHint,
  resolveAvailableDefaultAgent,
  shouldAttemptSessionResume,
  shouldResumeClaudeSession,
  shouldResumeCodexSession,
} from './chatAgentSelection';
import { chatMessageRoleLabel, compactModelButtonLabel, reasoningEffortLabel } from './chatLabels';
import {
  assignGeneratedImageAsCover,
  generatedImageDragPayload,
  importGeneratedImageIntoNote,
  readGeneratedImageArtifact,
  writeGeneratedImageDragPayload,
  type GeneratedImageCoverKind,
} from './generatedImageDrag';
import {
  ChatConversationUiStateCache,
  type ChatConversationUiState,
} from './chatConversationUiState';
import { ChatUiStatePersistence } from './chatUiStatePersistence';
import {
  reconcileStableMessageOrder,
  resolveMemoryRuntimeDiagnostic,
  resolveChatMessageRenderMode,
  resolveChatMessageRenderUpdate,
  resolvePlainTextMutation,
  type ChatMessageRenderFingerprint,
  type ChatMessageRenderMode,
} from './chatMessageRendering';

export const AILU_VIEW_TYPE = VIEW_IDS.chat;

export interface ChatViewDeps {
  getSettings: () => AiluSettings;
  saveSettings: () => Promise<void>;
  providerStore: ProviderStore;
  vaultStore: VaultStore;
  runtimeManager: RuntimeManager;
  chatRunCoordinator: ChatRunCoordinator;
  chatContextService: ChatContextService;
  memoryReadService: VerifiedMemoryReadService;
  memoryWriteService: VerifiedMemoryWriteService;
  isMemoryRuntimeReady: () => boolean;
  setMemoryRuntimeDiagnostic: (diagnostic: string | null) => void;
  chatUiState: ChatConversationUiStateCache;
  chatUiStatePersistence: ChatUiStatePersistence;
  getChatUiStatePersistenceWarning: () => string | null;
  getChatWriteState: () => ChatWriteState;
  onChatWriteStateChange: (listener: (state: ChatWriteState) => void) => () => void;
  isSessionRegistryHealthy: () => boolean;
  getSelectedConversation: () => StoredConversation | null;
  setSelectedConversation: (conversation: StoredConversation) => void;
  openSettings: () => void;
  openPublishing: () => void;
}

export interface ChatWriteState {
  available: boolean;
  reason: string;
}

interface ActiveEditorContext {
  file: TFile;
  selection: string;
  currentLine: string;
  cursorLine: number;
  cursorCh: number;
  updatedAt: number;
}

interface HistoryPopoverState {
  generation: number;
  loadGeneration: number;
  archiveFilter: Exclude<ConversationArchiveFilter, 'all'>;
  query: string;
  cursor: string | null;
  items: ConversationSummary[];
  loading: boolean;
  root: HTMLElement;
  list: HTMLElement;
  loadMore: HTMLButtonElement;
  searchTimer: number | null;
}

interface ConversationPagingState {
  conversationId: string;
  nextBeforeSequence: number | null;
  totalMessageCount: number;
  persistedMessages: ChatMessage[];
  loadingEarlier: boolean;
}

interface MessageScrollAnchor {
  conversationId: string;
  messageId: string;
  viewportOffset: number;
}

interface PendingPersistedViewport {
  conversationId: string;
  bindingGeneration: number;
  state: ChatConversationUiState;
}

interface PendingUiStateLoad {
  conversationId: string;
  bindingGeneration: number;
}

interface MessageMarkdownRender {
  content: string;
  item: HTMLElement;
  version: number;
  promise: Promise<void>;
}

interface RenderedMessageRecord extends ChatMessageRenderFingerprint {
  item: HTMLElement;
}

const MAX_CHAT_CONTEXT_FILE_BYTES = 10 * 1024 * 1024;

export class AiluChatView extends ItemView {
  private conversation: StoredConversation | null = null;
  private agentId: AgentId = 'claude';
  private planMode = false;
  private selectedSkill: SlashCommand | null = null;
  private skillPillEl: HTMLElement | null = null;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private chatStorageBannerEl: HTMLElement | null = null;
  private historyButtonEl!: HTMLButtonElement;
  private historyPopoverEl: HTMLElement | null = null;
  private historyPopoverState: HistoryPopoverState | null = null;
  private historyPopoverGeneration = 0;
  private historyTriggerEl: HTMLElement | null = null;
  private sendButtonEl!: HTMLButtonElement;
  private suggestEl: HTMLElement | null = null;
  private running = false;
  private readonly liveAssistantMessageIds = new Set<string>();
  private conversationLoadError: string | null = null;
  private conversationPersistenceWarning: string | null = null;
  private reportedConversationLoadError: string | null = null;
  private conversationWatch: ChatConversationWatch | null = null;
  private conversationBindingGeneration = 0;
  private conversationRefreshTimer: number | null = null;
  private viewInitialized = false;
  private dropdownCloseRegistered = false;
  private contextTrackingRegistered = false;
  private contextRowEl: HTMLElement | null = null;
  private contextHandoffHintEl: HTMLElement | null = null;
  private activeEditorContext: ActiveEditorContext | null = null;
  private observedMarkdownView: MarkdownView | null = null;
  private dismissedContextSignature: string | null = null;
  private modelSubmenuEl: HTMLElement | null = null;
  private submenuHideTimeout: number | null = null;
  private codexStatusUnsubscribe: (() => void) | null = null;
  private ccSwitchStatusUnsubscribe: (() => void) | null = null;
  private chatWriteStateUnsubscribe: (() => void) | null = null;
  private persistenceBackpressureNotice: Notice | null = null;
  private lastPersistenceBackpressureNotice = '';
  private lastPersistenceBackpressureNoticeAt = 0;
  private chromeContextEl: HTMLElement | null = null;
  private agentSwitcherEl: HTMLElement | null = null;
  private agentControlsEl: HTMLElement | null = null;
  private settingsSaveQueue: Promise<void> = Promise.resolve();
  private restoringChatScroll = false;
  private renderedConversationId: string | null = null;
  private historyOpenGeneration = 0;
  private conversationPaging: ConversationPagingState | null = null;
  private pendingMessageScrollAnchor: MessageScrollAnchor | null = null;
  private pendingPersistedViewport: PendingPersistedViewport | null = null;
  private pendingUiStateLoad: PendingUiStateLoad | null = null;
  private readonly conversationOperations = new ConversationUiOperationGate();
  private messageRenderGeneration = 0;
  private viewportRestoreGeneration = 0;
  private messageRenderCompletion: Promise<void> = Promise.resolve();
  private readonly messageMarkdownRenders = new Map<string, MessageMarkdownRender>();
  private readonly renderedMessageRecords = new Map<string, RenderedMessageRecord>();
  private readonly artifactPreviewUrls = new ManagedPreviewUrlStore();
  private activeArtifactPreviewKeys = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private readonly deps: ChatViewDeps) {
    super(leaf);
  }

  override getViewType(): string {
    return AILU_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return PLUGIN_NAME;
  }

  override getIcon(): string {
    return 'message-square';
  }

  override async onOpen(): Promise<void> {
    brandAiluWorkspaceTab(this.leaf);
    let promptRuntimeSetup = false;
    if (!this.viewInitialized) {
      const settings = this.deps.getSettings();
      const discovery = new RuntimeDiscovery({
        configuredPaths: settings.configuredPaths,
        configSources: settings.configSources,
      });
      const availability = Object.fromEntries(
        SELECTABLE_AGENT_IDS.map(agentId => [agentId, discovery.resolve(agentId).found]),
      ) as Record<AgentId, boolean>;
      this.agentId = resolveAvailableDefaultAgent(settings.defaultAgentId, availability);
      promptRuntimeSetup = !availability[this.agentId] && process.platform !== 'win32';
      this.planMode = settings.planModeDefault;
      this.viewInitialized = true;
    }
    this.containerEl.addClass('ailu-view-container');
    if (!this.dropdownCloseRegistered) {
      this.registerDomEvent(document, 'click', event => this.closeDropdownsOutside(event));
      this.dropdownCloseRegistered = true;
    }
    if (!this.contextTrackingRegistered) {
      this.registerEditorContextTracking();
      this.contextTrackingRegistered = true;
    }
    if (!this.codexStatusUnsubscribe) {
      this.codexStatusUnsubscribe = this.deps.runtimeManager.onCodexStatusChange(() => {
        if (this.agentId !== 'codex') return;
        this.refreshAgentControls();
        this.refreshStatus();
      });
    }
    if (!this.ccSwitchStatusUnsubscribe) {
      this.ccSwitchStatusUnsubscribe = this.deps.runtimeManager.onCcSwitchStatusChange(snapshot => {
        if (this.agentId !== 'claude') return;
        if (this.deps.getSettings().configSources.claude !== 'ccSwitchCurrent') return;
        this.reconcileCcSwitchReasoningEffort(snapshot);
        this.refreshAgentControls();
        this.refreshStatus();
      });
    }
    if (!this.chatWriteStateUnsubscribe) {
      this.chatWriteStateUnsubscribe = this.deps.onChatWriteStateChange(() => {
        this.refreshChatStorageState();
        this.updateRunControls();
      });
    }
    this.updateEditorContextFromWorkspace();
    this.render();
    this.ensureConversation();
    this.bindCurrentConversation();
    if (this.agentId === 'claude' && this.deps.getSettings().configSources.claude === 'ccSwitchCurrent') {
      void this.deps.runtimeManager.refreshCcSwitchStatus().then(snapshot => {
        this.reconcileCcSwitchReasoningEffort(snapshot);
        this.refreshAgentControls();
        this.refreshStatus();
      });
    }
    this.renderMessages();
    this.refreshStatus();
    if (this.agentId === 'codex') void this.deps.runtimeManager.refreshCodexStatus();
    if (promptRuntimeSetup) this.openRuntimeSetup();
  }

  override async onClose(): Promise<void> {
    restoreWorkspaceTabIcon(this.leaf);
    const conversationId = this.conversation?.id ?? null;
    this.captureCurrentConversationUiState();
    this.historyOpenGeneration += 1;
    this.messageRenderGeneration += 1;
    this.viewportRestoreGeneration += 1;
    // Submenus live on document.body, so they outlive contentEl unless removed here.
    this.hideModelSubmenu();
    this.hideHistoryPopover();
    this.codexStatusUnsubscribe?.();
    this.codexStatusUnsubscribe = null;
    this.ccSwitchStatusUnsubscribe?.();
    this.ccSwitchStatusUnsubscribe = null;
    this.chatWriteStateUnsubscribe?.();
    this.chatWriteStateUnsubscribe = null;
    this.persistenceBackpressureNotice?.hide();
    this.persistenceBackpressureNotice = null;
    this.lastPersistenceBackpressureNotice = '';
    this.lastPersistenceBackpressureNoticeAt = 0;
    this.artifactPreviewUrls.revokeAll();
    this.activeArtifactPreviewKeys.clear();
    this.unbindCurrentConversation();
    if (conversationId) await this.deps.chatUiStatePersistence.flush(conversationId);
  }

  private closeAllDropdowns(): void {
    for (const open of Array.from(this.containerEl.querySelectorAll('.ailu-model-selector.is-open'))) {
      open.classList.remove('is-open');
    }
    this.hideModelSubmenu();
  }

  private ccSwitchLabel(snapshot: CcSwitchSnapshot): string {
    return ccSwitchSnapshotLabel(ccSwitchGlobalSnapshot(snapshot));
  }

  private closeDropdownsOutside(event: MouseEvent): void {
    const target = event.target instanceof HTMLElement ? event.target : null;
    for (const selector of Array.from(this.containerEl.querySelectorAll('.ailu-model-selector.is-open'))) {
      if (!target || !selector.contains(target)) {
        selector.classList.remove('is-open');
        this.hideModelSubmenu();
      }
    }
    // Close model submenu if clicking outside
    if (this.modelSubmenuEl && this.modelSubmenuEl.classList.contains('is-open')) {
      if (!target ||
          (!this.modelSubmenuEl.contains(target) &&
           !target.closest('.ailu-model-option.has-submenu'))) {
        this.hideModelSubmenu();
      }
    }
    // Close history popover if clicking outside
    if (this.historyPopoverEl && (!target || (!this.historyPopoverEl.contains(target) && target !== this.historyButtonEl))) {
      this.hideHistoryPopover();
    }
  }

  private registerEditorContextTracking(): void {
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      if (leaf?.view instanceof MarkdownView) {
        this.observedMarkdownView = leaf.view;
        this.captureMarkdownViewContext(leaf.view);
      }
    }));
    this.registerEvent(this.app.workspace.on('file-open', file => {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView) {
        this.observedMarkdownView = activeView;
        this.captureMarkdownViewContext(activeView);
        return;
      }
      if (file instanceof TFile && this.activeEditorContext?.file.path !== file.path) {
        this.captureFileOnlyContext(file);
      }
    }));
    this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
      if (info.file instanceof TFile) {
        this.captureEditorContext(editor, info.file);
      }
    }));
    // The workspace events above miss cursor/selection movement, so a light poll
    // remains — but only while this panel is actually visible.
    this.registerInterval(window.setInterval(() => {
      if (!this.containerEl.isShown()) return;
      this.updateEditorContextFromWorkspace();
    }, 600));
  }

  private updateEditorContextFromWorkspace(): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      this.observedMarkdownView = activeView;
      this.captureMarkdownViewContext(activeView);
      return;
    }
    if (this.observedMarkdownView?.file instanceof TFile) {
      this.captureMarkdownViewContext(this.observedMarkdownView);
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile instanceof TFile && this.activeEditorContext?.file.path !== activeFile.path) {
      this.captureFileOnlyContext(activeFile);
    }
  }

  private captureMarkdownViewContext(view: MarkdownView): void {
    if (!(view.file instanceof TFile)) return;
    this.captureEditorContext(view.editor, view.file);
  }

  private captureFileOnlyContext(file: TFile): void {
    this.updateActiveEditorContext({
      file,
      selection: '',
      currentLine: '',
      cursorLine: 0,
      cursorCh: 0,
      updatedAt: Date.now(),
    });
  }

  private captureEditorContext(editor: Editor, file: TFile): void {
    const cursor = editor.getCursor();
    let currentLine = '';
    try {
      currentLine = editor.getLine(cursor.line);
    } catch {
      currentLine = '';
    }
    this.updateActiveEditorContext({
      file,
      selection: editor.getSelection(),
      currentLine,
      cursorLine: cursor.line,
      cursorCh: cursor.ch,
      updatedAt: Date.now(),
    });
  }

  private updateActiveEditorContext(context: ActiveEditorContext): void {
    const previousSignature = this.activeEditorContext ? contextSignature(this.activeEditorContext) : '';
    const nextSignature = contextSignature(context);
    this.activeEditorContext = context;
    if (previousSignature !== nextSignature) {
      this.renderActiveContextChip();
    }
  }

  private getVisibleEditorContext(): ActiveEditorContext | null {
    if (!this.activeEditorContext) return null;
    if (this.dismissedContextSignature === contextSignature(this.activeEditorContext)) return null;
    return this.activeEditorContext;
  }

  private renderActiveContextChip(): void {
    if (!this.contextRowEl) return;
    this.contextRowEl.empty();
    const context = this.getVisibleEditorContext();
    this.contextRowEl.toggleClass('has-content', Boolean(context));
    if (!context) return;

    const hasSelection = Boolean(context.selection.trim());
    const fileChip = this.contextRowEl.createDiv({ cls: 'ailu-file-chip' });
    fileChip.toggleClass('has-selection', hasSelection);
    fileChip.setAttribute('title', hasSelection
      ? `${context.file.path}\n\n${context.selection.trim()}`
      : context.file.path);
    const fileIcon = fileChip.createSpan({ cls: 'ailu-file-chip-icon' });
    setIcon(fileIcon, hasSelection ? 'text-select' : 'file-text');
    fileChip.createSpan({
      cls: 'ailu-file-chip-name',
      text: hasSelection
        ? `${context.file.basename} · 已选中 ${countTextChars(context.selection)} 字`
        : context.file.path,
    });
    const close = fileChip.createEl('button', {
      cls: 'ailu-file-chip-remove',
      attr: { type: 'button', 'aria-label': '忽略当前 Obsidian 上下文' },
    });
    setIcon(close, 'x');
    close.onclick = event => {
      event.stopPropagation();
      this.dismissedContextSignature = contextSignature(context);
      this.renderActiveContextChip();
    };
  }

  private refreshContextHandoffHint(): void {
    if (!this.contextHandoffHintEl) return;
    const conversationId = this.conversation?.id;
    const hint = conversationHandoffHint(
      this.conversation,
      this.agentId,
      getAgentDescriptor(this.agentId).displayName,
      {
        running: this.running,
        preparing: Boolean(
          conversationId && this.conversationOperations.isPreparing(conversationId),
        ),
      },
    );
    this.contextHandoffHintEl.setText(hint ?? '');
    this.contextHandoffHintEl.toggleClass('is-visible', Boolean(hint));
  }

  private render(): void {
    this.hideModelSubmenu();
    const root = this.contentEl;
    // Keep whatever the user has typed across re-renders.
    const pendingInput = this.inputEl?.value ?? '';
    root.empty();
    root.addClass('ailu-view', 'ailu-chat-view');
    root.setAttribute('data-agent', this.agentId);

    renderStudioChrome(root, {
      active: 'chat',
      context: getAgentDescriptor(this.agentId).displayName,
      onNavigate: section => {
        if (section === 'publishing') this.deps.openPublishing();
      },
      renderActions: headerActions => {
        const newChatButton = headerActions.createEl('button', { cls: 'clickable-icon ailu-header-btn' });
        setIcon(newChatButton, 'plus');
        newChatButton.ariaLabel = '新建对话';
        newChatButton.title = '新建对话';
        newChatButton.onclick = () => void this.startNewConversation();

        this.historyButtonEl = headerActions.createEl('button', { cls: 'clickable-icon ailu-header-btn' });
        setIcon(this.historyButtonEl, 'history');
        this.historyButtonEl.ariaLabel = '历史对话';
        this.historyButtonEl.title = '历史对话';
        this.historyButtonEl.onclick = event => {
          event.stopPropagation();
          this.toggleHistoryPopover(this.historyButtonEl);
        };

        const settingsButton = headerActions.createEl('button', { cls: 'clickable-icon ailu-header-btn' });
        setIcon(settingsButton, 'settings');
        settingsButton.ariaLabel = '打开设置';
        settingsButton.title = '打开设置';
        settingsButton.onclick = this.deps.openSettings;

      },
    });
    this.chromeContextEl = root.querySelector<HTMLElement>('.ailu-chrome-title small');

    const messagesWrapper = root.createDiv({ cls: 'ailu-messages-wrapper' });
    this.chatStorageBannerEl = messagesWrapper.createDiv({ cls: 'ailu-chat-storage-banner' });
    this.messagesEl = messagesWrapper.createDiv({ cls: 'ailu-chat-log' });
    this.messagesEl.onscroll = event => {
      if (this.restoringChatScroll) return;
      const conversationId = this.conversation?.id ?? null;
      const pendingLoad = conversationId
        && this.pendingUiStateLoad?.conversationId === conversationId
        && this.pendingUiStateLoad.bindingGeneration === this.conversationBindingGeneration
        ? this.pendingUiStateLoad
        : null;
      if (pendingLoad) {
        if (!event.isTrusted) return;
        this.pendingUiStateLoad = null;
        this.pendingPersistedViewport = null;
      }
      this.viewportRestoreGeneration += 1;
      this.captureCurrentConversationViewport();
    };

    const composer = root.createDiv({ cls: 'ailu-input-container' });
    const inputWrapper = composer.createDiv({ cls: 'ailu-input-wrapper' });
    inputWrapper.toggleClass('ailu-input-plan-mode', this.planMode);

    this.contextRowEl = inputWrapper.createDiv({ cls: 'ailu-context-row' });
    this.renderActiveContextChip();

    this.contextHandoffHintEl = inputWrapper.createDiv({ cls: 'ailu-context-handoff-hint' });
    this.refreshContextHandoffHint();

    this.inputEl = inputWrapper.createEl('textarea', {
      cls: 'ailu-input',
      attr: {
        placeholder: '告诉Ailu你要做的事',
      },
    });
    this.inputEl.value = pendingInput;
    this.renderSkillPill();
    this.inputEl.oninput = () => {
      this.captureCurrentConversationDraft();
      void this.updateSuggestions();
    };
    this.inputEl.onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.sendMessage();
      }
      if (event.key === 'Escape') {
        if (this.running) {
          event.preventDefault();
          event.stopPropagation();
          this.stopCurrentConversation();
        }
        this.clearSuggestions();
      }
    };

    const toolbar = inputWrapper.createDiv({ cls: 'ailu-input-toolbar' });
    const toolbarLeft = toolbar.createDiv({ cls: 'ailu-toolbar-left' });
    this.renderAgentSelector(toolbarLeft);
    this.agentControlsEl = toolbarLeft.createDiv({ cls: 'ailu-agent-controls' });
    this.renderConfigSourceSelector(this.agentControlsEl);
    this.renderModelSelector(this.agentControlsEl);
    this.renderEffortSelector(this.agentControlsEl);

    const toolbarRight = toolbar.createDiv({ cls: 'ailu-toolbar-right' });
    const skillButton = toolbarRight.createEl('button', { cls: 'clickable-icon ailu-toolbar-btn' });
    setIcon(skillButton, 'box');
    skillButton.ariaLabel = '选择创作 Skill';
    skillButton.onclick = () => void this.openSkillPicker();

    const planToggle = toolbarRight.createDiv({ cls: 'ailu-permission-toggle' });
    const planLabel = planToggle.createSpan({ cls: 'ailu-permission-label', text: 'Plan' });
    planLabel.toggleClass('plan-active', this.planMode);
    const planSwitch = planToggle.createDiv({ cls: 'ailu-toggle-switch' });
    planSwitch.toggleClass('active', this.planMode);
    // Session-local toggle; the persistent default lives in the settings tab.
    planToggle.onclick = () => {
      this.planMode = !this.planMode;
      inputWrapper.toggleClass('ailu-input-plan-mode', this.planMode);
      planLabel.toggleClass('plan-active', this.planMode);
      planSwitch.toggleClass('active', this.planMode);
    };

    const attachButton = toolbarRight.createEl('button', { cls: 'clickable-icon ailu-toolbar-btn' });
    setIcon(attachButton, 'paperclip');
    attachButton.ariaLabel = 'Attach active note';
    attachButton.onclick = () => void this.attachActiveNote();

    this.sendButtonEl = toolbarRight.createEl('button', { cls: 'clickable-icon ailu-send-btn' });
    this.sendButtonEl.onclick = () => {
      if (this.running) {
        this.stopCurrentConversation();
        return;
      }
      void this.sendMessage();
    };
    this.updateRunControls();
    this.refreshChatStorageState();
  }

  /** Update only Agent-dependent controls; keep the composer and rendered transcript mounted. */
  private refreshAgentControls(): void {
    this.closeAllDropdowns();
    this.contentEl.setAttribute('data-agent', this.agentId);
    const descriptor = getAgentDescriptor(this.agentId);
    this.chromeContextEl?.setText(descriptor.displayName);
    this.agentSwitcherEl?.setAttribute('data-agent', this.agentId);
    this.agentSwitcherEl?.querySelector<HTMLElement>('.ailu-model-label')?.setText(descriptor.displayName);
    for (const option of Array.from(this.agentSwitcherEl?.querySelectorAll<HTMLElement>('[data-agent-id]') ?? [])) {
      const isActive = option.dataset.agentId === this.agentId;
      option.toggleClass('selected', isActive);
      option.setAttribute('aria-checked', String(isActive));
    }
    if (!this.agentControlsEl) return;
    this.agentControlsEl.empty();
    this.renderConfigSourceSelector(this.agentControlsEl);
    this.renderModelSelector(this.agentControlsEl);
    this.renderEffortSelector(this.agentControlsEl);
  }

  /** Serialize quick successive selections so the last visible choice is also the last saved choice. */
  private queueSettingsSave(): Promise<void> {
    this.settingsSaveQueue = this.settingsSaveQueue
      .catch(() => undefined)
      .then(() => this.deps.saveSettings())
      .catch(error => {
        console.error('Ailu could not save the Agent selection.', error);
        new Notice('Agent 选择已切换，但暂时无法保存到插件设置。');
      });
    return this.settingsSaveQueue;
  }

  private setupDropdown(selector: HTMLElement, button: HTMLElement): void {
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.onclick = event => {
      event.stopPropagation();
      const wasOpen = selector.classList.contains('is-open');
      this.closeAllDropdowns();
      if (!wasOpen) {
        selector.classList.add('is-open');
      }
    };
    button.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        button.click();
      }
      if (event.key === 'Escape') {
        selector.classList.remove('is-open');
      }
    };
  }

  private renderAgentSelector(parent: HTMLElement): void {
    const selector = parent.createDiv({ cls: 'ailu-model-selector ailu-agent-selector' });
    this.agentSwitcherEl = selector;
    const button = selector.createDiv({
      cls: 'ailu-model-btn',
      attr: { 'aria-label': '选择 Agent' },
    });
    const buttonIcon = button.createSpan({ cls: 'ailu-option-icon' });
    setIcon(buttonIcon, 'bot');
    button.createSpan({ cls: 'ailu-model-label', text: getAgentDescriptor(this.agentId).displayName });
    const chevron = button.createSpan({ cls: 'ailu-model-chevron' });
    setIcon(chevron, 'chevron-up');
    this.setupDropdown(selector, button);

    const dropdown = selector.createDiv({
      cls: 'ailu-model-dropdown',
      attr: { role: 'menu', 'aria-label': 'Agent' },
    });
    dropdown.createDiv({ cls: 'ailu-model-group', text: 'Agent（智能体）' });
    const settings = this.deps.getSettings();
    const discovery = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    });
    for (const agentId of SELECTABLE_AGENT_IDS) {
      const descriptor = getAgentDescriptor(agentId);
      const status = discovery.resolve(agentId);
      const option = dropdown.createDiv({
        cls: 'ailu-model-option',
        attr: {
          role: 'menuitemradio',
          'aria-checked': String(agentId === this.agentId),
          'data-agent-id': agentId,
        },
      });
      option.tabIndex = 0;
      option.toggleClass('selected', agentId === this.agentId);
      const icon = option.createSpan({ cls: 'ailu-option-icon' });
      setIcon(icon, status.found ? 'check' : 'circle-alert');
      option.createSpan({ text: descriptor.displayName });
      option.createSpan({
        cls: status.found ? 'ailu-option-note' : 'ailu-option-note is-missing',
        text: status.found ? '已就绪' : '未安装',
      });
      const select = (): void => {
        option.blur();
        void this.switchAgent(agentId, !status.found);
      };
      option.onclick = event => {
        event.stopPropagation();
        select();
      };
      option.onkeydown = event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        select();
      };
    }
  }

  private renderConfigSourceSelector(parent: HTMLElement): void {
    const settings = this.deps.getSettings();
    const currentSource = settings.configSources[this.agentId];
    const sourceMeta = currentSource === 'providerProfile'
      ? { icon: 'sparkles', label: '自定义' }
      : currentSource === 'ccSwitchCurrent'
        ? { icon: 'route', label: 'CC' }
        : { icon: 'hard-drive', label: '本机' };
    const selector = parent.createDiv({ cls: 'ailu-model-selector ailu-source-selector' });
    const button = selector.createDiv({ cls: 'ailu-model-btn' });
    const icon = button.createSpan({ cls: 'ailu-source-icon' });
    setIcon(icon, sourceMeta.icon);
    button.createSpan({
      cls: 'ailu-model-label',
      text: sourceMeta.label,
    });
    const chevron = button.createSpan({ cls: 'ailu-model-chevron' });
    setIcon(chevron, 'chevron-up');
    this.setupDropdown(selector, button);

    const dropdown = selector.createDiv({ cls: 'ailu-model-dropdown' });
    dropdown.createDiv({ cls: 'ailu-model-group', text: '配置来源' });
    this.renderConfigSourceOption(dropdown, {
      agentId: this.agentId,
      source: 'localCli',
      currentSource,
      icon: 'hard-drive',
      label: '本机配置',
    });
    if (this.agentId === 'claude') {
      this.renderConfigSourceOption(dropdown, {
        agentId: 'claude',
        source: 'ccSwitchCurrent',
        currentSource,
        icon: 'route',
        label: 'CC Switch · 跟随全局',
      });
    }
    this.renderConfigSourceOption(dropdown, {
      agentId: this.agentId,
      source: 'providerProfile',
      currentSource,
      icon: 'sparkles',
      label: '自定义供应商',
      disabled: !getAgentDescriptor(this.agentId).supportsProviderProfiles,
    });
  }

  private renderConfigSourceOption(parent: HTMLElement, options: {
    agentId: AgentId;
    source: RuntimeConfigSource;
    currentSource: RuntimeConfigSource;
    icon: string;
    label: string;
    disabled?: boolean;
  }): void {
    const option = parent.createDiv({ cls: 'ailu-model-option ailu-config-source-option' });
    option.toggleClass('disabled', Boolean(options.disabled));
    option.toggleClass('selected', options.currentSource === options.source);
    const optionIcon = option.createSpan({ cls: 'ailu-option-icon' });
    setIcon(optionIcon, options.icon);
    option.createSpan({ text: options.label });
    const currentModelLabel = this.getCurrentModelLabel(options.agentId, options.source);
    if (currentModelLabel) {
      option.createSpan({ cls: 'ailu-option-note', text: currentModelLabel });
    }
    if (options.currentSource === options.source) {
      const checkIcon = option.createSpan({ cls: 'ailu-option-check' });
      setIcon(checkIcon, 'check');
    }
    option.onclick = event => {
      event.stopPropagation();
      if (options.disabled) return;
      void this.selectConfigSource(options.agentId, options.source);
    };
  }

  private getCurrentModelLabel(agentId: AgentId, source: RuntimeConfigSource): string {
    const settings = this.deps.getSettings();
    if (agentId === 'codex' && source === 'providerProfile') return '不可用';
    if (source === 'ccSwitchCurrent') {
      if (agentId !== 'claude') return '不可用';
      const snapshot = this.deps.runtimeManager.getCcSwitchSnapshot();
      if (snapshot.state === 'ready') return this.ccSwitchLabel(snapshot);
      if (snapshot.state === 'error') return '未连接';
      return '等待刷新';
    }
    if (source === 'localCli') {
      if (agentId === 'claude') {
        const selectedModel = settings.localModelByAgent.claude?.trim() ?? '';
        return resolveClaudeLocalModel(
          selectedModel || undefined,
          this.getLocalModelEnvironment(),
          this.getLocalModelCwd(),
        )?.label
          ?? '跟随 Claude Code';
      }
      if (agentId === 'codex') {
        const status = this.deps.runtimeManager.getCodexStatus();
        const selectedModel = settings.localModelByAgent.codex?.trim() ?? '';
        if (selectedModel) {
          return status.models.find(model => model.id === selectedModel || model.model === selectedModel)?.displayName
            ?? selectedModel;
        }
        return status.currentModel?.displayName ?? status.currentModelId ?? '跟随 Codex App';
      }
      const selectedModel = settings.localModelByAgent[agentId] ?? '';
      if (!selectedModel) {
        const detected = listLocalModels(agentId).find(m => m.id);
        return detected?.label ?? '默认';
      }
      return listLocalModels(agentId).find(m => m.id === selectedModel)?.label ?? selectedModel;
    } else {
      const profileId = settings.providerProfileByAgent[agentId];
      const profiles = this.deps.providerStore.list(agentId);
      const profile = profileId ? profiles.find(p => p.id === profileId) : profiles.find(p => p.isDefault);
      if (profile) return profile.name;
      return '未配置';
    }
  }

  private getLocalModelEnvironment(): NodeJS.ProcessEnv {
    return runtimeEnvironment(process.env);
  }

  private getLocalModelCwd(): string | undefined {
    return getVaultBasePath(this.app) ?? undefined;
  }

  private showModelSubmenu(options: {
    triggerEl: HTMLElement;
    title: string;
    items: Array<{
      id: string;
      label: string;
      note?: string;
      icon: string;
      selected: boolean;
      onSelect: () => void | Promise<void>;
    }>;
  }): void {
    if (this.submenuHideTimeout) {
      window.clearTimeout(this.submenuHideTimeout);
      this.submenuHideTimeout = null;
    }

    this.hideModelSubmenu();

    const submenu = createDiv();
    submenu.className = 'ailu-model-submenu';
    submenu.createDiv({ cls: 'ailu-model-group', text: options.title });
    if (options.items.length === 0) {
      const empty = submenu.createDiv({ cls: 'ailu-model-option disabled' });
      const emptyIcon = empty.createSpan({ cls: 'ailu-option-icon' });
      setIcon(emptyIcon, 'circle-alert');
      empty.createSpan({ text: '暂无可选模型' });
    }
    for (const item of options.items) {
      const option = submenu.createDiv({ cls: 'ailu-model-option' });
      option.toggleClass('selected', item.selected);
      const icon = option.createSpan({ cls: 'ailu-option-icon' });
      setIcon(icon, item.icon);
      option.createSpan({ text: item.label });
      if (item.note) {
        option.createSpan({ cls: 'ailu-option-note', text: item.note });
      }
      if (item.selected) {
        const checkIcon = option.createSpan({ cls: 'ailu-option-check' });
        setIcon(checkIcon, 'check');
      }
      option.onclick = event => {
        event.stopPropagation();
        void item.onSelect();
      };
    }

    document.body.appendChild(submenu);
    void submenu.offsetHeight;

    const triggerRect = options.triggerEl.getBoundingClientRect();
    const submenuRect = submenu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let top = triggerRect.top - 4;
    let left = triggerRect.right + 4;

    // 右边界检测：如果右侧放不下，就显示在选项左侧
    if (left + submenuRect.width > viewportWidth - 8) {
      left = triggerRect.left - submenuRect.width - 4;
    }

    // 下边界检测：如果下方放不下，就向上调整
    if (top + submenuRect.height > viewportHeight - 8) {
      top = Math.max(8, viewportHeight - submenuRect.height - 8);
    }

    submenu.style.top = `${top}px`;
    submenu.style.left = `${left}px`;
    submenu.setCssProps({ zIndex: 'var(--layer-modal, 10001)' });
    submenu.addClass('is-open');

    submenu.addEventListener('mouseenter', () => {
      if (this.submenuHideTimeout) {
        window.clearTimeout(this.submenuHideTimeout);
        this.submenuHideTimeout = null;
      }
    });

    submenu.addEventListener('mouseleave', () => {
      this.scheduleHideSubmenu();
    });

    this.modelSubmenuEl = submenu;
  }

  private hideModelSubmenu(): void {
    if (this.submenuHideTimeout) {
      window.clearTimeout(this.submenuHideTimeout);
      this.submenuHideTimeout = null;
    }
    if (this.modelSubmenuEl) {
      this.modelSubmenuEl.remove();
      this.modelSubmenuEl = null;
    }
  }

  private toggleHistoryPopover(triggerEl: HTMLElement): void {
    if (this.historyPopoverEl) {
      this.hideHistoryPopover();
      return;
    }
    this.historyTriggerEl = triggerEl;
    void this.showHistoryPopover();
  }

  private async showHistoryPopover(): Promise<void> {
    const triggerEl = this.historyTriggerEl;
    this.hideHistoryPopover();
    if (!triggerEl) return;
    const generation = this.historyPopoverGeneration;
    const popover = createDiv({ cls: 'ailu-history-popover' });
    const header = popover.createDiv({ cls: 'ailu-history-header' });
    header.createSpan({ text: '历史对话' });
    const tabs = header.createDiv({ cls: 'ailu-history-tabs' });
    const activeTab = tabs.createEl('button', {
      cls: 'ailu-history-tab is-active',
      text: '进行中',
      attr: { type: 'button' },
    });
    const archivedTab = tabs.createEl('button', {
      cls: 'ailu-history-tab',
      text: '已归档',
      attr: { type: 'button' },
    });
    const search = popover.createEl('input', {
      cls: 'ailu-history-search',
      attr: {
        type: 'search',
        placeholder: '搜索标题或最近内容',
        'aria-label': '搜索历史对话',
      },
    });
    const list = popover.createDiv({ cls: 'ailu-history-list' });
    const loadMore = popover.createEl('button', {
      cls: 'ailu-history-load-more',
      text: '加载更多',
      attr: { type: 'button' },
    });
    const state: HistoryPopoverState = {
      generation,
      loadGeneration: 0,
      archiveFilter: 'active',
      query: '',
      cursor: null,
      items: [],
      loading: false,
      root: popover,
      list,
      loadMore,
      searchTimer: null,
    };
    activeTab.onclick = event => {
      event.stopPropagation();
      if (state.archiveFilter === 'active') return;
      state.archiveFilter = 'active';
      activeTab.addClass('is-active');
      archivedTab.removeClass('is-active');
      void this.loadHistoryPage(state, true);
    };
    archivedTab.onclick = event => {
      event.stopPropagation();
      if (state.archiveFilter === 'archived') return;
      state.archiveFilter = 'archived';
      archivedTab.addClass('is-active');
      activeTab.removeClass('is-active');
      void this.loadHistoryPage(state, true);
    };
    search.oninput = () => {
      state.query = search.value;
      if (state.searchTimer !== null) window.clearTimeout(state.searchTimer);
      // Invalidate an already-running request immediately. Waiting for the
      // debounce before advancing the generation lets an old query repaint
      // the list under the user's newer input.
      state.loadGeneration += 1;
      state.loading = false;
      state.cursor = null;
      state.items = [];
      state.loadMore.disabled = true;
      state.loadMore.removeClass('is-visible');
      this.renderHistoryPopoverState(state);
      state.searchTimer = window.setTimeout(() => {
        state.searchTimer = null;
        void this.loadHistoryPage(state, true);
      }, HISTORY_SEARCH_DEBOUNCE_MS);
    };
    loadMore.onclick = event => {
      event.stopPropagation();
      void this.loadHistoryPage(state, false);
    };
    document.body.appendChild(popover);
    void popover.offsetHeight;

    const triggerRect = triggerEl.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let top = triggerRect.bottom + 4;
    let left = triggerRect.left;
    if (left + popoverRect.width > viewportWidth - 8) {
      left = Math.max(8, viewportWidth - popoverRect.width - 8);
    }
    if (top + popoverRect.height > viewportHeight - 8) {
      top = Math.max(8, triggerRect.top - popoverRect.height - 4);
    }
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    popover.setCssProps({ zIndex: 'var(--layer-modal, 10000)' });
    popover.addClass('is-open');
    this.historyPopoverEl = popover;
    this.historyPopoverState = state;
    await this.loadHistoryPage(state, true);
  }

  private hideHistoryPopover(): void {
    this.historyPopoverGeneration += 1;
    this.historyTriggerEl = null;
    const searchTimer = this.historyPopoverState?.searchTimer;
    if (searchTimer !== null && searchTimer !== undefined) window.clearTimeout(searchTimer);
    this.historyPopoverState = null;
    if (this.historyPopoverEl) {
      this.historyPopoverEl.remove();
      this.historyPopoverEl = null;
    }
  }

  private async loadHistoryPage(state: HistoryPopoverState, reset: boolean): Promise<void> {
    if (!this.isHistoryPopoverStateCurrent(state)) return;
    if (state.loading && !reset) return;
    const requestGeneration = ++state.loadGeneration;
    state.loading = true;
    if (reset) {
      state.cursor = null;
      state.items = [];
    }
    this.renderHistoryPopoverState(state);
    try {
      const query = state.query.replace(/\s+/g, ' ').trim();
      const page = query
        ? await this.deps.vaultStore.searchConversations(query, {
          cursor: reset ? null : state.cursor,
          pageSize: HISTORY_PAGE_SIZE,
          archiveFilter: state.archiveFilter,
        })
        : await this.deps.vaultStore.listConversationSummaries(
          reset ? null : state.cursor,
          HISTORY_PAGE_SIZE,
          state.archiveFilter,
        );
      if (!this.isHistoryPopoverStateCurrent(state) || requestGeneration !== state.loadGeneration) return;
      state.items = reset
        ? page.items
        : mergeConversationSummaries(state.items, page.items);
      state.cursor = page.nextCursor;
      state.loading = false;
      this.renderHistoryPopoverState(state);
    } catch (error) {
      if (!this.isHistoryPopoverStateCurrent(state) || requestGeneration !== state.loadGeneration) return;
      state.loading = false;
      this.renderHistoryPopoverState(state);
      state.list.createDiv({
        cls: 'ailu-history-empty is-error',
        text: `历史读取失败，原记录未被修改：${errorMessage(error)}`,
      });
      state.loadMore.addClass('is-visible');
      state.loadMore.disabled = false;
      state.loadMore.setText('重试加载');
    }
  }

  private renderHistoryPopoverState(state: HistoryPopoverState): void {
    if (!this.isHistoryPopoverStateCurrent(state)) return;
    state.list.empty();
    if (state.items.length === 0) {
      state.list.createDiv({
        cls: 'ailu-history-empty',
        text: state.loading
          ? '正在读取…'
          : state.query.trim()
            ? '没有找到匹配的对话'
            : state.archiveFilter === 'archived'
              ? '暂无已归档对话'
              : '暂无历史对话',
      });
    } else {
      for (const conversation of state.items) {
        this.renderHistoryItem(state.list, conversation, state);
      }
    }
    state.loadMore.toggleClass('is-visible', Boolean(state.cursor) || state.loading);
    state.loadMore.disabled = state.loading;
    state.loadMore.setText(state.loading ? '正在加载…' : '加载更多');
  }

  private isHistoryPopoverStateCurrent(state: HistoryPopoverState): boolean {
    return this.historyPopoverState === state
      && this.historyPopoverEl === state.root
      && this.historyPopoverGeneration === state.generation;
  }

  private renderHistoryItem(
    parent: HTMLElement,
    conversation: ConversationSummary,
    state: HistoryPopoverState,
  ): void {
    const isArchived = conversation.archivedAt !== null;
    const archivePending = this.conversationOperations.isArchivePending(conversation.id);
    const isCurrent = !isArchived && this.conversation?.id === conversation.id;
    const isRunning = !isArchived && this.deps.chatRunCoordinator.isConversationRunning(conversation.id);
    const item = parent.createDiv({ cls: `ailu-history-item${isCurrent ? ' is-current' : ''}` });
    item.toggleClass('is-archived', isArchived);
    item.toggleClass('is-pending', archivePending);
    item.toggleClass('is-running', isRunning);
    const icon = item.createSpan({ cls: 'ailu-history-item-icon' });
    setIcon(icon, resolveHistoryConversationIcon({
      agentId: conversation.agentId,
      isArchived,
      isCurrent,
      isRunning,
    }));
    const body = item.createDiv({ cls: 'ailu-history-item-body' });
    body.createDiv({ cls: 'ailu-history-item-title', text: conversation.title || '未命名对话' });
    body.createDiv({
      cls: 'ailu-history-item-meta',
      text: `${getAgentDescriptor(conversation.agentId).displayName} · ${formatRelativeTime(conversation.updatedAt)}${isRunning ? ' · 正在运行' : ''}${archivePending ? ' · 正在归档' : ''}`,
    });
    if (!isArchived) {
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.onclick = () => void this.openHistoryConversation(conversation);
      item.onkeydown = event => {
        if (event.target !== item) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void this.openHistoryConversation(conversation);
      };
    }
    const action = item.createEl('button', {
      cls: 'ailu-history-item-action',
      attr: {
        type: 'button',
        'aria-label': isArchived ? '恢复对话' : '归档对话',
        title: isArchived ? '恢复到进行中' : '归档对话',
      },
    });
    setIcon(action, isArchived ? 'archive-restore' : 'archive');
    action.disabled = archivePending;
    action.onclick = event => {
      event.stopPropagation();
      action.disabled = true;
      void this.changeConversationArchiveState(conversation, state).finally(() => {
        if (action.isConnected) action.disabled = false;
      });
    };
  }

  private async changeConversationArchiveState(
    conversation: ConversationSummary,
    state: HistoryPopoverState,
  ): Promise<void> {
    if (!this.deps.getChatWriteState().available) {
      new Notice(this.deps.getChatWriteState().reason || '对话存储当前为只读，无法更改归档状态。');
      return;
    }
    const shouldArchive = conversation.archivedAt === null;
    if (shouldArchive && !this.conversationOperations.markArchivePending(conversation.id)) {
      new Notice('这段对话正在归档，请稍候。');
      return;
    }
    try {
      await this.conversationOperations.run(conversation.id, async () => {
        const fresh = await this.loadFreshConversationSummary(conversation);
        if (!fresh) throw new Error('对话不存在，或归档状态已在其他窗口中变更。');
        const isArchivedNow = fresh.archivedAt !== null;
        if (shouldArchive ? isArchivedNow : !isArchivedNow) {
          new Notice(shouldArchive
            ? '这段对话已归档。'
            : '这段对话已恢复。');
          return;
        }
        if (shouldArchive) {
          const archiveBlockReason = getConversationArchiveBlockReason(
            fresh,
            this.conversation?.id ?? null,
            this.deps.chatRunCoordinator.isConversationRunning(conversation.id),
          );
          if (archiveBlockReason) {
            new Notice(archiveBlockReason);
            return;
          }
          await this.deps.vaultStore.archiveConversation(conversation.id, fresh.revision);
          new Notice('对话已归档，历史内容仍完整保留。');
          return;
        }
        await this.deps.vaultStore.restoreConversation(conversation.id, fresh.revision);
        new Notice('对话已恢复，可在“进行中”里打开。');
      });
    } catch (error) {
      new Notice(`${shouldArchive ? '归档' : '恢复'}失败，原记录未被修改：${errorMessage(error)}`);
    } finally {
      if (shouldArchive) this.conversationOperations.clearArchivePending(conversation.id);
      if (this.isHistoryPopoverStateCurrent(state)) await this.loadHistoryPage(state, true);
    }
  }

  private async openHistoryConversation(conversation: ConversationSummary): Promise<void> {
    if (this.conversationOperations.isArchivePending(conversation.id)) {
      new Notice('这段对话正在归档，完成前不能打开。');
      return;
    }
    const openGeneration = ++this.historyOpenGeneration;
    try {
      await this.conversationOperations.run(conversation.id, async () => {
        if (openGeneration !== this.historyOpenGeneration) return;
        if (this.conversationOperations.isArchivePending(conversation.id)) {
          new Notice('这段对话正在归档，完成前不能打开。');
          return;
        }
        const previousConversationId = this.conversation?.id ?? null;
        this.captureCurrentConversationUiState();
        if (previousConversationId) {
          await this.deps.chatUiStatePersistence.flush(previousConversationId);
          if (openGeneration !== this.historyOpenGeneration) return;
        }
        const [windowed, snapshot] = await Promise.all([
          this.deps.vaultStore.loadConversationWindow(conversation.id, MESSAGE_PAGE_SIZE),
          this.deps.chatRunCoordinator.snapshotConversation(conversation.id),
        ]);
        if (openGeneration !== this.historyOpenGeneration) return;
        if (this.conversationOperations.isArchivePending(conversation.id)) {
          new Notice('这段对话正在归档，完成前不能打开。');
          return;
        }
        if (!windowed) throw new Error('对话不存在、已归档，或尚未完成恢复。');
        if (snapshot.loadError) throw new Error(snapshot.loadError);
        const base = snapshot.conversation ?? windowed.conversation;
        const selected: StoredConversation = {
          ...base,
          messages: mergeConversationMessages(windowed.conversation.messages, snapshot.messages),
        };
        this.hideHistoryPopover();
        this.conversationPaging = {
          conversationId: conversation.id,
          nextBeforeSequence: windowed.nextBeforeSequence,
          totalMessageCount: windowed.totalMessageCount,
          persistedMessages: [...windowed.conversation.messages],
          loadingEarlier: false,
        };
        this.pendingMessageScrollAnchor = null;
        this.conversation = selected;
        this.running = snapshot.running;
        this.syncLiveAssistantMessageIds(snapshot);
        this.deps.setSelectedConversation(selected);
        this.removeSkill();
        this.bindCurrentConversation();
        const settings = this.deps.getSettings();
        const selection = applyChatAgentSelection(settings, this.agentId, selected.agentId);
        this.agentId = selection.agentId;
        this.refreshAgentControls();
        this.renderMessages();
        this.refreshStatus();
        if (this.agentId === 'codex') void this.deps.runtimeManager.refreshCodexStatus();
        if (this.agentId === 'claude' && settings.configSources.claude === 'ccSwitchCurrent') {
          void this.deps.runtimeManager.refreshCcSwitchStatus().then(runtimeSnapshot => {
            this.reconcileCcSwitchReasoningEffort(runtimeSnapshot);
            this.refreshAgentControls();
            this.refreshStatus();
          });
        }
        if (selection.defaultChanged) await this.queueSettingsSave();
      });
    } catch (error) {
      if (openGeneration !== this.historyOpenGeneration) return;
      new Notice(`无法读取该对话：${errorMessage(error)}`);
    }
  }

  private async loadFreshConversationSummary(
    stale: ConversationSummary,
  ): Promise<ConversationSummary | null> {
    if (stale.archivedAt === null) {
      const windowed = await this.deps.vaultStore.loadConversationWindow(stale.id, 1);
      if (windowed) {
        return {
          ...stale,
          title: windowed.conversation.title,
          agentId: windowed.conversation.agentId,
          createdAt: windowed.conversation.createdAt,
          updatedAt: windowed.conversation.updatedAt,
          revision: windowed.conversation.revision,
          messageCount: windowed.totalMessageCount,
          archivedAt: null,
        };
      }
    }
    const archived = await this.findConversationSummary(stale.id, 'archived');
    if (archived) return archived;
    if (stale.archivedAt !== null) {
      const windowed = await this.deps.vaultStore.loadConversationWindow(stale.id, 1);
      if (windowed) {
        return {
          ...stale,
          title: windowed.conversation.title,
          agentId: windowed.conversation.agentId,
          createdAt: windowed.conversation.createdAt,
          updatedAt: windowed.conversation.updatedAt,
          revision: windowed.conversation.revision,
          messageCount: windowed.totalMessageCount,
          archivedAt: null,
        };
      }
    }
    return null;
  }

  private async findConversationSummary(
    conversationId: string,
    archiveFilter: Exclude<ConversationArchiveFilter, 'all'>,
  ): Promise<ConversationSummary | null> {
    let cursor: string | null = null;
    const visitedCursors = new Set<string>();
    do {
      const page = await this.deps.vaultStore.listConversationSummaries(
        cursor,
        HISTORY_PAGE_SIZE,
        archiveFilter,
      );
      const found = page.items.find(item => item.id === conversationId);
      if (found) return found;
      if (!page.nextCursor || visitedCursors.has(page.nextCursor)) return null;
      visitedCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
    return null;
  }

  private scheduleHideSubmenu(): void {
    if (this.submenuHideTimeout) {
      window.clearTimeout(this.submenuHideTimeout);
    }
    this.submenuHideTimeout = window.setTimeout(() => {
      this.submenuHideTimeout = null;
      this.hideModelSubmenu();
    }, 200);
  }

  private async selectConfigSource(agentId: AgentId, source: RuntimeConfigSource): Promise<void> {
    const descriptor = getAgentDescriptor(agentId);
    if (source === 'providerProfile' && !descriptor.supportsProviderProfiles) return;
    if (source === 'ccSwitchCurrent' && agentId !== 'claude') return;
    const settings = this.deps.getSettings();
    settings.configSources[agentId] = source;
    settings.defaultAgentId = agentId;
    if (source === 'providerProfile' && !settings.providerProfileByAgent[agentId]) {
      const profile = this.deps.providerStore.find(agentId);
      if (profile) {
        settings.providerProfileByAgent[agentId] = profile.id;
      }
    }
    if (agentId === 'claude' && source !== 'ccSwitchCurrent') {
      settings.reasoningEffortByAgent.claude = reconcileClaudeReasoningEffort(
        this.getClaudeReasoningCapability(settings),
        settings.reasoningEffortByAgent.claude,
      );
    }
    this.agentId = agentId;
    this.closeAllDropdowns();
    this.refreshAgentControls();
    this.refreshStatus();
    await this.queueSettingsSave();
    if (source === 'ccSwitchCurrent') {
      const snapshot = await this.deps.runtimeManager.refreshCcSwitchStatus();
      this.refreshAgentControls();
      this.refreshStatus();
      if (snapshot.state === 'ready') {
        new Notice(`CC Switch 本地代理已连接：${this.ccSwitchLabel(snapshot)}。`);
      } else {
        new Notice(userFacingErrorText(snapshot.error, '未连接到 CC Switch 本地代理。'));
      }
    }
    if (source === 'providerProfile' && !this.deps.providerStore.find(agentId, settings.providerProfileByAgent[agentId])) {
      new Notice(`已切换到自定义供应商，请先在模型设置里添加 ${descriptor.displayName} 的模型配置。`);
    }
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(agentId);
    if (!status.found) {
      this.openRuntimeSetup();
    }
  }

  private renderModelSelector(parent: HTMLElement): void {
    const selector = parent.createDiv({ cls: 'ailu-model-selector ailu-profile-selector' });
    const button = selector.createDiv({ cls: 'ailu-model-btn' });
    button.createSpan({
      cls: 'ailu-model-label',
      text: compactModelButtonLabel(this.getModelSelectorLabel()),
    });
    const chevron = button.createSpan({ cls: 'ailu-model-chevron' });
    setIcon(chevron, 'chevron-up');
    this.setupDropdown(selector, button);

    const settings = this.deps.getSettings();
    const dropdown = selector.createDiv({ cls: 'ailu-model-dropdown' });
    const source = settings.configSources[this.agentId];
    const isLocal = source === 'localCli';
    if (this.agentId === 'claude') {
      this.renderClaudeModelDropdown(dropdown, settings, source);
      return;
    }
    if (this.agentId === 'codex') {
      this.renderCodexModelDropdown(dropdown);
      return;
    }

    const selectedLocalModel = settings.localModelByAgent[this.agentId] ?? '';
    const localModels = listLocalModels(this.agentId);
    if (selectedLocalModel && !localModels.some(model => model.id === selectedLocalModel)) {
      localModels.push({ id: selectedLocalModel, label: selectedLocalModel, note: 'selected' });
    }
    if (localModels.length > 0) {
      dropdown.createDiv({ cls: 'ailu-model-group', text: '本地 CLI 模型' });
      for (const model of localModels) {
        const option = dropdown.createDiv({ cls: 'ailu-model-option' });
        option.toggleClass('selected', isLocal && (settings.localModelByAgent[this.agentId] ?? '') === model.id);
        const icon = option.createSpan({ cls: 'ailu-option-icon' });
        setIcon(icon, 'terminal');
        option.createSpan({ text: model.label });
        if (model.note) {
          option.createSpan({ cls: 'ailu-option-note', text: model.note });
        }
        option.onclick = event => {
          event.stopPropagation();
          void this.selectLocalCli(model.id);
        };
      }
    } else {
      dropdown.createDiv({ cls: 'ailu-model-group', text: '运行方式' });
      const localOption = dropdown.createDiv({ cls: 'ailu-model-option' });
      localOption.toggleClass('selected', isLocal);
      const terminalIcon = localOption.createSpan({ cls: 'ailu-option-icon' });
      setIcon(terminalIcon, 'terminal');
      localOption.createSpan({ text: '本地 CLI' });
      localOption.onclick = event => {
        event.stopPropagation();
        void this.selectLocalCli();
      };
    }

    const profiles = this.deps.providerStore.list(this.agentId);
    if (profiles.length === 0) {
      dropdown.createDiv({ cls: 'ailu-model-group', text: '供应商配置' });
      const empty = dropdown.createDiv({ cls: 'ailu-model-option disabled' });
      const emptyIcon = empty.createSpan({ cls: 'ailu-option-icon' });
      setIcon(emptyIcon, 'key-round');
      empty.createSpan({ text: '添加供应商配置后可指定模型' });
    }
    for (const profile of profiles) {
      dropdown.createDiv({ cls: 'ailu-model-group', text: profile.name });
      if (profile.configurationError) {
        const option = dropdown.createDiv({ cls: 'ailu-model-option disabled' });
        const warningIcon = option.createSpan({ cls: 'ailu-option-icon' });
        setIcon(warningIcon, 'triangle-alert');
        option.createSpan({ text: profile.name });
        option.createSpan({ cls: 'ailu-option-note', text: 'URL 需在设置中修复' });
        continue;
      }
      const profileSelected = !isLocal && settings.providerProfileByAgent[this.agentId] === profile.id;
      const models = profile.models.length > 0 ? profile.models : [profile.model].filter(Boolean);
      if (models.length === 0) {
        const option = dropdown.createDiv({ cls: 'ailu-model-option' });
        option.toggleClass('selected', profileSelected);
        const keyIcon = option.createSpan({ cls: 'ailu-option-icon' });
        setIcon(keyIcon, 'key-round');
        option.createSpan({ text: profile.name });
        option.createSpan({ cls: 'ailu-option-note', text: '未指定模型' });
        option.onclick = event => {
          event.stopPropagation();
          void this.selectProfile(profile.id);
        };
        continue;
      }
      for (const model of models) {
        const option = dropdown.createDiv({ cls: 'ailu-model-option' });
        option.toggleClass('selected', profileSelected && (profile.defaultModel || profile.model) === model);
        const keyIcon = option.createSpan({ cls: 'ailu-option-icon' });
        setIcon(keyIcon, 'key-round');
        option.createSpan({ text: model });
        option.onclick = event => {
          event.stopPropagation();
          void this.selectProfile(profile.id, model);
        };
      }
    }

    dropdown.createDiv({ cls: 'ailu-model-group', text: '设置' });
    const configure = dropdown.createDiv({ cls: 'ailu-model-option' });
    const settingsIcon = configure.createSpan({ cls: 'ailu-option-icon' });
    setIcon(settingsIcon, 'settings');
    configure.createSpan({ text: '配置模型' });
    configure.onclick = event => {
      event.stopPropagation();
      this.deps.openSettings();
    };
  }

  private renderEffortSelector(parent: HTMLElement): void {
    const settings = this.deps.getSettings();
    const selectedEffort = this.getEffectiveReasoningEffort(settings);
    const effortOptions = this.getReasoningEffortOptions(settings);
    const selector = parent.createDiv({ cls: 'ailu-model-selector ailu-effort-selector' });
    const button = selector.createDiv({ cls: 'ailu-model-btn' });
    button.createSpan({
      cls: 'ailu-model-label',
      text: reasoningEffortLabel(selectedEffort),
    });
    const chevron = button.createSpan({ cls: 'ailu-model-chevron' });
    setIcon(chevron, 'chevron-up');
    this.setupDropdown(selector, button);

    const dropdown = selector.createDiv({ cls: 'ailu-model-dropdown' });
    dropdown.createDiv({ cls: 'ailu-model-group', text: '推理强度' });
    this.renderEffortOption(dropdown, '', selectedEffort, effortOptions.autoNote);
    for (const effort of effortOptions.efforts) {
      this.renderEffortOption(dropdown, effort, selectedEffort);
    }
  }

  private renderEffortOption(
    parent: HTMLElement,
    effort: string,
    selectedEffort: string,
    note?: string,
  ): void {
    const option = parent.createDiv({ cls: 'ailu-model-option' });
    option.toggleClass('selected', selectedEffort === effort);
    const icon = option.createSpan({ cls: 'ailu-option-icon' });
    setIcon(icon, effort ? 'gauge' : 'hard-drive');
    option.createSpan({ text: reasoningEffortLabel(effort) });
    if (!effort && note) {
      option.createSpan({ cls: 'ailu-option-note', text: note });
    }
    if (selectedEffort === effort) {
      const checkIcon = option.createSpan({ cls: 'ailu-option-check' });
      setIcon(checkIcon, 'check');
    }
    option.onclick = event => {
      event.stopPropagation();
      void this.selectReasoningEffort(effort);
    };
  }

  private getCodexEffortOptions(settings: AiluSettings): string[] {
    return orderedSupportedCodexReasoningEfforts(this.getSelectedCodexModel(settings));
  }

  private getReasoningEffortOptions(settings: AiluSettings): {
    efforts: string[];
    autoNote: string;
  } {
    if (this.agentId === 'codex') {
      const modelDefault = this.getSelectedCodexModel(settings)?.defaultReasoningEffort ?? '';
      return {
        efforts: this.getCodexEffortOptions(settings),
        autoNote: modelDefault
          ? `模型默认：${reasoningEffortLabel(modelDefault)}`
          : '跟随 Codex App 当前模型',
      };
    }
    const capability = this.getClaudeReasoningCapability(settings);
    return {
      efforts: [...capability.supportedEfforts],
      autoNote: capability.autoNote,
    };
  }

  private getSelectedCodexModel(settings: AiluSettings): CodexModelDescriptor | null {
    const status = this.deps.runtimeManager.getCodexStatus();
    const selectedModel = settings.localModelByAgent.codex?.trim() ?? '';
    if (selectedModel) {
      return status.models.find(model => model.id === selectedModel || model.model === selectedModel) ?? null;
    }
    return status.currentModel ?? status.models.find(model => model.isDefault) ?? null;
  }

  private getClaudeReasoningCapability(
    settings: AiluSettings,
    ccSwitchSnapshot = this.deps.runtimeManager.getCcSwitchSnapshot(),
  ): ClaudeReasoningCapability {
    const configSource = settings.configSources.claude;
    if (configSource === 'ccSwitchCurrent') {
      return resolveClaudeReasoningCapability({
        configSource,
        cliModel: ccSwitchSnapshot.currentCliModel,
        routedModel: ccSwitchSnapshot.currentModel,
      });
    }
    if (configSource === 'providerProfile') {
      const selectedProfileId = settings.providerProfileByAgent.claude;
      const profiles = this.deps.providerStore.list('claude');
      const profile = selectedProfileId
        ? profiles.find(candidate => candidate.id === selectedProfileId)
        : profiles.find(candidate => candidate.isDefault);
      const profileModel = profile?.defaultModel || profile?.model || '';
      return resolveClaudeReasoningCapability({
        configSource,
        cliModel: profileModel,
        routedModel: profileModel,
      });
    }
    const selectedModel = settings.localModelByAgent.claude?.trim() ?? '';
    const resolvedModel = resolveClaudeLocalModel(
      selectedModel || undefined,
      this.getLocalModelEnvironment(),
      this.getLocalModelCwd(),
    );
    return resolveClaudeReasoningCapability({
      configSource,
      cliModel: resolvedModel?.cliModel || selectedModel,
      routedModel: resolvedModel?.routedModel,
    });
  }

  private reconcileCcSwitchReasoningEffort(snapshot: CcSwitchSnapshot): void {
    const settings = this.deps.getSettings();
    if (settings.configSources.claude !== 'ccSwitchCurrent') return;
    const selected = settings.reasoningEffortByAgent?.claude ?? '';
    const reconciled = reconcileClaudeReasoningEffort(
      this.getClaudeReasoningCapability(settings, snapshot),
      selected,
    );
    if (reconciled === selected) return;
    settings.reasoningEffortByAgent.claude = reconciled;
    void this.queueSettingsSave();
  }

  private getEffectiveReasoningEffort(settings: AiluSettings, agentId = this.agentId): string {
    const selected = settings.reasoningEffortByAgent?.[agentId]?.trim() ?? '';
    if (agentId === 'codex') {
      if (settings.configSources.codex !== 'localCli') return '';
      return reconcileCodexReasoningEffort(this.getSelectedCodexModel(settings), selected);
    }
    if (agentId === 'claude') {
      return reconcileClaudeReasoningEffort(this.getClaudeReasoningCapability(settings), selected);
    }
    return '';
  }

  private renderCodexModelDropdown(dropdown: HTMLElement): void {
    const status = this.deps.runtimeManager.getCodexStatus();
    const settings = this.deps.getSettings();
    const selectedModel = settings.localModelByAgent.codex?.trim() ?? '';
    dropdown.createDiv({ cls: 'ailu-model-group', text: '本机 Codex App' });
    const followOption = dropdown.createDiv({ cls: 'ailu-model-option' });
    followOption.toggleClass('selected', !selectedModel);
    const followIcon = followOption.createSpan({ cls: 'ailu-option-icon' });
    setIcon(followIcon, status.state === 'error' ? 'circle-alert' : 'hard-drive');
    followOption.createSpan({ text: '跟随本机' });
    const currentModelLabel = status.currentModel?.displayName
      ?? status.currentModelId
      ?? (status.state === 'connecting' ? '正在读取模型…' : '本机默认');
    followOption.createSpan({ cls: 'ailu-option-note', text: currentModelLabel });
    followOption.onclick = event => {
      event.stopPropagation();
      void this.selectCodexModel('');
    };

    dropdown.createDiv({ cls: 'ailu-model-group', text: '可用模型' });
    if (status.models.length === 0) {
      const empty = dropdown.createDiv({ cls: 'ailu-model-option disabled' });
      const emptyIcon = empty.createSpan({ cls: 'ailu-option-icon' });
      setIcon(emptyIcon, status.state === 'error' ? 'circle-alert' : 'loader');
      empty.createSpan({ text: status.state === 'error' ? '模型列表读取失败' : '正在读取…' });
      return;
    }
    for (const model of status.models) {
      const option = dropdown.createDiv({ cls: 'ailu-model-option' });
      const isSelected = selectedModel === model.id || selectedModel === model.model;
      option.toggleClass('selected', isSelected);
      const icon = option.createSpan({ cls: 'ailu-option-icon' });
      setIcon(icon, 'cpu');
      option.createSpan({ text: model.displayName || model.model });
      option.createSpan({
        cls: 'ailu-option-note',
        text: model.isDefault ? '默认' : `${model.supportedReasoningEfforts.length} 档强度`,
      });
      if (isSelected) {
        const checkIcon = option.createSpan({ cls: 'ailu-option-check' });
        setIcon(checkIcon, 'check');
      }
      option.onclick = event => {
        event.stopPropagation();
        void this.selectCodexModel(model.model);
      };
    }
  }

  private renderClaudeModelDropdown(
    dropdown: HTMLElement,
    settings: AiluSettings,
    source: RuntimeConfigSource,
  ): void {
    if (source === 'localCli') {
      dropdown.createDiv({ cls: 'ailu-model-group', text: '本机 Claude Code' });
      const localEnvironment = this.getLocalModelEnvironment();
      const localCwd = this.getLocalModelCwd();
      const detected = getClaudeDetectedLocalModel(localEnvironment, localCwd);
      const selectedModel = settings.localModelByAgent.claude?.trim() ?? '';
      const localModels = listLocalModels('claude', localEnvironment, localCwd);
      if (selectedModel && !localModels.some(model => model.id === selectedModel)) {
        localModels.push({ id: selectedModel, label: selectedModel, note: 'selected' });
      }
      for (const model of localModels) {
        const option = dropdown.createDiv({ cls: 'ailu-model-option' });
        const selected = selectedModel === model.id;
        option.toggleClass('selected', selected);
        const icon = option.createSpan({ cls: 'ailu-option-icon' });
        setIcon(icon, model.id ? 'cpu' : 'hard-drive');
        option.createSpan({ text: model.id ? model.label : '跟随本机' });
        const resolvedModel = model.id
          ? resolveClaudeLocalModel(model.id, localEnvironment, localCwd)
          : null;
        const note = model.id
          ? resolvedModel?.routedModel
            ? `${resolvedModel.label} · ${resolvedModel.note}`
            : model.note
          : detected
            ? `${detected.label} · ${detected.note}`
            : 'Claude Code 默认配置';
        if (note) option.createSpan({ cls: 'ailu-option-note', text: note });
        if (selected) {
          const checkIcon = option.createSpan({ cls: 'ailu-option-check' });
          setIcon(checkIcon, 'check');
        }
        option.onclick = event => {
          event.stopPropagation();
          void this.selectLocalCli(model.id);
        };
      }
      return;
    }

    if (source === 'ccSwitchCurrent') {
      const snapshot = this.deps.runtimeManager.getCcSwitchSnapshot();
      dropdown.createDiv({ cls: 'ailu-model-group', text: 'CC Switch · 当前路由' });
      const current = dropdown.createDiv({ cls: 'ailu-model-option selected disabled' });
      const currentIcon = current.createSpan({ cls: 'ailu-option-icon' });
      setIcon(currentIcon, snapshot.state === 'ready' ? 'route' : 'circle-alert');
      current.createSpan({
        text: snapshot.state === 'ready'
          ? this.ccSwitchLabel(snapshot)
          : 'CC Switch 未连接',
      });
      current.createSpan({
        cls: 'ailu-option-note',
        text: snapshot.state === 'ready'
          ? snapshot.proxyStatusStale
            ? '已按 CC Switch 当前配置读取 · 状态端点仍是上一请求'
            : '本地代理在线 · 未发起上游测试'
          : userFacingErrorText(snapshot.error, '点击下方刷新'),
      });
      const refresh = dropdown.createDiv({ cls: 'ailu-model-option' });
      const refreshIcon = refresh.createSpan({ cls: 'ailu-option-icon' });
      setIcon(refreshIcon, 'refresh-cw');
      const refreshLabel = refresh.createSpan({ text: '刷新 CC Switch 状态' });
      let refreshing = false;
      refresh.onclick = async event => {
        event.stopPropagation();
        if (refreshing) return;
        refreshing = true;
        refresh.addClass('is-loading');
        refreshLabel.setText('刷新中…');
        try {
          const refreshed = await this.deps.runtimeManager.refreshCcSwitchStatus();
          if (refreshed.state === 'ready') {
            new Notice(`CC Switch 已刷新：${this.ccSwitchLabel(refreshed)}`);
          } else {
            new Notice(`CC Switch 状态刷新失败：${userFacingErrorText(refreshed.error, '本机代理不可用')}`);
          }
        } catch (error) {
          new Notice(`CC Switch 状态刷新失败：${userFacingErrorMessage(error, '本机代理不可用')}`);
        } finally {
          this.closeAllDropdowns();
          this.refreshAgentControls();
          this.refreshStatus();
        }
      };
      dropdown.createDiv({
        cls: 'ailu-model-group',
        text: '只跟随 CC Switch 全局配置，不受当前 Vault 的 Claude 项目配置影响。',
      });
      return;
    }

    const profiles = this.deps.providerStore.list('claude');
    dropdown.createDiv({ cls: 'ailu-model-group', text: '供应商' });
    if (profiles.length === 0) {
      const empty = dropdown.createDiv({ cls: 'ailu-model-option disabled' });
      const emptyIcon = empty.createSpan({ cls: 'ailu-option-icon' });
      setIcon(emptyIcon, 'key-round');
      empty.createSpan({ text: '请先添加 Claude 模型配置' });
    }

    const selectedProfileId = settings.providerProfileByAgent.claude;
    for (const profile of profiles) {
      const items = this.getProfileModelItems(profile, selectedProfileId);
      this.renderSupplierOption(dropdown, {
        label: profile.name,
        note: `${items.length} 个模型`,
        icon: 'key-round',
        selected: selectedProfileId === profile.id,
        onOpen: triggerEl => this.showModelSubmenu({
          triggerEl,
          title: profile.name,
          items,
        }),
      });
    }

    dropdown.createDiv({ cls: 'ailu-model-group', text: '设置' });
    const configure = dropdown.createDiv({ cls: 'ailu-model-option' });
    const settingsIcon = configure.createSpan({ cls: 'ailu-option-icon' });
    setIcon(settingsIcon, 'settings');
    configure.createSpan({ text: '管理模型配置' });
    configure.onclick = event => {
      event.stopPropagation();
      this.deps.openSettings();
    };
  }

  private renderSupplierOption(parent: HTMLElement, options: {
    label: string;
    note: string;
    icon: string;
    selected: boolean;
    onOpen: (triggerEl: HTMLElement) => void;
  }): void {
    const option = parent.createDiv({ cls: 'ailu-model-option has-submenu ailu-supplier-option' });
    option.toggleClass('selected', options.selected);
    option.tabIndex = 0;
    const icon = option.createSpan({ cls: 'ailu-option-icon' });
    setIcon(icon, options.icon);
    option.createSpan({ text: options.label });
    option.createSpan({ cls: 'ailu-option-note', text: options.note });
    if (options.selected) {
      const checkIcon = option.createSpan({ cls: 'ailu-option-check' });
      setIcon(checkIcon, 'check');
    }
    const arrow = option.createSpan({ cls: 'ailu-submenu-arrow' });
    setIcon(arrow, 'chevron-right');
    option.addEventListener('mouseenter', () => options.onOpen(option));
    option.addEventListener('mouseleave', () => this.scheduleHideSubmenu());
    option.onfocus = () => options.onOpen(option);
    option.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight') {
        event.preventDefault();
        options.onOpen(option);
      }
      if (event.key === 'Escape') {
        this.hideModelSubmenu();
      }
    };
    option.onclick = event => {
      event.stopPropagation();
      options.onOpen(option);
    };
  }

  private getProfileModelItems(profile: ProviderProfile, selectedProfileId: string): Array<{
    id: string;
    label: string;
    note?: string;
    icon: string;
    selected: boolean;
    onSelect: () => void | Promise<void>;
  }> {
    const models = profile.models.length > 0 ? profile.models : [profile.model].filter(Boolean);
    if (models.length === 0) {
      return [{
        id: profile.id,
        label: profile.name,
        note: '未设置模型',
        icon: 'key-round',
        selected: selectedProfileId === profile.id,
        onSelect: () => this.selectProfile(profile.id),
      }];
    }
    const activeModel = profile.defaultModel || profile.model;
    return models.map(model => ({
      id: `${profile.id}:${model}`,
      label: model,
      note: profile.name,
      icon: 'key-round',
      selected: selectedProfileId === profile.id && activeModel === model,
      onSelect: () => this.selectProfile(profile.id, model),
    }));
  }

  private refreshStatus(): void {
    this.updateRunControls();
  }

  // Conversations start as in-memory drafts; they are only persisted once the
  // first message is sent, so open/close cycles never litter the store.
  private ensureConversation(forceNew = false): void {
    if (this.conversation && !forceNew) return;
    const selected = forceNew ? null : this.deps.getSelectedConversation();
    this.conversation = selected ?? this.deps.vaultStore.createDraftConversation(this.agentId);
    this.deps.setSelectedConversation(this.conversation);
  }

  private bindCurrentConversation(): void {
    this.unbindCurrentConversation();
    const conversationId = this.conversation?.id;
    if (!conversationId) return;
    const uiState = this.deps.chatUiState.selectConversation(conversationId);
    if (this.inputEl && uiState) this.inputEl.value = uiState.draft;
    this.conversationLoadError = null;
    this.conversationPersistenceWarning = null;
    this.reportedConversationLoadError = null;
    this.refreshChatStorageState();
    const generation = ++this.conversationBindingGeneration;
    this.pendingUiStateLoad = {
      conversationId,
      bindingGeneration: generation,
    };
    void this.deps.chatUiStatePersistence.load(conversationId).then(state => {
      if (generation !== this.conversationBindingGeneration || this.conversation?.id !== conversationId) return;
      if (this.inputEl) this.inputEl.value = state.draft;
      void this.restoreLoadedConversationUiState(conversationId, state, generation);
    });
    const watch = this.deps.chatRunCoordinator.watchConversation(conversationId, delivery => {
      if (generation !== this.conversationBindingGeneration || this.conversation?.id !== conversationId) return;
      if (delivery.type === 'snapshot') {
        this.applyConversationSnapshot(delivery.snapshot);
        return;
      }
      this.scheduleConversationSnapshotRefresh(conversationId, generation);
    });
    this.conversationWatch = watch;
    void watch.ready.catch(error => {
      if (generation !== this.conversationBindingGeneration) return;
      new Notice(`无法连接当前对话：${errorMessage(error)}`);
    });
  }

  private unbindCurrentConversation(): void {
    this.conversationBindingGeneration += 1;
    this.pendingUiStateLoad = null;
    this.pendingPersistedViewport = null;
    this.conversationWatch?.close();
    this.conversationWatch = null;
    if (this.conversationRefreshTimer !== null) {
      window.clearTimeout(this.conversationRefreshTimer);
      this.conversationRefreshTimer = null;
    }
  }

  private async restoreLoadedConversationUiState(
    conversationId: string,
    state: ChatConversationUiState,
    bindingGeneration: number,
  ): Promise<void> {
    const isCurrent = (): boolean => (
      bindingGeneration === this.conversationBindingGeneration
      && this.conversation?.id === conversationId
      && this.pendingUiStateLoad?.conversationId === conversationId
      && this.pendingUiStateLoad.bindingGeneration === bindingGeneration
    );
    if (!isCurrent()) return;

    const paging = this.conversationPaging?.conversationId === conversationId
      ? this.conversationPaging
      : null;
    if (!state.followBottom && state.anchorMessageId && paging
      && !this.conversation?.messages.some(message => message.id === state.anchorMessageId)) {
      paging.loadingEarlier = true;
      this.updateLoadEarlierButton(paging);
      try {
        const restored = await loadPersistedMessagesThroughAnchor({
          conversationId,
          anchorMessageId: state.anchorMessageId,
          persistedMessages: paging.persistedMessages,
          nextBeforeSequence: paging.nextBeforeSequence,
          loadPage: beforeSequence => this.deps.vaultStore.loadMessages(
            conversationId,
            beforeSequence,
            MESSAGE_PAGE_SIZE,
          ),
          shouldContinue: isCurrent,
        });
        if (!isCurrent() || this.conversationPaging !== paging || !this.conversation) return;
        paging.persistedMessages = restored.persistedMessages;
        paging.nextBeforeSequence = restored.nextBeforeSequence;
        this.conversation = {
          ...this.conversation,
          messages: mergeConversationMessages(
            paging.persistedMessages,
            this.conversation.messages,
          ),
        };
        this.deps.setSelectedConversation(this.conversation);
      } catch (error) {
        if (!isCurrent() || this.conversationPaging !== paging) return;
        new Notice(`原阅读位置加载失败，已保留最近消息：${errorMessage(error)}`);
      } finally {
        if (this.conversationPaging === paging) {
          paging.loadingEarlier = false;
          this.updateLoadEarlierButton(paging);
        }
      }
    }
    if (!isCurrent()) return;
    this.pendingPersistedViewport = {
      conversationId,
      bindingGeneration,
      state,
    };
    this.renderMessages();
    this.refreshChatStorageState();
  }

  private scheduleConversationSnapshotRefresh(conversationId: string, generation: number): void {
    if (this.conversationRefreshTimer !== null) return;
    this.conversationRefreshTimer = window.setTimeout(() => {
      this.conversationRefreshTimer = null;
      void this.deps.chatRunCoordinator.snapshotConversation(conversationId).then(snapshot => {
        if (generation !== this.conversationBindingGeneration || this.conversation?.id !== conversationId) return;
        this.applyConversationSnapshot(snapshot);
      }).catch(error => {
        if (generation !== this.conversationBindingGeneration) return;
        new Notice(`无法刷新当前对话：${errorMessage(error)}`);
      });
    }, 32);
  }

  private applyConversationSnapshot(snapshot: ChatConversationSnapshot): void {
    if (this.conversation?.id !== snapshot.conversationId) return;
    this.syncLiveAssistantMessageIds(snapshot);
    if (snapshot.loadError) {
      this.conversationLoadError = snapshot.loadError;
      this.running = snapshot.running;
      const signature = `${snapshot.conversationId}:${snapshot.loadError}`;
      if (this.reportedConversationLoadError !== signature) {
        this.reportedConversationLoadError = signature;
        new Notice('该对话历史读取失败，已停止写入以保护原记录。');
      }
      this.renderMessages();
      this.refreshChatStorageState();
      this.updateRunControls();
      return;
    }
    this.conversationLoadError = null;
    const unpersisted = [...snapshot.runs].reverse().find(run => (
      Boolean(run.persistenceError)
      || (run.terminalStatus !== null && run.startPersisted && !run.finalPersisted)
    ));
    this.conversationPersistenceWarning = unpersisted
      ? unpersisted.persistenceError ?? '该回答只保留在当前内存中，尚未完整写入对话历史。'
      : null;
    const base = snapshot.conversation ?? this.conversation;
    const paging = this.conversationPaging?.conversationId === snapshot.conversationId
      ? this.conversationPaging
      : null;
    this.conversation = {
      ...base,
      messages: paging
        ? mergeConversationMessages(paging.persistedMessages, snapshot.messages)
        : snapshot.messages,
      updatedAt: base.updatedAt,
    };
    this.deps.setSelectedConversation(this.conversation);
    this.running = snapshot.running;
    this.renderMessages();
    this.refreshChatStorageState();
    this.updateRunControls();
    this.refreshStatus();
  }

  private syncLiveAssistantMessageIds(snapshot: ChatConversationSnapshot): void {
    this.liveAssistantMessageIds.clear();
    for (const run of snapshot.runs) {
      if (run.phase === 'completed' || run.phase === 'cancelled' || run.phase === 'failed') continue;
      this.liveAssistantMessageIds.add(run.assistantMessage.id);
    }
  }

  private stopCurrentConversation(): void {
    const conversationId = this.conversation?.id;
    if (!conversationId) return;
    const stopped = this.deps.chatRunCoordinator.stopConversation(conversationId);
    if (stopped.cancelledRunIds.length === 0) {
      new Notice('当前对话没有正在运行的任务。');
      return;
    }
    void stopped.completions.catch(error => {
      new Notice(`停止任务时出错：${errorMessage(error)}`);
    });
  }

  private renderMessages(): void {
    if (!this.messagesEl) return;
    this.refreshContextHandoffHint();
    const conversationId = this.conversation?.id ?? null;
    const sameConversation = Boolean(
      conversationId && this.renderedConversationId === conversationId,
    );
    const hasPendingPersistedViewport = Boolean(
      conversationId && this.pendingPersistedViewport?.conversationId === conversationId,
    );
    if (sameConversation && !hasPendingPersistedViewport) {
      this.captureCurrentConversationViewport();
    }
    const renderGeneration = ++this.messageRenderGeneration;
    if (!sameConversation) this.resetRenderedMessages();
    this.renderedConversationId = conversationId;
    if (this.conversationLoadError) {
      this.resetRenderedMessages();
      const error = this.messagesEl.createDiv({ cls: 'ailu-chat-load-error' });
      error.createDiv({ cls: 'ailu-chat-load-error-title', text: '无法读取这段对话' });
      error.createDiv({
        cls: 'ailu-chat-load-error-detail',
        text: '为了保护原有历史，插件没有把它当成空对话，也不会继续写入。请先检查对话存储文件。',
      });
      this.completeMessageRender(conversationId, renderGeneration, []);
      return;
    }
    const messages = this.conversation?.messages ?? [];
    if (messages.length === 0) {
      this.resetRenderedMessages();
      this.renderEmptyState();
      this.completeMessageRender(conversationId, renderGeneration, []);
      return;
    }
    this.activeArtifactPreviewKeys = new Set(messages.flatMap(message => (
      (message.metadata?.artifacts ?? [])
        .filter((artifact): artifact is ChatImageArtifact => artifact.type === 'image')
        .map(artifact => this.artifactPreviewKey(message.id, artifact))
    )));
    this.artifactPreviewUrls.revokeExcept(this.activeArtifactPreviewKeys);
    for (const child of Array.from(this.messagesEl.children)) {
      if (!child.hasClass('ailu-message')) child.remove();
    }
    const activeMessageIds = new Set<string>();
    const markdownPromises: Promise<void>[] = [];
    const desiredItems: HTMLElement[] = [];
    for (const message of messages) {
      activeMessageIds.add(message.id);
      const existing = this.renderedMessageRecords.get(message.id);
      if (existing) {
        const next = this.messageRenderFingerprint(message);
        const update = resolveChatMessageRenderUpdate(existing, next);
        if (update === 'reuse' || (update === 'update-plain' && this.updatePlainMessage(existing, next))) {
          desiredItems.push(existing.item);
          const markdownRender = this.messageMarkdownRenders.get(message.id);
          if (markdownRender?.item === existing.item) markdownPromises.push(markdownRender.promise);
          continue;
        }
      }
      existing?.item.remove();
      this.renderedMessageRecords.delete(message.id);
      const rendered = this.renderMessage(message);
      this.renderedMessageRecords.set(message.id, rendered.record);
      desiredItems.push(rendered.record.item);
      if (rendered.markdownPromise) markdownPromises.push(rendered.markdownPromise);
    }
    for (const [messageId, record] of this.renderedMessageRecords) {
      if (activeMessageIds.has(messageId)) continue;
      record.item.remove();
      this.renderedMessageRecords.delete(messageId);
      const markdownRender = this.messageMarkdownRenders.get(messageId);
      if (markdownRender?.item === record.item) this.messageMarkdownRenders.delete(messageId);
    }
    const loadEarlierControl = this.renderLoadEarlierMessagesControl();
    reconcileStableMessageOrder(this.messagesEl, desiredItems, loadEarlierControl);
    this.completeMessageRender(conversationId, renderGeneration, markdownPromises);
  }

  private resetRenderedMessages(): void {
    this.messagesEl.empty();
    this.renderedMessageRecords.clear();
    this.messageMarkdownRenders.clear();
    this.activeArtifactPreviewKeys.clear();
    this.artifactPreviewUrls.revokeAll();
  }

  private completeMessageRender(
    conversationId: string | null,
    renderGeneration: number,
    markdownPromises: readonly Promise<void>[],
  ): void {
    this.messageRenderCompletion = Promise.allSettled(markdownPromises).then(async () => {
      if (renderGeneration !== this.messageRenderGeneration
        || this.conversation?.id !== conversationId) return;
      await nextLayoutFrames();
    });
    this.restoreConversationViewport(conversationId);
  }

  private renderLoadEarlierMessagesControl(): HTMLElement | null {
    const paging = this.conversationPaging;
    if (!paging || paging.conversationId !== this.conversation?.id) return null;
    const control = this.messagesEl.createDiv({ cls: 'ailu-chat-load-earlier' });
    this.messagesEl.insertBefore(control, this.messagesEl.firstChild);
    const visibleCount = this.conversation?.messages.length ?? paging.persistedMessages.length;
    control.createSpan({
      cls: 'ailu-chat-load-earlier-count',
      text: `已显示 ${visibleCount} / ${Math.max(visibleCount, paging.totalMessageCount)} 条`,
    });
    if (paging.nextBeforeSequence === null) {
      control.createSpan({ cls: 'ailu-chat-load-earlier-complete', text: '已到最早消息' });
      return control;
    }
    const button = control.createEl('button', {
      cls: 'ailu-chat-load-earlier-button',
      text: paging.loadingEarlier ? '正在加载…' : '加载更早消息',
      attr: { type: 'button' },
    });
    button.disabled = paging.loadingEarlier;
    button.onclick = () => void this.loadEarlierMessages();
    return control;
  }

  private async loadEarlierMessages(): Promise<void> {
    const paging = this.conversationPaging;
    const conversationId = this.conversation?.id;
    if (!paging || !conversationId || paging.conversationId !== conversationId
      || paging.loadingEarlier || paging.nextBeforeSequence === null) return;
    const beforeSequence = paging.nextBeforeSequence;
    const generation = this.conversationBindingGeneration;
    paging.loadingEarlier = true;
    this.updateLoadEarlierButton(paging);
    try {
      const page = await this.deps.vaultStore.loadMessages(
        conversationId,
        beforeSequence,
        MESSAGE_PAGE_SIZE,
      );
      if (generation !== this.conversationBindingGeneration
        || this.conversation?.id !== conversationId
        || this.conversationPaging !== paging) return;
      const anchor = this.captureFirstVisibleMessageAnchor(conversationId);
      const earlier = page.messages.map(item => item.message);
      paging.persistedMessages = mergeConversationMessages(earlier, paging.persistedMessages);
      paging.nextBeforeSequence = page.nextBeforeSequence;
      paging.loadingEarlier = false;
      this.conversation = {
        ...this.conversation,
        messages: mergeConversationMessages(paging.persistedMessages, this.conversation.messages),
      };
      this.deps.setSelectedConversation(this.conversation);
      this.pendingMessageScrollAnchor = anchor;
      this.renderMessages();
    } catch (error) {
      if (generation !== this.conversationBindingGeneration
        || this.conversation?.id !== conversationId
        || this.conversationPaging !== paging) return;
      paging.loadingEarlier = false;
      this.updateLoadEarlierButton(paging);
      new Notice(`更早消息加载失败，当前内容未被修改：${errorMessage(error)}`);
    } finally {
      if (paging.loadingEarlier) {
        paging.loadingEarlier = false;
        this.updateLoadEarlierButton(paging);
      }
    }
  }

  private updateLoadEarlierButton(paging: ConversationPagingState): void {
    if (this.conversationPaging !== paging || paging.conversationId !== this.conversation?.id) return;
    const button = this.messagesEl?.querySelector<HTMLButtonElement>('.ailu-chat-load-earlier-button');
    if (!button) return;
    button.disabled = paging.loadingEarlier;
    button.setText(paging.loadingEarlier ? '正在加载…' : '加载更早消息');
  }

  private captureFirstVisibleMessageAnchor(conversationId: string): MessageScrollAnchor | null {
    if (!this.messagesEl || this.conversation?.id !== conversationId) return null;
    const viewportTop = this.messagesEl.getBoundingClientRect().top;
    for (const item of Array.from(this.messagesEl.querySelectorAll<HTMLElement>('[data-message-id]'))) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom < viewportTop) continue;
      const messageId = item.dataset.messageId;
      if (!messageId) continue;
      return {
        conversationId,
        messageId,
        viewportOffset: rect.top - viewportTop,
      };
    }
    return null;
  }

  private renderMessage(message: ChatMessage): {
    record: RenderedMessageRecord;
    markdownPromise: Promise<void> | null;
  } {
    const item = this.messagesEl.createDiv({ cls: `ailu-message is-${message.role}` });
    item.dataset.messageId = message.id;
    const fingerprint = this.messageRenderFingerprint(message);
    const resolvedAgentId = fingerprint.agentId;
    const role = chatMessageRoleLabel(
      message.role,
      message.role === 'assistant'
        ? getAgentDescriptor(resolvedAgentId ?? this.agentId).displayName
        : '',
    );
    if (role) item.createDiv({ cls: 'ailu-message-role', text: role });
    const artifacts = message.metadata?.artifacts ?? [];
    let markdownPromise: Promise<void> | null = null;
    if (message.role === 'assistant' || message.role === 'error') {
      if (fingerprint.mode === 'live-plain') {
        item.addClass('is-streaming');
        item.createEl('pre', {
          cls: 'ailu-message-content',
          text: this.plainMessageText(fingerprint),
        });
      } else {
        markdownPromise = this.queueMessageMarkdown(item, message);
      }
    } else {
      item.createEl('pre', { cls: 'ailu-message-content', text: message.content });
    }
    for (const artifact of artifacts) {
      if (artifact.type === 'image') this.renderImageArtifact(item, message.id, artifact);
    }
    if (message.role === 'assistant' && typeof message.metadata?.durationMs === 'number') {
      this.renderTurnDuration(item, message.metadata.durationMs);
    }
    if (fingerprint.memoryActionAvailable) this.renderMemoryWriteAction(item, message);
    return {
      record: {
        item,
        ...fingerprint,
      },
      markdownPromise,
    };
  }

  private messageRenderFingerprint(message: ChatMessage): ChatMessageRenderFingerprint {
    const artifacts = message.metadata?.artifacts ?? [];
    const resolvedAgentId = message.role === 'assistant'
      ? message.agentId ?? this.agentId
      : message.agentId;
    const mode: ChatMessageRenderMode = resolveChatMessageRenderMode({
      role: message.role,
      liveAssistant: this.liveAssistantMessageIds.has(message.id),
    });
    return {
      role: message.role,
      content: message.content,
      agentId: resolvedAgentId,
      artifactsSignature: JSON.stringify(artifacts),
      durationMs: message.metadata?.durationMs,
      mode,
      memoryActionAvailable: message.role === 'assistant'
        && Boolean(message.content.trim())
        && mode !== 'live-plain'
        && this.deps.isMemoryRuntimeReady(),
    };
  }

  private plainMessageText(fingerprint: ChatMessageRenderFingerprint): string {
    return fingerprint.mode === 'live-plain' && !fingerprint.content.trim()
      ? '思考中…'
      : fingerprint.content;
  }

  private updatePlainMessage(
    record: RenderedMessageRecord,
    next: ChatMessageRenderFingerprint,
  ): boolean {
    const content = record.item.querySelector<HTMLElement>('pre.ailu-message-content');
    if (!content) return false;
    const mutation = resolvePlainTextMutation(
      this.plainMessageText(record),
      this.plainMessageText(next),
    );
    if (mutation.type === 'append') {
      const tail = content.lastChild;
      if (tail?.nodeType === 3) {
        (tail as Text).appendData(mutation.text);
      } else {
        content.append(document.createTextNode(mutation.text));
      }
    } else if (mutation.type === 'replace') {
      content.textContent = mutation.text;
    }
    record.item.toggleClass('is-streaming', next.mode === 'live-plain');
    Object.assign(record, next);
    return true;
  }

  private renderTurnDuration(parent: HTMLElement, durationMs: number): void {
    const seconds = Math.max(0, durationMs) / 1000;
    parent.createDiv({ cls: 'ailu-turn-duration', text: `总耗时 ${seconds.toFixed(1)}s` });
  }

  private renderMemoryWriteAction(parent: HTMLElement, message: ChatMessage): void {
    const actions = parent.createDiv({ cls: 'ailu-message-actions' });
    const button = actions.createEl('button', {
      cls: 'ailu-memory-write-button',
      text: '沉淀到记忆',
      attr: {
        type: 'button',
        'aria-label': '将这条回答沉淀到正式 Agent 记忆',
        title: '先预览完整记忆文件，再由你确认写入',
      },
    });
    button.onclick = () => {
      const candidates = (this.conversation?.messages ?? [])
        .flatMap(item => item.metadata?.memoryReferences ?? [])
        .map(reference => ({
          relativePath: reference.relativePath,
          projectId: reference.projectId
            || (reference.channel === 'project' ? AILU_IDS.memoryProjectId : ''),
        }));
      new MemoryWriteModal(this.app, {
        service: this.deps.memoryWriteService,
        message: {
          ...message,
          metadata: message.metadata ? { ...message.metadata } : undefined,
        },
        conversationTitle: this.conversation?.title ?? '对话结论',
        candidateTargets: candidates,
      }).open();
    };
  }


  private queueMessageMarkdown(parent: HTMLElement, message: ChatMessage): Promise<void> | null {
    if (!message.content.trim()) return null;
    parent.createEl('pre', {
      cls: 'ailu-message-content ailu-message-markdown-pending',
      text: message.content,
    });
    const existing = this.messageMarkdownRenders.get(message.id);
    if (existing) {
      existing.content = message.content;
      existing.item = parent;
      existing.version += 1;
      return existing.promise;
    }
    const render: MessageMarkdownRender = {
      content: message.content,
      item: parent,
      version: 1,
      promise: Promise.resolve(),
    };
    this.messageMarkdownRenders.set(message.id, render);
    render.promise = this.runMessageMarkdownWorker(message.id, render);
    return render.promise;
  }

  private async runMessageMarkdownWorker(
    messageId: string,
    render: MessageMarkdownRender,
  ): Promise<void> {
    while (this.messageMarkdownRenders.get(messageId) === render) {
      const version = render.version;
      const content = render.content;
      const item = render.item;
      const placeholder = item.querySelector<HTMLElement>('.ailu-message-markdown-pending');
      const container = createDiv({ cls: 'ailu-message-content markdown-rendered' });
      try {
        await MarkdownRenderer.render(
          this.app,
          sanitizeManagedPreviewMarkdown(content, new Set()),
          container,
          '',
          this,
        );
      } catch (error) {
        console.error('Ailu could not render a chat message as Markdown.', error);
        container.empty();
        container.createEl('pre', { text: content });
      }
      if (this.messageMarkdownRenders.get(messageId) !== render) return;
      if (render.version !== version || render.item !== item) continue;
      const currentRecord = this.renderedMessageRecords.get(messageId);
      if (currentRecord?.item === item && currentRecord.content === content && placeholder) {
        placeholder.replaceWith(container);
      }
      this.messageMarkdownRenders.delete(messageId);
      return;
    }
  }

  private artifactPreviewKey(messageId: string, artifact: ChatImageArtifact): string {
    return `${messageId}:${artifact.id}:${artifact.vaultPath}:${artifact.mimeType}`;
  }

  private renderImageArtifact(
    parent: HTMLElement,
    messageId: string,
    artifact: ChatImageArtifact,
  ): void {
    const previewKey = this.artifactPreviewKey(messageId, artifact);
    const card = parent.createDiv({ cls: 'ailu-image-artifact-card' });
    const link = card.createEl('a', {
      cls: 'ailu-image-artifact',
      attr: {
        target: '_blank',
        rel: 'noopener',
        draggable: 'false',
        title: '拖到 Markdown 笔记中，按 Obsidian 附件设置保存',
        'aria-label': 'Ailu 生成图片，可拖到 Markdown 笔记中',
      },
    });
    const image = link.createEl('img', {
      attr: {
        alt: 'Ailu 生成图片',
        draggable: 'false',
      },
    });
    link.addEventListener('dragstart', event => {
      if (!event.dataTransfer || !writeGeneratedImageDragPayload(event.dataTransfer, artifact)) {
        event.preventDefault();
        new Notice('这张图片的来源信息无效，暂时不能拖入笔记。');
        return;
      }
      link.addClass('is-dragging');
    });
    link.addEventListener('dragend', () => link.removeClass('is-dragging'));

    const footer = card.createDiv({ cls: 'ailu-image-artifact-footer' });
    const hint = footer.createSpan({
      cls: 'ailu-image-artifact-hint',
      text: '正在安全读取图片…',
    });
    const actions = footer.createEl('button', {
      cls: 'ailu-image-artifact-use-button',
      attr: {
        type: 'button',
        'aria-label': '选择这张图片的用途',
        'aria-haspopup': 'menu',
      },
    });
    const actionsIcon = actions.createSpan({ cls: 'ailu-image-artifact-use-icon' });
    setIcon(actionsIcon, 'ellipsis');
    actions.createSpan({ text: '用途' });
    actions.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      this.showGeneratedImageActions(event, artifact);
    });
    card.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      this.showGeneratedImageActions(event, artifact);
    });
    void readGeneratedImageArtifact(this.app, artifact).then((verified) => {
      if (!this.activeArtifactPreviewKeys.has(previewKey) || !parent.parentElement) return;
      const previewUrl = this.artifactPreviewUrls.setVerifiedImage(
        previewKey,
        verified.bytes,
        verified.mimeType,
      );
      link.href = previewUrl;
      link.draggable = true;
      image.src = previewUrl;
      hint.setText('可拖入正文');
    }).catch((error) => {
      if (!this.activeArtifactPreviewKeys.has(previewKey) || !parent.parentElement) return;
      this.artifactPreviewUrls.revoke(previewKey);
      card.addClass('is-unavailable');
      image.remove();
      link.removeAttribute('href');
      link.draggable = false;
      hint.setText(userFacingErrorMessage(error, '图片无法安全预览。'));
    });
  }

  private showGeneratedImageActions(event: MouseEvent, artifact: ChatImageArtifact): void {
    const target = this.getGeneratedImageTarget();
    const menu = new Menu();
    menu.addItem(item => item
      .setTitle(target ? `当前文章：${target.note.basename}` : '请先打开目标 Markdown 文章')
      .setIcon(target ? 'file-text' : 'circle-alert')
      .setDisabled(true));
    menu.addSeparator();
    menu.addItem(item => item
      .setTitle('复制图片')
      .setIcon('copy')
      .onClick(() => void this.copyGeneratedImage(artifact)));
    menu.addItem(item => item
      .setTitle(target ? `插入《${target.note.basename}》正文` : '插入当前文章正文')
      .setIcon('file-input')
      .setDisabled(!target?.view)
      .onClick(() => {
        if (target?.view) void this.insertGeneratedImageIntoArticle(target.view, target.note, artifact);
      }));
    menu.addSeparator();
    menu.addItem(item => item
      .setTitle(target ? `设为《${target.note.basename}》公众号封面（16:9）` : '设为公众号封面（16:9）')
      .setIcon('panels-top-left')
      .setDisabled(!target)
      .onClick(() => {
        if (target) void this.setGeneratedImageCover(target.note, artifact, 'wechat');
      }));
    menu.addItem(item => item
      .setTitle(target ? `设为《${target.note.basename}》X 封面（5:2）` : '设为 X 封面（5:2）')
      .setIcon('panel-top')
      .setDisabled(!target)
      .onClick(() => {
        if (target) void this.setGeneratedImageCover(target.note, artifact, 'x');
      }));
    menu.showAtMouseEvent(event);
  }

  private getGeneratedImageTarget(): { note: TFile; view: MarkdownView | null } | null {
    const tracked = this.activeEditorContext?.file
      ?? this.observedMarkdownView?.file
      ?? this.app.workspace.getActiveFile();
    if (!(tracked instanceof TFile) || tracked.extension !== 'md') return null;
    const note = this.app.vault.getAbstractFileByPath(tracked.path);
    if (!(note instanceof TFile) || note.extension !== 'md') return null;
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const openView = this.app.workspace.getLeavesOfType('markdown')
      .map(leaf => leaf.view)
      .find((view): view is MarkdownView => (
        view instanceof MarkdownView && view.file?.path === note.path
      )) ?? null;
    const view = activeView?.file?.path === note.path
      ? activeView
      : this.observedMarkdownView?.file?.path === note.path && openView === this.observedMarkdownView
        ? this.observedMarkdownView
        : openView;
    if (!view) return null;
    return { note, view };
  }

  private async copyGeneratedImage(artifact: ChatImageArtifact): Promise<void> {
    try {
      if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function') {
        throw new Error('当前 Obsidian 环境不支持直接复制图片。');
      }
      const image = await readGeneratedImageArtifact(this.app, artifact);
      const blob = new Blob([new Uint8Array(image.bytes)], { type: image.mimeType });
      await navigator.clipboard.write([new ClipboardItem({ [image.mimeType]: blob })]);
      new Notice('图片已复制。');
    } catch (error) {
      new Notice(`图片复制失败：${errorMessage(error)}`);
    }
  }

  private async insertGeneratedImageIntoArticle(
    view: MarkdownView,
    note: TFile,
    artifact: ChatImageArtifact,
  ): Promise<void> {
    const payload = generatedImageDragPayload(artifact);
    if (!payload) {
      new Notice('这张图片的来源信息无效，暂时不能插入正文。');
      return;
    }
    try {
      await importGeneratedImageIntoNote(this.app, view.editor, note, view.editor.getCursor(), payload);
      new Notice(`图片已插入《${note.basename}》正文。`);
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  private async setGeneratedImageCover(
    note: TFile,
    artifact: ChatImageArtifact,
    kind: GeneratedImageCoverKind,
  ): Promise<void> {
    try {
      await assignGeneratedImageAsCover(this.app, note, artifact, kind);
      const platform = kind === 'wechat' ? '公众号' : 'X';
      new Notice(`已设为《${note.basename}》${platform}封面，不会插入正文。`);
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  private renderEmptyState(): void {
    const empty = this.messagesEl.createDiv({ cls: 'ailu-welcome' });
    empty.createDiv({ cls: 'ailu-welcome-greeting', text: '从一篇笔记开始，或直接交给 Ailu。' });
  }

  private showConversationSendFailure(prefix: string, error: unknown): void {
    const detail = errorMessage(error);
    const message = `${prefix}：${detail}`;
    if (!(error instanceof ChatPersistenceBackpressureError)) {
      new Notice(message);
      return;
    }
    const now = Date.now();
    if (this.lastPersistenceBackpressureNotice === detail
      && now - this.lastPersistenceBackpressureNoticeAt < 8_000) return;
    this.persistenceBackpressureNotice?.hide();
    this.persistenceBackpressureNotice = new Notice(message, 10_000);
    this.lastPersistenceBackpressureNotice = detail;
    this.lastPersistenceBackpressureNoticeAt = now;
  }

  private async sendMessage(): Promise<void> {
    if (this.running) return;
    const writeState = this.deps.getChatWriteState();
    if (!writeState.available || this.conversationLoadError) {
      new Notice(this.conversationLoadError
        ? '当前对话读取失败，不能继续写入。'
        : writeState.reason || '当前对话存储为只读。');
      return;
    }
    const rawPrompt = this.inputEl.value.trim();
    if (!rawPrompt && !this.selectedSkill) return;
    const skillPrompt = this.selectedSkill?.insertText ?? '';
    this.ensureConversation();
    const conversation = this.conversation;
    if (!conversation) return;
    if (this.deps.chatRunCoordinator.isConversationRunning(conversation.id)) {
      new Notice('这段对话已有任务在运行，请等它完成或先停止。');
      return;
    }
    const agentId = this.agentId;
    const planModeAtSend = this.planMode;
    const activeEditorContextAtSend = this.getVisibleEditorContext();
    const settings = cloneChatSettingsSnapshot(this.deps.getSettings());
    if (!this.conversationOperations.tryBeginPreparation(conversation.id)) return;
    this.updateRunControls();
    try {
    this.deps.chatRunCoordinator.assertContextPreparationAllowed(conversation.id);
    const memoryQuery = buildChatMemoryQuery({
      userInput: rawPrompt || this.selectedSkill?.label || '内容创作',
      conversationTitle: conversation.title,
      recentMessages: conversation.messages.slice(-2).map(message => message.content),
      activeNotePath: activeEditorContextAtSend?.file.path,
      selectedSkillLabel: this.selectedSkill?.label,
    });
    this.deps.memoryReadService.prefetch(memoryQuery);
    const bindingGeneration = this.conversationBindingGeneration;
    const inputValueAtSend = this.inputEl.value;
    const skillAtSend = this.selectedSkill;
    const isStillCurrent = (): boolean => (
      this.conversation?.id === conversation.id
      && this.conversationBindingGeneration === bindingGeneration
    );
    const vaultBasePath = getVaultBasePath(this.app);
    if (!vaultBasePath) {
      new Notice('Ailu 需要本机桌面 Vault 路径。');
      return;
    }
    const configSource = settings.configSources[agentId];
    if (configSource === 'ccSwitchCurrent' && agentId !== 'claude') {
      new Notice('CC Switch 全局配置仅支持 Claude Code。');
      return;
    }
    const ccSwitchSnapshot = configSource === 'ccSwitchCurrent'
      ? await this.deps.runtimeManager.refreshCcSwitchStatus()
      : null;
    if (
      ccSwitchSnapshot
      && (ccSwitchSnapshot.state !== 'ready' || ccSwitchSnapshot.selectionSource !== 'liveConfig')
    ) {
      new Notice(userFacingErrorText(ccSwitchSnapshot.error, '未连接到 CC Switch 本地代理。'));
      return;
    }
    const modelOverride = configSource === 'localCli'
      ? settings.localModelByAgent[agentId]
      : undefined;
    const reasoningEffort = this.getEffectiveReasoningEffort(settings, agentId);
    const providerProfile = agentId === 'claude' && configSource === 'providerProfile'
      ? this.deps.providerStore.find(agentId, settings.providerProfileByAgent[agentId])
      : null;
    const resolvedLocalClaudeModel = agentId === 'claude' && configSource === 'localCli'
      ? resolveClaudeLocalModel(
        modelOverride || undefined,
        this.getLocalModelEnvironment(),
        vaultBasePath,
      )
      : null;
    const ccSwitchSessionConfig = agentId === 'claude' && configSource === 'ccSwitchCurrent'
      ? resolveClaudeCcSwitchSessionConfig(
        ccSwitchSnapshot?.routeEnvironment,
        ccSwitchSnapshot?.currentCliModel,
        ccSwitchSnapshot?.routeFingerprint,
      )
      : null;
    const codexStatus = agentId === 'codex'
      ? this.deps.runtimeManager.getCodexStatus()
      : null;
    const modelContextCapacity = resolveModelContextCapacity({
      agentId,
      configSource,
      cliModel: agentId === 'codex'
        ? codexStatus?.currentModelId
        : configSource === 'ccSwitchCurrent'
          ? ccSwitchSessionConfig?.cliModel
          : resolvedLocalClaudeModel?.cliModel ?? modelOverride,
      routedModel: configSource === 'ccSwitchCurrent'
        ? ccSwitchSnapshot?.currentModel
        : resolvedLocalClaudeModel?.routedModel,
      providerModel: providerProfile?.defaultModel || providerProfile?.model,
      runtimeContextWindowTokens: codexStatus?.contextWindowTokens
        ?? codexStatus?.currentModel?.contextWindowTokens,
      runtimeAutoCompactTokenLimit: codexStatus?.autoCompactTokenLimit
        ?? codexStatus?.currentModel?.autoCompactTokenLimit,
    });
    const claudeSessionConfigKey = agentId === 'claude'
      ? buildClaudeSessionConfigKey({
        configSource,
        effectiveModel: configSource === 'localCli' || configSource === 'ccSwitchCurrent'
          ? configSource === 'ccSwitchCurrent'
            ? ccSwitchSessionConfig?.cliModel ?? ''
            : resolvedLocalClaudeModel?.cliModel || ''
          : providerProfile?.defaultModel || providerProfile?.model || '',
        fullAccess: settings.fullAccessByAgent.claude,
        localRouteFingerprint: ccSwitchSessionConfig?.routeFingerprint
          ?? resolvedLocalClaudeModel?.routeFingerprint,
        reasoningEffort,
        providerProfileId: configSource === 'providerProfile'
          ? providerProfile?.id ?? settings.providerProfileByAgent[agentId]
          : undefined,
        providerProfileUpdatedAt: providerProfile?.updatedAt,
        ccSwitchProviderId: ccSwitchSnapshot?.currentProviderId ?? undefined,
      })
      : '';
    const codexSessionConfigKey = agentId === 'codex'
      ? buildCodexSessionConfigKey({
        fullAccess: settings.fullAccessByAgent.codex && !planModeAtSend,
      })
      : '';
    const sessionConfigKey = agentId === 'claude'
      ? claudeSessionConfigKey
      : codexSessionConfigKey;
    const runtimeModel = configSource === 'localCli'
      ? resolvedLocalClaudeModel?.cliModel || modelOverride
      : configSource === 'ccSwitchCurrent'
        ? ccSwitchSessionConfig?.cliModel || undefined
        : undefined;
    const resolved = await resolveMentions(this.app, rawPrompt, settings.maxContextFileChars);
    const resolvedAttachments = mergeAttachments(resolved.attachments);
    const activeContext = await this.resolveActiveEditorContext(
      settings.maxContextFileChars,
      activeEditorContextAtSend,
      resolvedAttachments,
    );
    const userPrompt = activeContext.prompt
      ? `${resolved.prompt}\n\n${activeContext.prompt}`
      : resolved.prompt;
    const verifiedMemory = await this.deps.memoryReadService.read(memoryQuery);
    this.deps.setMemoryRuntimeDiagnostic(
      resolveMemoryRuntimeDiagnostic(verifiedMemory.warnings),
    );
    const runtimePrompt = [skillPrompt, verifiedMemory.prompt, userPrompt]
      .filter(Boolean)
      .join('\n\n');
    const attachments = mergeAttachments([...resolvedAttachments, ...activeContext.attachments]);
    const reservedInputTokens = DEFAULT_NATIVE_RUNTIME_OVERHEAD_TOKENS
      + attachments.length * DEFAULT_ATTACHMENT_RESERVE_TOKENS;
    const userMessage: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content: rawPrompt,
      createdAt: Date.now(),
      agentId,
      ...(verifiedMemory.references.length > 0
        ? { metadata: { memoryReferences: verifiedMemory.references } }
        : {}),
    };
    const assistantMessage: ChatMessage = {
      id: createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      agentId,
    };
    const storedSessionId = conversation.sessionIds?.[agentId];
    const resumeCandidate = agentId === 'claude'
      ? shouldResumeClaudeSession(
        storedSessionId,
        conversation.sessionConfigKeys?.claude,
        claudeSessionConfigKey,
      ) ? storedSessionId : undefined
      : shouldResumeCodexSession(
        storedSessionId,
        conversation.sessionConfigKeys?.codex,
        codexSessionConfigKey,
      ) ? storedSessionId : undefined;
    const sessionId = this.canResumeSession(conversation.id, agentId, resumeCandidate)
      ? resumeCandidate
      : undefined;
    // A brand-new draft does not exist in the V2 store until persistStart.
    // It has no history to hand off, so avoid turning the first send into a
    // failed repository lookup.
    const preparedContext = conversation.messages.length === 0
      ? prepareNewConversationContext({
        currentPrompt: runtimePrompt,
        systemPrompt: settings.systemPrompt,
        modelContextTokens: modelContextCapacity.contextWindowTokens,
        modelOutputReserveTokens: modelContextCapacity.outputReserveTokens,
        reservedInputTokens,
      })
      : await this.deps.chatContextService.prepare({
        conversationId: conversation.id,
        targetAgentId: agentId,
        currentPrompt: runtimePrompt,
        resumeCandidate: sessionId,
        modelContextTokens: modelContextCapacity.contextWindowTokens,
        modelOutputReserveTokens: modelContextCapacity.outputReserveTokens,
        requestOverheadText: [settings.systemPrompt],
        reservedInputTokens,
      });
    this.deps.chatRunCoordinator.assertContextPreparationAllowed(conversation.id);
    if (this.deps.chatRunCoordinator.isConversationRunning(conversation.id)) {
      throw new Error('准备上下文期间，这段对话启动了另一项任务；本次未发送。');
    }
    const runtimeExecutionFingerprint = this.deps.runtimeManager.captureExecutionFingerprint({
      agentId,
      cwd: vaultBasePath,
      configSource,
      providerProfileId: configSource === 'providerProfile'
        ? settings.providerProfileByAgent[agentId]
        : undefined,
      model: runtimeModel,
      reasoningEffort: reasoningEffort || undefined,
      planMode: planModeAtSend,
      fullAccess: settings.fullAccessByAgent[agentId],
      purpose: 'chat',
      allowFreshSessionFallback: preparedContext.allowFreshSessionFallback,
    });
    const title = !conversation.title || conversation.title === DEFAULT_CONVERSATION_TITLE
      ? rawPrompt.replace(/\s+/g, ' ').trim().slice(0, 60) || conversation.title
      : conversation.title;
    const conversationSnapshot: StoredConversation = {
      ...conversation,
      title,
      updatedAt: Date.now(),
      messages: [...conversation.messages, userMessage, assistantMessage],
    };
    try {
      const handle = await this.deps.chatRunCoordinator.submit({
        conversationId: conversation.id,
        conversationSnapshot,
        userMessage,
        assistantMessage,
        contextCheckpointDraft: preparedContext.contextCheckpointDraft,
        expectedRevision: preparedContext.sourceRevision,
        sessionConfigKey,
        runtimeRequest: {
          conversationId: conversation.id,
          agentId,
          purpose: 'chat',
          prompt: preparedContext.effectivePrompt,
          cwd: vaultBasePath,
          configSource,
          providerProfileId: configSource === 'providerProfile'
            ? settings.providerProfileByAgent[agentId]
            : undefined,
          ...runtimeExecutionFingerprint,
          ccSwitchProviderId: ccSwitchSnapshot?.currentProviderId ?? undefined,
          ccSwitchRouteFingerprint: ccSwitchSnapshot?.routeFingerprint ?? undefined,
          ccSwitchSessionFingerprint: ccSwitchSessionConfig?.routeFingerprint,
          model: runtimeModel,
          reasoningEffort: reasoningEffort || undefined,
          sessionId: preparedContext.sessionId,
          freshSessionPrompt: preparedContext.freshSessionPrompt,
          allowFreshSessionFallback: preparedContext.allowFreshSessionFallback,
          contextCheckpointId: preparedContext.contextCheckpointId,
          systemPrompt: settings.systemPrompt,
          planMode: planModeAtSend,
          fullAccess: settings.fullAccessByAgent[agentId],
          attachments,
        },
      });
      if (preparedContext.notice) new Notice(preparedContext.notice);
      if (isStillCurrent()) {
        this.running = true;
        this.liveAssistantMessageIds.add(assistantMessage.id);
        this.conversation = conversationSnapshot;
        this.deps.setSelectedConversation(conversationSnapshot);
        this.renderMessages();
        if (this.inputEl.value === inputValueAtSend) {
          this.inputEl.value = '';
          this.deps.chatUiState.updateDraft(conversation.id, '');
          this.deps.chatUiStatePersistence.schedule(conversation.id);
        }
        this.clearSuggestions();
        if (this.selectedSkill === skillAtSend) this.removeSkill();
      }
      const cachedDraft = this.deps.chatUiState.snapshot(conversation.id).draft;
      if (cachedDraft === inputValueAtSend) {
        this.deps.chatUiState.updateDraft(conversation.id, '');
        this.deps.chatUiStatePersistence.schedule(conversation.id);
      }
      void handle.completion.then(result => {
        if (!result.finalPersisted) {
          new Notice(`“${conversationSnapshot.title}”的回答未能完整保存，请先复制已显示的内容。`);
        }
      });
    } catch (error) {
      if (isStillCurrent()) {
        this.running = this.deps.chatRunCoordinator.isConversationRunning(conversation.id);
        this.updateRunControls();
      }
      this.showConversationSendFailure('未能启动当前对话', error);
    }
    } catch (error) {
      this.showConversationSendFailure('未能准备当前对话', error);
    } finally {
      this.conversationOperations.finishPreparation(conversation.id);
      if (this.conversation?.id === conversation.id) this.updateRunControls();
    }
  }

  private canResumeSession(
    conversationId: string,
    agentId: AgentId,
    sessionId: string | undefined,
  ): boolean {
    return shouldAttemptSessionResume({
      sessionId,
      registryHealthy: this.deps.isSessionRegistryHealthy(),
      hasKnownConflict: Boolean(sessionId && this.deps.chatRunCoordinator
        .listSessionConflicts()
        .some(conflict => conflict.sessionId === sessionId)),
      knownOwner: sessionId ? this.deps.chatRunCoordinator.getSessionOwner(sessionId) : null,
      conversationId,
      agentId,
    });
  }

  private async startNewConversation(): Promise<void> {
    this.closeAllDropdowns();
    this.hideHistoryPopover();
    const previousConversationId = this.conversation?.id ?? null;
    this.captureCurrentConversationUiState();
    const generation = ++this.historyOpenGeneration;
    if (previousConversationId) {
      await this.deps.chatUiStatePersistence.flush(previousConversationId);
      if (generation !== this.historyOpenGeneration) return;
    }
    this.conversationPaging = null;
    this.pendingMessageScrollAnchor = null;
    this.liveAssistantMessageIds.clear();
    this.ensureConversation(true);
    this.running = false;
    this.bindCurrentConversation();
    const conversationId = this.conversation?.id;
    this.inputEl.value = conversationId
      ? this.deps.chatUiState.selectConversation(conversationId)?.draft ?? ''
      : '';
    this.removeSkill();
    this.renderMessages();
    this.inputEl.focus();
  }

  private async switchAgent(agentId: AgentId, promptInstallIfMissing = false): Promise<void> {
    const settings = this.deps.getSettings();
    const selection = applyChatAgentSelection(settings, this.agentId, agentId);
    const { agentChanged, defaultChanged } = selection;
    if (!agentChanged && !defaultChanged) {
      this.closeAllDropdowns();
      if (agentId === 'claude' && settings.configSources.claude === 'ccSwitchCurrent') {
        void this.deps.runtimeManager.refreshCcSwitchStatus().then(snapshot => {
          this.reconcileCcSwitchReasoningEffort(snapshot);
          this.refreshAgentControls();
          this.refreshStatus();
        });
      }
      if (promptInstallIfMissing) this.openRuntimeSetup(agentId);
      return;
    }

    this.agentId = selection.agentId;
    this.refreshContextHandoffHint();
    this.refreshAgentControls();
    this.refreshStatus();
    if (agentId === 'codex') void this.deps.runtimeManager.refreshCodexStatus();
    if (agentId === 'claude' && settings.configSources.claude === 'ccSwitchCurrent') {
      void this.deps.runtimeManager.refreshCcSwitchStatus().then(snapshot => {
        this.reconcileCcSwitchReasoningEffort(snapshot);
        this.refreshAgentControls();
        this.refreshStatus();
      });
    }
    if (promptInstallIfMissing) this.openRuntimeSetup(agentId);
    if (defaultChanged) await this.queueSettingsSave();
  }

  private async selectLocalCli(modelId = ''): Promise<void> {
    const agentId = this.agentId;
    const settings = this.deps.getSettings();
    applyLocalCliSelection(settings, agentId, modelId);
    if (agentId === 'claude') {
      settings.reasoningEffortByAgent.claude = reconcileClaudeReasoningEffort(
        this.getClaudeReasoningCapability(settings),
        settings.reasoningEffortByAgent.claude,
      );
    }
    this.closeAllDropdowns();
    this.refreshAgentControls();
    this.refreshStatus();
    await this.queueSettingsSave();
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(agentId);
    if (!status.found) {
      this.openRuntimeSetup(agentId);
    }
  }

  private async selectCodexModel(modelId: string): Promise<void> {
    const settings = this.deps.getSettings();
    const status = this.deps.runtimeManager.getCodexStatus();
    const model = modelId
      ? status.models.find(candidate => candidate.id === modelId || candidate.model === modelId) ?? null
      : status.currentModel ?? status.models.find(candidate => candidate.isDefault) ?? null;
    const selectedEffort = settings.reasoningEffortByAgent?.codex ?? '';
    settings.configSources.codex = 'localCli';
    settings.localModelByAgent.codex = modelId;
    settings.reasoningEffortByAgent.codex = reconcileCodexReasoningEffort(model, selectedEffort);
    this.closeAllDropdowns();
    this.refreshAgentControls();
    this.refreshStatus();
    await this.queueSettingsSave();
  }

  private async selectReasoningEffort(effort: string): Promise<void> {
    const settings = this.deps.getSettings();
    if (this.agentId === 'codex') {
      if (settings.configSources.codex !== 'localCli') return;
      const supported = new Set(['', ...this.getCodexEffortOptions(settings)]);
      if (!supported.has(effort)) return;
    } else if (this.agentId === 'claude') {
      const supported = new Set(['', ...this.getClaudeReasoningCapability(settings).supportedEfforts]);
      if (!supported.has(effort)) return;
    } else {
      return;
    }
    settings.reasoningEffortByAgent[this.agentId] = effort;
    this.closeAllDropdowns();
    this.refreshAgentControls();
    await this.queueSettingsSave();
  }

  private async selectProfile(profileId: string, model?: string): Promise<void> {
    const agentId = this.agentId;
    const descriptor = getAgentDescriptor(agentId);
    if (!descriptor.supportsProviderProfiles) return;
    if (!this.deps.providerStore.find(agentId, profileId)) {
      new Notice('这个供应商配置不可执行，请先在设置中修复 URL。');
      this.deps.openSettings();
      return;
    }
    const settings = this.deps.getSettings();
    settings.configSources[agentId] = 'providerProfile';
    settings.providerProfileByAgent[agentId] = profileId;
    settings.defaultAgentId = agentId;
    if (model !== undefined) {
      await this.deps.providerStore.setActiveModel(profileId, model);
    }
    if (agentId === 'claude') {
      settings.reasoningEffortByAgent.claude = reconcileClaudeReasoningEffort(
        this.getClaudeReasoningCapability(settings),
        settings.reasoningEffortByAgent.claude,
      );
    }
    this.closeAllDropdowns();
    this.refreshAgentControls();
    this.refreshStatus();
    await this.queueSettingsSave();
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(agentId);
    if (!status.found) {
      this.openRuntimeSetup(agentId);
    }
  }

  private getModelSelectorLabel(): string {
    const settings = this.deps.getSettings();
    if (settings.configSources[this.agentId] === 'ccSwitchCurrent') {
      const snapshot = this.deps.runtimeManager.getCcSwitchSnapshot();
      if (snapshot.state === 'ready') return this.ccSwitchLabel(snapshot);
      return 'CC Switch 未连接';
    }
    if (settings.configSources[this.agentId] === 'localCli') {
      if (this.agentId === 'claude') {
        const selectedModel = settings.localModelByAgent.claude?.trim() ?? '';
        const resolved = resolveClaudeLocalModel(
          selectedModel || undefined,
          this.getLocalModelEnvironment(),
          this.getLocalModelCwd(),
        );
        return resolved?.label ?? '跟随 Claude Code';
      }
      if (this.agentId === 'codex') {
        const status = this.deps.runtimeManager.getCodexStatus();
        const selectedModel = settings.localModelByAgent.codex?.trim() ?? '';
        if (selectedModel) {
          return status.models.find(model => model.id === selectedModel || model.model === selectedModel)?.displayName
            ?? selectedModel;
        }
        return status.currentModel?.displayName
          ?? status.currentModelId
          ?? (status.state === 'connecting' ? '读取 Codex 模型…' : '跟随 Codex App');
      }
      const selectedModel = settings.localModelByAgent[this.agentId] ?? '';
      const localModels = listLocalModels(this.agentId);
      const label = selectedModel
        ? localModels.find(model => model.id === selectedModel)?.label ?? selectedModel
        : localModels.find(model => model.id)?.label ?? 'CLI 默认';
      return label;
    }
    const selectedProfileId = settings.providerProfileByAgent[this.agentId];
    const profiles = this.deps.providerStore.list(this.agentId);
    const selectedProfile = selectedProfileId
      ? profiles.find(profile => profile.id === selectedProfileId)
      : profiles.find(profile => profile.isDefault);
    if (selectedProfileId && !selectedProfile) {
      return '模型配置不存在';
    }
    if (!selectedProfile) return '请配置模型';
    const model = selectedProfile.defaultModel || selectedProfile.model || '未设置模型';
    return model || selectedProfile.name;
  }

  private async updateSuggestions(): Promise<void> {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const slashQuery = findSlashQuery(this.inputEl.value, cursor);
    if (slashQuery !== null) {
      const commands = filterSlashCommands(await loadChatSkills(
        this.agentId,
        this.deps.getSettings().creativeSkillNames,
      ), slashQuery);
      this.showSuggestions(commands.map(command => ({
        label: command.label,
        description: command.description,
        apply: () => this.selectSkill(command, slashQuery),
      })));
      return;
    }
    const mentionQuery = findMentionQuery(this.inputEl.value, cursor);
    if (mentionQuery !== null) {
      const lower = mentionQuery.toLowerCase();
      const files = this.app.vault.getFiles()
        .filter(file => file.path.toLowerCase().includes(lower))
        .slice(0, 20);
      this.showSuggestions(files.map(file => ({
        label: file.path,
        description: file.extension,
        apply: () => this.replaceCurrentToken(`@${mentionQuery}`, `@"${file.path}"`),
      })));
      return;
    }
    this.clearSuggestions();
  }

  private showSuggestions(items: Array<{ label: string; description: string; apply: () => void }>): void {
    this.clearSuggestions();
    if (items.length === 0) return;
    this.suggestEl = this.inputEl.parentElement?.createDiv({ cls: 'ailu-suggest' }) ?? null;
    if (!this.suggestEl) return;
    for (const item of items) {
      const el = this.suggestEl.createDiv({ cls: 'ailu-suggest-item' });
      el.createDiv({ text: item.label });
      el.createEl('small', { text: item.description });
      el.onclick = () => {
        item.apply();
        this.clearSuggestions();
        this.inputEl.focus();
      };
    }
  }

  private clearSuggestions(): void {
    this.suggestEl?.remove();
    this.suggestEl = null;
  }

  private async openSkillPicker(): Promise<void> {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    if (findSlashQuery(this.inputEl.value, cursor) === null) {
      const before = this.inputEl.value.slice(0, cursor);
      const insertion = before && !/\s$/.test(before) ? ' /' : '/';
      this.inputEl.value = `${before}${insertion}${this.inputEl.value.slice(cursor)}`;
      const nextCursor = cursor + insertion.length;
      this.inputEl.setSelectionRange(nextCursor, nextCursor);
      this.captureCurrentConversationDraft();
    }
    this.inputEl.focus();
    await this.updateSuggestions();
  }

  private selectSkill(command: SlashCommand, slashQuery: string): void {
    this.selectedSkill = command;
    this.replaceCurrentToken(`/${slashQuery}`, '');
    this.renderSkillPill();
    this.inputEl.focus();
  }

  private renderSkillPill(): void {
    this.skillPillEl?.remove();
    this.skillPillEl = null;
    if (!this.selectedSkill) return;
    const wrapper = this.inputEl.parentElement;
    if (!wrapper) return;
    const pill = wrapper.createDiv({ cls: 'ailu-skill-pill' });
    const icon = pill.createSpan({ cls: 'ailu-skill-pill-icon' });
    setIcon(icon, 'box');
    pill.createSpan({ cls: 'ailu-skill-pill-name', text: this.selectedSkill.label });
    const remove = pill.createEl('button', {
      cls: 'ailu-skill-pill-remove',
      attr: { type: 'button', 'aria-label': '移除 skill' },
    });
    setIcon(remove, 'x');
    remove.onclick = () => this.removeSkill();
    wrapper.insertBefore(pill, this.inputEl);
    this.skillPillEl = pill;
  }

  private removeSkill(): void {
    this.selectedSkill = null;
    this.skillPillEl?.remove();
    this.skillPillEl = null;
  }

  private replaceCurrentToken(token: string, replacement: string): void {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const rawStart = this.inputEl.value.lastIndexOf(token, cursor);
    if (rawStart < 0) return;
    const start = Math.max(0, rawStart);
    this.inputEl.value = `${this.inputEl.value.slice(0, start)}${replacement}${this.inputEl.value.slice(cursor)}`;
    this.captureCurrentConversationDraft();
  }

  private updateRunControls(): void {
    const writeBlocked = Boolean(this.conversationLoadError) || !this.deps.getChatWriteState().available;
    const conversationId = this.conversation?.id;
    const preparing = Boolean(
      conversationId && this.conversationOperations.isPreparing(conversationId),
    );
    if (this.inputEl) this.inputEl.disabled = writeBlocked;
    if (this.sendButtonEl) {
      setIcon(this.sendButtonEl, this.running ? 'square' : preparing ? 'loader-circle' : 'arrow-up');
      const label = this.running ? '停止当前任务' : preparing ? '正在准备当前消息' : '发送消息';
      this.sendButtonEl.ariaLabel = label;
      this.sendButtonEl.title = label;
      this.sendButtonEl.toggleClass('is-running', this.running);
      this.sendButtonEl.toggleClass('is-preparing', preparing);
      this.sendButtonEl.disabled = preparing || (writeBlocked && !this.running);
    }
    this.refreshContextHandoffHint();
  }

  private captureCurrentConversationDraft(): void {
    const conversationId = this.conversation?.id;
    if (!conversationId || !this.inputEl) return;
    this.deps.chatUiState.updateDraft(conversationId, this.inputEl.value);
    this.deps.chatUiStatePersistence.schedule(conversationId);
  }

  private captureCurrentConversationViewport(): void {
    const conversationId = this.conversation?.id;
    if (!conversationId || !this.messagesEl) return;
    if (this.pendingUiStateLoad?.conversationId === conversationId
      && this.pendingUiStateLoad.bindingGeneration === this.conversationBindingGeneration) return;
    const visibleAnchor = this.captureFirstVisibleMessageAnchor(conversationId);
    this.deps.chatUiState.updateViewport(conversationId, {
      scrollTop: this.messagesEl.scrollTop,
      scrollHeight: this.messagesEl.scrollHeight,
      clientHeight: this.messagesEl.clientHeight,
      anchor: visibleAnchor
        ? {
          messageId: visibleAnchor.messageId,
          viewportOffset: visibleAnchor.viewportOffset,
        }
        : null,
    });
    this.deps.chatUiStatePersistence.schedule(conversationId);
  }

  private captureCurrentConversationUiState(): void {
    this.captureCurrentConversationDraft();
    this.captureCurrentConversationViewport();
  }

  private restoreConversationViewport(conversationId: string | null): void {
    if (!conversationId || !this.messagesEl) return;
    const pendingPersisted = this.pendingPersistedViewport?.conversationId === conversationId
      && this.pendingPersistedViewport.bindingGeneration === this.conversationBindingGeneration
      ? this.pendingPersistedViewport
      : null;
    const state = pendingPersisted?.state ?? this.deps.chatUiState.snapshot(conversationId);
    const pendingAnchor = this.pendingMessageScrollAnchor?.conversationId === conversationId
      ? this.pendingMessageScrollAnchor
      : null;
    const persistedAnchor: MessageScrollAnchor | null = state.anchorMessageId
      ? {
        conversationId,
        messageId: state.anchorMessageId,
        viewportOffset: state.anchorViewportOffset,
      }
      : null;
    const anchor = pendingAnchor ?? (state.followBottom ? null : persistedAnchor);
    const restoreGeneration = ++this.viewportRestoreGeneration;
    const renderCompletion = this.messageRenderCompletion;
    void renderCompletion.then(() => {
      if (restoreGeneration !== this.viewportRestoreGeneration
        || this.conversation?.id !== conversationId
        || !this.messagesEl) return;
      this.restoringChatScroll = true;
      try {
        if (anchor) {
          const anchored = Array.from(
            this.messagesEl.querySelectorAll<HTMLElement>('[data-message-id]'),
          ).find(item => item.dataset.messageId === anchor.messageId);
          if (anchored) {
            const viewportTop = this.messagesEl.getBoundingClientRect().top;
            const currentOffset = anchored.getBoundingClientRect().top - viewportTop;
            this.messagesEl.scrollTop += currentOffset - anchor.viewportOffset;
          } else {
            this.messagesEl.scrollTop = Math.min(
              state.scrollTop,
              Math.max(0, this.messagesEl.scrollHeight - this.messagesEl.clientHeight),
            );
          }
        } else {
          this.messagesEl.scrollTop = state.followBottom
            ? this.messagesEl.scrollHeight
            : Math.min(
              state.scrollTop,
              Math.max(0, this.messagesEl.scrollHeight - this.messagesEl.clientHeight),
            );
        }
      } finally {
        this.restoringChatScroll = false;
        if (this.pendingMessageScrollAnchor === pendingAnchor) this.pendingMessageScrollAnchor = null;
        if (this.pendingPersistedViewport === pendingPersisted) {
          this.pendingPersistedViewport = null;
        }
        const pendingLoad = this.pendingUiStateLoad;
        if (pendingLoad?.conversationId === conversationId
          && pendingLoad.bindingGeneration === this.conversationBindingGeneration) {
          this.pendingUiStateLoad = null;
        }
        this.captureCurrentConversationViewport();
      }
    });
  }

  private refreshChatStorageState(): void {
    if (!this.chatStorageBannerEl) return;
    const writeState = this.deps.getChatWriteState();
    const messages: string[] = [];
    if (this.conversationLoadError) {
      messages.push('这段对话读取失败；为保护历史，已禁止继续写入。');
    } else if (!writeState.available) {
      messages.push(writeState.reason || '对话存储当前为只读。');
    }
    if (!this.deps.isSessionRegistryHealthy()) {
      messages.push('历史会话关系未完整读取；后续消息不会自动续接旧会话。');
    }
    if (this.conversationPersistenceWarning) {
      messages.push('最近一条回答未完整保存；请先复制当前可见内容。');
    }
    const uiStateWarning = this.deps.getChatUiStatePersistenceWarning();
    if (uiStateWarning) messages.push(uiStateWarning);
    this.chatStorageBannerEl.setText(messages.join(' '));
    this.chatStorageBannerEl.toggleClass('is-visible', messages.length > 0);
  }

  private async attachActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice('当前没有可附加的笔记。');
      return;
    }
    try {
      await readVerifiedVaultFile(
        this.app,
        file,
        MAX_CHAT_CONTEXT_FILE_BYTES,
        !guessMimeType(file)?.startsWith('image/'),
      );
    } catch (error) {
      new Notice(userFacingErrorMessage(error, '无法安全读取当前笔记。'));
      return;
    }
    const prefix = this.inputEl.value.trim() ? `${this.inputEl.value.trim()}\n` : '';
    this.inputEl.value = `${prefix}@"${file.path}"`;
    this.captureCurrentConversationDraft();
    const mimeType = guessMimeType(file);
    if (mimeType?.startsWith('image/')) {
      new Notice('已添加图片附件。');
    } else {
      new Notice('已添加笔记附件。');
    }
  }

  private async resolveActiveEditorContext(
    maxChars: number,
    capturedContext: ActiveEditorContext | null = this.getVisibleEditorContext(),
    existingAttachments: readonly FileAttachment[] = [],
  ): Promise<{ prompt: string; attachments: FileAttachment[] }> {
    const context = capturedContext;
    if (!context) {
      return { prompt: '', attachments: [] };
    }
    const mimeType = guessMimeType(context.file);
    const attachments: FileAttachment[] = [];
    const lines = [
      'Current Obsidian context:',
      `File: ${context.file.path}`,
      `Cursor: line ${context.cursorLine + 1}, column ${context.cursorCh + 1}`,
    ];
    let verified: Awaited<ReturnType<typeof readVerifiedVaultFile>>;
    try {
      verified = await readVerifiedVaultFile(
        this.app,
        context.file,
        MAX_CHAT_CONTEXT_FILE_BYTES,
        !mimeType?.startsWith('image/'),
      );
    } catch {
      lines.push('[Could not securely read active file content]');
      return { prompt: lines.join('\n'), attachments };
    }
    if (mimeType?.startsWith('image/')) {
      try {
        const existingBytes = existingAttachments.reduce((total, attachment) => (
          total + (attachment.byteLength ?? 0)
        ), 0);
        if (
          existingAttachments.length >= MAX_FROZEN_ATTACHMENT_COUNT
          || existingBytes + verified.body.byteLength > MAX_FROZEN_ATTACHMENTS_TOTAL_BYTES
        ) {
          throw new Error('Image attachments exceed the per-turn safety budget.');
        }
        attachments.push(freezeVerifiedImageAttachment({
          vaultPath: context.file.path,
          vaultRoot: getVaultBasePath(this.app) ?? '',
          body: verified.body,
          mimeType,
        }));
      } catch {
        lines.push('[Could not securely freeze active image attachment]');
        return { prompt: lines.join('\n'), attachments };
      }
    }

    const selectedText = context.selection.trim();
    if (selectedText) {
      lines.push(
        'Selected text:',
        '```',
        truncateText(selectedText, maxChars),
        '```',
      );
      return { prompt: lines.join('\n'), attachments };
    }

    if (context.currentLine.trim()) {
      lines.push(
        'Current cursor line:',
        '```',
        context.currentLine,
        '```',
      );
    }

    if (mimeType?.startsWith('image/')) {
      lines.push('The active file is an image attachment.');
      return { prompt: lines.join('\n'), attachments };
    }

    if (mimeType === 'text/markdown' || mimeType === 'text/plain') {
      const text = verified.body.toString('utf8');
      lines.push(
        'Active file content:',
        '```',
        truncateText(text, maxChars),
        '```',
      );
    } else {
      lines.push('[Unsupported active file type]');
    }

    return { prompt: lines.join('\n'), attachments };
  }

  private openRuntimeSetup(agentId: AgentId = this.agentId): void {
    const settings = this.deps.getSettings();
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(agentId);
    if (status.found) {
      new Notice(`${status.descriptor.displayName} 已可使用。`);
      return;
    }
    new RuntimeSetupModal(this.app, status, this.deps.openSettings).open();
  }
}

function contextSignature(context: ActiveEditorContext): string {
  return [
    context.file.path,
    context.selection,
    context.currentLine,
    context.cursorLine,
    context.cursorCh,
  ].join('\n');
}

function countTextChars(value: string): number {
  return Array.from(value.trim()).length;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated]`;
}

function errorMessage(error: unknown): string {
  return userFacingErrorMessage(error, '操作未完成，请查看本地诊断日志。');
}

function cloneChatSettingsSnapshot(settings: AiluSettings): AiluSettings {
  return JSON.parse(JSON.stringify(settings)) as AiluSettings;
}

function nextLayoutFrames(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function mergeAttachments(attachments: FileAttachment[]): FileAttachment[] {
  const seen = new Set<string>();
  const merged: FileAttachment[] = [];
  for (const attachment of attachments) {
    const identity = attachment.contentSha256?.trim() || attachment.absolutePath || attachment.vaultPath;
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(attachment);
  }
  return merged;
}

export interface PersistedConversationMessagePage {
  messages: Array<{ sequence: number; message: ChatMessage }>;
  nextBeforeSequence: number | null;
}

export interface LoadPersistedMessagesThroughAnchorOptions {
  conversationId: string;
  anchorMessageId: string;
  persistedMessages: readonly ChatMessage[];
  nextBeforeSequence: number | null;
  loadPage: (beforeSequence: number) => Promise<PersistedConversationMessagePage>;
  shouldContinue?: () => boolean;
}

/**
 * Page backwards only as far as the user's explicitly persisted reading anchor.
 * A repeated cursor is treated as the end so a malformed store cannot loop forever.
 */
export async function loadPersistedMessagesThroughAnchor(
  options: LoadPersistedMessagesThroughAnchorOptions,
): Promise<{
  persistedMessages: ChatMessage[];
  nextBeforeSequence: number | null;
  anchorFound: boolean;
}> {
  let persistedMessages = [...options.persistedMessages];
  let nextBeforeSequence = options.nextBeforeSequence;
  let anchorFound = persistedMessages.some(message => message.id === options.anchorMessageId);
  const visitedCursors = new Set<number>();
  while (!anchorFound && nextBeforeSequence !== null && (options.shouldContinue?.() ?? true)) {
    if (visitedCursors.has(nextBeforeSequence)) break;
    visitedCursors.add(nextBeforeSequence);
    const page = await options.loadPage(nextBeforeSequence);
    persistedMessages = mergeConversationMessages(
      page.messages.map(item => item.message),
      persistedMessages,
    );
    anchorFound = persistedMessages.some(message => message.id === options.anchorMessageId);
    if (page.nextBeforeSequence === nextBeforeSequence) {
      nextBeforeSequence = null;
      break;
    }
    nextBeforeSequence = page.nextBeforeSequence;
  }
  return { persistedMessages, nextBeforeSequence, anchorFound };
}

/**
 * Keep the stable order of already loaded history, replace matching live
 * messages with their newest snapshot, then append newly streamed messages.
 */
export function mergeConversationMessages(
  persistedMessages: readonly ChatMessage[],
  liveMessages: readonly ChatMessage[],
): ChatMessage[] {
  const liveById = new Map(liveMessages.map(message => [message.id, message]));
  const seen = new Set<string>();
  const merged: ChatMessage[] = [];
  for (const message of persistedMessages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(liveById.get(message.id) ?? message);
  }
  for (const message of liveMessages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
}

/** Preserve the current page order while refreshing duplicates and appending the next page. */
export function mergeConversationSummaries(
  current: readonly ConversationSummary[],
  incoming: readonly ConversationSummary[],
): ConversationSummary[] {
  const incomingById = new Map(incoming.map(item => [item.id, item]));
  const seen = new Set<string>();
  const merged: ConversationSummary[] = [];
  for (const item of current) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(incomingById.get(item.id) ?? item);
  }
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

export function getConversationArchiveBlockReason(
  conversation: Pick<ConversationSummary, 'id' | 'archivedAt'>,
  currentConversationId: string | null,
  running: boolean,
): string | null {
  if (conversation.archivedAt !== null) return null;
  if (conversation.id === currentConversationId) {
    return '当前正在查看的对话不能归档；请先切换到另一段对话。';
  }
  if (running) return '这段对话仍在后台运行，完成或停止后才能归档。';
  return null;
}

/** Apply the same complete-request budget before the first durable turn exists. */
export function prepareNewConversationContext(input: {
  currentPrompt: string;
  systemPrompt?: string;
  modelContextTokens: number;
  modelOutputReserveTokens: number;
  reservedInputTokens: number;
}): ChatContextPreparation {
  const budget = estimateContextBudget({
    additionalText: [input.systemPrompt ?? '', input.currentPrompt],
    modelContextTokens: input.modelContextTokens,
    outputReserveTokens: input.modelOutputReserveTokens,
    reservedTokens: input.reservedInputTokens,
  });
  if (budget.overSoftLimit) throw new ChatContextOverflowError();
  return {
    effectivePrompt: input.currentPrompt,
    sessionId: undefined,
    allowFreshSessionFallback: false,
    mode: 'new-conversation',
    notice: '',
  };
}

export function resolveHistoryConversationIcon(options: {
  agentId: AgentId;
  isArchived: boolean;
  isCurrent: boolean;
  isRunning: boolean;
}): string {
  if (options.isRunning) return 'loader-circle';
  if (options.isArchived) return 'archive';
  if (options.isCurrent) return 'check';
  return HISTORY_AGENT_ICONS[options.agentId] ?? 'message-circle';
}

/**
 * UI-only gates. Preparation is independent per conversation, while history
 * mutations/open operations for the same conversation are strictly ordered.
 */
export class ConversationUiOperationGate {
  private readonly preparing = new Set<string>();
  private readonly archivePending = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();

  tryBeginPreparation(conversationId: string): boolean {
    if (this.preparing.has(conversationId)) return false;
    this.preparing.add(conversationId);
    return true;
  }

  finishPreparation(conversationId: string): void {
    this.preparing.delete(conversationId);
  }

  isPreparing(conversationId: string): boolean {
    return this.preparing.has(conversationId);
  }

  markArchivePending(conversationId: string): boolean {
    if (this.archivePending.has(conversationId)) return false;
    this.archivePending.add(conversationId);
    return true;
  }

  clearArchivePending(conversationId: string): void {
    this.archivePending.delete(conversationId);
  }

  isArchivePending(conversationId: string): boolean {
    return this.archivePending.has(conversationId);
  }

  run<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(conversationId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    const tail = task.then(() => undefined, () => undefined);
    this.tails.set(conversationId, tail);
    void tail.then(() => {
      if (this.tails.get(conversationId) === tail) this.tails.delete(conversationId);
    });
    return task;
  }
}

const HISTORY_PAGE_SIZE = 50;
const MESSAGE_PAGE_SIZE = 100;
const HISTORY_SEARCH_DEBOUNCE_MS = 250;

const HISTORY_AGENT_ICONS: Record<AgentId, string> = {
  claude: 'bot',
  codex: 'terminal',
};

function formatRelativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}
