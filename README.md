# Ailu

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
![Commercial use: permitted under AGPL](https://img.shields.io/badge/commercial_use-permitted_under_AGPL-2ea44f.svg)
![Commercial support: available](https://img.shields.io/badge/commercial_support-available-7c3aed.svg)

Ailu 是一款桌面端 Obsidian 插件，把本地 Agent 对话、内容预览、公众号草稿上传、飞书文档同步和 X Article 草稿创建收进同一个简约工作台。显示名为 `Ailu`，插件 ID、包名、存储和 Agent Memory 身份统一为 `ailu`。

## 当前分发状态

Ailu 0.2.0 以公开源码和 [GitHub Release](https://github.com/mcncarl/ailu/releases/tag/0.2.0) 分发。普通用户优先安装 Release 中经过验证的 `main.js`、`manifest.json` 和 `styles.css`；GitHub 自动生成的 “Source code” 压缩包不包含被忽略的 `main.js` 与 `build-attestation.json`，不能直接当作 Obsidian 插件包使用。

当前可写功能的已验证支持范围是 macOS/POSIX。Windows 会 fail-closed 以只读模式启动，不执行 Agent 对话、行内修改、设置写入或部署。

## 从 Release 安装（推荐）

1. 安装 Obsidian Desktop 1.11.4 或更高版本，并在目标 Vault 的“设置 → 第三方插件”中启用第三方插件。
2. 从 [Ailu 0.2.0 Release](https://github.com/mcncarl/ailu/releases/tag/0.2.0) 下载 `main.js`、`manifest.json` 和 `styles.css`。可同时下载 `build-attestation.json`、`LICENSE` 与 `THIRD_PARTY_NOTICES.md` 核对构建和许可证。
3. 在目标 Vault 中创建 `.obsidian/plugins/ailu/`，把三个运行文件放入该目录；不要把 GitHub 的 Source code ZIP 直接放进去。
4. 完全退出并重开 Obsidian，在“设置 → 第三方插件”中启用 Ailu，然后继续执行下方“首次启动验收”。

Release 安装不需要 Node.js；核心写锁仍要求系统存在可执行的 `/usr/bin/python3`，Agent 对话仍要求至少安装并登录 Claude Code 或 Codex。需要自行审计源码、修改插件或使用受验证部署/回滚工具时，再采用下面的源码流程。

## 从源码构建安装

### 1. 准备环境

- Obsidian Desktop 1.11.4 或更高版本；先打开目标 Vault，在“设置 → 第三方插件”中启用第三方插件，使 `.obsidian/plugins/` 和 `.obsidian/community-plugins.json` 完成初始化。
- Node.js 22.13 或更高版本及 npm。
- 核心写锁和部署器要求 `/usr/bin/python3` 可执行。这不是只有 X 流程才需要的可选依赖。
- 安装当前受支持版本的 [Claude Code](https://code.claude.com/) 或 [Codex](https://github.com/openai/codex)，至少选择一个，并先在终端完成一次登录。

先核对前置条件：

```bash
node --version
npm --version
/usr/bin/python3 --version
claude --version  # 或 codex --version
```

### 2. 克隆、审计并构建

```bash
git clone https://github.com/mcncarl/ailu.git
cd ailu
npm ci
npm run audit:dependencies
npm run check
```

`npm run check` 会依次运行全量测试、公开源码清单策略、lint、正式构建和 Release 验证。完成后应生成 `main.js` 与 `build-attestation.json`。

### 3. 只读检查并安装到一个 Vault

Vault 参数必须是带引号的真实绝对物理路径，不能使用 `~`、符号链接路径或自定义 Obsidian 配置目录。先执行不会改动 Vault 的 plan：

```bash
npm run deploy:plan -- --vault "/Users/你的用户名/Documents/My Vault"
```

确认输出中的 Vault、插件 ID 和四个产物哈希无误，完全退出所有 Obsidian 进程，再执行 apply：

```bash
npm run deploy:apply -- --vault "/Users/你的用户名/Documents/My Vault"
```

保存命令输出中的 receipt 路径；它是后续核对、恢复或回滚的依据。部署器会启用 `ailu`，不会删除 `.ailu/` 数据，也不会删除插件目录或部署证据。

### 4. 首次启动验收

1. 重开 Obsidian，在“设置 → 第三方插件”确认 Ailu 已启用。
2. 打开“设置 → Ailu”，确认 Agent 行显示已就绪；若只安装了 Codex 或 Claude Code，Ailu 会自动选择已安装的那个。若两者都未找到，会直接打开安装引导。
3. 如果终端里可用、Obsidian 中却显示未安装，在 Ailu 设置里配置真实可执行文件路径。通过 Finder 启动的 Obsidian 可能看不到 nvm、fnm、asdf 或 mise 的 shell shim；同时确保该 CLI 所需的 `node` 目录也对图形应用可见。
4. 保持“完全访问”关闭，并先打开对话框中的 `Plan`。点击左侧 Ailu 图标，或使用命令面板 `Ailu: 打开对话`，发送：`只回复 OK，不读写任何文件。`
5. 再打开一篇普通 Markdown，发送：`只读取当前笔记并概括三点，不修改文件。` 确认标题栏运行状态、回复和本地历史都正常。
6. 使用命令面板 `Ailu: 打开草稿区`，确认当前 Markdown 的本地预览可打开。飞书、X 和公众号属于独立的可选集成，主对话验收通过后再分别配置。

“完全访问”关闭不等于所有普通对话都只读：普通模式仍会把所选 CLI 限制在其受限工作区权限内；其中 Codex 当前使用 `workspace-write` 且不逐条弹出批准。需要纯只读规划时保持 `Plan` 开启，确认需求后再关闭。

兼容的 Agent Memory Runtime v2 是可选的本机增强能力，不随仓库安装。没有 `~/.config/agent-memory/scripts/memoryctl` 时，对话继续正常工作，记忆检索和“沉淀到记忆”入口会保持关闭；不要把它的缺失当成 Agent CLI 故障。

## 完整功能配置

上面的首次验收只证明 Ailu 核心、Agent 对话和本地预览可用。若要交付给其他人完整使用，还必须按 [《Ailu 完整安装与集成配置》](docs/COMPLETE_SETUP.md)分别完成并验收：

1. Ubuntu 服务器、公众号固定出口 IPv4 白名单、`wechat-relay`、Tailscale Serve 或 Caddy HTTPS，以及 Ailu 中转地址和 Token；
2. 与当前 Ailu 匹配的 `x-article-draft-uploader`、独立 Python/Playwright 环境、Chrome 登录态与 X Cookie 导入；
3. `lark-cli` 安装，以及在 Ailu 草稿区完成的中国版飞书配置、扫码授权和目标目录选择；
4. 可选的 Agent Memory Runtime v2 安装与 `memoryctl --actor ailu version --json` 握手。

四条集成互不替代，也不应在第一次启动时一起排错。完整指南为每一步给出了成功信号、凭据边界和失败后的处理顺序。

### 更新

```bash
git pull --ff-only
npm ci
npm run audit:dependencies
npm run check
npm run deploy:plan -- --vault "/Users/你的用户名/Documents/My Vault"
```

确认 plan 后退出所有 Obsidian，再执行同一 Vault 的 `deploy:apply`。一次只更新一个 Vault，重开并验收后再处理下一个。

### 常见阻断

- `VAULT_COMMUNITY_PLUGINS_NOT_INITIALIZED`：先用 Obsidian 打开该 Vault 并启用第三方插件，然后退出 Obsidian 重试。
- `AILU_PYTHON_MISSING`：确认 `/usr/bin/python3 --version` 成功；缺失时核心写入也会转为只读。
- `OBSIDIAN_RUNNING`：apply 前仍有 Obsidian 进程；保存工作后完全退出再重试。
- `Vault path must be canonical`：传入了符号链接或非物理路径；换成带引号的真实绝对路径。
- Agent 显示“未安装”或首次连接报错：先在终端核对 CLI 版本与登录，再检查 Ailu 设置中的可执行路径；旧 CLI 可能不支持当前依赖的协议参数，应先升级 CLI 后复测。

## 功能

### AI 助手

- 在 Obsidian 侧边栏中使用 Claude Code 或 Codex。
- 支持文件引用、斜杠命令、模型、自定义供应商以及 Markdown 选区内联编辑。
- 对话框会发现本机 Claude Code、Codex、`~/.agents/skills` 与 Codex 插件缓存中的 Skill 入口，只读取名称、说明和位置用于候选列表；用户自行选择要启用的创作 Skill。只有明确选中后，当前 Agent 才会读取对应 `SKILL.md` 及其相对引用，Ailu 不捆绑、复制或自动安装个人 Skill。
- 若本机安装了兼容的 Agent Memory Runtime v2，每次发送前只从共享 Agent 记忆中检索 `app_id=ailu`、用户级 `project_id=global` 与默认项目 `project_id=ailu` 的创作偏好与项目工作流；`global` 只允许命中 `用户记忆/`，`项目/` 与 `工作流/` 必须使用真实项目 ID。检索完全在本机执行，结果仅作为写作上下文，不构成上传、发布、发消息、付费、凭证读取或删除授权。写入其他项目时必须显式传入该项目的真实 `project_id`，不会被底层强行归到 Ailu。
- Claude Code 可在“本机配置 / CC Switch · 跟随全局 / 自定义供应商”之间切换。CC Switch 模式每次发送前都重新检查本地代理及全局 Claude 模型路由，不读取当前 Vault 的 `.claude/settings*.json`，不复制 API Key，也不修改 CC Switch 的全局选择。
- Codex 模型和推理强度从本机 App Server 动态读取；支持模型实际提供的 `low`、`medium`、`high`、`xhigh`、`max`、`ultra` 六档。
- 本地对话和内联编辑直接调用用户已安装的 Agent CLI。Claude Code 与 Codex 的“完全访问”默认关闭；只有用户在对应设置中明确开启后，普通对话才会请求高权限运行。Plan 模式始终保持只规划。

### 草稿工作台

- 当前 Markdown 自动生成公众号本地预览，并可复制排版 HTML。
- 可在公众号草稿区点击“导入 InformationOS 包”，拖入交接包内的 `metadata.json` 或粘贴包目录；Ailu 会重新核对目录结构、合同、全部文件哈希、封面和正文图片，再进入同一套人工确认与草稿回读流程。本地核对不会读取 InformationOS 数据库、Vault 或 Ailu 凭据，也不会自动上传；只有使用者继续并完成最终确认后，现有草稿通道才会使用 Ailu 自己保存的 Relay Token。
- 公众号内置 8 套确定性本地模板：纸墨编辑风、柔彩手记、开放设计档案、靛蓝羊皮纸、三色编辑部、黑粉手写体、蜜桃玩字和彩色胶囊；模板旁可独立选择正文字体与 14–20px 字号，默认使用纸墨楷宋 17px，也可改为跟随模板。
- 上传前移除重复标题和封面、清理危险列表结构、逐张检查图片并把超限正文图压缩到 1 MB 以内。
- 只通过用户自行部署的 [`wechat-relay`](https://github.com/mcncarl/wechat-relay) 创建公众号草稿；每次都需要最终确认，并在创建后回读核验。
- 若创建接口已返回 `media_id` 但回读失败，工作台会保留该 ID 并提示先人工核对草稿箱；端到端防重复仍要求中转服务持久化处理 `Idempotency-Key`。
- 不包含群发和正式发布入口，Agent 也不能绕过确认直接上传。
- 草稿区通过同一行的“公众号 / 飞书 / X 文章”切换目标，不增加新的侧边栏标签或 Ribbon 入口。
- 飞书模式复用用户独立安装的 `lark-cli`，只申请文档创建、读取、覆盖更新、图片上传，以及云盘文件夹和知识库节点的目录只读权限；不会读取消息、日历或多维表格内容，也不会退出本机共享的飞书登录。
- 首次创建默认放入个人文档库根目录；“更改”会只读加载云盘文件夹、个人文档库和当前账号可访问的知识库层级，用户可逐级展开并选择，不需要复制链接。该位置只影响新建文档，已关联文档仍在原位置更新并保持链接不变。本地图片按原文位置插入，每次创建或覆盖前均需确认，并在完成后回读验证。
- X 文章模式在本机生成接近 X Article 的 5:2 封面卡片与正文预览；代码块、图片、图注、表格和 X 帖子链接均有本地样式，预览不会静默加载 X 的远程 widgets 脚本。
- X 草稿创建复用用户独立安装的 `x-article-draft-uploader` Skill：先在本机生成不修改原文、已剔除 BOM 与 YAML frontmatter 的上传副本，再执行 fail-closed dry-run。上传图片必须是当前 Vault 内、非符号链接、20 MB 以内且通过文件头核验的 PNG/JPEG/GIF/WebP；远程或 Vault 外图片会在打开 X 前停止流程并显示具体原因。正文最多 25 个媒体项，封面单独上传且不占正文名额；不超过 10×10 的 Markdown 表格会写成 X 原生表格后读回核验。dry-run 产生 3–5 个有序正文检查点、按 Unicode code point 计算的规范化字符数和 SHA-256；成功必须按顺序全部命中，且读回正文的字符数与 SHA-256 完全一致。
- 每次真正打开 X 前都要再次确认；流程只填写并等待草稿自动保存，没有最终发布入口。草稿 URL 已生成后的失败会保留链接并要求先人工核对，工作台不会自动重试、续传或删除草稿。

## 运行要求

- 桌面端 Obsidian 1.11.4 或更高版本。macOS/POSIX 支持完整写入；Windows 0.2.0 仅支持 fail-closed 只读查看。
- 从源码构建需要 Node.js 22.13 或更高版本；核心写锁和部署要求可执行的 `/usr/bin/python3`。
- 至少独立安装一个受支持的 Agent CLI：[Claude Code](https://code.claude.com/) 或 [Codex](https://github.com/openai/codex)。
- 使用飞书同步时，需另行安装 [lark-cli](https://github.com/larksuite/cli)；Ailu 会在草稿区完成中国版飞书 `brand=feishu` 的配置与扫码授权，不会连接国际版 Lark。插件只发现现有 CLI，不代为安装或升级。
- 使用 X 文章草稿时，安装已与 Ailu `0.2.0` 复核的公开 tag [`x-article-draft-uploader-v1.0.1`](https://github.com/mcncarl/yichen-skills/tree/x-article-draft-uploader-v1.0.1/yichen-x-article-draft-uploader)（commit `9f679d9f28d656eb01b60d806faa709f85173c51`），并使用该版本锁定的 Python 依赖；不要安装会继续变化的任意 `main` 快照。插件只发现和调用现有 Skill，不复制、安装或升级它。该 Skill 使用独立的个人学习与非商业协议，商业使用须事先取得作者明确书面授权，不随 Ailu 的 AGPL 许可证重新授权。

插件会从用户配置的路径、`~/.ailu/runtimes/`、系统 `PATH` 与支持的桌面客户端中发现现有可执行文件，不会自动复制、安装或升级 CLI 及其依赖。托管 runtime 必须是非符号链接的真实可执行文件。Ailu 只确认可执行文件和可选版本文本，不能预先保证旧版 CLI 的协议兼容；首次使用前应在终端升级、登录并执行一次版本检查。

## 数据与网络边界

Ailu 自身和固定模板预览不要求 Ailu 云端账号；Claude Code、Codex 及其模型供应商通常仍需要登录、API Key 或网络连接。

- 创作记忆通过本机 `memoryctl --actor ailu`、`app_id=ailu`、单一实际 `project_id`（用户记忆可用 `global`）、`agent_scope=shared`、`status=active` 限定读取，不扫描完整记忆库，不把对话自动写入长期记忆。默认项目文件是 `项目/Ailu.md`，对应 `project_id=ailu`；每条业务响应要求 `schema_version: 2`。插件启动、设置变更、transition marker 变化或 5 秒 TTL 到期时调用 `memoryctl --actor ailu version --json` 握手，严格要求 `ready=true`、`runtime_api_version=2`、`writer_protocol_version=2`、actor 列表含 `ailu`，并验证 manifest 与全 runtime bundle 的非空 SHA-256 完整性。缓存身份同时绑定 executable realpath、manifest realpath/mtime、transition marker 哈希及 runtime/manifest 完整性哈希。任一检查或业务子命令失败都会禁用正式记忆读写、清空读取缓存并记录本地诊断，同时隐藏不可用的记忆入口；它不会阻断普通对话，也不会绕过 Runtime v2 或复用跨 transition 的缓存结果。
- Skill 发现只读取本机各 Skill 入口文件的 frontmatter，并由用户从候选列表中挑选；只有用户在对话框明确选中某个 Skill 后，才要求当前 Agent 读取该 Skill 的完整入口与相对引用。依赖未安装插件或当前 Agent 不具备的工具时，由 Agent 明确提示能力限制。用户在当前请求中选择发布或上传类 Skill 时，不再仅因该动作重复确认；目标或内容不明确时仍需澄清。
- 对话、飞书和 X 的本地预览不会让 MarkdownRenderer 直接读取远程 URL、任意本地路径或未核验的 Vault 资源；已冻结并校验哈希与文件头的图片会转成当前预览专用的 `blob:` URL，其余媒体显示为本地占位符。公众号快照是唯一会主动下载笔记远程图片的预览路径：只允许 HTTPS 443，逐跳重验公开 DNS 地址、响应类型和大小，并把冻结字节交给预览与完整性检查。
- 只有用户点击“上传到草稿箱”、通过最终确认后，封面、正文图片和文章 HTML 才会发往用户配置的中转地址。
- 只有用户在飞书模式点击“创建飞书文档 / 同步到飞书”并确认后，当前 Markdown 和本地图片才会交给本机 `lark-cli`；文档 ID、链接和内容哈希写入当前笔记的 Ailu frontmatter，用于后续更新与防重复。
- X 预览主体完全在本机生成。只有用户点击“创建 X 草稿”并通过最终确认后，插件才会启动 Skill 的独立 Playwright 浏览器，把临时 Markdown、已校验的 Vault 内图片和 X Cookie 文件用于草稿填写；不会接管当前 Chrome，也不会点击最终发布。远程媒体在进入 MarkdownRenderer 前会替换为本地占位符，预览和 X 上传预检都不会联网下载它。
- X Cookie 内容不写入 Vault、插件 `data.json`、日志或 Git，只保存在 `~/.ailu/secrets/x/cookies.json`（目录 `0700`、文件 `0600`）。设置页提供“从 Chrome 导入 / 粘贴 JSON / 选择 JSON”三条路线；用户也可开启“缺失时导出”，仅在 Cookie 不存在、已过期或缺少 `x.com` 的 `auth_token`/`ct0` 时调用 Skill 的 Chrome 导出脚本，可能触发 macOS 钥匙串授权。外部脚本只写私密 staging，Ailu 校验域名、有效期与必需项后才原子替换 canonical 文件。
- X 上传的单次运行目录、结果 JSON、草稿 URL 和最终截图会保留用于故障核对；插件不会自动删除这些证据。半成品或成功草稿在用户确认已记录链接前会阻止工作台自动切换笔记；受限为 `0600` 的本机日志会保留草稿 URL 与诊断目录以防视图意外关闭，但绝不记录 Cookie 值。
- 中转 Token 必须由至少 32 个随机字节生成，保存在 Obsidian SecretStorage，不写入 `data.json`；公众号 AppSecret 只存在于用户自己的 `wechat-relay` 服务器，绝不进入 Ailu。插件本身不提供直连公众号接口的降级路径。
- CC Switch 的代理存活状态通过回环地址 `127.0.0.1:15721` 的 `/health` 和 `/status` 读取；`/status.current_provider` 实际是上一轮模型请求使用的 Provider，不能代表刚完成的界面切换。因此插件只从 `~/.cc-switch/settings.json` 白名单读取 `currentProviderClaude` 和可选的 `claudeConfigDir`，再从该全局目录的 `settings.json` 提取顶层模型与 Haiku / Sonnet / Opus / 子 Agent 等非秘密模型路由字段。当前选择文件不可用时会直接报错，不回退到上一轮请求记录；发送前会复核全局 Provider 与模型路由指纹，并让 Claude Code 只加载用户级 settings，明确排除当前 Vault 的 project/local settings。插件不读取 CC Switch SQLite、鉴权字段或已保存凭证。当前 CC Switch 没有面向外部插件的 Provider 列表/切换 API，因此精确换用其他 Provider 需在 CC Switch 内完成；实际故障转移仍由 CC Switch 决定。

## 本地存储

Ailu 的 Vault 命名空间是 `.ailu/`，全局目录是 `~/.ailu/`。对话写入先独占 `.ailu/conversation-writer.lock`，Provider 与全局设置写入先独占 `~/.ailu/provider-writer.lock`；文件更新通过物理 helper 执行 compare-and-swap（CAS，比较后交换），检测到并发变化时 fail-closed，不覆盖未知版本。私有目录使用 `0700`，私有文件使用 `0600`。

当前 Vault 内：

- `.ailu/chat-store.json` 与 `.ailu/chat-v2-*/`：当前 authoritative V2 对话图。
- `.ailu/conversations.json`：旧版迁移输入；新安装不一定生成，不能作为当前对话是否保存成功的判断依据。
- `.ailu/commands.json`、`.ailu/mention-cache.json`、`.ailu/generated-images/`：命令、引用缓存和已导入图片。

用户主目录内：

- `~/.ailu/providers.json`：不含明文 API Key 的 Provider 元数据。
- `~/.ailu/frozen-attachments/`：发送给 Agent 前按 SHA-256 冻结的图片附件副本；目录 `0700`、文件 `0600`，相同内容复用。Ailu 不会自动删除这些副本，清理必须由用户明确发起。
- `~/.ailu/tmp/`、`~/.ailu/cache/`、`~/.ailu/logs/`：单次运行、缓存和日志目录。
- `~/.ailu/lark/authorization.json`：不含令牌的飞书授权模式、CLI 版本和时间记录；真实凭据仍由 `lark-cli` 管理。

Provider API Key 与公众号中转 Token 保存在 Obsidian SecretStorage，不写入 Vault 或上述普通 JSON 文件。如需改变全局存储位置，使用 `AILU_HOME`。多进程 writer gateway 与 Agent 进程树清理目前只承诺 macOS/POSIX；Windows 因没有等价的已验证 FileShare/LockFileEx 与 Job Object 边界，会 fail-closed 只读启动，不启动 Claude Code/Codex，也不执行对话、行内修改或设置写入。

## 公众号中转

公众号接口需要 AppSecret 和稳定的微信白名单出口 IP，因此公开版不提供共享托管中转，也不会把 AppSecret 下放到插件。用户需要自行准备一台具有固定公网 IPv4 的服务器，并把该服务器的实际出口 IP 加入微信公众号后台白名单。服务器可优先选择香港或海外地区，但应结合账号可达性、延迟、当地法规与服务商条款自行决定；域名本身不能替代固定出口 IP。

`wechat-relay` 提供两条正式路线：

[`wechat-relay`](https://github.com/mcncarl/wechat-relay) 是独立公开仓库，可匿名读取和按固定 Release 部署。它不会随 Ailu 自动安装、托管或启动；公众号上传只有在使用者自己的服务器、白名单、凭据、HTTPS 和 readiness 全部验收后才可用。

1. 固定 IPv4 VPS + 自有域名 + Caddy HTTPS。适合长期使用，Ailu 填写域名对应的 HTTPS 服务根地址，例如 `https://relay.example.com`。
2. 固定 IPv4 VPS + Tailscale Serve。无需自有域名；Ailu 填写 tailnet 内的 HTTPS MagicDNS 服务根地址，例如 `https://relay-host.example-tailnet.ts.net`。不要启用 Tailscale Funnel，也不要把 Tailscale Serve 地址填成 `localhost`。

两条路线在 Ailu 中都只填服务根地址，不在末尾加 `/v1`；Ailu 会自行拼接各个 `/wechat/...` 请求路径。

不要把 relay 的公网 HTTP、AppSecret、RELAY_TOKEN、Cloudflare/Tailscale 凭据、SQLite/WAL、日志、草稿 URL 或 `media_id` 放进仓库。完整部署步骤与威胁边界见 `wechat-relay` 自身文档。

### 离线部署、验收与回滚

部署器一次只处理一个 Vault；先完成并验收该 Vault，再处理下一个。当前 CLI 只支持使用标准 `.obsidian` 配置目录的 Vault；自定义 Obsidian 配置目录会 fail-closed，不能猜测路径。`plan` 只读核对构建证明、四个发行资产、当前启用列表、Ailu 目标目录和回滚基线：

```bash
npm ci
npm run audit:dependencies
npm run check
npm run deploy:plan -- --vault "/绝对路径/某个 Vault"
```

确认 plan 后执行：

```bash
npm run deploy:apply -- --vault "/绝对路径/某个 Vault"
```

`apply` 仅支持已验证的 macOS/POSIX gateway，要求所有 Obsidian 进程退出，并独占 Ailu 的 Vault 锁与全局 Provider 锁。构建器先后两次实哈希完整源码、依赖锁和 Node/esbuild/TypeScript 工具链，并把证明写入 `build-attestation.json`；部署器再对实际捕获的证明和产物交叉复核。它在 `.obsidian/ailu-deployment-backups/` 下用 `O_EXCL` 创建不覆盖的私有备份，备份当前 `community-plugins.json` 和已有 Ailu 发行目录，再复制并实哈希验证 `main.js`、`manifest.json`、`styles.css` 与构建证明。最后通过物理锁 helper 的原子 exchange CAS 在 `community-plugins.json` 中启用 `ailu`，保留列表中的其他插件 ID。启用列表是唯一权威提交指针；失败 sidecar、receipt 与 outcome 保留为 `0600` 证据，不自动删除。

回滚先读 plan，再 apply receipt：

```bash
npm run deploy:rollback-plan -- --receipt "/绝对路径/deploy-receipt.json"
npm run deploy:rollback-apply -- --receipt "/绝对路径/deploy-receipt.json"
```

如果进程恰好在启用指针已成功、outcome 证据尚未落盘的窗口崩溃，普通 plan 会 fail-closed。先在 Obsidian 完全退出时用同一 receipt 做只读恢复计划，再在全部 writer lock 下核对精确启用列表和四个产物哈希并补齐终态证据：

```bash
npm run deploy:recover-plan -- --receipt "/绝对路径/deploy-receipt.json"
npm run deploy:recover-apply -- --receipt "/绝对路径/deploy-receipt.json"
```

回滚不会删除 `plugins/ailu/` 或 `.ailu/`。只有 Ailu Vault、Home、Provider、插件设置与部署基线完全未变化时，才会恢复部署前的启用列表；只要部署后产生新数据或设置变化，回滚就会 fail-closed，需先核对并执行 forward repair。

## 开发与验证

```bash
npm ci
npm run audit:dependencies
npm run check
```

Obsidian 插件资产为 `main.js`、`manifest.json` 和 `styles.css`，并附 `build-attestation.json`。每个 GitHub Release 还同时提供根 `LICENSE`、`THIRD_PARTY_NOTICES.md` 与 `LICENSES/*.txt`；完整法律文本也会作为保留注释嵌入 `main.js`，因此通过 Obsidian 安装插件时不会丢失许可证与第三方声明。

提交普通问题前请先使用设置页的“复制脱敏诊断”。不要上传原始 `~/.ailu/logs/`、X 诊断目录、最终截图、Cookie 文件、草稿 URL、Vault 路径或任何 SecretStorage 内容。安全问题不要提交 issue，请按 [SECURITY.md](SECURITY.md) 私下报告；数据流与默认边界见 [PRIVACY.md](PRIVACY.md) 和 [THREAT_MODEL.md](THREAT_MODEL.md)。

## 相关公开仓库

| 仓库 | 与 Ailu 的关系 | 许可证边界 |
| --- | --- | --- |
| [`mcncarl/ailu`](https://github.com/mcncarl/ailu) | Ailu 核心源码与 Release | AGPL-3.0-or-later |
| [`mcncarl/wechat-relay`](https://github.com/mcncarl/wechat-relay) | 用户自建的公众号草稿中转服务 | AGPL-3.0-or-later，独立部署 |
| [`mcncarl/yichen-skills`](https://github.com/mcncarl/yichen-skills) | 提供固定版本 X Article uploader Skill | 独立个人学习与非商业许可；商用须书面授权 |
| [`mcncarl/agent-memory-vault`](https://github.com/mcncarl/agent-memory-vault) | 可选 Agent Memory Runtime v2 模板与安装来源 | 独立 MIT 许可证 |
| [`freestylefly/wesight-obsidian`](https://github.com/freestylefly/wesight-obsidian) | Ailu 的 WeSight 0.4.0 上游来源 | AGPL-3.0-or-later；详见第三方声明 |

这些仓库相互独立：公开、安装或授权其中一个，不会自动改变其他仓库的许可证、凭据或运行权限。

## 许可证与商业使用

> 商业使用：允许，但必须遵守 AGPL-3.0-or-later。
>
> 商业部署、定制、培训与技术支持：可联系[维护者](https://github.com/mcncarl)。

Ailu 使用 [GNU AGPL-3.0-or-later](LICENSE)，无需另行购买 Ailu 核心的商业使用许可。收费服务不会替代或限制 AGPL 已授予的软件权利。

Copyright (C) 2026 Ailu contributors and WeSight contributors。Ailu 是从 WeSight 0.4.0 修改而来的衍生作品；来源、修改声明、第三方组件版权和许可证见 [Third-Party Notices](THIRD_PARTY_NOTICES.md)，相关许可证文本位于 [`LICENSES/`](LICENSES/) 目录。独立安装的 X uploader Skill 不属于 Ailu AGPL 核心，其商业使用须按该 Skill 自带的 `LICENSE` 取得书面授权。
