import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  webUtils: {
    getPathForFile: (file: { nativePath?: string }) => file.nativePath ?? '',
  },
}));
vi.mock('obsidian', () => ({
  App: class {},
  Modal: class {},
  Notice: class {},
  setIcon: vi.fn(),
}));

import {
  InformationOsPublicationPackageError,
  type PreparedArticle,
} from '../src/publishing';
import {
  buildInformationOsPackageSummary,
  canCloseInformationOsPackageImport,
  informationOsDroppedPackagePath,
  informationOsPackageErrorMessage,
  informationOsPackagePublishErrorMessage,
  normalizeInformationOsPackagePath,
} from '../src/ui/informationOsPackageImportModal';

const publishingStudioSource = fs.readFileSync(
  fileURLToPath(new URL('../src/ui/publishingStudioView.ts', import.meta.url)),
  'utf8',
);
const styles = fs.readFileSync(
  fileURLToPath(new URL('../styles.css', import.meta.url)),
  'utf8',
);

function prepared(): PreparedArticle {
  return {
    schemaVersion: 1,
    sourceHash: `sha256:${'1'.repeat(64)}`,
    contentHash: `sha256:${'2'.repeat(64)}`,
    title: '已审核的 InformationOS 文章',
    author: 'Ailu',
    digest: '交接摘要',
    contentSourceUrl: '',
    needOpenComment: false,
    onlyFansCanComment: false,
    html: '<p>正文</p>',
    cover: {
      id: 'cover',
      fileName: 'cover.png',
      mimeType: 'image/png',
      body: new ArrayBuffer(1),
      contentHash: `sha256:${'3'.repeat(64)}`,
      originalBytes: 1,
    },
    images: [],
    stats: {
      removedCover: false,
      removedCoverReason: 'not-present',
      removedTitle: false,
      imageCount: 3,
      uniqueImageCount: 3,
      compressedImageCount: 1,
      headingCount: 1,
      paragraphCount: 1,
      nativeListCount: 0,
      nativeListItemCount: 0,
      dangerousListSectionCount: 0,
      dangerousListParagraphCount: 0,
      dangerousListBlockCount: 0,
      textLength: 2,
    },
    preflight: {
      passed: true,
      completedAt: '2026-08-25T00:00:00.000Z',
      integrityHash: `sha256:${'4'.repeat(64)}`,
      checkedImageCount: 3,
      compressedImageCount: 1,
    },
  };
}

describe('InformationOS package import UI helpers', () => {
  test('accepts copied folder paths and derives a package root from metadata.json', () => {
    expect(normalizeInformationOsPackagePath(' "D:\\exports\\article-one" ')).toBe(
      'D:\\exports\\article-one',
    );
    expect(normalizeInformationOsPackagePath('D:\\exports\\article-one\\metadata.json')).toBe(
      'D:\\exports\\article-one',
    );
    expect(normalizeInformationOsPackagePath('/srv/exports/article-one/metadata.json')).toBe(
      '/srv/exports/article-one',
    );
    expect(informationOsDroppedPackagePath({
      name: 'metadata.json',
      path: 'D:\\exports\\article-one\\metadata.json',
    })).toBe('D:\\exports\\article-one');
    const modernElectronFile = {
      name: 'metadata.json',
      nativePath: 'D:\\exports\\article-two\\metadata.json',
    };
    expect(informationOsDroppedPackagePath(modernElectronFile)).toBe(
      'D:\\exports\\article-two',
    );
    expect(informationOsDroppedPackagePath({
      name: 'article.html',
      path: 'D:\\exports\\article-two\\article.html',
    })).toBeNull();
    expect(informationOsDroppedPackagePath({ name: 'metadata.json' })).toBeNull();
  });

  test('uses actionable path-free messages before and after the network boundary', () => {
    const packageError = new InformationOsPublicationPackageError('PACKAGE_INTEGRITY_MISMATCH');
    expect(informationOsPackageErrorMessage(packageError)).toBe(
      '发布包内容与 metadata.json 记录的哈希不一致。',
    );
    expect(informationOsPackageErrorMessage(new Error('D:\\secret\\package'))).toBe(
      '发布包检查失败；未读取任何凭据，也没有发送公众号请求。',
    );
    expect(informationOsPackagePublishErrorMessage(new Error('Bearer secret-token'))).toBe(
      '草稿上传未完成；请先查看本地诊断日志和公众号草稿箱，再决定是否重试。',
    );
  });

  test('summarizes the verified bytes without exposing the full integrity hash', () => {
    expect(buildInformationOsPackageSummary(prepared())).toEqual({
      title: '已审核的 InformationOS 文章',
      digest: '交接摘要',
      imageCount: 3,
      compressedImageCount: 1,
      integrityLabel: `sha256:${'4'.repeat(12)}`,
      warningCount: 0,
      warnings: [],
    });
  });

  test('keeps the operation reservation until the remote draft result settles', () => {
    expect(canCloseInformationOsPackageImport('idle', false)).toBe(true);
    expect(canCloseInformationOsPackageImport('checking', false)).toBe(true);
    expect(canCloseInformationOsPackageImport('ready', false)).toBe(true);
    expect(canCloseInformationOsPackageImport('publishing', false)).toBe(false);
    expect(canCloseInformationOsPackageImport('publishing', true)).toBe(true);
  });
});

describe('InformationOS package import UI wiring', () => {
  test('exposes one explicit import action and reuses the confirmed relay draft path', () => {
    expect(publishingStudioSource).toContain("text: '导入 InformationOS 包'");
    expect(publishingStudioSource).toContain('prepareInformationOsPublicationPackage(packagePath)');
    expect(publishingStudioSource).toContain('openInformationOsPackageImport(this.app');
    expect(publishingStudioSource).toContain("transportLabel: 'InformationOS 发布包 · 自托管公众号中转'");
    expect(publishingStudioSource).toContain('assertPublishingDestinationUnchanged');
    expect(publishingStudioSource).toContain('idempotencyKey: prepared.contentHash');
    expect(publishingStudioSource).not.toContain('publishInformationOsPublicationPackage(');
  });

  test('keeps the verified-package seal responsive and motion optional', () => {
    expect(styles).toContain('.ailu-informationos-import-seal');
    expect(styles).toContain('.ailu-informationos-import-reality');
    expect(styles).toContain('@media (max-width: 520px)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });

});
