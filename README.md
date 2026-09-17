# DSH × Thunderbird

把 Thunderbird 接进 DSH 侧边栏，并在这之上加 AI 邮件辅助。两部分：

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| **Thunderbird 插件**（MailExtension，MV2） | `thunderbird-addon/` | 把 Thunderbird 的邮件/文件夹/发送 API 暴露出去 |
| **DSH 插件**（Cordis host + client 两半） | `dsh-side/thunderbird-host.mjs`、`panel-client.js` | 桥端点 + 侧边栏入口 + 面板宿主 + AI 动作 |
| **面板 UI** | `dsh-side/ui.html` | 单文件，无依赖，三栏可拖拽 |

已在真实环境跑通：Thunderbird（IMAP 三账号）↔ DSH 侧边栏面板 ↔ `deepseek-flash`。

## 架构

```
┌─ Thunderbird ────────────────────────────┐
│  MailExtension (background.js)           │
│    长轮询 /api/thunderbird/poll           │
│    执行 browser.messages / compose …      │
└──────────────┬───────────────────────────┘
               │ fetch (本机回环 HTTP)
┌──────────────▼───────────────────────────┐
│  DSH host（Cordis 插件 dsh-thunderbird）   │
│   /api/thunderbird/poll    长轮询挂起、下发命令 │
│   /api/thunderbird/result  收执行结果        │
│   /api/thunderbird/event   收新邮件等事件     │
│   /api/thunderbird/events  读事件（面板用）   │
│   /api/thunderbird/rpc     一次性调用（调试） │
│   /api/thunderbird/status  连接状态          │
│   /api/thunderbird/ui      面板 HTML        │
│   /api/thunderbird/ai      AI 动作（走 ctx.llm）│
└──────────────┬───────────────────────────┘
               │ iframe（同源，或直接开在侧边栏）
┌──────────────▼───────────────────────────┐
│  DSH 浏览器端                             │
│  侧边栏浏览器标签 → /api/thunderbird/ui    │
└──────────────────────────────────────────┘
```

方向是刻意选的：**DSH 当服务端，Thunderbird 当客户端**。原因是实测出来的硬约束（见下），
只有这个方向不需要 DSH 侧具备 HTTP 客户端或原始 socket 能力。

## AI 辅助

面板里每个入口都打到 `/api/thunderbird/ai`，由**DSH 自己的 `ctx.llm` 服务**执行——
没有任何自建模型调用，用的是你配置的默认模型（当前 `deepseek-official/deepseek-flash`）。

| 动作 | 入口 | 说明 |
| --- | --- | --- |
| `summarize` | 阅读栏「AI 总结」/ 勾选多封「总结已选」 | 三段式：一句话结论 / 关键要点 / 待办与截止 |
| `translate` | 「AI 翻译」/ 划词菜单「翻译」 | 保留称呼、分段、署名 |
| `rewrite` | 「AI 改写」/ 划词菜单「改写」 | 弹输入框收改写要求（更简洁 / 更正式…） |
| `reply` | 「AI 回复草稿」 | 产出「主题：…」+ 正文，可一键「填入回复」 |
| `draft` | 撰写区「AI 代写」 | 收一句要求（如"催一下上个月的发票，语气客气"）→ 产出主题+正文 |
| `classify` | 阅读栏「AI 分类建议」 | 输出分类 + 置信度 + 建议动作 + 理由 |
| `ask` | 划词菜单「问 AI」/「提问已选」 | 带上下文提问，不重复原文 |

划词：在正文里选中文字 → 浮出「问 AI / 总结 / 翻译 / 改写」。
多选：列表勾选若干封 → 顶栏「总结已选 / 提问已选」（最多一次 8 封）。
代写产出后点「填入回复」进撰写区（若你已填过收件人，不会被覆盖）。

## 邮件会话（把一条邮件线挂成 DSH 工作区）

面板里的 AI 是一次性的：回答完就散在界面里。**邮件会话**把「一个聚合后的主题」变成
DSH 里一个真实的工作区 + 会话，于是对话、上下文和产出都留得住。

对一条邮件线点「建 DSH 会话」，发生这些事：

1. host 半区把这条线导出成一个目录：**`thread.md`**（每封邮件的头 + 正文 + 附件清单）
   和 **`ai-log.md`**（AI 产出记录）；
2. client 半区（跑在 DSH 页面里）调 `ctx.workspaces.create({path})` 把目录注册成工作区，
   再调 `ctx.uiWorkspace.connectWorkspace(workspaceId)` 连一个会话出来；
3. 拿到的 `workspaceId` / `sessionId` 写回绑定记录，之后「打开会话」直接进 DSH。

关键点：**会话的工作目录就是那个邮件目录**。所以 DSH 自己的 agent 一进去就能用常规
文件工具读到这封邮件，不需要任何特权接口；面板里的每一次 AI 动作也会追加进 `ai-log.md`。

记录是持久的（`~/.dsh/dsh-thunderbird/mail-sessions.json`，`DSH_HOME` 优先），
面板重启、DSH 重启都不丢；「解除」只删绑定，目录和会话都留着。

面板里能做的：打开会话 / 右侧打开 / 重同步（把新邮件重新导出）/ 看 `thread.md` /
看 `ai-log.md` / 解除。

## 在 DSH 里直接用邮件（模型工具）

host 半区还把这套能力注册成了 DSH 的**模型工具**，所以**任何会话**（不只是邮件会话）
都能直接读写邮件，用自己的模型和自己的工具链：

| 工具 | 作用 |
| --- | --- |
| `thunderbird_folders` | 列文件夹（拿 `folderId`） |
| `thunderbird_search` | 服务端全库搜索（不受面板分页限制） |
| `thunderbird_thread` | 按主题聚合读整条线（含正文）——回答/翻译/起草前先读它 |
| `thunderbird_message` | 按 id 读单封（头 + 纯文本正文） |
| `thunderbird_flag` | 已读 / 星标 |
| `thunderbird_send` | 用你的账号真发信 |
| `thunderbird_rules` | 查看 / 运行本地分类规则 |

工具描述里明确写了 `thunderbird_send` 会真的发信，所以只有你要求时才会被调用。

## 分类规则（原生动作）

Thunderbird 的 WebExtension API **不暴露原生过滤器**（没有 `messenger.filters`），所以"匹配"
只能自己算。但引擎放在 **Thunderbird 后台页**（`thunderbird-addon/rules.js`），不是 DSH 侧：

- **新邮件到达即执行**——DSH 关着也生效，也不受 DSH 会话重置影响；
- 规则集存在 `browser.storage.local`，天然持久；
- 动作全部是原生操作：`messages.update`（已读/星标/垃圾/标签）、`messages.move`、`messages.delete`。

面板「分类规则」按钮：新建 / 编辑 / 勾选启停 / 删除，**试运行**（只列命中，不改邮件）、
**立即执行**（对当前文件夹跑一次）。也可以从一封邮件「用这封建规则」预填匹配条件，
或先「AI 分类建议」让模型给建议再据此建规则。

匹配字段：发件人含 / 主题含 / 收件人含 / 限定文件夹 / 仅未读；默认**首个命中即停**，
勾选「继续匹配后续规则」可叠加多个动作。

新增 RPC：`rules.get` / `rules.set` / `rules.run`（`dryRun:true` 为试运行）/ `rules.describe`。
新邮件触发的结果会作为 `rules/applied` 事件回传面板。

## 为什么是这个设计（实测结论）

| 能力 | 结果 | 影响 |
| --- | --- | --- |
| Host 侧 `web.fetch` 访问 localhost | **挂死**（promise 永不 settle） | 不能用它调用本机服务 |
| Host 侧 `subprocess` 双向 stdio 管道 | **可用** | 备选通道（本方案未用） |
| Host 侧 `webServer.register` 路由 | **可用** | 本方案的落点 |
| MailExtension 里开 TCP socket | 不支持（需 native messaging + 写注册表） | 排除 native host 方案 |

现成的轮子（`mareurs/thunderbird-mcp` 等 Thunderbird MCP server）走的是
`AI ──stdio──▶ Rust 二进制 ──HTTP──▶ XPCOM 特权扩展`：需要特权扩展 + Rust 构建，
且 README 明写 Windows/macOS 未测试。本方案在 Windows 上不需要这些。

## 安装

### 1. DSH 侧（常驻插件包）

这个目录本身就是 DSH 的插件包：`package.json` 里 `main` 指向 host 半边、
`dsh.bundle.patch` 指向 `cordis.patch.yml`。把它接进 `web` profile 即可：

```powershell
powershell -File .\persistent-install.ps1            # 幂等
powershell -File .\persistent-install.ps1 -Rollback  # 撤销
```

它只改两处：`profiles/web/package.json` 的 `dependencies`（`link:` 指向本目录）和
`dsh.profile.bundles`，再补一个 `node_modules` junction。**重启 DSH 生效。**

⚠️ **不要手写 `profiles/web/cordis.patch.yml` 来"持久化"**：往 composition 里塞一条
指向本地模块的 `insert` 行会把 DSH 启动打挂（`DeepSeek request extension preparation failed`）。
正确做法是让包自带 patch（`dsh.bundle.patch`），由加载器去应用。

### 2. Thunderbird 侧

```powershell
powershell -File .\install-addon.ps1                  # 自动定位正在使用的配置
powershell -File .\install-addon.ps1 -ProfilePath X   # 指定配置
```

真正的活在 `dev/install-extension.py` 里：用 Python 打出 `.xpi`，然后**通过 Marionette
把 XPI 交给 `AddonManager.getInstallForFile()`**。装完是一个正常的 profile 扩展
（`location: app-profile`、`foreignInstall: false`），重启 Thunderbird 后自动起来。

**为什么不能直接往 `<profile>\extensions\` 里丢 XPI**（这是这次最贵的一个坑）：

- 现代 Gecko **不再扫描**那个目录，文件会在下一次启动时**被删掉**；
- 看起来"装上了"（`extensions.json` 里短暂出现过条目、`active: true`），
  但后台页面根本没跑，桥一直是 offline —— 排查方向会被彻底带偏。

Thunderbird 自带 Marionette，所以可以零点击安装：

```powershell
# 关键：-remote-allow-system-access，否则 Marionette:SetContext 报 System access is required
thunderbird.exe -marionette -remote-allow-system-access
AddonManager.getInstallForFile(xpi) -> install.install()
```

未签名能装，因为 Thunderbird 的 `xpinstall.signatures.required` **默认就是 false**
（不像 Firefox release 会忽略这个偏好）。装出来的 `signedState: 0`（未签名）、
`isActive: true`。

`user.js` 里仍建议保留：

```
user_pref("extensions.autoDisableScopes", 0);   // 不要自动禁用侧载扩展
```

零改动试用（重启后失效）：设置 → 附加组件 → 调试附加组件 → 临时载入
`thunderbird-addon/manifest.json`。

### 3. 没有 Thunderbird 时验证链路

```powershell
node .\dev\mock-thunderbird.js http://127.0.0.1:43129
```

⚠️ **不要和真实插件同时开**：两者都会长轮询同一个端点，会互相抢命令。接真实 Thunderbird 前先停掉 mock。

## 协议

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| GET | `/api/thunderbird/poll?wait=25000&client=thunderbird` | 长轮询，返回 `{commands:[{id,method,params}]}` |
| POST | `/api/thunderbird/result` | `{id, ok, result?|error?}` |
| POST | `/api/thunderbird/event` | `{type, data}` 主动事件（新邮件） |
| GET | `/api/thunderbird/events?since=N` | 读事件窗口 |
| GET | `/api/thunderbird/status` | 状态诊断 |
| GET | `/api/thunderbird/rpc?method=X&params=<urlencoded json>&timeoutMs=N` | 一次性调用（调试） |
| GET | `/api/thunderbird/ui` | 面板 HTML |
| GET | `/api/thunderbird/session/list` | 邮件会话绑定记录 + 会话目录根 |
| POST | `/api/thunderbird/session/create` | 导出这条主题线为目录（`thread.md` / `ai-log.md`） |
| POST | `/api/thunderbird/session/sync` | 用最新邮件重写 `thread.md` |
| POST | `/api/thunderbird/session/attach` | 记下 client 半区拿到的 `workspaceId` / `sessionId` |
| POST | `/api/thunderbird/session/log` | 追加一条 AI 记录 |
| POST | `/api/thunderbird/session/remove` | 解除绑定（默认保留目录） |
| GET | `/api/thunderbird/session/file` | 读 `thread.md` 或 `ai-log.md` |

插件侧方法（`background.js` 的 `methods` 表）：`ping`、`accounts.list`、`folders.tree`、
`folders.list`、`messages.list`、`messages.get`、`messages.body`、`messages.search`、
`messages.update`、`messages.delete`、`messages.move`、`messages.send`、`mail.open`、
`tags.list`、`addressBooks.list`。

## 真实 Thunderbird 上踩到的坑（都已处理）

- **manifest 里出现 `browser_action` 会让整份 manifest 校验失败**，`getInstallForFile()`
  只报一个 `-3`（`ERROR_CORRUPT_FILE`），而 `nsIZipReader` 明明能列出全部条目 ——
  看起来像压缩包坏了，其实是清单不合法。Thunderbird 没有 Firefox 那条 action 工具栏，
  想要状态指示就用 `message_display_action` / `compose_action`，或者干脆不做。
  `dev/probe-manifest.py` 就是为定位这个坑写的：它拿几份最小 manifest 往
  AddonManager 里灌，一次分清是「包坏了」「MV2 不行」还是「某个 key 不认」。
- **`MessageId` 是整数**，不是字符串。早期用 `String()` 包装导致
  `messages.getFull/update/delete/move` 全部报 `Incorrect argument types`。
  现在 `toMessageId()` 只在纯数字字符串时转数字，其余原样透传。
- **`MessageId` 每次重启都会重排**（官方文档明说）。面板每次都重新列表，不跨重启缓存 id；
  手工用旧 id 调试会打到完全不同的邮件上。
- **正文要用 `listInlineTextParts`**（TB 128+），`getFull({decodeContent:true})` 只作兜底。
- **大邮件要手动载入**：正文解码需要先把整封邮件从服务器拉下来，几百 KB 的邮件可能耗时数十秒
  甚至失败（Thunderbird 侧报 `Error reading message N`）。面板对 > 1.5 MB 的邮件改为
  「载入正文」按钮，插件侧对 > 8 MB 直接跳过。
- **命令并发下发**：早期串行执行，一封大邮件会把后面的状态查询全堵住。现在并发派发，最多 6 条在飞。
- **附件与转发邮件**：有些邮件（`message/rfc822` 套 PDF）本来就没有正文。面板会列出附件，
  并提供「在 Thunderbird 中打开」（`messageDisplay.open`）作为出口。
- **列表排序**：请求 `sortType:'date', sortOrder:'descending'`（TB 148+），并在客户端再兜底排一次。
- **存储不能挡住轮询**：早期 `main()` 先 `await storage.local.get()` 再进循环，
  存储后端一旦卡住（临时载入 → profile 安装的迁移过程里出现过），桥就永远不上线而且**不报错**。
  现在先起 `loop()`，配置读取带 4 秒超时，任何失败都退化成默认值。
- **fetch 有 XHR 兜底**：后台页面优先用 `fetch`，失败自动改走 `XMLHttpRequest`
  （MailExtension 里支持最久的传输方式），当前实际走的是 `fetch`（`debug.api` 的 `diag.transport`）。
- **心跳**：后台页面启动时立刻发一个 `bridge/start` 事件，DSH 端只凭它就能区分
  「插件没起来」和「插件起来了但连不上」。
- **邮件里的图片不能继承面板的圆角/底色**。`border-radius: 6px` 曾经让 Foxmail 签名图
  变成一个圆角白块；现在 `.content.html img` 只约束尺寸。
- **白底 bitmap 在暗色下是一块白砖**：白底是画在像素里的，CSS 去不掉。面板会采样图片
  四边（`scanMailImages`），接近纯白就把这张图判成 logo/emoji 贴图，套
  `invert(1) hue-rotate(180deg)` —— 这个组合只翻转明度、保留色相，于是白底融进面板底色，
  蓝色 logo 还是蓝的。远程图片会让 canvas 变脏（跨域），直接跳过。底栏有开关。
- **主题色全部来自 DSH**：host 上不再维护一套"看起来差不多"的调色板，
  `mirrorTheme()` 把 13 个 `--dsw-*` token（含 `bg-overlay` / `state-warn` / `specific-sidebar-fill`）
  映到面板变量上，`--tb-bg-3` 由 `color-mix` 推出来。非 DSH 环境才回退到内置色板。

## 面板顶部与 DSH 桌面版标题栏

DSH Desktop 用固定定位的 `#dsh-desktop-windows-drag-region`（`top:0; height:36px;
-webkit-app-region: drag`）作为窗口拖拽区，并只在父文档里给「按钮/输入框」加 `no-drag`。
**这条规则进不到 iframe 内部**，所以面板顶部的按钮会被拖拽区吃掉、点了没反应。

`ui.html` 的做法：从父文档读 `--dsh-titlebar-safe-inset-top`（DSH 在 `:root` 上定义了 36px），
写成自己的 `--tb-inset-top`，`.app` 用它做 `padding-top`。已实测：父级 36px → 子页 `--tb-inset-top: 36px`
→ `.app` 计算 `padding-top: 36px`。非桌面版（或跨域父页面）读不到就退化成 0。

同一段逻辑还把父页面的 `--dsw-*` 主题变量镜像进来，所以面板跟随 DSH 明暗主题。

## 调试

```powershell
curl http://127.0.0.1:43129/api/thunderbird/status
curl "http://127.0.0.1:43129/api/thunderbird/rpc?method=ping"
curl "http://127.0.0.1:43129/api/thunderbird/rpc?method=accounts.list"
```

面板本体可单独打开：`http://127.0.0.1:43129/api/thunderbird/ui`

排查插件是否被 Thunderbird 加载：

```powershell
node .\dev\inspect-addons.js 'dsh-thunderbird-bridge@dsh.local' "$env:APPDATA\Thunderbird\Profiles\<配置目录名>"
```

输出 `active / userDisabled / appDisabled / signedState / installedDir`，用来区分「没加载」和「加载了但连不上」。

插件自己也会报状态，比翻 JSON 直观：

```powershell
curl "http://127.0.0.1:43129/api/thunderbird/rpc?method=debug.api"
```

`result.diag` 里是后台页面的自述：`transport`（fetch 还是 xhr）、`polls`、`storageOk`、
`lastError`、`config.baseUrl`、`bootedAt`。桥 offline 时先看这里，再看 `status`。

⚠️ 别把 `devtools.console.stdout.content` / `devtools.console.stdout.chrome` 写进 user.js 再启动
Thunderbird：没有有效 stdout 时 Thunderbird 会直接起不来（踩过，已回退）。

## 已知限制

- `main` 面板是**中央列**，侧边栏提供入口图标。DSH 右侧栏的 tab 类型由 `dsh-better-sidebar`
  自己的注册表管理，动态插件加不进去。
- **发送邮件未在真实账号上验证**：代码走 `compose.beginNew(null, details)` +
  `compose.sendMessage(tabId, {mode:'sendNow'})`（TB 91+ 路径），对 mock 验证通过，
  `ping` 里 `capabilities.compose` 为 true；但我没有用你的账号真发过信。
- 删除按钮走 Thunderbird 默认策略（有废纸篓就进废纸篓），不做永久删除。
- 附件只能看列表，不能下载/预览；日历、通讯录写操作未做（`addressBooks.list` 只读）。
- HTML 正文视图做了朴素清洗（去 script/style/iframe/内联事件、拦截链接跳转），不是安全沙箱。
- 面板 HTML 每次请求现读磁盘，改完刷新即生效；路径由 `dsh-side/thunderbird-host.mjs` 里的
  `DEFAULT_UI_PATH` 推出，不用手工配。
- **改 host 半区必须重启 DSH**：它是真实的 ESM 模块，Cordis 按模块 URL 缓存，`patchReload: live`
  只监听 profile 的 patch 文件，不会重新 import 这个模块。client 半区（面板宿主）改完至少
  要刷新页面。改完 host 之前可以用 `node dev/test-host.mjs` 先验证：
  它把 host 挂到假 Cordis ctx 上，让协议替身去轮询，跑 27 条端到端断言。

## 打包 Thunderbird 插件（.xpi）

```powershell
python .\dev\build_xpi.py
# -> dist\dsh-thunderbird-bridge-1.0.0.xpi
```

用 Python 的 `zipfile` 而不是 PowerShell 的 `Compress-Archive` /
`ZipFile::CreateFromDirectory`：后两者在 .NET Framework 上会写**反斜杠**分隔符，
而 `nsIZipReader` 按字面理解，装的时候直接 `ERROR_CORRUPT_FILE`。

三种加载方式：

| 方式 | 重启后 |
| --- | --- |
| 直接往 `<profile>\extensions\` 丢 `.xpi` | **文件被删掉**，现代 Gecko 不扫这个目录 |
| 临时载入（调试附加组件） | **消失**，每次重启都要重新载入 |
| `install-addon.ps1`（Marionette + AddonManager） | **保留**，是正常的 profile 扩展 |

## 许可

**AGPL-3.0-or-later**，全文见 `LICENSE`。

选择它的原因：这个项目通过回环 HTTP 把邮件能力暴露给别的进程，是典型的网络服务形态；
AGPL 要求分发者和**提供网络服务者**都回馈源码，能保证使用者拿到同一份自由。

`docs/` 目录下的截图取自真实邮箱（含主题、发件人、单号、窗口标题里的账号），
已在 `.gitignore` 中排除，不随仓库分发。

## 文件

```
dsh-thunderbird/
├─ thunderbird-addon/          Thunderbird MailExtension（.xpi 的源目录）
│  ├─ manifest.json            MV2，含 messagesRead/accountsRead/compose 等权限
│  ├─ background.js            协议循环 + Thunderbird API 方法表
│  ├─ rules.js                 分类规则引擎（本地存储 + 新邮件自动执行）
│  └─ options.html/.js         DSH 地址配置与连接测试
├─ dsh-side/
│  ├─ thunderbird-host.mjs     Cordis host 半边（桥 + 面板/AI 路由）
│  ├─ panel-client.js          Cordis client 半边（侧边栏图标 + 面板宿主）
│  └─ ui.html                  面板 UI（单文件，无依赖）
├─ dev/
│  ├─ build_xpi.py             用 zipfile 打 .xpi（正斜杠）
│  ├─ install-extension.py     Marionette + AddonManager 零点击安装
│  ├─ test-host.mjs            把 host 半区挂到假 Cordis ctx 上跑端到端断言
│  ├─ probe-manifest.py        往 AddonManager 灌最小 manifest，定位 -3 的成因
│  ├─ marionette-eval.py       在真实 Thunderbird 里跑 JS（chrome / system 沙箱）
│  ├─ mock-thunderbird.js      无 Thunderbird 时的协议替身
│  └─ inspect-addons.js        查插件在配置目录里的加载状态
├─ docs/                       面板实拍截图（含真实邮件，已 gitignore）
├─ install-addon.ps1           调 dev/install-extension.py
├─ persistent-install.ps1      把本目录接成 DSH 的常驻插件
├─ cordis.patch.yml            DSH bundle patch
├─ package.json                DSH 插件包清单
├─ LICENSE                     AGPL-3.0
└─ README.md
```
