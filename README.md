# DSH × Thunderbird

把 Thunderbird 接进 DSH 侧边栏，并在这之上加 AI 邮件辅助。两部分：

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| **Thunderbird 插件**（MailExtension） | `thunderbird-addon/` | 把 Thunderbird 的邮件/文件夹/发送 API 暴露出去 |
| **DSH 插件**（Cordis，host-only） | `dsh-side/thunderbird-host.mjs` | 桥端点 + 面板 HTML + AI 动作 |

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

### 1. DSH 侧

插件以**动态 Cordis Plugin** 形式运行，host-only，**无需授权**：

```
pluginId: tbmail-1   （桥 + 面板 + AI）
```

面板不在侧边栏注册自定义标签，而是直接开一个页签指向 `/api/thunderbird/ui`
（用 DSH 自带的 sidebar 浏览器打开即可，`sidebar_open` 工具也能开）。

⚠️ **动态插件是会话级的**：DSH 会话重置后它会消失（进程本身不重启也会）。
恢复方式：重新定义并运行同一个 Package（源码在 `dsh-side/thunderbird-host.mjs`）。

⚠️ **不要手写 `profiles/web/cordis.patch.yml` 来"持久化"**：我试过加一条 `insert`
行指向本地模块，结果把 DSH 启动打挂了（`DeepSeek request extension preparation failed`）。
已回滚，备份在 `cordis.patch.yml.bak-before-thunderbird`。要真正常驻，应当走 DSH
自己的插件打包/装载流程，而不是往 composition 里塞行。

### 2. Thunderbird 侧

```powershell
powershell -File .\install-addon.ps1                 # 自动定位正在使用的配置
powershell -File .\install-addon.ps1 -ProfilePath X   # 指定配置
powershell -File .\install-addon.ps1 -Uninstall
```

脚本会：定位配置目录（按 `installs.ini` 找**实际在用**的那个）→ 拷进
`<profile>/extensions/dsh-thunderbird-bridge@dsh.local/` → 往 `user.js` 写两条偏好：

```
user_pref("xpinstall.signatures.required", false);   // 允许未签名扩展
user_pref("extensions.autoDisableScopes", 0);        // 不要自动禁用侧载扩展
```

**必须完全退出并重启 Thunderbird** 才会加载；装好后 `curl http://127.0.0.1:43129/api/thunderbird/status`
应显示 `"online": true, "client": "thunderbird"`。

不想改偏好也可以零改动试用：设置 → 附加组件 → 调试附加组件 → 临时载入
`thunderbird-addon/manifest.json`（重启后失效）。

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

插件侧方法（`background.js` 的 `methods` 表）：`ping`、`accounts.list`、`folders.tree`、
`folders.list`、`messages.list`、`messages.get`、`messages.body`、`messages.search`、
`messages.update`、`messages.delete`、`messages.move`、`messages.send`、`mail.open`、
`tags.list`、`addressBooks.list`。

## 真实 Thunderbird 上踩到的坑（都已处理）

- **`MessageId` 是整数**，不是字符串。早期用 `String()` 包装导致
  `messages.getFull/update/delete/move` 全部报 `Incorrect argument types`。
  现在 `toMessageId()` 只在纯数字字符串时转数字，其余原样透传。
- **`MessageId` 每次重启都会重排**（官方文档明说）。面板每次都重新列表，不跨重启缓存 id；
  手工用旧 id 调试会打到完全不同的邮件上。
- **正文要用 `listInlineTextParts`**（TB 128+），`getFull({decodeContent:true})` 只作兜底。
- **大邮件要手动载入**：正文解码需要先把整封邮件从服务器拉下来，几百 KB 的邮件可能耗时数十秒
  甚至失败（Thunderbird 侧报 `Error reading message N`）。面板对 > 150 KB 的邮件改为
  「载入正文」按钮，插件侧对 > 8 MB 直接跳过。
- **命令并发下发**：早期串行执行，一封大邮件会把后面的状态查询全堵住。现在并发派发，最多 6 条在飞。
- **附件与转发邮件**：有些邮件（`message/rfc822` 套 PDF）本来就没有正文。面板会列出附件，
  并提供「在 Thunderbird 中打开」（`messageDisplay.open`）作为出口。
- **列表排序**：请求 `sortType:'date', sortOrder:'descending'`（TB 148+），并在客户端再兜底排一次。

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

## 打包 Thunderbird 插件（.xpi）

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  "$PWD\thunderbird-addon", "$PWD\dist\dsh-thunderbird-bridge-1.0.0.xpi",
  [System.IO.Compression.CompressionLevel]::Optimal, $false)
```

`Compress-Archive` 只接受 `.zip`，所以这里用 `ZipFile` API（`$false` = 目录内容放在压缩包根，不套一层）。

安装（**正式扩展**，重启后仍在）：

- **图形界面**：设置 → 附加组件和主题 → 齿轮 → 从文件安装附加组件 → 选那个 `.xpi`
- **免界面**：把 `.xpi` 放到 `<配置目录>\extensions\dsh-thunderbird-bridge@dsh.local.xpi` 然后重启
  Thunderbird（侧载；需要 `user.js` 里的 `xpinstall.signatures.required=false`）

未签名扩展的两种加载方式对比：

| 方式 | 重启后 |
| --- | --- |
| 临时载入（调试附加组件） | **消失**，每次重启都要重新载入 |
| 从文件安装 / 侧载 `.xpi` | 保留，出现在「扩展」列表里 |

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
│  ├─ mock-thunderbird.js      无 Thunderbird 时的协议替身
│  └─ inspect-addons.js        查插件在配置目录里的加载状态
├─ docs/                       面板实拍截图（含真实邮件，已 gitignore）
├─ install-addon.ps1           把 .xpi 装进配置目录
├─ persistent-install.ps1      把本目录接成 DSH 的常驻插件
├─ cordis.patch.yml            DSH bundle patch
├─ package.json                DSH 插件包清单
├─ LICENSE                     AGPL-3.0
└─ README.md
```
