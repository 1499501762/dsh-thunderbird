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
| `translate` | 「AI 翻译」/ 划词菜单「翻译」 | **只翻这封邮件自己的正文**（见下），保留称呼、分段、署名 |
| `rewrite` | 划词菜单「改写」/ 撰写区选中文字右键「AI 改写这段」 | 弹输入框收改写要求（更简洁 / 更正式…） |
| `reply` | 「AI 回复草稿」 | 产出「主题：…」+ 正文，可一键「填入回复」 |
| `draft` | 撰写区「AI 代写」 | 收一句要求（如"催一下上个月的发票，语气客气"）→ 产出主题+正文 |
| `classify` | 阅读栏「AI 分类建议」 | 输出分类 + 置信度 + 建议动作 + 理由 |
| `ask` | 划词菜单「问 AI」/「提问已选」/ 撰写区右键「AI 提问这段」 | 带上下文提问，不重复原文 |

**阅读栏没有「AI 改写」**：改写一封你正在*读*的邮件，只会产出一段无处可去的文本。
改写属于有正文可改的地方 —— 撰写区，走选中文字的右键菜单。

划词：在正文里选中文字 → 浮出「问 AI / 总结 / 翻译 / 改写」。
多选：列表勾选若干封 → 顶栏「总结已选 / 提问已选」（最多一次 8 封）。
代写产出后点「填入回复」进撰写区（若你已填过收件人，不会被覆盖）。

### 翻译只翻这封邮件的正文

一封回复里塞了三样东西：这个人写的话、他的签名、以及之前整条邮件链。
「翻译这封邮件」指的是第一样 —— 翻另外两样会把读者真正想看的那几句话淹掉，
而且那根本不是这个人写的。

切分是**文本启发式**（`topMailText()`），不是解析器：每个客户端标记引用段的方式都不同，
唯一的共同点是那几行开场。引用段的标记（`发件人：` / `From:` / `-----原始邮件-----` /
`在…写道：` / 行首 `>`）和签名的标记（`-- `、`Best regards`、`此致`、`祝好`…）
取**较早**的那个位置切掉。

两条刻意的设计：

- **短正文不是失败**。真实邮件经常只有一句「补发票合同」；第一版加了「切完太短就退回全文」
  的保护，结果把这类邮件整条链都送去翻译了。现在只有在**切完什么都不剩**时才退回全文。
- 标题写明「AI 翻译 · 仅这封正文」，因为"为什么只翻了一部分"应该在用户开口问之前就回答。

实测 10 封真实邮件，全部切出通信对方自己写的那段话（17274 字符 → 36 字符这类）。

### AI 输出的渲染

每个提示词都要求模型用 Markdown 回答（"先给一句话结论，再列最多 5 条要点"），
所以回来的是 `## 一句话结论` 和 `- 要点`。原来的 `renderRich` 只认 `**粗体**`，
这些标记是**字面显示**的，能看只是因为那个面板恰好是 `pre-wrap`。
`renderAiMarkdown()` 现在渲染标题、有序/无序列表、引用、代码块、分隔线和链接。

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

记录是持久的（`${DSH_HOME:-~/.dsh}/dsh-thunderbird/mail-sessions.json`；DSH Desktop 把
`DSH_HOME` 设为 `%APPDATA%\dsh-desktop\harness`，所以实际落在
`%APPDATA%\dsh-desktop\harness\dsh-thunderbird\mail\`），面板重启、DSH 重启都不丢；
「解除」只删绑定，目录和会话都留着。

面板里能做的：打开会话 / 右侧打开 / 重同步（把新邮件重新导出）/ 看 `thread.md` /
看 `ai-log.md` / 解除。

### 面板可以直接驱动这个会话

DSH 的会话是可以从插件里跑起来的 —— 我一开始看 Inspect 的 `sessions` 目录，只看到
`open / scope / binding / search / fork`，就下了「不支持」的结论，**那是错的**。
`ctx.sessions.binding(id)` 返回的绑定对象上挂着真正的会话实例：

```
binding = { sessionId, session, eventSource, ctx }
binding.session.prompt(content, mode)   // DSH 自己的输入框调的就是这个
binding.session.getSnapshot()           // running / promptError / lastAgentError
binding.session.cancel()
```

所以面板里的对话不是自建聊天框：

- **发**：面板 → client 半区（postMessage）→ `binding(id).session.prompt([{type:'text',text}], 'queue')`，
  于是这一轮跑在**那条邮件线真正的 DSH 会话里**，用的是 DSH 的 agent 和它的全部工具；
- **收**：host 半区用 `ctx.sessions.get(id).snapshotEvents()` 把会话日志读回来
  （只取 `user/message` / `assistant/message` / `tool/call` 的叶子字段），
  经 `/api/thunderbird/session/transcript` 给面板渲染 —— 和 DSH 显示的是同一份记录，
  不存在第二份历史；
- 第一条 prompt 会自动带上「工作目录是这封邮件」的说明，之后的追问不用重复。

会话行下面就是输入框：回车把问题送进会话，运行中会轮询并显示「模型正在回复…」，
可以「停止」。

## 邮件记忆库（接灵枢，四期）

顶栏「记忆库」按钮。选邮件文件夹 → 导出成 Markdown → 交给**灵枢**
（`@furongjun1999/dsh-memory`）变成可检索的知识。**导出本身不调用模型。**

### 为什么不是自己建一套知识库

因为环境里已经有灵枢，而且它的四个机制**全都空着没用过**（实测 0.4.8）：

| 指标 | 实测值 | 含义 |
|---|---|---|
| `knowledge` 层 | **不存在** | 知识层是空的 |
| `ccg_complete` | **0 / 58** | 现有节点全是没验证基底的对话流水 |
| `_link.jsonl`（溯源边） | **不存在**，`edges: 0` | 派生关系从未用过 |
| `review_pending` / `review_records` | **0 / 0** | 海马体审核队列从未用过 |
| `ingest` 水位 | `sessions: 0, events: 0` | 增量摄取从未跑过 |

现有 58 个节点全是 `contextual` 层的**用户消息原文**（`condition_space` 是个 1 小时时间窗）。
所以邮件不是"再建一套"，而是**把灵枢空着的知识层建起来**。

### 关键约束：它只注册工具，不发布服务

灵枢 `inject = ['tools']` —— 它把 `cg`/`stg`/`mdcg_*` 注册成 **agent 工具**，
**没有 Cordis 服务面**。所以本插件**调不到它**。唯一正路：

> 插件准备文件 → **一条 DSH 会话**用灵枢自己的工具把它们交进去。

⚠️ **绝对不要直接往 `<插件>/data/mdcg/` 写 md**。那是记忆库本体，直接写会绕过
**主动遗忘闸门、签名去重、审核队列、三级冲突检测、密级与加密、水位台账** ——
写进去的节点会缺 `id`/`consistency`，不进 `_audit.jsonl`，变成灵枢不认识的文件。
**它是 md 不代表它是可以随便写的 md。**

### 开工前实测的三件事（都验过，结论都是好的）

用 3 个探针 md 对**记忆根目录之外**的目录跑 `index_doc`：

1. **能索引外部目录** —— 3/3 文件成功、0 错误，`doc_ref` 里记的是**绝对 root**。
   ⇒ 所以导出目录必须**稳定**，不能用临时目录。（探针节点事后没能删掉，见「已知限制」。）
2. **没有前缀签名去重问题** —— 3 个文件进、3 个节点出，**包含那个开头故意写得和另一篇一样的**。
   `index_doc` 用的是文档派生的 `node_id`，不是 `write` 用的「内容前 50 字」签名。
   ⇒ **同主题、开头雷同的邮件不会被吞**（这是我事先标出来的最大风险）。
3. **密级与验证基底都对** —— `sensitivity: private` 被采纳；节点标了
   `verification_basis: data`。对比：`contextual` 层 58 个节点里**有验证基底的是 0 个**。

另外：**一个顶级标题 = 一个知识节点**，`##` 子标题变成那条节点的「子节」。
所以**一封邮件一个文件、文件里只有一个 `#`**，才是一封邮件一条节点。
`index_doc` 只存**标题+摘要**（level≤3），正文留在源文件，用 `doc_ref` + `op=ref` 回读。

### 四期分别是什么

| 期 | 做什么 | 走灵枢哪个门 |
|---|---|---|
| **P1** | 选文件夹 → 一封一个 md（`# 主题` + `## 邮件信息` + `## 正文`）+ `INDEX.md` + `state.json` | `index_doc` → `knowledge` 层 |
| **P2** | 蒸馏 `notes/<主题>.md`（实体/承诺/待办/未决），每条事实进**审核队列** | `mdcg_propose`（**不是** `write`） |
| **P3** | 每条提案带 `derived_from` = 来源邮件节点 id | 填 `_link.jsonl` |
| **P4** | `ingest(action=dir, incremental=true)` | 水位台账，新邮件不重跑 |

**P2 的预算上限写在 prompt 里（最多 20 封）** —— 底下没有任何成本控制，
而"每封邮件一次模型调用"正是这个功能悄悄变贵的方式。

P2/P3/P4 都是**开一条会话、把确切的调用写进 prompt**：
这不是偷懒，是上面那个约束的结果 —— 工具只有 agent 有。

### 导出目录

默认 `~/.dsh/dsh-thunderbird/mail-kb/`：

```
mail-kb/
├─ INDEX.md                     # 目录索引（也给 index_doc 吃）
├─ state.json                   # 上次导出时间、每个文件夹几封
├─ notes/                       # P2 蒸馏产物
└─ account1__收件箱/
   └─ 2026-09-16-Re-Thunderbird-bridge-design-906.md
```

文件名里的 message id 是故意的：同一天同一主题的两封邮件必须落到两个文件。

## 设置（顶栏「设置」）

这些以前是**散在代码里的字面量**（有的在宿主 `.mjs` 里，有的在 `ui.html` 的 prompt
字符串里），改任何一个都得改代码 + 重启 DSH。现在存到宿主侧
`~/.dsh/dsh-thunderbird/settings.json`。

**默认值就是原来那些字面量**，所以不动设置 = 行为完全不变（有断言守着这一点）。

| 项 | 默认 | 说明 |
|---|---|---|
| 导出根目录 | `~/.dsh/dsh-thunderbird/mail-kb` | 灵枢把**绝对路径**记进 `doc_ref.root`，所以**要稳定** |
| 每次最多取 | 50 | 每个文件夹每次导出多少封 |
| 蒸馏预算上限 | 20 | **唯一挡住模型账单的东西** → 必须可配 |
| 密级 | `private` | 灵枢按这个写节点（`private`/`secret` 落盘**加密**） |
| 导出后自动索引 | 关 | 开了会在没人点的情况下发一次模型调用 |
| 进度轮询间隔 | 1200ms | |

**「选择…」用 DSH 自己的目录选择器**（`uiWorkspace.pickDirectory()`，由 client 半区经
`ui/pick-directory` 转发）—— 让人手打一个 Windows 绝对路径不合理，而这个选择器本来就有。

**设置 ≠ 插件的 Cordis 配置。** 后者是部署时的接线（`uiPath`、`imageRoots`），只读；
这里是你运行时能改的偏好。

三个坑（都是实测踩到再修的，测试守着）：
1. **非法值必须回落到「当前值」，不是「默认值」** —— 否则发一个 `sensitivity:"nonsense"`
   会把已经调好的 `internal` 悄悄打回 `private`。
2. **部分更新必须合并** —— 面板一次只保存一栏，替换会静默清掉这一栏没带的字段。
   `reset` 则相反，**不能**合并 —— 第一版就是合并了，于是"恢复默认"变成什么都不做还报成功。
3. **空输入框不是值** —— `Number('')` 是 `0` 而 `Number.isFinite(0)` 为真，
   于是清空「每次最多取」会被夹成 **1** 存进去。空值现在直接跳过不提交。
   同理：设置接口读不到时**三个按钮全部禁用**，而不是让用户对着空表单按保存。

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

## 进 DSH 右侧栏（而不是只当一个中央列）

面板有两种呈现方式，`panel-client.js` 都做了：

1. **中央列 iframe**：把 `/api/thunderbird/ui` 塞进一个普通工作区标签。
2. **DSH 原生右侧栏标签**：这是默认想走的路。DSH 的右侧栏由 `dsh-better-sidebar`
   服务管理，它把注册表暴露成 `ctx.betterSidebar`：

   ```
   sidebar.registerTab({ id, title, description, order, single, component })
   sidebar.openTab({ type, url, title })
   sidebar.isTabEnabled(type)
   ```

   client 半区用它注册一个自己的 tab 类型 **`dsh-thunderbird:ai`**，
   再用 `require('react')` 的 `createElement` 传一个 iframe 组件（client 半区是普通
   DOM/JS，不能写 JSX）。

⚠️ **两个必须知道的坑**：

- **`openTab` 对未知或未启用的 tab 类型是静默失败的** —— 不抛错、不返回错误，
  只是什么都不发生。所以注册之后一定要用 `isTabEnabled(type)` 确认一次，
  否则你会对着一个"成功"的调用排查半天。
- **内置的 `browser` tab 类型不能用**：它的 iframe 沙箱没有 `allow-same-origin`，
  页面是 opaque origin，读不到父页面的 `--dsw-*` 主题变量，也拿不到
  `navigator.windowControlsOverlay`。必须注册自己的插件名下的 tab 类型。

注册之后，`/api/thunderbird/ui?view=ai` 会以"AI 块本身即页面"的模式渲染
（`html.ai-view` 去掉所有悬浮窗外框）。

### 这个插件往右侧栏放两个标签

| 标签类型 | 页面 | 内容 |
| --- | --- | --- |
| `dsh-thunderbird:ai` | `?view=ai` | 最近一次 AI 动作的完整结果（正文栏只留一行提示条） |
| `dsh-thunderbird:session` | `?view=session&key=…&session=…` | **一条邮件线的 DSH 会话** |

### 在 DSH 里删掉会话 → 邮件线自动解绑

删除会话以前只发生在 DSH 那一侧，邮件线还指着那个已经不存在的会话，面板照旧列着它，
往里提问每个都失败。现在 **client 半区订阅 DSH 自己的会话列表**，把消失的 id POST 给
`/api/thunderbird/session/detach`，宿主清掉 `sessionId` / `workspaceId`。

两件刻意的选择：

- **保留导出目录和 `ai-log.md`**。用户删的是**对话**，不是邮件；把文件一起删掉会销毁
  他们没要求销毁的历史。解绑只断开指向，随时可以重新挂载。
- 这条链**不经过面板**，所以面板关着也生效。回调本来想给面板发个事件，但面板比
  client 半区**深一层 frame**，往 `window` 发消息只会落到壳上；改成面板在「会话」窗口
  开着时顺带刷新列表。

### 会话输入框：直接驱动 DSH 自己的那个

`?view=session` 底部的输入框不是仿制品，**对于存在的部分它就是 DSH 的输入机器**：

```
handle = ctx.conversation.input.for(ctx.sessions.scope(sessionId))
handle.actions.setDraft(text)
handle.actions.submit()          // 等价于点原生输入框的发送
```

附件走原生那套（照抄 `dsh-client-ui-conversation` 第 16792 行起的 `addFiles`）：

```
drafts = conversation.createDrafts(sessionId, files)   // 注册文件并开始上传
handle.actions.addAttachments(drafts.map(d => d.id))   // 失败则 releaseDraftAttachments
```

**`addAttachments` 收的是附件 id，不是 File** —— 传 File 抛 `ids is not iterable`，
传 FileList 或 `[File]` 不报错但什么都不加。这是实测出来的，不是猜的。

输入框还带了它自己那部分状态：**模型**（从这条会话自己的回复记录里读，只读）、
**上下文占用估算**、**这条线的常驻指令**。

**做不到的两项，说清楚**：原生输入框的**模型切换**和**权限模式**是 client-ui 的功能，
没有对插件开放的服务面（实测 `modelSelection` / `permissionPresets` / `tokenMeter`
在插件的 ctx 上一个都不存在），所以模型是**显示**而不是可选；上下文是**按字符估算**、
不是接口返回的精确用量，标签上也这么写。

### 已保存的会话要"打开一次"才在内存里 —— 现在不用了

DSH 只在一个会话被**打开或追问**时才把它装配进内存，所以宿主那个 `sessions.get(id)`
对你重启 DSH 之后没碰过的邮件线返回 undefined，面板以前就显示
「会话当前不在内存里（在 DSH 里打开一次就会加载）」——让用户去干运行时的活。

**只读的门全都试过了，没有一个能装配它**：

| 调用 | 结果 |
| --- | --- |
| `sessions.binding(id)` | 返回对象，但**不装配**（所以"拿到值"不能当成成功） |
| `sessions.scope(id)` | 返回对象，不装配 |
| `sessions.materializeScope(id)` | 抛 `already has a bound scope`（它要的是 scope 描述，不是 session id） |
| `sessions.resolve(id)` | 返回值，不装配 |
| `sessions.sessionOf(id)` | `undefined` |
| **`sessions.open(id)`** | **装配成功** |

所以现在用 `sessions.open`：**会话标签**（`?view=session`）自己调 —— 这个框架就是为这条
会话打开的，它顺带把那条会话设成"当前"是合理的；**面板里的「会话」窗口**给一个
「加载会话」按钮，因为那个窗口**每条绑定的邮件线画一个 chat 块**，自动装配会把中央列
按行切换一次。

### 顶栏（自适应）

- 顶栏原来还有 `● Thunderbird` 和状态点 —— 那是**标题栏已经写过的同一件事**
  （标题栏就是「● Thunderbird … 已连接 Thunderbird」），同一个信息在一屏里说了两遍。
  现在顶栏只留面板自己才知道的东西：加载了哪些身份。
- 顶栏是 `nowrap`，**放不下时从尾部收进「⋯」**；搜索框**跟着输入内容变长**
  （用一个隐藏镜像量真实字宽 —— `长度 × N` 对非等宽字体是错的，中文永远不是等宽）。
- 两件必须做对才能让"收"是诚实的：**「⋯」自己有约 50px 宽**，如果在"量一次够不够"之后
  才显示它，栏会重新溢出、循环就少收一个按钮；还有**宽度过渡动画**会让搜索框追不上正在
  输入的文本，也会让测量说谎。

⚠️ **`?` 后面那串是必须的，而 `single: true` 会把它吃掉**：一个已经打开的标签在 dedupe
命中时**不会**带上新的 seed，所以给另一条邮件线点「打开 DSH 会话」会继续指向旧的那条。
开完之后必须再调一次 `sidebar.updateTab(id, { path: url, title })` 才算真的换过去。

⚠️ **右侧栏是 DSH 自己的布局状态，插件只能"请求"它展开**：`layout.openRightbar()` 会调，
但如果它是折叠的，标签就开在一个零宽的地方 —— 看起来和"按钮坏了"一模一样。
所以现在开完会**量一下我们自己那个 iframe 的宽度**并如实回话：
0 就明确告诉用户「已经开在右侧栏，但右侧栏现在是折叠的，点 DSH 右上角的侧栏按钮展开」。
（不要拿 `rightbarCol` 或 `nativeTabHost` 量：列是一个零宽 grid track、侧栏是画在里面的
绝对定位浮层，而 `nativeTabHost` 还会命中中央列的宿主 —— 量错盒子会把一次成功的打开报成失败。）

### 「打开 DSH 会话」到底打开的是什么

**不是 DSH 原生的会话组件**，因为 DSH 没有可 `require` 的会话组件，右侧栏的 kind 也只有
sidebar 插件自己注册的那几种（editor / git / subagent / sidechat / terminal / browser / diff），
没有任何一种能渲染**任意一个已存在的会话**。

所以这个标签是**我们自己画的**那条会话：走的是面板一直在用的
`/api/thunderbird/session/transcript` 和 `session/prompt`，所以底下仍然是那条真实的
DSH 会话，历史只有一份，一轮也只在一个地方跑。

改之前那个按钮调的是 `uiWorkspace.openSession()` —— 它把会话选到**中央列**，
面板里什么都不变，这正是"这个按钮没生效"的来源。

## 撰写、签名与右键菜单

### 撰写窗口

`写邮件` / `回复` 打开的是一个**固定头尾、中间滚动**的悬浮窗：收件人、抄送、主题、
工具栏和底部按钮都不随正文滚动。可选字段（抄送 / 主题）为空时收成一个 `+` 按钮，
点开才展开 —— 回复时主题已填，所以自动是展开的。

正文是 `contenteditable`，粘贴进来保留排版（`Ctrl+Shift+V` 保留原样，
`Ctrl+V` 做朴素清洗）。工具栏是 Word 形状的色卡：10 个基色 × 4 档浅色 + 标准色，
取色器只作为最后一项保留。

**发出去的是什么，编辑器里存的就是什么**：签名以原始 HTML 追加，
`file://` 图片在编辑时经 host 代理显示，发送时还原成原始 `src`。

### 签名编辑器（独立窗口）

签名编辑**不在撰写窗口里**：顶栏「签名」按钮或撰写窗的「签名」按钮打开一个独立悬浮窗。
它按账号管理签名库。

- 编辑器是真 `contenteditable`：加粗、颜色、列表、图片都保留；
- 「图」插入本地图片会转成 `data:` URL，所以签名自带图片，别的机器上也显示得出来；
- 「`</>`」切 HTML 源码视图 —— Thunderbird 的签名本来就是 HTML，没有这个入口就没法修；
- Thunderbird 自带签名是只读的，点「编辑」会开一份**副本**，不会回写账号设置。

### 右键菜单

一个元素、三套条目（`ui.html` 的 `CTX_TEXT_ITEMS` / `ctxMailItems`）：

| 上下文 | 条目 |
| --- | --- |
| 正文（撰写区 / 签名编辑器） | 剪切 · 复制 · 粘贴 · 粘贴为纯文本 · 全选 · 撤销 · 重做 · 清除格式 · 插入分割线 · 插入日期时间 |
| 邮件列表 / 阅读栏 | 回复 · 回复全部 · 转发 · 标为已读/未读 · 加星标 · 复制主题 · 复制发件人地址 · 整封邮件复制为 Markdown · 导出为 .eml · 打印 · 移动到… · 删除 |
| 阅读栏正文 | 上面两套，文字命令在前（光标就在文字里） |

**按条件出现的条目**：只有真的选中了文字才有「复制为 Markdown」；只有点在图片上才有
「图片另存为…」；只有在撰写区选中文字才有「AI 改写/翻译/提问这段」。一个常在但经常
拒绝执行的条目，比一个干脆不出现的条目更糟。

浏览器的 `execCommand('paste')` 已经被所有浏览器禁了很多年，所以"粘贴"走
`navigator.clipboard.read()`，拿不到权限时会明确提示用 `Ctrl+V`，而不是假装粘了。

「移动到…」把菜单**原地换成**文件夹列表（带缩进）而不是挂二级菜单：邮件客户端的
文件夹树很长，二级菜单经常掉到窗口外面。

### 第三层：Markdown、另存图片、对选中文字用 AI

**复制为 Markdown**（两个独立条目：选中内容 / 整封邮件）。转换器是自己写的
（`htmlToMarkdown`），不是引一个 CommonMark 库——它要处理邮件里真实出现的形状
（段落、加粗、链接、列表含嵌套、引用、表格、图片、代码块），其余一律**保文字、丢装饰**：
丢颜色比丢内容好。

两个刻意不做的事：

- **内联图片（cid）不导出 base64**。它在面板里是 `data:` URL，把它塞进剪贴板是往别人的
  笔记里灌一兆字节。有 alt 就写 `![alt](内联图片)`，没有就什么都不写。
- **`cid:` 和 Foxmail 写进 alt 的 `说明: cid:…` 会被清掉**。那是机器噪声，
  它曾经混进 Markdown，也曾经变成保存图片时的建议文件名。

**图片另存为**按你选的方案走 `showSaveFilePicker`，每次都弹目录选择器；浏览器没有这个
API 时退回 `<a download>`。字节来自 reader 已经拿到的地方（`data:` 或 host 代理），
代理挂掉退回原始地址的图会**再经代理取一次**而不是直接 fetch——直接 fetch 是一次 CORS
失败，用户只会看到"保存失败"。

**在撰写区对选中文字用 AI**：改写 / 翻译 / 提问。结果和其他 AI 动作一样进右侧栏 AI 标签，
再由你决定用不用——标签里多一个「替换选中」。

这里有个必须说清的实现点：**选区是挂在那个 ask 对象上的**（`state.ai.ask.range`），
不是存在一个单独的槽里。第一版把它存在单独槽里并在每次启动时清空，结果是
"右键 → AI 改写这段 → 在提问框里输入要求 → 提问" 这条路上选区一定会被清掉。
现在选区跟着发起它的那次 ask 走，别的启动拿不到它，也就不可能误替换。

因为选区只属于面板，右侧栏标签里的「提问」和「替换选中」都是**通过 BroadcastChannel
转发回面板**再执行的，标签自己不会跑第二次脱节的补全。

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
- **白底 bitmap 在暗色下是一块白砖**，而一把 `invert()` 会把本来就深色的 logo 也翻坏。
  现在的做法是**真的处理像素**（`whiteTile()`）：先按四边 flood fill 把近白区域填成透明，
  再算剩下内容的平均亮度 —— 只有深色内容会被 `invert(1) hue-rotate(180deg)`
  （用 canvas 的 `filter` 做，浏览器自己的实现）翻成浅色，彩色部分色相不变。
  结果直接写回 `img.src`，CSS 里不再有 filter。底栏有开关。
- **远程图片走 host 代理**（`/api/thunderbird/image?url=`）：跨域图片会让 canvas 变脏、
  永远没法采样；而且这样面板也不用去跟邮件里的追踪域名打交道。代理不可用时
  `fallbackProxiedImages()` 会把 `src` 还原成原地址，图不会因为代理挂了就不显示。
- **主题色全部来自 DSH**：`mirrorTheme()` 把 16 个 `--dsw-*` token（含 `bg-overlay`、
  `state-warn`、`specific-sidebar-fill`、`interactive-bg-hover/active`、`label-tertiary`）
  映到面板变量上。注意 **DSH 把这些 token 画在 `<body>` 上，不在 `<html>` 上** ——
  只读 `documentElement` 会全部拿到空值，面板就会一直用自己那套内置色板、跟应用背景对不上。
  现在按 `html → body → #root → [data-dsh-frame]` 依次找。
- **DSH 暗色主题的 `brand-primary` 是近白色**（`#f9fafb`），直接当强调色会让「实心主按钮」
  变成白底白字。现在按亮度推出 `--tb-accent-fg`，hover/active 也直接用 DSH 自己的
  `--dsw-alias-interactive-bg-hover/active`。
- **右上角避让：分两处，结论相反，别混为一谈。**
  - **client 半区自己的 `.dshTb-bar`（"● Thunderbird … 已连接 / ⟳"那一行）必须避让。**
    它**就在标题行上**，所以窗口按钮真的在它旁边 —— 不避让就是状态文字和刷新按钮
    压在最小化/关闭下面。这条我删过一次，理由是"所有用它的行都在标题行下面"，
    **对面板工具栏成立、对这条栏不成立**，于是回归了。
  - **面板里的 `.bar`（搜索/按钮那一行）和它的溢出弹窗不避让。** 它们的 `padding-top`
    已经把内容推到标题行下面，窗口按钮永远不在旁边，预留就是右侧一条死白。
  - **算出来必须夹紧。** 老版本在真实 GUI 里量出 **1300px** —— WCO 的
    `getTitlebarAreaRect()` 在嵌入 frame 里返回的是**整个标题栏**而不是按钮簇，而那条分支
    **没有上限** —— 结果不是"多留白"而是**把栏挤塌**。现在只认
    `--dsh-desktop-windows-caption-width` 这个**纯 px** token（`+44` 是壳给额外按钮留的），
    再退到 DOM 扫描，最后 Windows 兜底 138，**每条路径都夹到 ≤220px**，并且**完全不解析那个
    `calc()` token**（它正是 NaN 的来源）。实测：无 token → 12px；140px → **196px**；
    故意塞 1300px → **232px（夹住了）**，不再是塌掉。
  ⚠️ 仍然成立：**千万不要用"临时插一个 div 量宽度"的办法求值** —— client 半区正观察着同一棵树，
  插节点会再次触发它的挂载回调，于是又去测量 —— 自我维持的 mutation 死循环，把窗口卡死。
- **图片处理可以逐张改**：自动规则只在「内容确实很暗（深色像素 > 50%）**且**已经不贴边
  （说明是白纸上的墨迹而不是整块设计底板）」时才翻明度，其它情况只去白底、保留原色。
  点邮件里的任意图片循环 自动 → 只去白底 → 去白底+翻色 → 原样，选择按图片地址的哈希
  记在 localStorage，重渲染后仍然生效。

## 面板顶部与 DSH 桌面版标题栏

DSH Desktop 用固定定位的 `#dsh-desktop-windows-drag-region`（`top:0; height:36px;
-webkit-app-region: drag`）作为窗口拖拽区，并只在父文档里给「按钮/输入框」加 `no-drag`。
**这条规则进不到 iframe 内部**，所以面板顶部的按钮会被拖拽区吃掉、点了没反应。

`ui.html` 的做法：从父文档读 `--dsh-titlebar-safe-inset-top`（DSH 在 `:root` 上定义了 36px），
写成自己的 `--tb-inset-top`，`.app` 用它做 `padding-top`。已实测：父级 36px → 子页 `--tb-inset-top: 36px`
→ `.app` 计算 `padding-top: 36px`。非桌面版（或跨域父页面）读不到就退化成 0。

同一段逻辑还把父页面的 `--dsw-*` 主题变量镜像进来，所以面板跟随 DSH 明暗主题。

## 毛玻璃：为什么之前"没有效果"

面板里**早就有**一套 glass pass（`.bar`/`.foot`/`.folders`/`.list`/`.reader-head` 全是半透明 +
`backdrop-filter`）。它们之所以看起来还是一块**平的实心板**，原因在**面板外面**：

盖住中央列的那个浮层（`[data-dsh-thunderbird-view]`）的底色是
`var(--dsw-alias-bg-base)` —— **不透明的 `rgb(21,21,23)`**。iframe 里所有半透明层叠上去之后
透出来的全是这块纯色，于是合成的结果就是一个纯色。glass pass 那句注释其实已经预感到了
（"a translucent layer over a flat fill is just a slightly wrong solid"），只是把"底"设成了
**不透明的**渐变，于是自己把自己抵消了。

还有一层：**`backdrop-filter` 只能采到元素背后真实存在的东西**。放在 iframe 内部，
它的 backdrop 就是 iframe 自己那个透明的根 —— 没有任何东西可糊。**所以模糊必须做在浮层上**，
因为浮层在 DSH 文档里，背后才是真正的内容。

最终：浮层 `76% 不透明度 + blur(26px)`，`body`/`.app` 透明化。

**76% 这个数是量出来的，不是拍的**：64% 时浮层背后那段会话内容会透出来、面板看起来发灰发白；
88% 又几乎看不出玻璃。26px 的模糊是关键 —— 它把背后的会话内容糊到不可读，
所以低不透明度才是安全的：**玻璃靠模糊，不透明度只负责染色**。

### 大面板背后是纯色，怎么做出毛玻璃？

`backdrop-filter` **只能糊它背后真实存在的东西**。全覆盖的大面板背后什么都没有，所以
所有做成了的实现在这种情况下都是**把背景画出来**，而不是采样：

| 实现 | 做法 |
|---|---|
| Windows 11 Mica / Acrylic | 采样桌面壁纸 → 模糊 → 染色 |
| macOS Big Sur | 糊窗口背后的桌面 |
| 自带背景的面板（我们） | **合成一张"极光/mesh"**：2–3 个极大的、对比度极低的径向渐变，替代壁纸 |

所以答案是：**加一张低对比度的大渐变**。但**只有渐变还不够**，它仍然会像一块"稍微不对的纯色"。
第二味药同样重要：**噪点颗粒（grain）**。颗粒是让一块渐变读起来像**材质**而不是纯色的关键，
顺便还能消掉暗色主题下这种低对比渐变必然产生的**色带（banding）**。
实现是一张 `feTurbulence` 的 SVG data-URI，`opacity: .38`。

两者都放在 `z-index:-1`，藏在所有面板表面之下 —— 所以 `.app` 自己**不能**画底色，否则会把它们盖住。

### 层数太多 → 文字不可读：那条规则

**半透明的"外壳"，不透明的"内容"。** 层叠 alpha 会**乘向不透明**（既没有更"玻璃"，
还把文字需要的对比度吃掉了），所以载字的表面一律不透明，只有包在周围的 chrome 半透明。

这次真正让文字不可读的其实不是层数，而是一个 **token 语义 bug**（见下），
但它暴露的问题是真的：`.list` / `.reader` 现在都是不透明的 `--tb-bg`。

### `--tb-accent` 在暗色主题下是**近白色**

面板在**约 15 处**把 `--tb-accent` 当**蒙层和文字色**用：未读行、选中的文件夹、
AI 按钮、用户聊天气泡……

而它镜像自 `--dsw-alias-brand-primary` —— **在 DSH 暗色主题下这个 token 是
`rgb(249,250,251)`，近白**。因为它其实是"品牌面上的**前景色**"，不是品牌色相。
于是"未读"变成一层近白蒙层 + 近白文字 = **白字压白底，完全不可读**。

（这和之前 `.ai-badge` 白压白是同一个陷阱的第二次出现 —— 那次只修了 badge 一个点，
没有修镜像层，所以它以另一种形式回来了。）

修法在镜像层，一次修掉全部 15 处：**如果镜像来的 brand 色是"淡色"（加权亮度 > 200/255），
就不镜像它，保留本插件自己的色相。** 淡色不是强调色。

修后实测：`--tb-accent: #7aa2ff`（保留）、未读行底色
`color(srgb .478 .635 1 / .12)`（蓝色蒙层）、未读主题字色 `rgb(122,162,255)`。

## 左侧栏收起时 TB 图标下面多一格

**不是这个插件的 bug**，而且有对照实验：把我们的入口 `display:none` 之后，
那个双倍间距**依然存在**，只是上移了一格。

量出来的事实（收起态图标中心间距）：`48,48,48,48,48,48,48,96` ——
最后一个 96 是别人的。DSH 的「区域」栏里第一个子元素
`*_sectionHeader` 在收起时**标题文字被隐藏、但 36px 盒子加 12px 边距还在**
（实测 36×35、零文本、三个子元素全被 DSH 自己的收起样式隐藏）。因为我们的入口正好在它上面，
看起来就像是 TB 图标换行了。

修法：收起态下 `display:none` 掉 `*_sectionHeader`。**纯样式、不碰 DOM、只在收起态生效**；
因为收起态下区域栏的 section header 按构造就是空盒子，所以不会丢任何可见内容 ——
已用"修前修后可见图标数都是 12"验证。

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

- **发送邮件未在真实账号上验证**：代码走 `compose.beginNew(null, details)` +
  `compose.sendMessage(tabId, {mode:'sendNow'})`（TB 91+ 路径），对 mock 验证通过，
  `ping` 里 `capabilities.compose` 为 true；但我没有用你的账号真发过信。
  其余**写操作都已在真实邮箱上跑通并核对**：已读/未读、星标、`messages.move`
  （同文件夹空转返回 `{moved:1}`，确认参数与 `folderId` 格式正确）、右键菜单的
  `messages.update` 往返（加星标 → 取消星标，邮箱状态已还原）。
  为了不留下副作用，**没有对真实邮件做跨文件夹移动或删除**。
- 删除按钮走 Thunderbird 默认策略（有废纸篓就进废纸篓），不做永久删除。
- 「导出为 .eml」由面板自己按已取到的头 + 正文重新拼一封 `multipart/alternative`，
  是**重新生成**而不是服务端原始字节 —— 扩展侧目前没有暴露出 `messages.getRaw`。
  它能在任何邮件客户端里打开。
- 「复制为 Markdown」丢格式是**有意的**：颜色、字号、字体在 Markdown 里没有对应物，
  保文字比保装饰重要。红色警告、背景色高亮这类语义会丢。
- 「图片另存为」用 `showSaveFilePicker`，需要一次真实点击（合成点击不算用户手势），
  所以它在真实右键里能用；侧栏 iframe 里若被权限策略拦下会自动退回下载。
- 附件只能看列表，不能下载/预览；日历、通讯录写操作未做（`addressBooks.list` 只读）。
- HTML 正文视图做了朴素清洗（去 script/style/iframe/内联事件、拦截链接跳转），不是安全沙箱。
- 面板 HTML 每次请求现读磁盘，改完刷新即生效；路径由 `dsh-side/thunderbird-host.mjs` 里的
  `DEFAULT_UI_PATH` 推出，不用手工配。
- **改 host 半区必须重启 DSH**：它是真实的 ESM 模块，Cordis 按模块 URL 缓存，`patchReload: live`
  只监听 profile 的 patch 文件，不会重新 import 这个模块。client 半区（面板宿主）改完至少
  要刷新页面。改完 host 之前可以用 `node dev/test-host.mjs` 先验证：
  它把 host 挂到假 Cordis ctx 上，让协议替身去轮询，跑 31 条端到端断言。
  改 `ui.html` 里的内联脚本后跑 `node dev/check-panel.mjs`：它 `new Function()` 解析一遍，
  能抓住"少一个括号"和"`//` 注释吞掉下一个函数声明"这类不会被浏览器报出来的错。
- 面板页面**会被浏览器缓存**：改完 `ui.html` 后 `ego_navigate`/普通刷新可能仍拿旧版，
  验收时带一个 `?cb=<时间戳>` 强制取新。
- **`session/detach` 是宿主改动，要重启 DSH 才生效**（和 `dsh-side/thunderbird-host.mjs`
  里其它改动一样）。在那之前，删除会话只会让面板列着一个死绑定。
- **会话输入框的 `submit()` 没有被实际执行验证过**：验证它需要真的发出一个 turn，
  而那是一次对外部服务的提交，自动审批策略正确地拒绝了。它的输入端
  （`setDraft` → `draftRev` 递增）和附件端（`createDrafts` → `addAttachments` →
  `attachmentIds` 出现，再 `removeAttachment` 清干净）都实测过，
  `submit` 的实现是 `dsh-client-ui-conversation` 里
  `submit: () => this.submit('queue')`（原生发送按钮绑的就是它），但没有真跑过一次。
- **P1 的导出路由要重启 DSH 才生效**：它是宿主改动，而宿主的模块是按 URL 缓存的。
  在重启之前，面板上按「导出选中文件夹」会 404。P1 本身由 `dev/test-host.mjs`
  **新起一份宿主**验证（8 条断言：任务跑到终态、一封一个文件、**每个文件恰好一个 `#`**、
  `## 邮件信息`+`## 正文`、文件名唯一）—— 这是唯一能在不重启当前 DSH 的前提下
  测宿主改动的办法。
- ~~探针留下的 3 个 knowledge 节点还在用户记忆里~~ **已清除**。验证 `index_doc`
  通路时索引了 3 个测试 md（`doc_ref.root` 都指向 `dist\kb-probe`）。删除过程有三个坑，
  都值得记下来：
  1. **`mdcg_forget` 不是被"否决"，是被"超时"** —— 头两次调用没人在这 8 秒内确认，
     自动拒绝。超时和用户否决是两回事，别混为一谈。
  2. **`override=true` 不要顺手加**。这 3 个节点 `protect(action="check")` 返回
     `protected: false, immutable: false` —— 本来就不受保护，`override` 纯属多余，
     而且它会被安全分类器读成"故意绕过权限检查"，**把一个普通删除变成了可疑操作**。
     受保护条件只有三种：self/anchor 层、`protected` 标记、`importance≥0.7`。
  3. 分类器的授权窗口只看**最近几条消息**：用户说了"放行"，但中间隔了几次工具调用之后
     那句话就滑出窗口，此时参数里写"用户已批准"是不可信的（那是我自己说的）。**重新问
     一次就过了**，不要换措辞去绕。
  删除结果（已独立验证）：`tombstones: 3`、`ccg_by_layer` 里 **`knowledge` 层整个消失**、
  `sensitivity_counts` 里 `private: 3` 消失、用原来能命中它的查询重跑
  `scanned` 65→62 且**检索不到**。墓碑 id：`e855bff595058759` /
  `98e858c5528c3adf` / `a88f94ea1500a61b` —— `forget` 是**软删除**（tombstone → `trash/`），
  需要的话 `mdcg_restore` 能撤销。
- **P2/P3/P4 只验证到「调用写法正确」**：`mdcg_propose`/`derived_from`/`ingest` 的
  参数取自 `cg(op="help", query=…)` 的实测文档，但**没有真的跑过一个完整蒸馏批次** ——
  那要花真模型调用，而且会在审核队列里留条目。要跑就在面板上按「蒸馏成记忆」。

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
│  ├─ test-host.mjs            把 host 半区挂到假 Cordis ctx 上跑 31 条端到端断言
│  ├─ check-panel.mjs          解析 ui.html 里的内联脚本，抓语法错
│  ├─ probe-manifest.py        往 AddonManager 灌最小 manifest，定位 -3 的成因
│  ├─ probe-inline-images.mjs  探测邮件内联图片在各客户端的还原情况
│  ├─ marionette-eval.py       在真实 Thunderbird 里跑 JS（chrome / system 沙箱）
│  ├─ mock-thunderbird.js      无 Thunderbird 时的协议替身
│  ├─ addon-state.js           打印扩展的加载状态（供 PowerShell 调用）
│  └─ inspect-addons.js        查插件在配置目录里的加载状态
├─ docs/                       面板实拍截图（含真实邮件，已 gitignore）
├─ install-addon.ps1           调 dev/install-extension.py
├─ persistent-install.ps1      把本目录接成 DSH 的常驻插件
├─ cordis.patch.yml            DSH bundle patch
├─ package.json                DSH 插件包清单
├─ LICENSE                     AGPL-3.0
└─ README.md
```
