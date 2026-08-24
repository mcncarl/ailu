import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';

import { DraftCreatedVerificationError, LocalRelayTransport } from './localRelayTransport';
import { MAX_WECHAT_COVER_BYTES } from './imagePreflight';
import {
  assertPreparedArticleReady,
  PreparedArticleBuilder,
} from './preparedArticleBuilder';
import type {
  LocalRelayPublishOptions,
  LocalRelayPublishResult,
  PreparedArticle,
  PreparedArticleBuildInput,
  PublishingImageInput,
} from './types';

/** The version emitted by InformationOS' local publication-package exporter. */
export const INFORMATION_OS_PUBLICATION_PACKAGE_SCHEMA_VERSION = 1 as const;

/** Maximum number of inline assets accepted from one handoff package. */
export const MAX_INFORMATION_OS_PUBLICATION_ASSETS = 50;

/** Hard bound applied before any bytes are handed to the Ailu image preflight. */
export const MAX_INFORMATION_OS_PUBLICATION_FILE_BYTES = 20 * 1024 * 1024;

/** Keep one imported package below a bounded in-process memory footprint. */
export const MAX_INFORMATION_OS_PUBLICATION_TOTAL_ASSET_BYTES = 120 * 1024 * 1024;

const REQUIRED_FILES = [
  'article.md',
  'article.html',
  'article.txt',
  'source-references.json',
  'publishing-checklist.md',
] as const;

const REQUIRED_ROOT_ENTRIES = new Set<string>([
  'metadata.json',
  ...REQUIRED_FILES,
  'assets',
  'cover',
]);

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const WINDOWS_UNSUPPORTED_SEGMENT = /[<>:"|?*]/u;
const WINDOWS_TRAILING_DOT_OR_SPACE = /[. ]$/u;

export type InformationOsPublicationPackageErrorCode =
  | 'PACKAGE_PATH_INVALID'
  | 'PACKAGE_UNAVAILABLE'
  | 'PACKAGE_STRUCTURE_INVALID'
  | 'PACKAGE_METADATA_INVALID'
  | 'PACKAGE_INTEGRITY_MISMATCH'
  | 'PACKAGE_ASSET_INVALID'
  | 'PACKAGE_ARTICLE_INVALID'
  | 'PUBLISH_TRANSPORT_INVALID'
  | 'PUBLISH_FAILED';

const ERROR_MESSAGES: Record<InformationOsPublicationPackageErrorCode, string> = {
  PACKAGE_PATH_INVALID: 'InformationOS publication package path is invalid',
  PACKAGE_UNAVAILABLE: 'InformationOS publication package is unavailable',
  PACKAGE_STRUCTURE_INVALID: 'InformationOS publication package structure is invalid',
  PACKAGE_METADATA_INVALID: 'InformationOS publication package metadata is invalid',
  PACKAGE_INTEGRITY_MISMATCH: 'InformationOS publication package integrity check failed',
  PACKAGE_ASSET_INVALID: 'InformationOS publication package asset is invalid',
  PACKAGE_ARTICLE_INVALID: 'InformationOS publication package article is invalid',
  PUBLISH_TRANSPORT_INVALID: 'a constructed LocalRelayTransport is required',
  PUBLISH_FAILED: 'InformationOS publication package publish failed',
};

/**
 * Stable, path-free errors for the handoff boundary. The underlying filesystem
 * error is intentionally not retained because it can contain a local path or
 * a transport error can contain credentials.
 */
export class InformationOsPublicationPackageError extends Error {
  override readonly name = 'InformationOsPublicationPackageError';

  constructor(readonly code: InformationOsPublicationPackageErrorCode) {
    super(ERROR_MESSAGES[code]);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface InformationOsPublicationPackageOptions {
  /** Optional override when a caller has a separately reviewed title. */
  title?: string;
  author?: string;
  digest?: string;
  contentSourceUrl?: string;
  needOpenComment?: boolean;
  onlyFansCanComment?: boolean;
  containerStyle?: string;
  builder?: PreparedArticleBuilder;
}

export interface InformationOsPublicationPackageRequest
  extends InformationOsPublicationPackageOptions {
  packagePath: string;
}

export interface PublishInformationOsPublicationPackageRequest
  extends InformationOsPublicationPackageRequest {
  transport: LocalRelayTransport;
  idempotencyKey?: string;
}

interface PackageMetadata {
  schema_version: 1;
  export_id: string;
  draft_id: string;
  draft_version: number;
  content_hash: string;
  asset_manifest_hash: string;
  created_at: string;
  file_hashes: Record<string, string>;
  title?: string;
  digest?: string;
  author?: string;
  content_source_url?: string;
  need_open_comment?: boolean;
  only_fans_can_comment?: boolean;
}

interface LoadedPackage {
  metadata: PackageMetadata;
  html: string;
  files: Map<string, Uint8Array>;
  coverReference: string;
  assetReferences: string[];
  assetMimeTypes: Map<string, ImageMimeType>;
}

type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/bmp';

function fail(code: InformationOsPublicationPackageErrorCode): never {
  throw new InformationOsPublicationPackageError(code);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function containsControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function assertPackagePath(pathname: unknown): asserts pathname is string {
  if (typeof pathname !== 'string' || pathname.length === 0 || containsControlCharacter(pathname)) {
    fail('PACKAGE_PATH_INVALID');
  }
  const windowsPath = pathname.replaceAll('/', '\\');
  if (
    windowsPath.startsWith('\\\\')
    || windowsPath.startsWith('\\?\\')
    || windowsPath.startsWith('\\.\\')
    || /^[A-Za-z]:[^\\]/u.test(windowsPath)
    || !isAbsolute(pathname)
  ) {
    fail('PACKAGE_PATH_INVALID');
  }
  for (const [index, segment] of windowsPath.split('\\').entries()) {
    if (index === 0 && /^[A-Za-z]:$/u.test(segment)) continue;
    if (segment === '.' || segment === '..') fail('PACKAGE_PATH_INVALID');
    if (
      segment === ''
    ) continue;
    if (
      WINDOWS_UNSUPPORTED_SEGMENT.test(segment)
      || WINDOWS_TRAILING_DOT_OR_SPACE.test(segment)
      || WINDOWS_RESERVED_SEGMENT.test(segment)
    ) fail('PACKAGE_PATH_INVALID');
  }
}

function safePackageReference(reference: unknown): reference is string {
  if (
    typeof reference !== 'string'
    || reference.length === 0
    || reference.length > 600
    || reference.includes('\\')
    || reference.startsWith('/')
    || reference.includes('..')
    || containsControlCharacter(reference)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(reference)
  ) return false;
  const segments = reference.split('/');
  return segments.every(segment => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !WINDOWS_UNSUPPORTED_SEGMENT.test(segment)
    && !WINDOWS_TRAILING_DOT_OR_SPACE.test(segment)
    && !WINDOWS_RESERVED_SEGMENT.test(segment)
  ));
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('PACKAGE_STRUCTURE_INVALID');
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function canonicalPackageDirectory(pathname: unknown): Promise<string> {
  assertPackagePath(pathname);
  const requested = resolve(pathname);
  let information;
  try {
    information = await lstat(requested);
  } catch {
    fail('PACKAGE_UNAVAILABLE');
  }
  if (!information.isDirectory() || information.isSymbolicLink()) {
    fail('PACKAGE_STRUCTURE_INVALID');
  }
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch {
    fail('PACKAGE_UNAVAILABLE');
  }
  if (!samePath(requested, canonical)) fail('PACKAGE_STRUCTURE_INVALID');
  return canonical;
}

async function canonicalChildPath(root: string, reference: string, directory: boolean): Promise<string> {
  if (!safePackageReference(reference) || !isWithin(root, resolve(root, ...reference.split('/')))) {
    fail('PACKAGE_STRUCTURE_INVALID');
  }
  const requested = resolve(root, ...reference.split('/'));
  let information;
  try {
    information = await lstat(requested);
  } catch {
    fail('PACKAGE_STRUCTURE_INVALID');
  }
  if (information.isSymbolicLink() || (directory ? !information.isDirectory() : !information.isFile())) {
    fail('PACKAGE_STRUCTURE_INVALID');
  }
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch {
    fail('PACKAGE_STRUCTURE_INVALID');
  }
  if (!samePath(requested, canonical) || !isWithin(root, canonical)) {
    fail('PACKAGE_STRUCTURE_INVALID');
  }
  let canonicalInformation;
  try {
    canonicalInformation = await lstat(canonical);
  } catch {
    fail('PACKAGE_STRUCTURE_INVALID');
  }
  if (
    canonicalInformation.isSymbolicLink()
    || (directory ? !canonicalInformation.isDirectory() : !canonicalInformation.isFile())
  ) fail('PACKAGE_STRUCTURE_INVALID');
  return canonical;
}

async function readPackageFile(
  root: string,
  reference: string,
  maximumBytes = MAX_INFORMATION_OS_PUBLICATION_FILE_BYTES,
): Promise<Uint8Array> {
  const pathname = await canonicalChildPath(root, reference, false);
  let information;
  try {
    information = await lstat(pathname);
  } catch {
    fail('PACKAGE_STRUCTURE_INVALID');
  }
  if (information.size > maximumBytes) fail('PACKAGE_ASSET_INVALID');
  try {
    const bytes = await readFile(pathname);
    if (bytes.byteLength > maximumBytes) fail('PACKAGE_ASSET_INVALID');
    return bytes;
  } catch (error) {
    if (error instanceof InformationOsPublicationPackageError) throw error;
    fail('PACKAGE_UNAVAILABLE');
  }
}

async function collectDirectoryFiles(root: string, directoryReference: 'assets' | 'cover') {
  const files: string[] = [];
  const walk = async (reference: string): Promise<void> => {
    const directory = await canonicalChildPath(root, reference, true);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      fail('PACKAGE_UNAVAILABLE');
    }
    for (const entry of entries) {
      const childReference = `${reference}/${entry.name}`;
      if (!safePackageReference(childReference)) fail('PACKAGE_STRUCTURE_INVALID');
      if (entry.isSymbolicLink()) fail('PACKAGE_STRUCTURE_INVALID');
      if (entry.isDirectory()) {
        await walk(childReference);
      } else if (entry.isFile()) {
        await canonicalChildPath(root, childReference, false);
        files.push(childReference);
      } else {
        fail('PACKAGE_STRUCTURE_INVALID');
      }
    }
  };
  await walk(directoryReference);
  return files;
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) fail('PACKAGE_METADATA_INVALID');
}

function parseMetadata(bytes: Uint8Array): PackageMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    fail('PACKAGE_METADATA_INVALID');
  }
  if (!isObject(parsed)) fail('PACKAGE_METADATA_INVALID');
  const record = parsed;
  if (
    record.schema_version !== INFORMATION_OS_PUBLICATION_PACKAGE_SCHEMA_VERSION
    || typeof record.export_id !== 'string'
    || typeof record.draft_id !== 'string'
    || !Number.isSafeInteger(record.draft_version)
    || (record.draft_version as number) < 1
    || typeof record.created_at !== 'string'
  ) fail('PACKAGE_METADATA_INVALID');
  assertHash(record.content_hash);
  assertHash(record.asset_manifest_hash);
  if (!isObject(record.file_hashes)) fail('PACKAGE_METADATA_INVALID');
  const fileHashes: Record<string, string> = {};
  for (const [reference, hash] of Object.entries(record.file_hashes)) {
    if (!safePackageReference(reference)) fail('PACKAGE_METADATA_INVALID');
    assertHash(hash);
    fileHashes[reference] = hash;
  }
  if (Object.keys(fileHashes).length === 0) fail('PACKAGE_METADATA_INVALID');

  const optionalStrings = ['title', 'digest', 'author', 'content_source_url'] as const;
  for (const key of optionalStrings) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      fail('PACKAGE_METADATA_INVALID');
    }
  }
  for (const key of ['need_open_comment', 'only_fans_can_comment'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'boolean') {
      fail('PACKAGE_METADATA_INVALID');
    }
  }
  return {
    schema_version: 1,
    export_id: record.export_id,
    draft_id: record.draft_id,
    draft_version: record.draft_version as number,
    content_hash: record.content_hash,
    asset_manifest_hash: record.asset_manifest_hash,
    created_at: record.created_at,
    file_hashes: fileHashes,
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(typeof record.digest === 'string' ? { digest: record.digest } : {}),
    ...(typeof record.author === 'string' ? { author: record.author } : {}),
    ...(typeof record.content_source_url === 'string'
      ? { content_source_url: record.content_source_url }
      : {}),
    ...(typeof record.need_open_comment === 'boolean'
      ? { need_open_comment: record.need_open_comment }
      : {}),
    ...(typeof record.only_fans_can_comment === 'boolean'
      ? { only_fans_can_comment: record.only_fans_can_comment }
      : {}),
  };
}

function imageMime(bytes: Uint8Array): ImageMimeType | null {
  if (
    bytes.byteLength >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return 'image/png';
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.byteLength >= 6
    && (new TextDecoder().decode(bytes.slice(0, 6)) === 'GIF87a'
      || new TextDecoder().decode(bytes.slice(0, 6)) === 'GIF89a')
  ) return 'image/gif';
  if (bytes.byteLength >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

function extensionMatchesMime(reference: string, mimeType: ImageMimeType): boolean {
  const extension = reference.toLowerCase().split('.').pop() ?? '';
  const allowed: Record<ImageMimeType, readonly string[]> = {
    'image/jpeg': ['jpg', 'jpeg'],
    'image/png': ['png'],
    'image/gif': ['gif'],
    'image/bmp': ['bmp'],
  };
  return allowed[mimeType].includes(extension);
}

function assetReferencesFromHashes(fileHashes: Record<string, string>): {
  assets: string[];
  covers: string[];
} {
  const assets: string[] = [];
  const covers: string[] = [];
  for (const reference of Object.keys(fileHashes)) {
    if (reference.startsWith('assets/')) assets.push(reference);
    else if (reference.startsWith('cover/')) covers.push(reference);
    else if (!REQUIRED_FILES.includes(reference as typeof REQUIRED_FILES[number])) {
      fail('PACKAGE_METADATA_INVALID');
    }
  }
  if (
    assets.length + covers.length > MAX_INFORMATION_OS_PUBLICATION_ASSETS
    || covers.length !== 1
  ) {
    fail('PACKAGE_ASSET_INVALID');
  }
  return { assets, covers };
}

async function loadPackage(pathname: string): Promise<LoadedPackage> {
  const root = await canonicalPackageDirectory(pathname);
  let rootEntries;
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch {
    fail('PACKAGE_UNAVAILABLE');
  }
  const names = rootEntries.map(entry => entry.name).sort();
  const expected = [...REQUIRED_ROOT_ENTRIES].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail('PACKAGE_STRUCTURE_INVALID');
  for (const entry of rootEntries) {
    if (entry.isSymbolicLink()) fail('PACKAGE_STRUCTURE_INVALID');
  }

  const metadataBytes = await readPackageFile(root, 'metadata.json', 2 * 1024 * 1024);
  const metadata = parseMetadata(metadataBytes);
  const expectedRootHashes = [...REQUIRED_FILES];
  const actualHashReferences = Object.keys(metadata.file_hashes);
  for (const file of REQUIRED_FILES) {
    if (metadata.file_hashes[file] === undefined) fail('PACKAGE_METADATA_INVALID');
  }
  if (metadata.file_hashes['metadata.json'] !== undefined) fail('PACKAGE_METADATA_INVALID');
  const { assets, covers } = assetReferencesFromHashes(metadata.file_hashes);
  const physicalAssets = await collectDirectoryFiles(root, 'assets');
  const physicalCovers = await collectDirectoryFiles(root, 'cover');
  if (
    JSON.stringify(actualHashReferences.filter(file => file !== 'metadata.json').sort())
      !== JSON.stringify([...REQUIRED_FILES, ...assets, ...covers].sort())
    || JSON.stringify(physicalAssets.sort()) !== JSON.stringify(assets.sort())
    || JSON.stringify(physicalCovers.sort()) !== JSON.stringify(covers.sort())
  ) fail('PACKAGE_STRUCTURE_INVALID');
  if (assets.length > MAX_INFORMATION_OS_PUBLICATION_ASSETS || covers.length !== 1) {
    fail('PACKAGE_ASSET_INVALID');
  }

  const files = new Map<string, Uint8Array>();
  for (const reference of expectedRootHashes) {
    const bytes = await readPackageFile(root, reference);
    files.set(reference, bytes);
    if (sha256(bytes) !== metadata.file_hashes[reference]) fail('PACKAGE_INTEGRITY_MISMATCH');
  }
  let totalAssetBytes = 0;
  const assetMimeTypes = new Map<string, ImageMimeType>();
  for (const reference of [...assets, ...covers]) {
    const bytes = await readPackageFile(root, reference);
    files.set(reference, bytes);
    if (sha256(bytes) !== metadata.file_hashes[reference]) fail('PACKAGE_INTEGRITY_MISMATCH');
    totalAssetBytes += bytes.byteLength;
    if (totalAssetBytes > MAX_INFORMATION_OS_PUBLICATION_TOTAL_ASSET_BYTES) {
      fail('PACKAGE_ASSET_INVALID');
    }
    const mimeType = imageMime(bytes);
    if (!mimeType || !extensionMatchesMime(reference, mimeType)) fail('PACKAGE_ASSET_INVALID');
    if (reference.startsWith('cover/')) {
      if (bytes.byteLength > MAX_WECHAT_COVER_BYTES) fail('PACKAGE_ASSET_INVALID');
    } else {
      if (bytes.byteLength > MAX_INFORMATION_OS_PUBLICATION_FILE_BYTES) fail('PACKAGE_ASSET_INVALID');
      if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') fail('PACKAGE_ASSET_INVALID');
    }
    assetMimeTypes.set(reference, mimeType);
  }
  const htmlBytes = files.get('article.html');
  if (!htmlBytes) fail('PACKAGE_STRUCTURE_INVALID');
  const html = decodeUtf8(htmlBytes);
  const coverReference = covers[0];
  if (!coverReference) fail('PACKAGE_ASSET_INVALID');
  return {
    metadata,
    html,
    files,
    coverReference,
    assetReferences: assets,
    assetMimeTypes,
  };
}

function imageInput(
  reference: string,
  bytes: Uint8Array,
  mimeType: ImageMimeType,
): PublishingImageInput {
  const fileName = basename(reference);
  const references = [reference, `./${reference}`, `/${reference}`];
  return {
    id: reference,
    fileName,
    mimeType,
    body: copyArrayBuffer(bytes),
    references,
  };
}

function assertControlledImageReferences(html: string, allowedReferences: readonly string[]): void {
  const allowed = new Set(allowedReferences);
  const allowedBasenames = new Map<string, number>();
  for (const reference of allowedReferences) {
    const name = basename(reference);
    allowedBasenames.set(name, (allowedBasenames.get(name) ?? 0) + 1);
  }
  for (const match of html.matchAll(
    /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu,
  )) {
    const source = match[1] ?? match[2] ?? match[3] ?? '';
    if (/^https?:\/\/mmbiz\.qpic\.cn\//iu.test(source)) continue;
    let decoded = source;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      fail('PACKAGE_ARTICLE_INVALID');
    }
    const pathPart = decoded.split(/[?#]/u, 1)[0] ?? '';
    if (
      !pathPart
      || pathPart.includes('..')
      || pathPart.includes('\\')
      || pathPart.startsWith('//')
      || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(pathPart)
    ) {
      fail('PACKAGE_ARTICLE_INVALID');
    }
    const rooted = pathPart.startsWith('/');
    const normalized = pathPart.replace(/^\.?\//u, '').replace(/^\//u, '');
    if (safePackageReference(normalized)) {
      if (!allowed.has(normalized) || (rooted && !normalized.startsWith('assets/') && !normalized.startsWith('cover/'))) {
        fail('PACKAGE_ARTICLE_INVALID');
      }
      continue;
    }
    if (rooted) fail('PACKAGE_ARTICLE_INVALID');
    const fileName = basename(normalized);
    if (!fileName || allowedBasenames.get(fileName) !== 1) fail('PACKAGE_ARTICLE_INVALID');
  }
}

function requestParts(
  input: string | InformationOsPublicationPackageRequest,
  options: InformationOsPublicationPackageOptions = {},
): { packagePath: string; options: InformationOsPublicationPackageOptions } {
  if (typeof input === 'string') return { packagePath: input, options };
  return {
    packagePath: input.packagePath,
    options: { ...input },
  };
}

export async function prepareInformationOsPublicationPackage(
  packagePath: string,
  options?: InformationOsPublicationPackageOptions,
): Promise<PreparedArticle>;
export async function prepareInformationOsPublicationPackage(
  request: InformationOsPublicationPackageRequest,
): Promise<PreparedArticle>;
export async function prepareInformationOsPublicationPackage(
  input: string | InformationOsPublicationPackageRequest,
  options: InformationOsPublicationPackageOptions = {},
): Promise<PreparedArticle> {
  const parts = requestParts(input, options);
  let loaded: LoadedPackage;
  try {
    loaded = await loadPackage(parts.packagePath);
  } catch (error) {
    if (error instanceof InformationOsPublicationPackageError) throw error;
    fail('PACKAGE_STRUCTURE_INVALID');
  }
  const metadata = loaded.metadata;
  const title = parts.options.title ?? metadata.title ?? '';
  const author = parts.options.author ?? metadata.author ?? '';
  const digest = parts.options.digest ?? metadata.digest;
  const contentSourceUrl = parts.options.contentSourceUrl ?? metadata.content_source_url ?? '';
  const needOpenComment = parts.options.needOpenComment ?? metadata.need_open_comment ?? false;
  const onlyFansCanComment = parts.options.onlyFansCanComment
    ?? metadata.only_fans_can_comment
    ?? false;
  const cover = imageInput(
    loaded.coverReference,
    loaded.files.get(loaded.coverReference)!,
    loaded.assetMimeTypes.get(loaded.coverReference)!,
  );
  const images = loaded.assetReferences.map(reference => imageInput(
    reference,
    loaded.files.get(reference)!,
    loaded.assetMimeTypes.get(reference)!,
  ));
  assertControlledImageReferences(
    loaded.html,
    [loaded.coverReference, ...loaded.assetReferences],
  );
  const builderInput: PreparedArticleBuildInput = {
    sourceHash: metadata.content_hash,
    title,
    author,
    digest,
    contentSourceUrl,
    needOpenComment,
    onlyFansCanComment,
    containerStyle: parts.options.containerStyle,
    html: loaded.html,
    cover,
    images,
  };
  let article: PreparedArticle;
  try {
    article = await (parts.options.builder ?? new PreparedArticleBuilder()).build(builderInput);
    assertPreparedArticleReady(article);
  } catch {
    fail('PACKAGE_ARTICLE_INVALID');
  }
  return article;
}

export async function publishInformationOsPublicationPackage(
  packagePath: string,
  transport: LocalRelayTransport,
  options?: InformationOsPublicationPackageOptions & LocalRelayPublishOptions,
): Promise<LocalRelayPublishResult>;
export async function publishInformationOsPublicationPackage(
  request: PublishInformationOsPublicationPackageRequest,
): Promise<LocalRelayPublishResult>;
export async function publishInformationOsPublicationPackage(
  input: string | PublishInformationOsPublicationPackageRequest,
  transportOrOptions?: LocalRelayTransport,
  options: InformationOsPublicationPackageOptions & LocalRelayPublishOptions = {},
): Promise<LocalRelayPublishResult> {
  let packagePath: string;
  let transport: LocalRelayTransport | undefined;
  let prepareOptions: InformationOsPublicationPackageOptions & LocalRelayPublishOptions;
  if (typeof input === 'string') {
    packagePath = input;
    transport = transportOrOptions;
    prepareOptions = options;
  } else {
    packagePath = input.packagePath;
    transport = input.transport;
    prepareOptions = { ...input };
  }
  if (!(transport instanceof LocalRelayTransport)) fail('PUBLISH_TRANSPORT_INVALID');
  let article: PreparedArticle;
  try {
    article = await prepareInformationOsPublicationPackage(packagePath, prepareOptions);
  } catch (error) {
    if (error instanceof InformationOsPublicationPackageError) throw error;
    fail('PACKAGE_ARTICLE_INVALID');
  }
  try {
    return await transport.publish(article, {
      ...(prepareOptions.idempotencyKey ? { idempotencyKey: prepareOptions.idempotencyKey } : {}),
    });
  } catch (error) {
    if (error instanceof DraftCreatedVerificationError) throw error;
    fail('PUBLISH_FAILED');
  }
}
