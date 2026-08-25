import {
  ItemView,
  MarkdownView,
  Notice,
  requestUrl,
  setIcon,
  TFile,
  type ViewStateResult,
  WorkspaceLeaf,
} from 'obsidian';

import { PLUGIN_NAME, SECRET_IDS, VIEW_IDS } from '../ids';
import type { LarkCliService } from '../feishu/larkCli';
import {
  assertPreparedArticleReady,
  DraftCreatedVerificationError,
  getWeChatPublishingAdvisories,
  LocalRelayTransport,
  prepareInformationOsPublicationPackage,
  prepareSnapshotForPublishing,
  selectCoverAsset,
  type PreparedArticle,
  type PublishingHttpRequest,
  type WeChatPublishingAdvisory,
} from '../publishing';
import {
  assertPublishingDestinationUnchanged,
  assertPublishingSourceUnchanged,
  createPublishingDestinationIdentity,
  isCurrentPublishingSource,
  maskedPublishingAppId,
  type PublishingDestinationIdentity,
  type PublishingSourceIdentity,
} from '../publishing/publicationGuard';
import { buildPreparedArticleClipboardPayload } from '../publishing/preparedArticleBuilder';
import {
  buildPublishingPreviewStats,
  type PublishingPreviewStats,
} from '../publishing/previewStats';
import type { AiluSettings } from '../types';
import { userFacingErrorMessage, userFacingErrorText } from '../utils/userFacingError';
import {
  renderWeChatArticle,
  replaceFormulaSvgs,
} from '../wechat/renderer';
import { buildWeChatSnapshot } from '../wechat/snapshot';
import type { WeChatAssetDraft, WeChatPreviewSnapshot } from '../wechat/types';
import {
  createTemplateThemeDocument,
  SELECTABLE_WECHAT_THEME_DEFINITIONS,
  type WeChatTemplateThemeId,
  type WeChatThemeDocument,
  type WeChatThemeId,
} from '../wechat/themes';
import {
  WECHAT_BODY_FONT_DEFINITIONS,
  WECHAT_BODY_FONT_SIZE_OPTIONS,
  type WeChatBodyFontId,
  type WeChatTypographyPreferences,
} from '../wechat/typography';
import { confirmDraftUpload } from './confirmDraftUploadModal';
import {
  openInformationOsPackageImport,
  type InformationOsPackagePublishResult,
} from './informationOsPackageImportModal';
import { FeishuPublishingPanel } from './feishuPublishingPanel';
import { XPublishingPanel } from './xPublishingPanel';
import type { XArticleUploadTaskCoordinator } from '../xArticle/uploadTaskCoordinator';
import {
  capturePublishingPreviewScroll,
  resolvePublishingPreviewScrollTop,
  type PublishingPreviewScrollState,
} from './publishingPreviewScroll';
import {
  collectPublishingSourceAnchors,
  type PublishingEditorScrollPosition,
  type PublishingEditorScrollSync,
  type PublishingSourceAnchor,
  resolvePublishingSourceScrollTop,
} from './publishingSourceScroll';
import { renderStudioChrome } from './studioChrome';
import { brandAiluWorkspaceTab, restoreWorkspaceTabIcon } from './ailuBrandMark';
import { buildWeChatCoverPreviewModel } from './wechatCoverPreview';
import {
  attentionPublishingTargetActivity,
  IDLE_PUBLISHING_TARGET_ACTIVITY,
  publishingTargetAccessibleLabel,
  runningPublishingTargetActivity,
  type PublishingTarget,
  type PublishingTargetActivity,
} from './publishingTargetActivity';

interface PublishingStudioViewDeps {
  larkCli: LarkCliService;
  xArticleUploadTasks: XArticleUploadTaskCoordinator;
  getSettings: () => AiluSettings;
  saveSettings: () => Promise<void>;
  editorScrollSync: PublishingEditorScrollSync;
  openChat: () => void;
  openSettings: () => void;
  authorizeXCookieMutation: () => Promise<void>;
  exportXCookiesFromChrome: () => Promise<{ cookieCount: number }>;
  ensureXCookiesForUpload: (allowExport: boolean) => Promise<{ cookieCount: number }>;
  getFeishuAssociationKey: () => string | null;
  ensureFeishuAssociationKey: () => Promise<string>;
}

type Operation = 'preflight' | 'publishing' | null;

interface PublicationIntent {
  identity: PublishingSourceIdentity;
  destination: PublishingDestinationIdentity;
  relayToken: string;
  prepared: PreparedArticle;
}

interface PublishingPreviewAnchor {
  key: string;
  occurrence: number;
  offset: number;
}

interface PendingPublishingPreviewScroll {
  filePath: string;
  state: PublishingPreviewScrollState;
  anchor: PublishingPreviewAnchor | null;
}

const PUBLISHING_PREVIEW_ANCHOR_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'blockquote',
  'pre',
  'figure',
  'img',
].join(',');

/**
 * One local-first publishing surface. Rendering and preflight never require an
 * account; the only network mutation is the explicitly confirmed relay upload.
 */
export class PublishingStudioView extends ItemView {
  private file: TFile | null = null;
  private snapshot: WeChatPreviewSnapshot | null = null;
  private themeDocument: WeChatThemeDocument | null = null;
  private prepared: PreparedArticle | null = null;
  private preparedKey = '';
  private preparedRenderedHtml = '';
  private articleEl: HTMLElement | null = null;
  private loading = false;
  private operation: Operation = null;
  private error: string | null = null;
  private statusText = '';
  private refreshTimer: number | null = null;
  private initialized = false;
  private renderVersion = 0;
  private sourceRevision = 0;
  private sourceDirty = true;
  private target: PublishingTarget = 'wechat';
  // Target changes only remount the visible surface. Panel instances stay
  // alive for the current file so an explicitly started remote task can
  // finish while the user prepares another destination.
  private feishuPanel: FeishuPublishingPanel | null = null;
  private feishuPanelFilePath = '';
  private xPanel: XPublishingPanel | null = null;
  private xPanelFilePath = '';
  private readonly targetButtonEls = new Map<PublishingTarget, HTMLButtonElement>();
  private pendingTargetFile: TFile | null = null;
  private pendingPreviewScroll: PendingPublishingPreviewScroll | null = null;
  private previewScrollRestoreFrame: number | null = null;
  private previewScrollRestoreTimer: number | null = null;
  private previewPendingImageCleanup: (() => void) | null = null;
  private editorScrollUnsubscribe: (() => void) | null = null;
  private previewSourceAnchors: PublishingSourceAnchor[] = [];
  private previewSourceSyncFrame: number | null = null;
  private previewSourceResizeObserver: ResizeObserver | null = null;
  private programmaticPreviewScroll = false;
  private programmaticPreviewScrollToken = 0;
  private previewManualScrollSequence: number | null = null;
  private wechatCoverObjectUrl: string | null = null;
  private wechatCoverObjectKey = '';

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: PublishingStudioViewDeps,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_IDS.publishing;
  }

  override getDisplayText(): string {
    return PLUGIN_NAME;
  }

  override getIcon(): string {
    return 'panels-top-left';
  }

  override async onOpen(): Promise<void> {
    brandAiluWorkspaceTab(this.leaf);
    if (!this.initialized) {
      this.initialized = true;
      this.containerEl.addClass('ailu-view-container');
      this.registerEvent(this.app.workspace.on('file-open', file => {
        if (file?.extension === 'md') void this.setFile(file);
      }));
      this.registerEvent(this.app.vault.on('modify', file => {
        if (!(file instanceof TFile) || file.path !== this.file?.path) return;
        this.markSourceDirty();
        if (this.target === 'wechat') {
          this.statusText = this.operation === 'publishing'
            ? this.statusText
            : '检测到文章变化，正在刷新预览…';
        }
        if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => {
          this.refreshTimer = null;
          if (this.feishuPanelFilePath === file.path) void this.feishuPanel?.refresh();
          if (this.xPanelFilePath === file.path) void this.xPanel?.refresh();
          if (this.target === 'wechat') void this.reload();
        }, 450);
      }));
    }
    if (!this.editorScrollUnsubscribe) {
      this.editorScrollUnsubscribe = this.deps.editorScrollSync.subscribe(position => {
        this.handleEditorScroll(position);
      });
    }
    if (!this.file) {
      const active = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (active) this.file = active;
    }
    await this.reload();
  }

  override async onClose(): Promise<void> {
    restoreWorkspaceTabIcon(this.leaf);
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.pendingTargetFile = null;
    this.editorScrollUnsubscribe?.();
    this.editorScrollUnsubscribe = null;
    this.resetPreviewScrollRestore();
    this.releaseWeChatCoverObjectUrl();
    this.resetTargetPanels();
  }

  override getState(): Record<string, unknown> {
    return {
      filePath: this.file?.path ?? null,
      target: this.target,
    };
  }

  override async setState(
    state: Record<string, unknown>,
    result: ViewStateResult,
  ): Promise<void> {
    const nextTarget: PublishingTarget = state.target === 'feishu'
      ? 'feishu'
      : state.target === 'x'
        ? 'x'
        : 'wechat';
    if (nextTarget !== this.target) {
      this.resetPreviewScrollRestore();
      if (nextTarget !== 'wechat') this.releaseWeChatCoverObjectUrl();
      this.target = nextTarget;
    }
    const filePath = typeof state.filePath === 'string' ? state.filePath : '';
    const candidate = filePath ? this.app.vault.getAbstractFileByPath(filePath) : null;
    if (candidate instanceof TFile && candidate.path !== this.file?.path) {
      if (this.isAnyTargetBusy()) {
        this.pendingTargetFile = candidate;
      } else {
        this.pendingTargetFile = null;
        this.resetPreviewScrollRestore();
        this.resetTargetPanels();
        this.file = candidate;
        this.markSourceDirty();
      }
    }
    await super.setState(state, result);
    if (this.contentEl.isConnected) await this.reload();
  }

  async setFile(file: TFile): Promise<void> {
    if (file.extension !== 'md') return;
    if (
      this.file?.path === file.path
      && (this.target !== 'wechat' || (this.snapshot && !this.sourceDirty))
    ) return;
    if (this.file?.path !== file.path && this.isAnyTargetBusy()) {
      const changed = this.pendingTargetFile?.path !== file.path;
      this.pendingTargetFile = file;
      if (changed) {
        new Notice(
          `${this.busyTargetLabels().join('、')}仍有任务进行中或结果待核对，处理完成后会切换到新笔记。`,
        );
      }
      return;
    }
    this.pendingTargetFile = null;
    if (this.file?.path !== file.path) this.resetPreviewScrollRestore();
    this.resetTargetPanels();
    this.file = file;
    await this.reload();
  }

  async refresh(): Promise<void> {
    if (this.target === 'feishu') {
      const panel = this.ensureFeishuPanel();
      if (panel) await panel.refresh();
      else await this.render();
      return;
    }
    if (this.target === 'x') {
      const panel = this.ensureXPanel();
      if (panel) await panel.refresh();
      else await this.render();
      return;
    }
    await this.reload();
  }

  private async reload(): Promise<void> {
    if (this.target !== 'wechat') {
      this.releaseWeChatCoverObjectUrl();
      this.loading = false;
      this.error = null;
      await this.render();
      if (this.target === 'feishu') this.ensureFeishuPanel()?.activate();
      else this.ensureXPanel()?.activate();
      return;
    }
    const file = this.file;
    const revision = this.markSourceDirty();
    const canKeepExistingPreview = Boolean(
      file
      && this.snapshot?.sourcePath === file.path
      && this.themeDocument,
    );
    this.loading = true;
    this.error = null;
    if (this.operation !== 'publishing') {
      this.statusText = canKeepExistingPreview ? '正在同步文章变化…' : '';
    }
    if (!canKeepExistingPreview) await this.render();
    try {
      if (!file) {
        if (!this.isCurrentReload(revision, file)) return;
        this.snapshot = null;
        this.themeDocument = null;
        return;
      }
      const snapshot = await buildWeChatSnapshot(this.app, file);
      if (!this.isCurrentReload(revision, file)) return;
      const themeDocument = this.resolveThemeDocument(snapshot);
      if (!this.isCurrentReload(revision, file)) return;
      this.snapshot = snapshot;
      this.themeDocument = themeDocument;
    } catch (error) {
      if (!this.isCurrentReload(revision, file)) return;
      this.snapshot = null;
      this.themeDocument = null;
      this.error = userFacingErrorMessage(error, '无法读取当前笔记。');
    } finally {
      if (this.isCurrentReload(revision, file)) {
        this.sourceDirty = false;
        this.loading = false;
        if (this.operation !== 'publishing') this.statusText = '';
        await this.render();
      }
    }
  }

  private markSourceDirty(): number {
    this.sourceRevision += 1;
    this.sourceDirty = true;
    this.invalidatePrepared();
    return this.sourceRevision;
  }

  private isCurrentReload(revision: number, file: TFile | null): boolean {
    return isCurrentPublishingSource(
      revision,
      file?.path ?? '',
      this.sourceRevision,
      this.file?.path ?? '',
    );
  }

  private selectedThemeId(): WeChatTemplateThemeId {
    return this.deps.getSettings().publishing.themeId;
  }

  private resolveThemeDocument(snapshot: WeChatPreviewSnapshot): WeChatThemeDocument {
    return createTemplateThemeDocument(snapshot, this.selectedThemeId());
  }

  private invalidatePrepared(): void {
    this.prepared = null;
    this.preparedKey = '';
    this.preparedRenderedHtml = '';
  }

  private currentPreparedKey(): string {
    if (!this.snapshot || !this.themeDocument) return '';
    const typography = this.currentTypography();
    return [
      this.snapshot.contentHash,
      this.themeDocument.contentHash,
      typography.bodyFontId,
      typography.bodyFontSize,
    ].join(':');
  }

  private currentTypography(): WeChatTypographyPreferences {
    const publishing = this.deps.getSettings().publishing;
    return {
      bodyFontId: publishing.bodyFontId,
      bodyFontSize: publishing.bodyFontSize,
    };
  }

  private cancelPreviewScrollRestoreCallbacks(): void {
    if (this.previewScrollRestoreFrame !== null) {
      window.cancelAnimationFrame(this.previewScrollRestoreFrame);
      this.previewScrollRestoreFrame = null;
    }
    if (this.previewScrollRestoreTimer !== null) {
      window.clearTimeout(this.previewScrollRestoreTimer);
      this.previewScrollRestoreTimer = null;
    }
    this.previewPendingImageCleanup?.();
    this.previewPendingImageCleanup = null;
  }

  private teardownPreviewSourceTracking(): void {
    if (this.previewSourceSyncFrame !== null) {
      window.cancelAnimationFrame(this.previewSourceSyncFrame);
      this.previewSourceSyncFrame = null;
    }
    this.previewSourceResizeObserver?.disconnect();
    this.previewSourceResizeObserver = null;
    this.previewSourceAnchors = [];
    this.programmaticPreviewScrollToken += 1;
    this.programmaticPreviewScroll = false;
  }

  private resetPreviewScrollRestore(): void {
    this.cancelPreviewScrollRestoreCallbacks();
    this.teardownPreviewSourceTracking();
    this.pendingPreviewScroll = null;
    this.previewManualScrollSequence = null;
  }

  private handleEditorScroll(position: PublishingEditorScrollPosition): void {
    if (position.filePath !== this.file?.path) return;
    if (
      this.previewManualScrollSequence !== null
      && position.sequence > this.previewManualScrollSequence
    ) {
      this.previewManualScrollSequence = null;
    }
    this.cancelPreviewScrollRestoreCallbacks();
    this.pendingPreviewScroll = null;
    this.scheduleCurrentEditorScrollSync(false);
  }

  private currentEditorScrollPosition(): PublishingEditorScrollPosition | null {
    const filePath = this.file?.path;
    if (!filePath) return null;
    const active = this.deps.editorScrollSync.latest(filePath);
    return active;
  }

  private measurePreviewSourceAnchors(viewport: HTMLElement, article: HTMLElement): void {
    this.previewSourceAnchors = collectPublishingSourceAnchors(
      viewport,
      article,
    );
  }

  private applyEditorScrollPosition(
    viewport: HTMLElement,
    position: PublishingEditorScrollPosition,
    force: boolean,
  ): boolean {
    if (
      position.filePath !== this.file?.path
      || (
        !force
        && this.previewManualScrollSequence !== null
        && position.sequence <= this.previewManualScrollSequence
      )
    ) return false;
    const nextTop = resolvePublishingSourceScrollTop(
      position,
      viewport,
      this.previewSourceAnchors,
    );
    if (Math.abs(viewport.scrollTop - nextTop) < 1) return true;
    this.programmaticPreviewScrollToken += 1;
    const token = this.programmaticPreviewScrollToken;
    this.programmaticPreviewScroll = true;
    viewport.scrollTop = nextTop;
    window.requestAnimationFrame(() => {
      if (token === this.programmaticPreviewScrollToken) {
        this.programmaticPreviewScroll = false;
      }
    });
    return true;
  }

  private scheduleCurrentEditorScrollSync(force: boolean): void {
    if (this.previewSourceSyncFrame !== null) {
      window.cancelAnimationFrame(this.previewSourceSyncFrame);
    }
    const version = this.renderVersion;
    this.previewSourceSyncFrame = window.requestAnimationFrame(() => {
      this.previewSourceSyncFrame = null;
      if (version !== this.renderVersion) return;
      const viewport = this.contentEl.querySelector<HTMLElement>('.ailu-publishing-scroll');
      const article = viewport?.querySelector<HTMLElement>('.ailu-publishing-article');
      const position = this.currentEditorScrollPosition();
      if (!viewport || !article || !position || !viewport.isConnected || !article.isConnected) return;
      if (!this.previewSourceAnchors.length) this.measurePreviewSourceAnchors(viewport, article);
      this.applyEditorScrollPosition(viewport, position, force);
    });
  }

  private installPreviewSourceTracking(
    viewport: HTMLElement,
    article: HTMLElement,
    version: number,
  ): void {
    viewport.addEventListener('scroll', () => {
      if (this.programmaticPreviewScroll) return;
      const position = this.currentEditorScrollPosition();
      if (position) this.previewManualScrollSequence = position.sequence;
    }, { passive: true });
    this.measurePreviewSourceAnchors(viewport, article);
    this.previewSourceResizeObserver = new ResizeObserver(() => {
      if (
        version !== this.renderVersion
        || !viewport.isConnected
        || !article.isConnected
      ) return;
      this.measurePreviewSourceAnchors(viewport, article);
      this.scheduleCurrentEditorScrollSync(false);
    });
    this.previewSourceResizeObserver.observe(article);

    if (this.previewManualScrollSequence !== null && this.pendingPreviewScroll) {
      this.schedulePreviewScrollRestore(viewport, article, version);
      return;
    }
    const position = this.currentEditorScrollPosition();
    if (position) {
      this.cancelPreviewScrollRestoreCallbacks();
      this.pendingPreviewScroll = null;
      this.scheduleCurrentEditorScrollSync(true);
      return;
    }
    this.schedulePreviewScrollRestore(viewport, article, version);
  }

  private previewAnchorElements(article: HTMLElement): HTMLElement[] {
    return Array.from(article.querySelectorAll<HTMLElement>(PUBLISHING_PREVIEW_ANCHOR_SELECTOR));
  }

  private previewAnchorKey(element: HTMLElement): string {
    const text = element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 180) ?? '';
    if (text) return `${element.tagName.toLowerCase()}:${text}`;
    if (element.tagName !== 'IMG') return '';
    const alt = element.getAttribute('alt')?.trim();
    if (alt) return `img:${alt}`;
    const source = element.getAttribute('src')?.trim() ?? '';
    return source ? `img:${source.slice(-180)}` : '';
  }

  private capturePreviewAnchor(
    viewport: HTMLElement,
    article: HTMLElement,
  ): PublishingPreviewAnchor | null {
    const viewportBounds = viewport.getBoundingClientRect();
    const occurrences = new Map<string, number>();
    for (const element of this.previewAnchorElements(article)) {
      const key = this.previewAnchorKey(element);
      if (!key) continue;
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const bounds = element.getBoundingClientRect();
      if (
        bounds.height <= 0
        || bounds.bottom <= viewportBounds.top + 1
        || bounds.top >= viewportBounds.bottom - 1
      ) continue;
      return {
        key,
        occurrence,
        offset: bounds.top - viewportBounds.top,
      };
    }
    return null;
  }

  private findPreviewAnchor(
    article: HTMLElement,
    anchor: PublishingPreviewAnchor,
  ): HTMLElement | null {
    let occurrence = 0;
    for (const element of this.previewAnchorElements(article)) {
      if (this.previewAnchorKey(element) !== anchor.key) continue;
      if (occurrence === anchor.occurrence) return element;
      occurrence += 1;
    }
    return null;
  }

  private capturePreviewScrollBeforeRender(): void {
    this.cancelPreviewScrollRestoreCallbacks();
    this.teardownPreviewSourceTracking();
    if (!this.file) return;
    const viewport = this.contentEl.querySelector<HTMLElement>('.ailu-publishing-scroll');
    const article = viewport?.querySelector<HTMLElement>('.ailu-publishing-article');
    if (!viewport || !article) return;
    const pending = this.pendingPreviewScroll;
    if (
      pending?.filePath === this.file.path
      && pending.state.top > 1
      && viewport.scrollTop <= 1
    ) return;
    const anchor = this.capturePreviewAnchor(viewport, article);
    this.pendingPreviewScroll = {
      filePath: this.file.path,
      state: capturePublishingPreviewScroll(viewport, anchor?.offset ?? null),
      anchor,
    };
  }

  private schedulePreviewScrollRestore(
    viewport: HTMLElement,
    article: HTMLElement,
    version: number,
  ): void {
    const pending = this.pendingPreviewScroll;
    if (!pending || pending.filePath !== this.file?.path) return;
    const restore = (): boolean => {
      if (
        version !== this.renderVersion
        || pending !== this.pendingPreviewScroll
        || !viewport.isConnected
        || !article.isConnected
      ) return false;
      const anchorElement = pending.anchor
        ? this.findPreviewAnchor(article, pending.anchor)
        : null;
      const viewportBounds = viewport.getBoundingClientRect();
      const anchorContentTop = anchorElement
        ? viewport.scrollTop + anchorElement.getBoundingClientRect().top - viewportBounds.top
        : null;
      viewport.scrollTop = resolvePublishingPreviewScrollTop(
        pending.state,
        viewport,
        anchorContentTop,
      );
      return true;
    };
    this.previewScrollRestoreFrame = window.requestAnimationFrame(() => {
      this.previewScrollRestoreFrame = null;
      if (!restore()) return;
      this.previewScrollRestoreFrame = window.requestAnimationFrame(() => {
        this.previewScrollRestoreFrame = null;
        if (!restore()) return;
        const pendingImages = new Set(
          Array.from(article.querySelectorAll<HTMLImageElement>('img'))
            .filter(image => !image.complete),
        );
        if (pendingImages.size === 0) {
          if (this.pendingPreviewScroll === pending) this.pendingPreviewScroll = null;
          return;
        }
        const listeners = new Map<HTMLImageElement, () => void>();
        const cleanup = (): void => {
          for (const [image, listener] of listeners) {
            image.removeEventListener('load', listener);
            image.removeEventListener('error', listener);
          }
          listeners.clear();
          if (this.previewPendingImageCleanup === cleanup) {
            this.previewPendingImageCleanup = null;
          }
        };
        this.previewPendingImageCleanup = cleanup;
        for (const image of pendingImages) {
          const settled = (): void => {
            pendingImages.delete(image);
            restore();
            if (pendingImages.size > 0) return;
            cleanup();
            if (this.previewScrollRestoreTimer !== null) {
              window.clearTimeout(this.previewScrollRestoreTimer);
              this.previewScrollRestoreTimer = null;
            }
            if (this.pendingPreviewScroll === pending) this.pendingPreviewScroll = null;
          };
          listeners.set(image, settled);
          image.addEventListener('load', settled, { once: true });
          image.addEventListener('error', settled, { once: true });
        }
        this.previewScrollRestoreTimer = window.setTimeout(() => {
          this.previewScrollRestoreTimer = null;
          restore();
          cleanup();
          if (this.pendingPreviewScroll === pending) this.pendingPreviewScroll = null;
        }, 15_000);
      });
    });
  }

  private async render(): Promise<void> {
    this.capturePreviewScrollBeforeRender();
    const version = ++this.renderVersion;
    const root = this.contentEl;
    root.empty();
    root.addClass('ailu-view', 'ailu-publishing-view');

    const shell = root.createDiv({ cls: 'ailu-publishing-shell' });
    renderStudioChrome(shell, {
      active: 'publishing',
      context: this.file?.path ?? '当前 Markdown',
      onNavigate: section => {
        if (section === 'chat') this.deps.openChat();
      },
      renderActions: actions => {
        const refresh = actions.createEl('button', {
          cls: 'clickable-icon ailu-header-btn',
          attr: {
            type: 'button',
            'aria-label': this.target === 'feishu' ? '刷新飞书本地预览' : '刷新预览',
          },
        });
        setIcon(refresh, 'refresh-cw');
        refresh.disabled = this.isCurrentTargetBusy();
        refresh.onclick = () => void this.refresh();
        const settings = actions.createEl('button', {
          cls: 'clickable-icon ailu-header-btn',
          attr: { type: 'button', 'aria-label': '打开草稿设置' },
        });
        setIcon(settings, 'settings');
        settings.onclick = this.deps.openSettings;
      },
    });

    this.renderTools(shell);
    if (this.target === 'feishu') {
      this.articleEl = null;
      const panel = this.ensureFeishuPanel();
      if (panel) {
        const preview = await panel.render(shell);
        if (
          version !== this.renderVersion
          || this.target !== 'feishu'
          || this.feishuPanel !== panel
          || !shell.isConnected
        ) return;
        panel.activate();
        if (!preview) return;
        this.installPreviewSourceTracking(
          preview.viewport,
          preview.article,
          version,
        );
      } else {
        this.renderFeishuEmpty(shell);
      }
      return;
    }
    if (this.target === 'x') {
      this.articleEl = null;
      const panel = this.ensureXPanel();
      if (panel) {
        const preview = await panel.render(shell);
        if (
          version !== this.renderVersion
          || this.target !== 'x'
          || this.xPanel !== panel
          || !shell.isConnected
        ) return;
        panel.activate();
        if (!preview) return;
        this.installPreviewSourceTracking(
          preview.viewport,
          preview.article,
          version,
        );
      } else {
        this.renderXEmpty(shell);
      }
      return;
    }
    this.renderMeta(shell);
    const scroll = shell.createDiv({ cls: 'ailu-publishing-scroll' });
    const surface = scroll.createDiv({ cls: 'ailu-wechat-publishing-surface' });
    this.articleEl = null;
    const canKeepExistingPreview = Boolean(
      this.loading
      && this.file
      && this.snapshot?.sourcePath === this.file.path
      && this.themeDocument,
    );
    const canShowPreview = Boolean(
      (!this.loading || canKeepExistingPreview)
      && this.file
      && !this.error
      && this.snapshot
      && this.themeDocument,
    );
    if (canShowPreview && this.snapshot) {
      this.renderWeChatCoverPreview(surface, this.snapshot);
    } else {
      this.releaseWeChatCoverObjectUrl();
    }
    const canvas = surface.createDiv({ cls: 'ailu-publishing-canvas' });

    if (this.loading && !canKeepExistingPreview) {
      this.renderState(canvas, 'loader-circle', '正在生成本地预览', '读取 Markdown、图片与主题样式。', 'ailu-publishing-loading');
    } else if (!this.file) {
      this.renderState(canvas, 'file-text', '打开一篇 Markdown', '草稿区会自动跟随当前笔记。', 'ailu-publishing-empty');
    } else if (this.error) {
      this.renderState(canvas, 'triangle-alert', '预览生成失败', this.error, 'ailu-publishing-error');
    } else if (!this.snapshot) {
      this.renderState(canvas, 'file-warning', '没有可预览内容', '请检查当前笔记是否可读。', 'ailu-publishing-empty');
    } else if (!this.themeDocument) {
      this.renderState(canvas, 'triangle-alert', '模板加载失败', '请重新刷新当前笔记。', 'ailu-publishing-error');
    } else {
      const article = canvas.createDiv({ cls: 'ailu-publishing-article' });
      this.articleEl = article;
      try {
        await renderWeChatArticle(this.app, this, this.snapshot, article, {
          themeDocument: this.themeDocument,
          typography: this.currentTypography(),
        });
        if (version !== this.renderVersion || !scroll.isConnected) return;
        this.installPreviewSourceTracking(scroll, article, version);
      } catch (error) {
        if (version !== this.renderVersion) return;
        article.empty();
        this.renderState(
          article,
          'triangle-alert',
          '主题渲染失败',
          userFacingErrorMessage(error, '当前主题无法渲染，请切换主题或重新打开笔记。'),
          'ailu-publishing-error',
        );
        this.articleEl = null;
      }
    }
    this.renderActions(shell);
  }

  private renderTools(parent: HTMLElement): void {
    const tools = parent.createDiv({ cls: 'ailu-publishing-tools' });
    const targets = tools.createDiv({
      cls: 'ailu-publishing-targets',
      attr: { role: 'tablist', 'aria-label': '草稿目标' },
    });
    this.targetButtonEls.clear();
    for (const option of [
      { id: 'wechat' as const, label: '公众号' },
      { id: 'feishu' as const, label: '飞书' },
      { id: 'x' as const, label: 'X 文章' },
    ]) {
      const button = targets.createEl('button', {
        cls: option.id === this.target ? 'is-active' : '',
        attr: {
          type: 'button',
          role: 'tab',
          'aria-selected': String(option.id === this.target),
        },
      });
      button.createSpan({ cls: 'ailu-publishing-target-label', text: option.label });
      button.createSpan({
        cls: 'ailu-publishing-target-activity',
        attr: { 'aria-hidden': 'true' },
      });
      this.targetButtonEls.set(option.id, button);
      this.updateTargetButton(option.id, button, option.label);
      button.onclick = () => void this.changeTarget(option.id);
    }
    tools.createDiv({ cls: 'ailu-publishing-tool-divider' });
    if (this.target === 'feishu') {
      tools.createSpan({
        cls: 'ailu-feishu-toolbar-state',
        text: '飞书文档 · 本地预览 · 手动同步',
      });
      tools.createDiv({ cls: 'ailu-spacer' });
      return;
    }
    if (this.target === 'x') {
      tools.createSpan({
        cls: 'ailu-x-toolbar-state',
        text: 'X Article · 仅创建草稿',
      });
      tools.createDiv({ cls: 'ailu-spacer' });
      return;
    }
    const formatControls = tools.createDiv({ cls: 'ailu-publishing-format-controls' });
    const themeLabel = formatControls.createEl('label', { cls: 'is-template' });
    themeLabel.createSpan({ text: '模板' });
    const themeSelect = themeLabel.createEl('select', {
      attr: { 'aria-label': '公众号排版主题' },
    });
    for (const theme of SELECTABLE_WECHAT_THEME_DEFINITIONS) {
      themeSelect.createEl('option', { value: theme.id, text: theme.label });
    }
    themeSelect.value = this.selectedThemeId();
    themeSelect.disabled = Boolean(this.operation) || this.sourceDirty;
    themeSelect.onchange = () => void this.changeTheme(themeSelect.value as WeChatThemeId);

    const publishing = this.deps.getSettings().publishing;
    const fontLabel = formatControls.createEl('label', { cls: 'is-font' });
    fontLabel.createSpan({ text: '字体' });
    const fontSelect = fontLabel.createEl('select', {
      attr: { 'aria-label': '公众号正文字体' },
    });
    for (const font of WECHAT_BODY_FONT_DEFINITIONS) {
      fontSelect.createEl('option', { value: font.id, text: font.label });
    }
    fontSelect.value = publishing.bodyFontId;
    fontSelect.disabled = Boolean(this.operation) || this.sourceDirty;
    fontSelect.onchange = () => void this.changeBodyFont(fontSelect.value as WeChatBodyFontId);

    const sizeLabel = formatControls.createEl('label', { cls: 'is-size' });
    sizeLabel.createSpan({ text: '字号' });
    const sizeSelect = sizeLabel.createEl('select', {
      attr: { 'aria-label': '公众号正文字号' },
    });
    for (const size of WECHAT_BODY_FONT_SIZE_OPTIONS) {
      sizeSelect.createEl('option', {
        value: String(size),
        text: size === 0 ? '跟随模板' : `${size}px`,
      });
    }
    sizeSelect.value = String(publishing.bodyFontSize);
    sizeSelect.disabled = Boolean(this.operation) || this.sourceDirty;
    sizeSelect.onchange = () => void this.changeBodyFontSize(Number(sizeSelect.value));

    tools.createDiv({ cls: 'ailu-spacer' });
    if (this.statusText) tools.createSpan({ cls: 'ailu-operation-status', text: this.statusText });
  }

  private renderMeta(parent: HTMLElement): void {
    const meta = parent.createDiv({ cls: 'ailu-publishing-meta' });
    if (!this.snapshot) {
      meta.createSpan({ text: this.file?.path ?? '尚未选择文章' });
      return;
    }
    const stats = this.currentPreviewStats();
    meta.createEl('strong', { text: this.snapshot.title || this.file?.basename || '未命名文章' });
    meta.createSpan({
      text: `正文图 ${stats.bodyImageCount} 张`,
      attr: { title: '按正文中实际出现次数统计，不含封面' },
    });
    meta.createSpan({
      text: stats.coverImageCount ? '封面 1 张' : '未设置封面',
      attr: { title: '封面单独计算，不重复计入正文图片' },
    });
    meta.createSpan({
      text: `正文 ${stats.visibleTextLength.toLocaleString()} 字`,
      attr: { title: '不计 YAML、Markdown 标记、图片地址和排版空白' },
    });
    const blocking = this.snapshot.warnings.filter(warning => warning.blocking).length;
    if (blocking) {
      meta.createSpan({ cls: 'has-warning', text: `${blocking} 项需处理` });
    } else if (
      !this.sourceDirty
      && this.prepared
      && this.preparedKey === this.currentPreparedKey()
      && this.articleEl
      && this.preparedRenderedHtml === this.articleEl.outerHTML
    ) {
      const advisories = this.publishingAdvisories(this.prepared);
      if (advisories.length) {
        meta.createSpan({
          cls: 'has-warning',
          text: `提醒：${advisories[0].title}`,
          attr: { title: advisories.map(advisory => advisory.message).join('\n') },
        });
      } else {
        meta.createSpan({
          cls: 'is-ready',
          text: `预检通过 · 正文图 ${this.prepared.stats.imageCount} 张`,
        });
      }
    } else {
      meta.createSpan({ text: '本地预览' });
    }
  }

  private renderWeChatCoverPreview(
    parent: HTMLElement,
    snapshot: WeChatPreviewSnapshot,
  ): void {
    const model = buildWeChatCoverPreviewModel(snapshot);
    if (!model.asset) this.releaseWeChatCoverObjectUrl();
    const card = parent.createDiv({
      cls: `ailu-wechat-cover-hero is-${model.source}`,
    });
    const media = card.createDiv({ cls: 'ailu-wechat-cover-media' });
    const previewUrl = model.asset ? this.wechatCoverPreviewUrl(model.asset) : null;
    if (previewUrl) {
      media.addClass('has-image');
      media.createEl('img', {
        attr: {
          src: previewUrl,
          alt: model.alt,
          decoding: 'async',
        },
      });
    } else {
      media.setAttrs({ role: 'img', 'aria-label': model.alt });
      const empty = media.createDiv({ cls: 'ailu-wechat-cover-empty' });
      const icon = empty.createSpan({ attr: { 'aria-hidden': 'true' } });
      setIcon(icon, model.asset ? 'image-off' : 'image-plus');
      empty.createSpan({
        text: model.asset ? '封面暂时无法显示' : '未设置封面',
      });
    }
    media.createDiv({
      cls: 'ailu-wechat-cover-badge',
      text: model.badge,
    });
    const body = card.createDiv({ cls: 'ailu-wechat-cover-body' });
    body.createDiv({ cls: 'ailu-wechat-cover-title', text: model.title });
    body.createDiv({ cls: 'ailu-wechat-cover-summary', text: model.summary });
  }

  private wechatCoverPreviewUrl(asset: WeChatAssetDraft): string | null {
    const objectKey = `${asset.contentHash}:${asset.mimeType}`;
    if (this.wechatCoverObjectUrl && this.wechatCoverObjectKey === objectKey) {
      return this.wechatCoverObjectUrl;
    }
    this.releaseWeChatCoverObjectUrl();
    if (
      asset.body.byteLength > 0
      && typeof URL.createObjectURL === 'function'
    ) {
      try {
        this.wechatCoverObjectUrl = URL.createObjectURL(new Blob(
          [asset.body],
          { type: asset.mimeType || 'application/octet-stream' },
        ));
        this.wechatCoverObjectKey = objectKey;
        return this.wechatCoverObjectUrl;
      } catch {
        this.releaseWeChatCoverObjectUrl();
      }
    }
    return asset.previewUrl.trim() || null;
  }

  private releaseWeChatCoverObjectUrl(): void {
    if (
      this.wechatCoverObjectUrl
      && typeof URL.revokeObjectURL === 'function'
    ) URL.revokeObjectURL(this.wechatCoverObjectUrl);
    this.wechatCoverObjectUrl = null;
    this.wechatCoverObjectKey = '';
  }

  private currentPreviewStats(): PublishingPreviewStats {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return { bodyImageCount: 0, coverImageCount: 0, visibleTextLength: 0 };
    }
    const cover = selectCoverAsset(snapshot);
    const stats = buildPublishingPreviewStats(snapshot.markdown, {
      bodyCoverTarget: cover?.token ?? null,
      hasCover: Boolean(cover),
      title: snapshot.title,
    });
    const hasCurrentPreflight = !this.sourceDirty
      && this.prepared
      && this.preparedKey === this.currentPreparedKey()
      && this.articleEl
      && this.preparedRenderedHtml === this.articleEl.outerHTML;
    return hasCurrentPreflight
      ? { ...stats, bodyImageCount: this.prepared?.stats.imageCount ?? stats.bodyImageCount }
      : stats;
  }

  private publishingAdvisories(prepared: PreparedArticle): WeChatPublishingAdvisory[] {
    const snapshotAdvisories = (this.snapshot?.warnings ?? [])
      .filter(warning => !warning.blocking)
      .map(warning => ({
        code: warning.code,
        title: warning.message,
        message: warning.message,
      }));
    return [
      ...snapshotAdvisories,
      ...getWeChatPublishingAdvisories(prepared.stats.imageCount),
    ];
  }

  private renderActions(parent: HTMLElement): void {
    const actions = parent.createDiv({ cls: 'ailu-publishing-actions' });
    const importPackage = actions.createEl('button', {
      text: '导入 InformationOS 包',
      attr: { type: 'button' },
    });
    importPackage.onclick = () => void this.importInformationOsPackage();
    const copy = actions.createEl('button', { text: '复制排版', attr: { type: 'button' } });
    copy.onclick = () => void this.copyPreview();
    const preflight = actions.createEl('button', { text: '检查草稿', attr: { type: 'button' } });
    preflight.onclick = () => void this.runPreflight();
    const publish = actions.createEl('button', {
      cls: 'mod-cta',
      text: this.operation === 'publishing' ? '正在上传草稿…' : '上传到草稿箱',
      attr: { type: 'button' },
    });
    publish.onclick = () => void this.publishDraft();
  }

  private renderState(
    parent: HTMLElement,
    iconName: string,
    title: string,
    description: string,
    className: string,
  ): void {
    const state = parent.createDiv({ cls: className });
    const card = state.createDiv({ cls: 'ailu-publishing-state-card' });
    const icon = card.createSpan();
    setIcon(icon, iconName);
    card.createEl('h3', { text: title });
    card.createEl('p', { text: description });
  }

  private renderFeishuEmpty(parent: HTMLElement): void {
    const meta = parent.createDiv({ cls: 'ailu-publishing-meta' });
    meta.createSpan({ text: '尚未选择文章' });
    const scroll = parent.createDiv({ cls: 'ailu-publishing-scroll ailu-feishu-publishing-scroll' });
    const surface = scroll.createDiv({ cls: 'ailu-feishu-publishing-surface' });
    this.renderState(
      surface,
      'file-text',
      '打开一篇 Markdown',
      '飞书同步会自动跟随当前笔记，但不会自动上传。',
      'ailu-publishing-empty',
    );
    const actions = parent.createDiv({ cls: 'ailu-publishing-actions ailu-feishu-publishing-actions' });
    const button = actions.createEl('button', {
      cls: 'mod-cta',
      text: '创建飞书文档',
      attr: { type: 'button' },
    });
    button.disabled = true;
  }

  private renderXEmpty(parent: HTMLElement): void {
    const meta = parent.createDiv({ cls: 'ailu-publishing-meta' });
    meta.createSpan({ text: '尚未选择文章' });
    const scroll = parent.createDiv({ cls: 'ailu-publishing-scroll ailu-x-publishing-scroll' });
    const surface = scroll.createDiv({ cls: 'ailu-x-publishing-surface' });
    this.renderState(
      surface,
      'file-text',
      '打开一篇 Markdown',
      'X Article 预览会自动跟随当前笔记，但不会自动创建草稿。',
      'ailu-publishing-empty',
    );
    const actions = parent.createDiv({ cls: 'ailu-publishing-actions ailu-x-actions' });
    const button = actions.createEl('button', {
      cls: 'mod-cta',
      text: '创建 X 草稿',
      attr: { type: 'button' },
    });
    button.disabled = true;
  }

  private isCurrentTargetBusy(): boolean {
    if (this.target === 'feishu') return Boolean(this.feishuPanel?.isBusy());
    if (this.target === 'x') return Boolean(this.xPanel?.isBusy());
    return Boolean(this.operation);
  }

  private targetActivity(target: PublishingTarget): PublishingTargetActivity {
    if (target === 'feishu') return this.feishuPanel?.activity() ?? IDLE_PUBLISHING_TARGET_ACTIVITY;
    if (target === 'x') return this.xPanel?.activity() ?? IDLE_PUBLISHING_TARGET_ACTIVITY;
    if (this.operation === 'publishing') return runningPublishingTargetActivity('正在上传草稿');
    if (this.operation === 'preflight') return runningPublishingTargetActivity('正在检查草稿');
    if (this.error || this.statusText.includes('回读未通过')) {
      return attentionPublishingTargetActivity('需要检查');
    }
    return IDLE_PUBLISHING_TARGET_ACTIVITY;
  }

  private updateTargetButton(
    target: PublishingTarget,
    button: HTMLButtonElement,
    label: string,
  ): void {
    const activity = this.targetActivity(target);
    const selected = target === this.target;
    button.toggleClass('is-active', selected);
    button.toggleClass('is-running', activity.tone === 'running');
    button.toggleClass('needs-attention', activity.tone === 'attention');
    button.setAttribute('aria-selected', String(selected));
    const accessibleLabel = publishingTargetAccessibleLabel({
      targetLabel: label,
      activity,
      selected,
    });
    button.setAttribute('aria-label', accessibleLabel);
    button.title = accessibleLabel;
  }

  private refreshTargetButtons(): void {
    const labels: Record<PublishingTarget, string> = {
      wechat: '公众号',
      feishu: '飞书',
      x: 'X 文章',
    };
    for (const [target, button] of this.targetButtonEls) {
      this.updateTargetButton(target, button, labels[target]);
    }
  }

  private isAnyTargetBusy(): boolean {
    return Boolean(this.operation)
      || Boolean(this.feishuPanel?.isBusy())
      || Boolean(this.xPanel?.isBusy());
  }

  private busyTargetLabels(): string[] {
    const labels: string[] = [];
    if (this.operation) labels.push('公众号');
    if (this.feishuPanel?.isBusy()) labels.push('飞书');
    if (this.xPanel?.isBusy()) labels.push('X 文章');
    return labels;
  }

  private drainPendingTargetFileIfIdle(): boolean {
    if (!this.pendingTargetFile || this.isAnyTargetBusy()) return false;
    const pending = this.pendingTargetFile;
    this.pendingTargetFile = null;
    void this.setFile(pending);
    return true;
  }

  private handlePanelRenderRequest(target: Exclude<PublishingTarget, 'wechat'>, filePath: string): void {
    if (this.file?.path !== filePath) return;
    this.refreshTargetButtons();
    if (this.drainPendingTargetFileIfIdle()) return;
    if (this.target === target) void this.render();
  }

  private async changeTarget(target: PublishingTarget): Promise<void> {
    if (target === this.target) return;
    this.resetPreviewScrollRestore();
    if (target !== 'wechat') this.releaseWeChatCoverObjectUrl();
    this.target = target;
    if (target === 'wechat') {
      await this.reload();
      return;
    }
    await this.render();
  }

  private ensureFeishuPanel(): FeishuPublishingPanel | null {
    const file = this.file;
    if (!file || this.target !== 'feishu') return null;
    if (this.feishuPanel && this.feishuPanelFilePath === file.path) {
      return this.feishuPanel;
    }
    this.resetFeishuPanel();
    this.feishuPanelFilePath = file.path;
    this.feishuPanel = new FeishuPublishingPanel({
      app: this.app,
      component: this,
      cli: this.deps.larkCli,
      file,
      getSettings: this.deps.getSettings,
      saveSettings: this.deps.saveSettings,
      getAssociationKey: this.deps.getFeishuAssociationKey,
      ensureAssociationKey: this.deps.ensureFeishuAssociationKey,
      requestRender: () => this.handlePanelRenderRequest('feishu', file.path),
    });
    return this.feishuPanel;
  }

  private resetFeishuPanel(): void {
    this.feishuPanel?.dispose();
    this.feishuPanel = null;
    this.feishuPanelFilePath = '';
  }

  private ensureXPanel(): XPublishingPanel | null {
    const file = this.file;
    if (!file || this.target !== 'x') return null;
    if (this.xPanel && this.xPanelFilePath === file.path) return this.xPanel;
    this.resetXPanel();
    this.xPanelFilePath = file.path;
    this.xPanel = new XPublishingPanel({
      app: this.app,
      component: this,
      file,
      getSettings: this.deps.getSettings,
      requestRender: () => this.handlePanelRenderRequest('x', file.path),
      uploadTasks: this.deps.xArticleUploadTasks,
      authorizeCookieMutation: this.deps.authorizeXCookieMutation,
      exportXCookiesFromChrome: this.deps.exportXCookiesFromChrome,
      ensureCookiesForUpload: this.deps.ensureXCookiesForUpload,
    });
    return this.xPanel;
  }

  private resetXPanel(): void {
    this.xPanel?.dispose();
    this.xPanel = null;
    this.xPanelFilePath = '';
  }

  private resetTargetPanels(): void {
    this.resetFeishuPanel();
    this.resetXPanel();
  }

  private async changeTheme(themeId: WeChatThemeId): Promise<void> {
    const revision = this.markSourceDirty();
    const settings = this.deps.getSettings();
    settings.publishing.themeId = themeId;
    settings.wechatThemeId = themeId;
    await this.render();
    try {
      await this.deps.saveSettings();
      if (revision !== this.sourceRevision) return;
      this.themeDocument = this.snapshot ? this.resolveThemeDocument(this.snapshot) : null;
      this.sourceDirty = false;
      await this.render();
    } catch (error) {
      if (revision === this.sourceRevision) {
        this.sourceDirty = false;
        await this.render();
      }
      new Notice(userFacingErrorMessage(error, '保存排版设置失败。'));
    }
  }

  private async changeBodyFont(bodyFontId: WeChatBodyFontId): Promise<void> {
    const settings = this.deps.getSettings();
    settings.publishing.bodyFontId = bodyFontId;
    await this.saveTypographyChange();
  }

  private async changeBodyFontSize(bodyFontSize: number): Promise<void> {
    const settings = this.deps.getSettings();
    settings.publishing.bodyFontSize = bodyFontSize;
    await this.saveTypographyChange();
  }

  private async saveTypographyChange(): Promise<void> {
    this.invalidatePrepared();
    await this.render();
    try {
      await this.deps.saveSettings();
    } catch (error) {
      new Notice(userFacingErrorMessage(error, '保存正文排版设置失败。'));
    }
  }

  private hasBlockingWarnings(): boolean {
    return Boolean(this.snapshot?.warnings.some(warning => warning.blocking));
  }

  private blockingWarningMessage(): string | null {
    return this.snapshot?.warnings.find(warning => warning.blocking)?.message ?? null;
  }

  private reserveWeChatOperation(operation: Exclude<Operation, null>): boolean {
    if (this.operation) {
      new Notice(this.operation === 'publishing'
        ? '公众号草稿正在上传并核验，请等待当前操作完成。'
        : '公众号草稿正在检查，请等待当前操作完成。');
      return false;
    }
    this.operation = operation;
    return true;
  }

  private async refreshWeChatPreviewForAction(): Promise<void> {
    if (this.sourceDirty || !this.articleEl) await this.reload();
  }

  private async prepareCurrent(): Promise<PreparedArticle> {
    if (this.sourceDirty || !this.file || !this.snapshot || !this.themeDocument || !this.articleEl) {
      throw new Error('当前排版尚未准备好');
    }
    if (this.hasBlockingWarnings()) {
      const first = this.snapshot.warnings.find(warning => warning.blocking);
      throw new Error(first?.message ?? '文章仍有阻断项');
    }
    const revision = this.sourceRevision;
    const file = this.file;
    const sourceSnapshot = this.snapshot;
    const themeDocument = this.themeDocument;
    const articleEl = this.articleEl;
    const renderedHtml = articleEl.outerHTML;
    const key = this.currentPreparedKey();
    if (
      this.prepared
      && this.preparedKey === key
      && this.preparedRenderedHtml === renderedHtml
    ) {
      assertPreparedArticleReady(this.prepared);
      return this.prepared;
    }
    this.invalidatePrepared();
    const rendered = articleEl.cloneNode(true) as HTMLElement;
    const formulaAssets = new Map<string, WeChatAssetDraft>();
    try {
      await replaceFormulaSvgs(rendered, async asset => {
        formulaAssets.set(asset.token, asset);
        return asset.token;
      }, false);
    } catch (error) {
      throw new Error(userFacingErrorMessage(error, '公式转换失败，请检查文章中的公式语法。'));
    }
    const snapshot = formulaAssets.size
      ? {
          ...sourceSnapshot,
          assets: [
            ...new Map([
              ...sourceSnapshot.assets.map(asset => [asset.token, asset] as const),
              ...formulaAssets,
            ]).values(),
          ],
        }
      : sourceSnapshot;
    const prepared = await prepareSnapshotForPublishing(snapshot, rendered.innerHTML, {
      containerStyle: rendered.getAttribute('style') ?? '',
    });
    if (
      this.sourceDirty
      || revision !== this.sourceRevision
      || file !== this.file
      || sourceSnapshot !== this.snapshot
      || themeDocument !== this.themeDocument
      || key !== this.currentPreparedKey()
    ) {
      throw new Error('文章或排版在检查期间已变化，请重新检查');
    }
    assertPreparedArticleReady(prepared);
    this.prepared = prepared;
    this.preparedKey = key;
    this.preparedRenderedHtml = renderedHtml;
    return prepared;
  }

  private currentPublicationIdentity(): PublishingSourceIdentity | null {
    if (
      this.sourceDirty
      || !this.file
      || !this.snapshot
      || !this.themeDocument
      || !this.prepared
      || this.preparedKey !== this.currentPreparedKey()
    ) return null;
    // The rendered HTML is frozen by prepareCurrent(). It deliberately does
    // not depend on the currently mounted tab; source/theme revisions still
    // invalidate it before the first remote request.
    return {
      revision: this.sourceRevision,
      filePath: this.file.path,
      snapshotContentHash: this.snapshot.contentHash,
      themeContentHash: this.themeDocument.contentHash,
      renderedHtml: this.preparedRenderedHtml,
      preparedContentHash: this.prepared.contentHash,
      preflightIntegrityHash: this.prepared.preflight.integrityHash,
    };
  }

  private currentPublicationDestination(): { identity: PublishingDestinationIdentity; relayToken: string } {
    const publishing = this.deps.getSettings().publishing;
    if (publishing.transport !== 'localRelay') {
      throw new Error('当前安全版本仅开放自托管公众号中转');
    }
    const relayToken = this.app.secretStorage.getSecret(SECRET_IDS.wechatRelayToken)?.trim() ?? '';
    return {
      identity: createPublishingDestinationIdentity({
        relayUrl: publishing.relayUrl,
        appId: publishing.appId,
        relayToken,
      }),
      relayToken,
    };
  }

  private capturePublicationIntent(prepared: PreparedArticle): PublicationIntent {
    if (prepared !== this.prepared) {
      throw new Error('当前预检结果已失效，请重新检查');
    }
    assertPreparedArticleReady(prepared);
    const identity = this.currentPublicationIdentity();
    if (!identity) throw new Error('当前预检结果已失效，请重新检查');
    const destination = this.currentPublicationDestination();
    return {
      identity,
      destination: destination.identity,
      relayToken: destination.relayToken,
      prepared,
    };
  }

  private assertPublicationIntentCurrent(intent: PublicationIntent): void {
    assertPreparedArticleReady(intent.prepared);
    if (intent.prepared !== this.prepared) {
      throw new Error('文章或排版在确认期间已变化，请重新检查并确认');
    }
    assertPublishingSourceUnchanged(intent.identity, this.currentPublicationIdentity());
    let currentDestination: PublishingDestinationIdentity | null = null;
    try {
      currentDestination = this.currentPublicationDestination().identity;
    } catch {
      currentDestination = null;
    }
    assertPublishingDestinationUnchanged(intent.destination, currentDestination);
  }

  private async runPreflight(): Promise<void> {
    if (!this.reserveWeChatOperation('preflight')) return;
    this.statusText = '正在检查标题、图片和微信兼容性…';
    try {
      await this.renderWeChatOperationState();
      await this.refreshWeChatPreviewForAction();
      const prepared = await this.prepareCurrent();
      const advisories = this.publishingAdvisories(prepared);
      const summary = `${prepared.stats.imageCount} 张正文图，${prepared.stats.compressedImageCount} 张已压缩`;
      if (advisories.length) {
        this.statusText = `检查完成：${summary}；${advisories[0].title}`;
        new Notice(`草稿检查完成：${advisories.map(advisory => advisory.message).join('；')}`);
      } else {
        this.statusText = `检查通过：${summary}`;
        new Notice('草稿检查通过。');
      }
    } catch (error) {
      this.statusText = '';
      new Notice(this.blockingWarningMessage()
        ?? userFacingErrorMessage(error, '草稿检查失败，请刷新预览后重试。'));
    } finally {
      this.operation = null;
      await this.finishWeChatOperation();
    }
  }

  private async copyPreview(): Promise<void> {
    if (!this.reserveWeChatOperation('preflight')) return;
    this.statusText = '正在按草稿发布规则净化复制内容…';
    try {
      await this.renderWeChatOperationState();
      await this.refreshWeChatPreviewForAction();
      const prepared = await this.prepareCurrent();
      const { html, plain } = buildPreparedArticleClipboardPayload(prepared);
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        })]);
      } else {
        await navigator.clipboard.writeText(plain);
      }
      const imageSummary = prepared.stats.imageCount
        ? `，含 ${prepared.stats.imageCount} 张正文图`
        : '';
      this.statusText = `已复制经过草稿预检的排版${imageSummary}`;
      new Notice(`${this.statusText}。`);
    } catch (error) {
      this.statusText = '';
      new Notice(this.blockingWarningMessage()
        ?? userFacingErrorMessage(error, '复制排版内容失败。'));
    } finally {
      this.operation = null;
      await this.finishWeChatOperation();
    }
  }

  private async importInformationOsPackage(): Promise<void> {
    if (this.operation) {
      this.reserveWeChatOperation('preflight');
      return;
    }
    if (this.deps.getSettings().publishing.transport !== 'localRelay') {
      new Notice('当前安全版本仅开放自托管公众号中转，请在草稿设置中切换。');
      return;
    }
    if (!this.reserveWeChatOperation('preflight')) return;
    this.statusText = '等待选择 InformationOS 发布包…';
    await this.renderWeChatOperationState();
    try {
      const result = await openInformationOsPackageImport(this.app, {
        prepare: packagePath => prepareInformationOsPublicationPackage(packagePath),
        publish: prepared => this.publishImportedInformationOsPackage(prepared),
      });
      if (result.status === 'succeeded') {
        this.statusText = `《${result.title}》草稿已创建并回读验证：${result.draftMediaId}`;
        new Notice(`《${result.title}》草稿已创建，${result.uploadedImageCount} 张正文图片已核验。`);
      } else if (result.status === 'remote_unknown') {
        this.statusText = `草稿 ${result.draftMediaId} 已返回，但回读未通过；请先核对草稿箱，勿直接重试`;
        new Notice('公众号草稿可能已创建，但回读校验未通过；请先核对草稿箱。', 0);
      } else {
        this.statusText = '';
      }
    } finally {
      this.operation = null;
      await this.finishWeChatOperation();
    }
  }

  private async publishImportedInformationOsPackage(
    prepared: PreparedArticle,
  ): Promise<InformationOsPackagePublishResult | null> {
    assertPreparedArticleReady(prepared);
    const destination = this.currentPublicationDestination();
    const advisories = getWeChatPublishingAdvisories(prepared.stats.imageCount);
    const confirmed = await confirmDraftUpload(this.app, {
      title: prepared.title,
      transportLabel: 'InformationOS 发布包 · 自托管公众号中转',
      accountLabel: maskedPublishingAppId(destination.identity.appId),
      relayHost: destination.identity.relayHost,
      imageCount: prepared.stats.imageCount,
      compressedImageCount: prepared.stats.compressedImageCount,
      warningCount: advisories.length,
      warnings: advisories.map(advisory => advisory.message),
    });
    if (!confirmed) return null;

    let currentDestination: PublishingDestinationIdentity | null = null;
    try {
      currentDestination = this.currentPublicationDestination().identity;
    } catch {
      currentDestination = null;
    }
    assertPublishingDestinationUnchanged(destination.identity, currentDestination);
    this.operation = 'publishing';
    this.statusText = `正在上传《${prepared.title}》的封面与正文图片，并创建草稿…`;
    await this.renderWeChatOperationState();

    try {
      currentDestination = null;
      try {
        currentDestination = this.currentPublicationDestination().identity;
      } catch {
        currentDestination = null;
      }
      assertPublishingDestinationUnchanged(destination.identity, currentDestination);
      const transport = new LocalRelayTransport({
        relayUrl: destination.identity.relayUrl,
        relayToken: destination.relayToken,
        request: request => this.relayRequest(request),
      });
      const result = await transport.publish(prepared, {
        idempotencyKey: prepared.contentHash,
      });
      return {
        status: 'succeeded',
        draftMediaId: result.draftMediaId,
        uploadedImageCount: result.uploadedImageCount,
      };
    } catch (error) {
      if (error instanceof DraftCreatedVerificationError) {
        return {
          status: 'remote_unknown',
          draftMediaId: error.draftMediaId,
        };
      }
      throw error;
    } finally {
      if (this.operation === 'publishing') this.operation = 'preflight';
      this.refreshTargetButtons();
    }
  }

  private async publishDraft(): Promise<void> {
    if (this.operation) {
      this.reserveWeChatOperation('preflight');
      return;
    }
    if (this.deps.getSettings().publishing.transport !== 'localRelay') {
      new Notice('当前安全版本仅开放自托管公众号中转，请在草稿设置中切换。');
      return;
    }
    if (!this.reserveWeChatOperation('preflight')) return;
    this.statusText = '上传前重新执行完整检查…';
    try {
      await this.renderWeChatOperationState();
      await this.refreshWeChatPreviewForAction();
      const prepared = await this.prepareCurrent();
      const intent = this.capturePublicationIntent(prepared);
      const advisories = this.publishingAdvisories(prepared);
      const confirmed = await confirmDraftUpload(this.app, {
        title: prepared.title,
        transportLabel: '自托管公众号中转',
        accountLabel: maskedPublishingAppId(intent.destination.appId),
        relayHost: intent.destination.relayHost,
        imageCount: prepared.stats.imageCount,
        compressedImageCount: prepared.stats.compressedImageCount,
        warningCount: advisories.length,
        warnings: advisories.map(advisory => advisory.message),
      });
      if (!confirmed) return;
      this.assertPublicationIntentCurrent(intent);
      this.operation = 'publishing';
      this.statusText = `正在上传《${prepared.title}》的封面与正文图片，并创建草稿…`;
      await this.renderWeChatOperationState();
      // The render above yields to Obsidian. Revalidate immediately before the
      // first network request so a file-open/modify/theme change cannot race
      // the confirmation modal and upload a stale prepared article.
      this.assertPublicationIntentCurrent(intent);
      const transport = new LocalRelayTransport({
        relayUrl: intent.destination.relayUrl,
        relayToken: intent.relayToken,
        request: request => this.relayRequest(request),
      });
      const result = await transport.publish(intent.prepared, {
        idempotencyKey: intent.prepared.contentHash,
      });
      this.statusText = `《${prepared.title}》草稿已创建并回读验证：${result.draftMediaId}`;
      new Notice(`《${prepared.title}》草稿已创建，${result.uploadedImageCount} 张正文图片已核验。`);
    } catch (error) {
      if (error instanceof DraftCreatedVerificationError) {
        this.statusText = `草稿 ${error.draftMediaId} 已返回，但回读未通过；请先核对草稿箱，勿直接重试`;
        new Notice(userFacingErrorText(error.message, '公众号草稿可能已创建，但回读校验未通过；请先核对草稿箱。'), 0);
      } else {
        this.statusText = '';
        new Notice(this.blockingWarningMessage()
          ?? userFacingErrorMessage(error, '公众号草稿上传失败，请查看本地诊断日志。'));
      }
    } finally {
      this.operation = null;
      await this.finishWeChatOperation();
    }
  }

  private async renderWeChatOperationState(): Promise<void> {
    this.refreshTargetButtons();
    if (this.target === 'wechat') await this.render();
  }

  private async finishWeChatOperation(): Promise<void> {
    this.refreshTargetButtons();
    if (this.drainPendingTargetFileIfIdle()) return;
    if (this.target === 'wechat') await this.render();
  }

  private async relayRequest(request: PublishingHttpRequest) {
    const response = await requestUrl({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      throw: false,
    });
    return {
      status: response.status,
      json: response.json as unknown,
      text: response.text,
    };
  }
}
