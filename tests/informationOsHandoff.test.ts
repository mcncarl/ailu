import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DraftCreatedVerificationError,
  LocalRelayTransport,
} from '../src/publishing/localRelayTransport';
import {
  InformationOsPublicationPackageError,
  MAX_INFORMATION_OS_PUBLICATION_ASSETS,
  prepareInformationOsPublicationPackage,
  publishInformationOsPublicationPackage,
} from '../src/publishing/informationOsHandoff';
import { assertPreparedArticleReady } from '../src/publishing/preparedArticleBuilder';
import { onePixelPng } from './fixtures/imageBytes';

function hash(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

interface FixtureAsset {
  reference: string;
  bytes: Uint8Array;
}

interface FixtureOptions {
  assets?: FixtureAsset[];
  covers?: FixtureAsset[];
  html?: string;
  title?: string;
}

async function createPackage(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ailu-informationos-handoff-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, 'cover'), { recursive: true });
  const assets = options.assets ?? [{ reference: 'assets/inline.png', bytes: new Uint8Array(onePixelPng()) }];
  const covers = options.covers ?? [{ reference: 'cover/cover.png', bytes: new Uint8Array(onePixelPng()) }];
  const title = options.title ?? 'InformationOS 导入测试';
  const html = options.html ?? [
    `<h1>${title}</h1>`,
    '<p><img src="cover/cover.png" alt="cover"></p>',
    '<h2>正文</h2>',
    '<p><img src="assets/inline.png" alt="inline"></p>',
  ].join('');
  const files = new Map<string, Uint8Array | string>([
    ['article.md', `# ${title}\n\n正文\n`],
    ['article.html', html],
    ['article.txt', '正文\n'],
    ['source-references.json', '[]\n'],
    ['publishing-checklist.md', '# 发布检查清单\n'],
  ]);
  for (const asset of [...assets, ...covers]) files.set(asset.reference, asset.bytes);
  for (const [reference, body] of files) {
    const pathname = join(root, ...reference.split('/'));
    await mkdir(join(pathname, '..'), { recursive: true });
    await writeFile(pathname, body);
  }
  const fileHashes: Record<string, string> = {};
  for (const [reference, body] of files) fileHashes[reference] = hash(body);
  await writeFile(join(root, 'metadata.json'), `${JSON.stringify({
    schema_version: 1,
    export_id: 'wexport_fixture',
    draft_id: 'wdraft_fixture',
    draft_version: 1,
    title,
    digest: 'fixture digest',
    content_hash: hash('approved-content'),
    asset_manifest_hash: hash('approved-assets'),
    file_hashes: fileHashes,
    created_at: '2026-08-25T00:00:00.000Z',
  }, null, 2)}\n`, 'utf8');
  return root;
}

async function cleanup(pathname: string): Promise<void> {
  await rm(pathname, { recursive: true, force: true });
}

describe('InformationOS publication package handoff', () => {
  let packagePath: string;

  afterEach(async () => {
    if (packagePath) await cleanup(packagePath);
  });

  test('reads a valid package and returns a fully preflighted PreparedArticle', async () => {
    packagePath = await createPackage();
    const article = await prepareInformationOsPublicationPackage(packagePath);

    expect(article.title).toBe('InformationOS 导入测试');
    expect(article.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(article.images).toHaveLength(1);
    expect(article.html).toContain('ailu-prepared-image://assets%2Finline.png');
    expect(article.html).not.toContain('cover/cover.png');
    expect(() => assertPreparedArticleReady(article)).not.toThrow();
  });

  test('rejects tampered article and asset bytes using a stable path-free error', async () => {
    packagePath = await createPackage();
    await writeFile(join(packagePath, 'article.html'), '<p>tampered</p>\n', 'utf8');
    await expect(prepareInformationOsPublicationPackage(packagePath)).rejects.toMatchObject({
      code: 'PACKAGE_INTEGRITY_MISMATCH',
      message: 'InformationOS publication package integrity check failed',
    });
    const stable = new InformationOsPublicationPackageError('PACKAGE_INTEGRITY_MISMATCH');
    expect(stable.message).not.toContain(packagePath);
  });

  test('enforces the exact InformationOS metadata contract', async () => {
    const mutations: Array<(metadata: Record<string, unknown>) => void> = [
      metadata => { delete metadata.title; },
      metadata => { metadata.relay_token = 'must-not-cross-the-handoff-boundary'; },
      metadata => { metadata.export_id = 'invalid id'; },
      metadata => { metadata.created_at = '2026-02-30T00:00:00.000Z'; },
      metadata => { metadata.fact_claims = Array.from({ length: 257 }, () => 'claim'); },
    ];

    for (const mutate of mutations) {
      packagePath = await createPackage();
      const metadataPath = join(packagePath, 'metadata.json');
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
      mutate(metadata);
      await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, 'utf8');
      await expect(prepareInformationOsPublicationPackage(packagePath)).rejects.toMatchObject({
        code: 'PACKAGE_METADATA_INVALID',
      });
      await cleanup(packagePath);
      packagePath = '';
    }
  });

  test('rejects traversal and extra root entries', async () => {
    packagePath = await createPackage();
    const metadata = JSON.parse(await readFile(join(packagePath, 'metadata.json'), 'utf8')) as {
      file_hashes: Record<string, string>;
    };
    metadata.file_hashes['assets/../outside.png'] = hash(new Uint8Array(onePixelPng()));
    await writeFile(join(packagePath, 'metadata.json'), JSON.stringify(metadata), 'utf8');
    await expect(prepareInformationOsPublicationPackage(packagePath)).rejects.toMatchObject({
      code: 'PACKAGE_METADATA_INVALID',
    });

    await cleanup(packagePath);
    packagePath = await createPackage({
      html: '<h1>traversal</h1><p><img src="../outside.png"></p>',
    });
    await expect(prepareInformationOsPublicationPackage(packagePath)).rejects.toMatchObject({
      code: 'PACKAGE_ARTICLE_INVALID',
    });

    await cleanup(packagePath);
    packagePath = await createPackage();
    await writeFile(join(packagePath, 'unexpected.txt'), 'unsafe', 'utf8');
    await expect(prepareInformationOsPublicationPackage(packagePath)).rejects.toMatchObject({
      code: 'PACKAGE_STRUCTURE_INVALID',
    });
  });

  test('rejects a package without exactly one cover and rejects too many inline assets', async () => {
    packagePath = await createPackage({ covers: [] });
    await expect(prepareInformationOsPublicationPackage(packagePath)).rejects.toMatchObject({
      code: 'PACKAGE_ASSET_INVALID',
    });
    await cleanup(packagePath);
    const maximumAssets = Array.from({ length: MAX_INFORMATION_OS_PUBLICATION_ASSETS }, (_, index) => ({
      reference: `assets/inline-${index}.png`,
      bytes: new Uint8Array(onePixelPng()),
    }));
    packagePath = await createPackage({
      assets: maximumAssets,
      html: [
        '<h1>maximum assets</h1>',
        '<p><img src="cover/cover.png"></p>',
        ...maximumAssets.map(asset => `<p><img src="${asset.reference}"></p>`),
      ].join(''),
    });
    await expect(prepareInformationOsPublicationPackage(packagePath)).resolves.toMatchObject({
      stats: { uniqueImageCount: MAX_INFORMATION_OS_PUBLICATION_ASSETS },
    });
    await cleanup(packagePath);
    const assets = Array.from({ length: MAX_INFORMATION_OS_PUBLICATION_ASSETS + 1 }, (_, index) => ({
      reference: `assets/inline-${index}.png`,
      bytes: new Uint8Array(onePixelPng()),
    }));
    packagePath = await createPackage({
      assets,
      html: '<h1>too many</h1><p><img src="cover/cover.png"></p><p>正文</p>',
    });
    await expect(prepareInformationOsPublicationPackage(packagePath)).rejects.toMatchObject({
      code: 'PACKAGE_METADATA_INVALID',
    });
    await cleanup(packagePath);
    packagePath = await createPackage({
      assets: [{ reference: 'assets/not-an-image.txt', bytes: new TextEncoder().encode('secret') }],
      html: '<h1>mime</h1><p>正文</p>',
    });
    await expect(prepareInformationOsPublicationPackage(packagePath)).rejects.toMatchObject({
      code: 'PACKAGE_ASSET_INVALID',
    });
  });

  test('rejects a symlinked package boundary', async () => {
    const canonical = await createPackage();
    const parent = await mkdtemp(join(tmpdir(), 'ailu-informationos-link-'));
    const linked = join(parent, 'linked-package');
    packagePath = parent;
    try {
      await symlink(canonical, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      await cleanup(canonical);
      return;
    }
    await expect(prepareInformationOsPublicationPackage(linked)).rejects.toMatchObject({
      code: 'PACKAGE_STRUCTURE_INVALID',
    });
    await cleanup(canonical);
  });

  test('maps builder rejection and binds publishing to the caller transport', async () => {
    packagePath = await createPackage();
    const builder = {
      build: vi.fn().mockRejectedValue(new Error(`builder path ${packagePath}`)),
    };
    await expect(prepareInformationOsPublicationPackage(packagePath, {
      builder: builder as never,
    })).rejects.toMatchObject({ code: 'PACKAGE_ARTICLE_INVALID' });

    const transport = new LocalRelayTransport({
      relayUrl: 'http://127.0.0.1:8787',
      relayToken: 'a'.repeat(64),
      request: vi.fn(),
    });
    const result = {
      draftMediaId: 'draft-fixture',
      coverMediaId: 'cover-fixture',
      uploadedImageCount: 1,
      verification: {
        title: 'InformationOS 导入测试',
        contentLength: 1,
        imageCount: 0,
        nativeListCount: 0,
        nativeListItemCount: 0,
        dangerousListSectionCount: 0,
        dangerousListParagraphCount: 0,
        dangerousListBlockCount: 0,
        localImageSourceCount: 0,
      },
    };
    const publish = vi.spyOn(transport, 'publish').mockResolvedValue(result);
    await expect(publishInformationOsPublicationPackage(packagePath, transport, {
      idempotencyKey: 'handoff-key',
    })).resolves.toEqual(result);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0].title).toBe('InformationOS 导入测试');
    expect(publish.mock.calls[0]?.[1]).toEqual({ idempotencyKey: 'handoff-key' });
  });

  test('preserves the draft identity when relay readback is uncertain', async () => {
    packagePath = await createPackage();
    const transport = new LocalRelayTransport({
      relayUrl: 'http://127.0.0.1:8787',
      relayToken: 'a'.repeat(64),
      request: vi.fn(),
    });
    vi.spyOn(transport, 'publish').mockRejectedValue(
      new DraftCreatedVerificationError('draft_media_123', 'readback unavailable'),
    );
    await expect(
      publishInformationOsPublicationPackage(packagePath, transport),
    ).rejects.toMatchObject({
      name: 'DraftCreatedVerificationError',
      draftMediaId: 'draft_media_123',
    });
  });
});
