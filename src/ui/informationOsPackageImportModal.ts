import { App, Modal, Notice, setIcon } from 'obsidian';
import { webUtils } from 'electron';

import {
  getWeChatPublishingAdvisories,
  InformationOsPublicationPackageError,
  type PreparedArticle,
} from '../publishing';

export type InformationOsPackagePublishResult =
  | {
      status: 'succeeded';
      draftMediaId: string;
      uploadedImageCount: number;
    }
  | {
      status: 'remote_unknown';
      draftMediaId: string;
    };

export type InformationOsPackageImportResult =
  | { status: 'cancelled' }
  | ({ title: string } & InformationOsPackagePublishResult);

export interface InformationOsPackageImportOptions {
  prepare: (packagePath: string) => Promise<PreparedArticle>;
  publish: (
    prepared: PreparedArticle,
  ) => Promise<InformationOsPackagePublishResult | null>;
}

export interface InformationOsPackageSummary {
  title: string;
  digest: string;
  imageCount: number;
  compressedImageCount: number;
  integrityLabel: string;
  warningCount: number;
  warnings: string[];
}

type ImportStage = 'idle' | 'checking' | 'ready' | 'publishing';

export function canCloseInformationOsPackageImport(
  stage: ImportStage,
  settled: boolean,
): boolean {
  return stage !== 'publishing' || settled;
}

export function normalizeInformationOsPackagePath(value: string): string {
  let normalized = value.trim();
  if (
    normalized.length >= 2
    && ((normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const leaf = separator >= 0 ? normalized.slice(separator + 1) : normalized;
  if (leaf.toLowerCase() === 'metadata.json') {
    normalized = separator > 0 ? normalized.slice(0, separator) : '';
  }
  return normalized;
}

export function informationOsDroppedPackagePath(
  file: { name?: string; path?: string } | null | undefined,
): string | null {
  if (!file) return null;
  let pathname = typeof file.path === 'string' ? file.path : '';
  if (!pathname) {
    try {
      pathname = informationOsNativeDroppedFilePath(file);
    } catch {
      pathname = '';
    }
  }
  const separator = Math.max(pathname.lastIndexOf('/'), pathname.lastIndexOf('\\'));
  const leaf = separator >= 0 ? pathname.slice(separator + 1) : pathname;
  if (leaf.toLowerCase() !== 'metadata.json') return null;
  const normalized = normalizeInformationOsPackagePath(pathname);
  return normalized || null;
}

function informationOsNativeDroppedFilePath(file: object): string {
  try {
    return webUtils?.getPathForFile(file as File) ?? '';
  } catch {
    return '';
  }
}

export function informationOsPackageErrorMessage(error: unknown): string {
  if (error instanceof InformationOsPublicationPackageError) {
    const messages: Record<typeof error.code, string> = {
      PACKAGE_PATH_INVALID: '请输入 InformationOS 发布包文件夹，或拖入包内的 metadata.json。',
      PACKAGE_UNAVAILABLE: '找不到这个发布包，请确认文件夹仍在本机且可读取。',
      PACKAGE_STRUCTURE_INVALID: '发布包目录不完整，或包含未列入交接清单的文件。',
      PACKAGE_METADATA_INVALID: 'metadata.json 不符合 InformationOS 交接合同。',
      PACKAGE_INTEGRITY_MISMATCH: '发布包内容与 metadata.json 记录的哈希不一致。',
      PACKAGE_ASSET_INVALID: '发布包中的封面或正文图片不符合草稿要求。',
      PACKAGE_ARTICLE_INVALID: '发布包正文无法通过 Ailu 本地草稿预检。',
      PUBLISH_TRANSPORT_INVALID: '当前公众号草稿通道不可用，请检查 Ailu 草稿设置。',
      PUBLISH_FAILED: '草稿上传失败，请检查中转设置后重新执行本地检查。',
    };
    return messages[error.code];
  }
  return '发布包检查失败；未读取任何凭据，也没有发送公众号请求。';
}

export function informationOsPackagePublishErrorMessage(error: unknown): string {
  if (error instanceof InformationOsPublicationPackageError) {
    return informationOsPackageErrorMessage(error);
  }
  return '草稿上传未完成；请先查看本地诊断日志和公众号草稿箱，再决定是否重试。';
}

export function buildInformationOsPackageSummary(
  prepared: PreparedArticle,
): InformationOsPackageSummary {
  const advisories = getWeChatPublishingAdvisories(prepared.stats.imageCount);
  return {
    title: prepared.title || '未命名文章',
    digest: prepared.digest || '未填写摘要',
    imageCount: prepared.stats.imageCount,
    compressedImageCount: prepared.stats.compressedImageCount,
    integrityLabel: prepared.preflight.integrityHash.slice(0, 19),
    warningCount: advisories.length,
    warnings: advisories.map(advisory => advisory.message),
  };
}

class InformationOsPackageImportModal extends Modal {
  private stage: ImportStage = 'idle';
  private packagePath = '';
  private prepared: PreparedArticle | null = null;
  private errorMessage = '';
  private settled = false;
  private generation = 0;

  constructor(
    app: App,
    private readonly options: InformationOsPackageImportOptions,
    private readonly settle: (result: InformationOsPackageImportResult) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('ailu-informationos-import-modal');
    this.render();
  }

  override onClose(): void {
    this.generation += 1;
    this.contentEl.empty();
    if (!this.settled) this.finish({ status: 'cancelled' }, false);
  }

  override close(): void {
    if (!canCloseInformationOsPackageImport(this.stage, this.settled)) {
      new Notice('正在等待公众号草稿返回结果，完成后可关闭。');
      return;
    }
    super.close();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const eyebrow = contentEl.createDiv({ cls: 'ailu-informationos-import-eyebrow' });
    const eyebrowIcon = eyebrow.createSpan({ attr: { 'aria-hidden': 'true' } });
    setIcon(eyebrowIcon, 'package-check');
    eyebrow.createSpan({ text: 'InformationOS → Ailu' });
    contentEl.createEl('h2', { text: '导入已审核的公众号发布包' });
    contentEl.createEl('p', {
      cls: 'ailu-informationos-import-lead',
      text: 'Ailu 会先在本机重新核对正文、封面、图片和每个文件的哈希。检查通过后仍需最后确认，才会创建公众号草稿；不会群发。',
    });

    if (this.prepared && this.stage !== 'checking') {
      this.renderReady(contentEl, this.prepared);
    } else {
      this.renderPicker(contentEl);
    }

    if (this.errorMessage) {
      const error = contentEl.createDiv({
        cls: 'ailu-informationos-import-error',
        attr: { role: 'alert' },
      });
      const icon = error.createSpan({ attr: { 'aria-hidden': 'true' } });
      setIcon(icon, 'triangle-alert');
      error.createSpan({ text: this.errorMessage });
    }
    if (this.stage === 'idle') {
      contentEl.querySelector<HTMLInputElement>('input')?.focus();
    }
  }

  private renderPicker(parent: HTMLElement): void {
    const picker = parent.createDiv({ cls: 'ailu-informationos-import-picker' });
    picker.setAttrs({
      role: 'group',
      'aria-label': 'InformationOS 发布包路径',
    });
    const icon = picker.createSpan({
      cls: 'ailu-informationos-import-picker-icon',
      attr: { 'aria-hidden': 'true' },
    });
    setIcon(icon, 'package-open');
    const copy = picker.createDiv({ cls: 'ailu-informationos-import-picker-copy' });
    copy.createEl('strong', { text: '拖入 metadata.json，或粘贴发布包文件夹' });
    copy.createSpan({ text: '只读取这个交接包，不扫描 Vault 或 InformationOS 数据库。' });
    const input = picker.createEl('input', {
      attr: {
        type: 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'D:\\…\\publication-package',
        'aria-label': 'InformationOS 发布包文件夹',
      },
    });
    input.value = this.packagePath;
    input.disabled = this.stage === 'checking';
    input.oninput = () => {
      this.packagePath = input.value;
      this.errorMessage = '';
    };
    input.onkeydown = event => {
      if (event.key !== 'Enter' || this.stage === 'checking') return;
      event.preventDefault();
      void this.checkPackage();
    };
    picker.ondragover = event => {
      event.preventDefault();
      picker.addClass('is-dragging');
    };
    picker.ondragleave = () => picker.removeClass('is-dragging');
    picker.ondrop = event => {
      event.preventDefault();
      picker.removeClass('is-dragging');
      const dropped = informationOsDroppedPackagePath(
        event.dataTransfer?.files.item(0),
      );
      if (!dropped) {
        this.errorMessage = '无法读取拖入项目的本机路径；请粘贴发布包文件夹。';
        this.render();
        return;
      }
      this.packagePath = dropped;
      this.errorMessage = '';
      void this.checkPackage();
    };

    const actions = parent.createDiv({ cls: 'ailu-informationos-import-actions' });
    const cancel = actions.createEl('button', {
      text: '取消',
      attr: { type: 'button' },
    });
    cancel.disabled = this.stage === 'checking';
    cancel.onclick = () => this.close();
    const check = actions.createEl('button', {
      cls: 'mod-cta',
      text: this.stage === 'checking' ? '正在核对发布包…' : '检查发布包',
      attr: { type: 'button' },
    });
    check.disabled = this.stage === 'checking';
    check.onclick = () => void this.checkPackage();
  }

  private renderReady(parent: HTMLElement, prepared: PreparedArticle): void {
    const summary = buildInformationOsPackageSummary(prepared);
    const seal = parent.createDiv({ cls: 'ailu-informationos-import-seal' });
    const sealIcon = seal.createSpan({ attr: { 'aria-hidden': 'true' } });
    setIcon(sealIcon, 'badge-check');
    const sealCopy = seal.createDiv();
    sealCopy.createEl('strong', { text: '本地字节核对通过' });
    sealCopy.createEl('code', { text: summary.integrityLabel });
    seal.createSpan({ cls: 'ailu-informationos-import-reality', text: 'LOCAL VERIFIED' });

    const article = parent.createDiv({ cls: 'ailu-informationos-import-article' });
    article.createEl('h3', { text: summary.title });
    article.createEl('p', { text: summary.digest });
    const facts = article.createDiv({ cls: 'ailu-informationos-import-facts' });
    this.renderFact(facts, '正文图片', `${summary.imageCount} 张`);
    this.renderFact(facts, '压缩处理', `${summary.compressedImageCount} 张`);
    this.renderFact(facts, '封面', '1 张 · 已绑定');
    this.renderFact(facts, '提醒', `${summary.warningCount} 项`);

    if (summary.warnings.length) {
      const warning = parent.createDiv({ cls: 'ailu-informationos-import-warning' });
      const warningIcon = warning.createSpan({ attr: { 'aria-hidden': 'true' } });
      setIcon(warningIcon, 'circle-alert');
      warning.createSpan({ text: summary.warnings.join('；') });
    }

    const actions = parent.createDiv({ cls: 'ailu-informationos-import-actions' });
    const back = actions.createEl('button', {
      text: '换一个发布包',
      attr: { type: 'button' },
    });
    back.disabled = this.stage === 'publishing';
    back.onclick = () => {
      this.generation += 1;
      this.prepared = null;
      this.stage = 'idle';
      this.errorMessage = '';
      this.render();
    };
    const publish = actions.createEl('button', {
      cls: 'mod-cta',
      text: this.stage === 'publishing' ? '正在创建并回读草稿…' : '继续到最后确认',
      attr: { type: 'button' },
    });
    publish.disabled = this.stage === 'publishing';
    publish.onclick = () => void this.publish(prepared);
  }

  private renderFact(parent: HTMLElement, label: string, value: string): void {
    const fact = parent.createDiv();
    fact.createSpan({ text: label });
    fact.createEl('strong', { text: value });
  }

  private async checkPackage(): Promise<void> {
    if (this.stage === 'checking' || this.stage === 'publishing') return;
    const packagePath = normalizeInformationOsPackagePath(this.packagePath);
    this.packagePath = packagePath;
    if (!packagePath) {
      this.errorMessage = '请输入 InformationOS 发布包文件夹，或拖入包内的 metadata.json。';
      this.render();
      return;
    }
    const generation = ++this.generation;
    this.stage = 'checking';
    this.prepared = null;
    this.errorMessage = '';
    this.render();
    try {
      const prepared = await this.options.prepare(packagePath);
      if (generation !== this.generation || !this.contentEl.isConnected) return;
      this.prepared = prepared;
      this.stage = 'ready';
    } catch (error) {
      if (generation !== this.generation || !this.contentEl.isConnected) return;
      this.stage = 'idle';
      this.errorMessage = informationOsPackageErrorMessage(error);
    }
    this.render();
  }

  private async publish(prepared: PreparedArticle): Promise<void> {
    if (this.stage !== 'ready' || prepared !== this.prepared) return;
    this.stage = 'publishing';
    this.errorMessage = '';
    this.render();
    try {
      const result = await this.options.publish(prepared);
      if (!result) {
        this.stage = 'ready';
        this.render();
        return;
      }
      this.finish({ ...result, title: prepared.title || '未命名文章' });
    } catch (error) {
      this.stage = 'ready';
      this.errorMessage = informationOsPackagePublishErrorMessage(error);
      this.render();
    }
  }

  private finish(result: InformationOsPackageImportResult, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(result);
    if (close) this.close();
  }
}

export function openInformationOsPackageImport(
  app: App,
  options: InformationOsPackageImportOptions,
): Promise<InformationOsPackageImportResult> {
  return new Promise(resolve => {
    new InformationOsPackageImportModal(app, options, resolve).open();
  });
}
