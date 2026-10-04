import fs from 'node:fs';
import crypto from 'node:crypto';

import { verifyPublicSourceTree } from './public-source-policy.mjs';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));

const EXPECTED_PLUGIN_ID = 'ailu';
const EXPECTED_PLUGIN_NAME = 'Ailu';
const EXPECTED_VERSION = '0.2.0';
const STORAGE_NAMESPACE = '.ailu';
const BUILD_ATTESTATION = 'build-attestation.json';
const DISTRIBUTION_LEGAL_FILES = [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'LICENSES/DIJKSTRAJS-MIT.txt',
  'LICENSES/ENTITIES-BSD-2-CLAUSE.txt',
  'LICENSES/MIT.txt',
  'LICENSES/MP-PREVIEW-MIT.txt',
  'LICENSES/OPEN-DESIGN-APACHE-2.0.txt',
  'LICENSES/PNGJS-MIT.txt',
  'LICENSES/QRCODE-MIT.txt',
  'LICENSES/X-ARTICLE-IN-OBSIDIAN-MIT.txt',
  'LICENSES/ZARA-ZHANG-TEMPLATES-MIT.txt',
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function verifyBuildAttestation(publicSourceFiles) {
  const attestation = JSON.parse(fs.readFileSync(BUILD_ATTESTATION, 'utf8'));
  requireCondition(
    attestation.schema_version === 1
      && attestation.product === EXPECTED_PLUGIN_ID
      && attestation.version === EXPECTED_VERSION
      && attestation.build?.command === 'node scripts/build-release.mjs'
      && attestation.build?.typecheck === 'node node_modules/typescript/lib/tsc.js --noEmit'
      && typeof attestation.build?.node === 'string'
      && typeof attestation.build?.platform === 'string'
      && typeof attestation.build?.arch === 'string'
      && attestation.toolchain?.node_executable_sha256 === sha256(fs.readFileSync(process.execPath))
      && attestation.toolchain?.esbuild_library_sha256 === sha256(fs.readFileSync('node_modules/esbuild/lib/main.js'))
      && attestation.toolchain?.esbuild_binary_sha256 === sha256(fs.readFileSync('node_modules/esbuild/bin/esbuild'))
      && attestation.toolchain?.typescript_cli_sha256 === sha256(fs.readFileSync('node_modules/typescript/lib/tsc.js'))
      && Array.isArray(attestation.inputs),
    'Build attestation has an unsupported identity or schema.',
  );
  const expectedInputs = publicSourceFiles.map(file => ({
    path: file,
    sha256: sha256(fs.readFileSync(file)),
  }));
  requireCondition(
    JSON.stringify(attestation.inputs) === JSON.stringify(expectedInputs),
    'Build attestation does not match the complete current source/package/toolchain input set.',
  );
  for (const artifact of ['main.js', 'manifest.json', 'styles.css']) {
    requireCondition(
      attestation.artifacts?.[artifact] === sha256(fs.readFileSync(artifact)),
      `Build attestation does not match ${artifact}.`,
    );
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

requireCondition(/^\d+\.\d+\.\d+$/.test(manifest.version), 'Manifest version must use x.y.z SemVer.');
requireCondition(manifest.id === EXPECTED_PLUGIN_ID, `Manifest id must be ${EXPECTED_PLUGIN_ID}.`);
requireCondition(manifest.name === EXPECTED_PLUGIN_NAME, `Manifest name must be ${EXPECTED_PLUGIN_NAME}.`);
requireCondition(manifest.version === EXPECTED_VERSION, `Manifest version must be ${EXPECTED_VERSION}.`);
requireCondition(packageJson.name === EXPECTED_PLUGIN_ID, 'Package name must match the plugin id.');
requireCondition(packageJson.version === manifest.version, 'Package and manifest versions must match.');
requireCondition(packageJson.private === true, 'The source package must remain private to prevent accidental npm publishing.');
requireCondition(packageJson.license === 'AGPL-3.0-or-later', 'Package license must be AGPL-3.0-or-later.');
requireCondition(packageLock.name === packageJson.name, 'Package lock name must match package.json.');
requireCondition(packageLock.version === packageJson.version, 'Package lock version must match package.json.');
requireCondition(packageLock.packages?.['']?.name === packageJson.name, 'Package lock root name must match package.json.');
requireCondition(packageLock.packages?.['']?.version === packageJson.version, 'Package lock root version must match package.json.');
requireCondition(
  packageJson.engines?.node === '>=22.13'
    && packageLock.packages?.['']?.engines?.node === '>=22.13',
  'Package metadata must require Node.js 22.13 or newer.',
);
requireCondition(
  packageJson.dependencies?.entities === '^4.5.0'
    && packageLock.packages?.['']?.dependencies?.entities === '^4.5.0'
    && packageLock.packages?.['node_modules/entities']?.version === '4.5.0'
    && packageLock.packages?.['node_modules/entities']?.license === 'BSD-2-Clause',
  'The entities runtime dependency and BSD-2-Clause lock metadata must remain pinned.',
);
requireCondition(
  packageJson.overrides?.['js-yaml'] === '4.3.2'
    && packageJson.overrides?.nanoid === '3.3.18'
    && packageLock.packages?.['node_modules/js-yaml']?.version === '4.3.2'
    && packageLock.packages?.['node_modules/nanoid']?.version === '3.3.18',
  'Known-vulnerable js-yaml or nanoid versions must not re-enter the development dependency tree.',
);
requireCondition(versions[manifest.version] === manifest.minAppVersion, 'versions.json must map the current version to minAppVersion.');
requireCondition(
  Object.keys(versions).length === 1 && Object.hasOwn(versions, EXPECTED_VERSION),
  'The Ailu plugin id must keep only its own 0.2.0 release history.',
);
requireCondition(typeof manifest.description === 'string' && manifest.description.length <= 250, 'Manifest description must be at most 250 characters.');
requireCondition(manifest.description.endsWith('.'), 'Manifest description must end with a period.');
requireCondition(manifest.isDesktopOnly === true, 'The plugin uses Node.js APIs and must be desktop-only.');

for (const file of [
  'README.md',
  'ASSETS.md',
  'SECURITY.md',
  'THREAT_MODEL.md',
  'PRIVACY.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'LICENSES/MIT.txt',
  'LICENSES/MP-PREVIEW-MIT.txt',
  'LICENSES/QRCODE-MIT.txt',
  'LICENSES/DIJKSTRAJS-MIT.txt',
  'LICENSES/PNGJS-MIT.txt',
  'LICENSES/ENTITIES-BSD-2-CLAUSE.txt',
  'LICENSES/X-ARTICLE-IN-OBSIDIAN-MIT.txt',
  'LICENSES/OPEN-DESIGN-APACHE-2.0.txt',
  'LICENSES/ZARA-ZHANG-TEMPLATES-MIT.txt',
  'THIRD_PARTY_NOTICES.md',
  'main.js',
  BUILD_ATTESTATION,
  'manifest.json',
  'styles.css',
]) {
  requireCondition(fs.existsSync(file), `${file} must exist.`);
  requireCondition(fs.statSync(file).size > 0, `${file} must exist and contain data.`);
}
for (const forbiddenPublicPath of [
  'assets/feishu-logo.png',
  'src/feishu/folderDestination.ts',
  'src/skills/canghe-wechat-title',
  'src/wechat/bundledCangheTitle.ts',
]) {
  requireCondition(
    !fs.existsSync(forbiddenPublicPath),
    `Private or third-party-unverified source must not enter the public release tree: ${forbiddenPublicPath}.`,
  );
}
const publicSourceTree = verifyPublicSourceTree(process.cwd(), {
  requireGeneratedArtifacts: true,
});
verifyBuildAttestation(publicSourceTree.files);

const license = fs.readFileSync('LICENSE', 'utf8');
requireCondition(license.includes('GNU AFFERO GENERAL PUBLIC LICENSE'), 'Root license must contain AGPL-3.0.');
requireCondition(
  license.trimStart().startsWith('GNU AFFERO GENERAL PUBLIC LICENSE'),
  'Root license must start with the standard AGPL-3.0 text for license detection.',
);

const mpPreviewLicense = fs.readFileSync('LICENSES/MP-PREVIEW-MIT.txt', 'utf8');
requireCondition(mpPreviewLicense.startsWith('MIT License'), 'MP Preview notice must retain the MIT License text.');
requireCondition(mpPreviewLicense.includes('Copyright (c) 2025 夜半Yeban'), 'MP Preview copyright notice is missing.');

const qrcodeLicense = fs.readFileSync('LICENSES/QRCODE-MIT.txt', 'utf8');
requireCondition(qrcodeLicense.startsWith('The MIT License (MIT)'), 'qrcode notice must retain the MIT License text.');
requireCondition(qrcodeLicense.includes('Copyright (c) 2012 Ryan Day'), 'qrcode copyright notice is missing.');

const dijkstraLicense = fs.readFileSync('LICENSES/DIJKSTRAJS-MIT.txt', 'utf8');
requireCondition(
  dijkstraLicense.includes('Copyright (C) 2008')
    && dijkstraLicense.includes('Wyatt Baldwin <self@wyattbaldwin.com>'),
  'dijkstrajs copyright notice is missing.',
);

const pngjsLicense = fs.readFileSync('LICENSES/PNGJS-MIT.txt', 'utf8');
requireCondition(
  pngjsLicense.includes('Copyright (c) 2015 Luke Page & Original Contributors')
    && pngjsLicense.includes('Copyright (c) 2012 Kuba Niegowski'),
  'pngjs copyright notices are missing.',
);

const entitiesLicense = fs.readFileSync('LICENSES/ENTITIES-BSD-2-CLAUSE.txt', 'utf8');
requireCondition(
  entitiesLicense.startsWith('Copyright (c) Felix Böhm')
    && entitiesLicense.includes('Redistribution and use in source and binary forms')
    && entitiesLicense.includes('THIS IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"'),
  'entities notice must retain the BSD-2-Clause copyright and license text.',
);

const xArticleLicense = fs.readFileSync('LICENSES/X-ARTICLE-IN-OBSIDIAN-MIT.txt', 'utf8');
requireCondition(xArticleLicense.startsWith('MIT License'), 'X Article notice must retain the MIT License text.');
requireCondition(xArticleLicense.includes('Copyright (c) 2026 Icy-Cat'), 'X Article copyright notice is missing.');

const openDesignLicense = fs.readFileSync('LICENSES/OPEN-DESIGN-APACHE-2.0.txt', 'utf8');
requireCondition(
  openDesignLicense.includes('Apache License')
    && openDesignLicense.includes('Version 2.0, January 2004'),
  'Open Design Apache-2.0 license text is missing.',
);
const zaraTemplatesLicense = fs.readFileSync('LICENSES/ZARA-ZHANG-TEMPLATES-MIT.txt', 'utf8');
requireCondition(
  zaraTemplatesLicense.includes('Copyright (c) 2026 Zara Zhang'),
  'Zara Zhang template copyright notice is missing.',
);

const thirdPartyNotices = fs.readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
requireCondition(
  thirdPartyNotices.includes('WeSight Obsidian plugin 0.4.0')
    && thirdPartyNotices.includes('4fab17721cf1deecf8c6f882a7afbf30943e980c')
    && thirdPartyNotices.includes('Copyright (C) 2026 WeSight contributors')
    && thirdPartyNotices.includes('Ailu modifications Copyright (C) 2026 Ailu contributors')
    && thirdPartyNotices.includes('2026-08-05'),
  'Third-party notices must preserve the exact WeSight 0.4.0 provenance and Ailu modification notice.',
);
requireCondition(thirdPartyNotices.includes('## MP Preview'), 'Third-party notices must include MP Preview.');
requireCondition(
  thirdPartyNotices.includes('LICENSES/MP-PREVIEW-MIT.txt'),
  'Third-party notices must link the MP Preview MIT text.',
);
requireCondition(
  thirdPartyNotices.includes('## qrcode')
    && thirdPartyNotices.includes('LICENSES/QRCODE-MIT.txt'),
  'Third-party notices must include qrcode and its MIT text.',
);
requireCondition(
  thirdPartyNotices.includes('## entities')
    && thirdPartyNotices.includes('BSD-2-Clause')
    && thirdPartyNotices.includes('LICENSES/ENTITIES-BSD-2-CLAUSE.txt'),
  'Third-party notices must include entities and its BSD-2-Clause text.',
);
requireCondition(
  thirdPartyNotices.includes('## X Article in Obsidian')
    && thirdPartyNotices.includes('LICENSES/X-ARTICLE-IN-OBSIDIAN-MIT.txt'),
  'Third-party notices must include X Article in Obsidian and its MIT text.',
);
requireCondition(
  thirdPartyNotices.includes('## Open Design templates')
    && thirdPartyNotices.includes('5580736c1ac6717f70d2f7f0aec4b3e7475e9f28')
    && thirdPartyNotices.includes('LICENSES/OPEN-DESIGN-APACHE-2.0.txt')
    && thirdPartyNotices.includes('LICENSES/ZARA-ZHANG-TEMPLATES-MIT.txt'),
  'Third-party notices must include the exact Open Design provenance and licenses.',
);
requireCondition(
  thirdPartyNotices.includes('LICENSES/DIJKSTRAJS-MIT.txt')
    && thirdPartyNotices.includes('LICENSES/PNGJS-MIT.txt'),
  'Third-party notices must include qrcode runtime dependencies.',
);

const readme = fs.readFileSync('README.md', 'utf8');
requireCondition(readme.includes(`# ${EXPECTED_PLUGIN_NAME}`), 'README must use the current plugin name.');
requireCondition(readme.includes(`\`${STORAGE_NAMESPACE}/`), 'README must document the vault storage namespace.');
requireCondition(readme.includes(`~/${STORAGE_NAMESPACE}/`), 'README must document the global storage namespace.');
requireCondition(
  readme.includes('community-plugins.json')
    && readme.includes('npm run deploy:plan')
    && readme.includes('npm run deploy:apply')
    && readme.includes('标准 `.obsidian` 配置目录')
    && readme.includes('Windows')
    && readme.includes('schema_version: 2'),
  'README must document canonical Ailu deployment and runtime API v2.',
);
requireCondition(
  readme.includes('商业使用：允许，但必须遵守 AGPL-3.0-or-later')
    && readme.includes('商业部署、定制、培训与技术支持：可联系')
    && readme.includes('mcncarl/wechat-relay')
    && readme.includes('mcncarl/yichen-skills')
    && readme.includes('mcncarl/agent-memory-vault')
    && readme.includes('freestylefly/wesight-obsidian'),
  'README must document the commercial-use boundary and related public repositories.',
);

const gitignore = fs.readFileSync('.gitignore', 'utf8');
requireCondition(gitignore.includes(`${STORAGE_NAMESPACE}/`), 'The active vault namespace must be ignored by Git.');

const buildConfig = fs.readFileSync('esbuild.config.mjs', 'utf8');
requireCondition(
  buildConfig.includes("entryPoints: ['src/main.ts']"),
  'The production bundle must use the conventional src/main.ts entry.',
);
requireCondition(
  !/external:\s*\[[\s\S]*?['"]entities['"]/.test(buildConfig)
    && !/require\(['"]entities['"]\)/.test(fs.readFileSync('main.js', 'utf8')),
  'The entities runtime dependency must be bundled into main.js.',
);

const idsSource = fs.readFileSync('src/ids.ts', 'utf8');
for (const value of [
  EXPECTED_PLUGIN_ID,
  EXPECTED_PLUGIN_NAME,
  'ailu-chat',
  'ailu-publishing',
  STORAGE_NAMESPACE,
  'AILU_HOME',
  'ailu-wechat-relay-token',
  'ailu-provider-api-key-',
]) {
  requireCondition(idsSource.includes(value), `src/ids.ts must define ${value}.`);
}

const processLockSource = fs.readFileSync('src/storage/processWriteLock.ts', 'utf8');
for (const lockInvariant of [
  'createAiluProcessWriteLock',
  'STORAGE_IDS.vaultDirectoryName',
  'os.fchmod(fd, 0o600)',
  'lock_directory_fd',
  'dir_fd=lock_directory_fd',
]) {
  requireCondition(
    processLockSource.includes(lockInvariant),
    `The canonical Ailu process fence must retain ${lockInvariant}.`,
  );
}

const verifiedMemorySource = fs.readFileSync('src/memory/verifiedMemory.ts', 'utf8');
const verifiedMemoryWriteSource = fs.readFileSync('src/memory/verifiedMemoryWrite.ts', 'utf8');
const memoryRuntimeHandshakeSource = fs.readFileSync('src/memory/runtimeHandshake.ts', 'utf8');
const creativeMemorySource = fs.readFileSync('src/memory/creativeMemory.ts', 'utf8');
requireCondition(
  verifiedMemorySource.includes('AGENT_MEMORY_RUNTIME_API_VERSION = 2')
    && verifiedMemoryWriteSource.includes('fencing_token')
    && verifiedMemoryWriteSource.includes('safePositiveInteger'),
  'Agent Memory must fail closed on runtime API v2 and bind positive fencing tokens.',
);
for (const handshakeInvariant of [
  "args: ['--actor', 'ailu', 'version', '--json']",
  'value.ready !== true',
  'value.runtime_api_version !== AILU_MEMORY_RUNTIME_API_VERSION',
  'value.writer_protocol_version !== AILU_MEMORY_WRITER_PROTOCOL_VERSION',
  "!value.canonical_actors.includes('ailu')",
  'identity.manifestMtimeNs',
  'identity.transitionMarkerFingerprint',
  'value.runtime_integrity_sha256',
  'value.manifest_sha256',
  'DEFAULT_CACHE_TTL_MS = 5_000',
]) {
  requireCondition(
    memoryRuntimeHandshakeSource.includes(handshakeInvariant),
    `Agent Memory runtime v2 handshake must retain ${handshakeInvariant}.`,
  );
}
requireCondition(
  creativeMemorySource.includes('retrieveVerifiedMemory')
    && !creativeMemorySource.includes("'search'"),
  'Creative memory must use the verified runtime API v2 bridge and never fall back to search v1.',
);

const brandMarkSource = fs.readFileSync('src/ui/ailuBrandMark.ts', 'utf8');
const studioChromeSource = fs.readFileSync('src/ui/studioChrome.ts', 'utf8');
requireCondition(
  brandMarkSource.includes("../../assets/ailu-ribbon-icon.png")
    && studioChromeSource.includes("./ailuBrandMark"),
  'Active Ailu chrome must import only the canonical Ailu asset.',
);
const publishingStudioViewSource = fs.readFileSync('src/ui/publishingStudioView.ts', 'utf8');
const chatViewSource = fs.readFileSync('src/ui/chatView.ts', 'utf8');
requireCondition(
  publishingStudioViewSource.includes("return 'panels-top-left'")
    && publishingStudioViewSource.includes('brandAiluWorkspaceTab(this.leaf)')
    && publishingStudioViewSource.includes('restoreWorkspaceTabIcon(this.leaf)')
    && chatViewSource.includes('brandAiluWorkspaceTab(this.leaf)')
    && chatViewSource.includes('restoreWorkspaceTabIcon(this.leaf)')
    && brandMarkSource.includes("icon.addClass('ailu-tab-brand-icon')")
    && fs.readFileSync('styles.css', 'utf8').includes('@supports ((-webkit-mask-image: none) or (mask-image: none))')
    && !fs.readFileSync('styles.css', 'utf8').includes('.lucide-panels-top-left'),
  'Ailu workspace tabs must use a namespaced brand mark with functional icon fallbacks.',
);
requireCondition(
  studioChromeSource.includes("icon: 'message-square'")
    && studioChromeSource.includes("icon: 'panels-top-left'")
    && studioChromeSource.includes('setIcon(icon, item.icon)')
    && !studioChromeSource.includes('ailu-chrome-nav-mark')
    && fs.readFileSync('src/studioMain.ts', 'utf8').includes(".setIcon('panels-top-left')"),
  'Ailu chat/draft navigation must retain functional glyphs while only the workspace tab is branded.',
);
const providerStoreSource = fs.readFileSync('src/storage/providerStore.ts', 'utf8');
for (const providerInvariant of [
  'recoverInterruptedTransaction',
  'auditCanonicalSecretPointers',
  'ailu-provider-secret-v2-',
  'assertNoPreparedProviderTransaction',
  'compareAndSwapTextFile',
]) {
  requireCondition(
    providerStoreSource.includes(providerInvariant),
    `Global Ailu Provider storage must retain ${providerInvariant}.`,
  );
}
requireCondition(
  !providerStoreSource.includes('current || stored.apiKey'),
  'Normal Ailu Provider reads must not fall back to plaintext metadata.',
);

const runtimeDiscoverySource = fs.readFileSync('src/runtime/discovery.ts', 'utf8');
const codexDesktopSource = fs.readFileSync('src/runtime/codexDesktop.ts', 'utf8');
for (const [file, source] of [
  ['src/runtime/discovery.ts', runtimeDiscoverySource],
  ['src/runtime/codexDesktop.ts', codexDesktopSource],
]) {
  requireCondition(
    source.includes('AILU_IDS'),
    `${file} must discover runtimes from canonical Ailu configuration.`,
  );
}

const larkCliSource = fs.readFileSync('src/feishu/larkCli.ts', 'utf8');
requireCondition(
  larkCliSource.includes("const DEFAULT_FOLDER_NAME = 'Ailu'"),
  'Automatic Feishu destination discovery/creation must use only the Ailu folder name.',
);

const studioMainSource = fs.readFileSync('src/studioMain.ts', 'utf8');
for (const settingsInvariant of [
  "PythonFcntlProcessWriteLock.forPrivateDirectory",
  "'provider-writer.lock'",
  'this.canonicalSettingsSnapshot?.raw ?? null',
  'compareAndSwapExternalText',
  'auditCanonicalSecretPointers',
  'this.registerView(VIEW_IDS.chat, createChatView)',
  'this.registerView(VIEW_IDS.publishing, createPublishingView)',
  "const supportsPhysicalWriter = process.platform !== 'win32' && Boolean(vaultBasePath)",
]) {
  requireCondition(
    studioMainSource.includes(settingsInvariant),
    `Ailu settings/Home writer gateway must retain ${settingsInvariant}.`,
  );
}

const deployerSource = fs.readFileSync('scripts/deploy-ailu.mjs', 'utf8');
for (const deployInvariant of [
  "import { verifyPublicSourceTree } from './public-source-policy.mjs';",
  "const CANONICAL_PLUGIN_ID = 'ailu'",
  "const CANONICAL_VAULT_NAMESPACE = '.ailu'",
  "spawnSync(process.execPath, ['scripts/verify-release.mjs']",
  'committed_by_community_pointer',
  'rolled_back_pre_pointer',
  'rollback_committed_by_community_pointer',
  'community-plugins.json',
  'VAULT_COMMUNITY_PLUGINS_NOT_INITIALIZED',
  'fs.constants.COPYFILE_EXCL',
  'CANONICAL_AUTHORITY_CHANGED',
  'build-attestation.json',
  'recover-plan',
  'deploy_pointer_observed',
  'deploymentGenerationHash',
  'exchange_files',
  'PREVIOUS_DEPLOY_OUTCOME_UNRECORDED',
  'assertCanonicalBaselinesUnchanged',
  "const parent = path.join(configDir, 'ailu-deployment-backups')",
  'currentCommunity.value.filter(id => id !== CANONICAL_PLUGIN_ID)',
  "'~/.ailu/provider-writer.lock'",
  'Ailu deployer handles exactly one Vault per invocation',
  'fs.linkSync(stage, file)',
  'return verifyPublicSourceTree(repoRoot).files;',
]) {
  requireCondition(
    deployerSource.includes(deployInvariant),
    `The canonical Ailu deployer must retain ${deployInvariant}.`,
  );
}
requireCondition(
  !deployerSource.includes('AILU_DEPLOY_RELEASE_VERIFIED'),
  'Ailu deployment must not allow an environment variable to bypass release verification.',
);

const bundle = fs.readFileSync('main.js', 'utf8');
requireCondition(!/sourceMappingURL=/.test(bundle), 'Production main.js must not include a source map.');
for (const legalFile of DISTRIBUTION_LEGAL_FILES) {
  const legalText = fs.readFileSync(legalFile, 'utf8').trimEnd().replaceAll('*/', '* /');
  const embedded = `===== BEGIN ${legalFile} =====\n${legalText}\n===== END ${legalFile} =====`;
  requireCondition(
    bundle.includes(embedded),
    `Production main.js must retain the complete distribution notice: ${legalFile}.`,
  );
}
for (const forbiddenDirectPublishingCapability of [
  'api.weixin.qq.com/cgi-bin',
  'CloudAuthService',
  'ShareCloudApi',
  'WeChatCloudApi',
]) {
  requireCondition(
    !bundle.includes(forbiddenDirectPublishingCapability),
    `Production main.js must not include a direct-publishing capability: ${forbiddenDirectPublishingCapability}.`,
  );
}
for (const feishuCapability of [
  'ailu-feishu-doc-id',
  'ailu-feishu-publishing-surface',
  'my_library',
  'AILU_FEISHU_IMAGE_',
]) {
  requireCondition(
    bundle.includes(feishuCapability),
    `Production main.js must include the Feishu publishing capability: ${feishuCapability}.`,
  );
}
for (const xArticleCapability of [
  'x-article-draft-uploader',
  'ailu-x-publishing-surface',
  'compose/articles/edit',
  'RESULT_OK True',
  'content_checkpoints',
  'expected_compact_sha256',
  'unicode_code_points',
]) {
  requireCondition(
    bundle.includes(xArticleCapability),
    `Production main.js must include the X Article draft capability: ${xArticleCapability}.`,
  );
}
for (const forbiddenXCapability of [
  'playwrightToken',
  'MCP Bridge',
  'resume-images-only',
  'platform.twitter.com/widgets.js',
]) {
  requireCondition(
    !bundle.includes(forbiddenXCapability),
    `Production main.js must not include unsafe X capability: ${forbiddenXCapability}.`,
  );
}
for (const relativePath of fs.readdirSync('src', { recursive: true })) {
  if (!relativePath.endsWith('.ts')) continue;
  const source = fs.readFileSync(`src/${relativePath}`, 'utf8');
  requireCondition(
    !/npm\s+install|npx\s+skills\s+add/.test(source),
    `Plugin source ${relativePath} contains a dependency installation command.`,
  );
}
requireCondition(
  bundle.includes(STORAGE_NAMESPACE)
    && bundle.includes('conversations.json')
    && bundle.includes('generated-images')
    && bundle.includes('ailu-share-id'),
  'Production main.js must use the stable Ailu vault namespace.',
);

process.stdout.write(`Verified ${manifest.name} ${manifest.version} release assets.\n`);
