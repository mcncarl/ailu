import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  attentionPublishingTargetActivity,
  IDLE_PUBLISHING_TARGET_ACTIVITY,
  publishingTargetAccessibleLabel,
  runningPublishingTargetActivity,
} from '../src/ui/publishingTargetActivity';

const publishingStudioSource = fs.readFileSync(
  fileURLToPath(new URL('../src/ui/publishingStudioView.ts', import.meta.url)),
  'utf8',
);
const stylesheet = fs.readFileSync(
  fileURLToPath(new URL('../styles.css', import.meta.url)),
  'utf8',
);

describe('publishing target activity', () => {
  it('announces selected, running, and attention states without changing the tab label', () => {
    expect(publishingTargetAccessibleLabel({
      targetLabel: '公众号',
      activity: IDLE_PUBLISHING_TARGET_ACTIVITY,
      selected: true,
    })).toBe('公众号，当前页面');
    expect(publishingTargetAccessibleLabel({
      targetLabel: '飞书',
      activity: runningPublishingTargetActivity('正在同步'),
      selected: false,
    })).toBe('飞书，正在同步');
    expect(publishingTargetAccessibleLabel({
      targetLabel: 'X 文章',
      activity: attentionPublishingTargetActivity('草稿待核对'),
      selected: false,
    })).toBe('X 文章，草稿待核对');
  });

  it('uses stable fallback labels for blank runtime messages', () => {
    expect(runningPublishingTargetActivity('  ')).toEqual({
      tone: 'running',
      label: '正在处理',
    });
    expect(attentionPublishingTargetActivity('')).toEqual({
      tone: 'attention',
      label: '需要处理',
    });
  });
});

describe('publishing target concurrency UI contract', () => {
  it('keeps navigation enabled and retains each target panel across tab switches', () => {
    expect(publishingStudioSource).not.toContain(
      'button.disabled = this.isCurrentTargetBusy()',
    );
    expect(publishingStudioSource).toMatch(
      /private async changeTarget\(target: PublishingTarget\)[\s\S]{0,360}?this\.target = target;[\s\S]{0,360}?await this\.render\(\);/,
    );
    const changeTargetBody = publishingStudioSource.match(
      /private async changeTarget\(target: PublishingTarget\): Promise<void> \{([\s\S]*?)\n\s{2}\}/,
    )?.[1] ?? '';
    expect(changeTargetBody).not.toContain('resetTargetPanels');
    expect(changeTargetBody).not.toContain('isCurrentTargetBusy');
  });

  it('routes background panel updates to badges without repainting an unrelated target', () => {
    expect(publishingStudioSource).toContain(
      "requestRender: () => this.handlePanelRenderRequest('feishu', file.path)",
    );
    expect(publishingStudioSource).toContain(
      "requestRender: () => this.handlePanelRenderRequest('x', file.path)",
    );
    expect(publishingStudioSource).toMatch(
      /private handlePanelRenderRequest[\s\S]{0,420}?this\.refreshTargetButtons\(\);[\s\S]{0,420}?if \(this\.target === target\) void this\.render\(\);/,
    );
  });

  it('keeps an accepted WeChat preflight valid when only the visible tab changes', () => {
    expect(publishingStudioSource).toContain(
      'this.preparedRenderedHtml === this.articleEl.outerHTML',
    );
    expect(publishingStudioSource).toContain(
      "containerStyle: rendered.getAttribute('style') ?? ''",
    );
    expect(publishingStudioSource).not.toContain(
      'this.preparedRenderedHtml === this.articleEl.innerHTML',
    );
    const identityBody = publishingStudioSource.match(
      /private currentPublicationIdentity\(\): PublishingSourceIdentity \| null \{([\s\S]*?)\n\s{2}\}/,
    )?.[1] ?? '';
    expect(identityBody).not.toContain('this.articleEl');
    expect(identityBody).toContain('renderedHtml: this.preparedRenderedHtml');

    const postPreparationGuard = publishingStudioSource.match(
      /const prepared = await prepareSnapshotForPublishing[\s\S]*?if \(([\s\S]*?)\) \{\r?\n\s{6}throw new Error\('文章或排版在检查期间已变化，请重新检查'\);/,
    )?.[1] ?? '';
    expect(postPreparationGuard).not.toContain('articleEl !== this.articleEl');
    expect(postPreparationGuard).not.toContain('this.articleEl.innerHTML');
    expect(postPreparationGuard).toContain('revision !== this.sourceRevision');
    expect(postPreparationGuard).toContain('key !== this.currentPreparedKey()');
  });

  it('shows compact non-wrapping activity dots with reduced-motion support', () => {
    expect(stylesheet).toMatch(
      /\.ailu-publishing-targets > button\.is-running \.ailu-publishing-target-activity/,
    );
    expect(stylesheet).toMatch(
      /\.ailu-publishing-targets > button\.needs-attention \.ailu-publishing-target-activity/,
    );
    expect(stylesheet).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
