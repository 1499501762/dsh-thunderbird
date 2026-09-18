/**
 * dsh-thunderbird — the DSH half of the DSH × Thunderbird bridge.
 *
 * Loaded as a local plugin package (dsh.bundle.patch -> cordis.patch.yml), so it
 * is part of the composition rather than a dynamic (process-local) Package: it
 * survives DSH restarts and needs no browser approval.
 *
 * It owns two things on DSH's own HTTP server:
 *
 *   /api/thunderbird/*        the mail bridge — a Thunderbird MailExtension
 *                             long-polls /poll, executes the command against
 *                             `browser.messages` & co., and posts /result back.
 *                             /ui serves the panel HTML shipped beside this file.
 *   /api/thunderbird/ai       mail-aware AI actions (summarize / translate /
 *                             rewrite / reply / draft / classify / ask) on top of
 *                             DSH's own `llm` service — no model calls are
 *                             hand-rolled here.
 *
 * Why the extension polls DSH instead of the other way round: a MailExtension
 * cannot open a socket without a privileged (XPCOM) extension plus a native
 * messaging host, and DSH's dynamic host realm has no HTTP client. Making DSH
 * the server needs neither.
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises'

export const name = 'dsh-thunderbird'

// webServer and fs are HARD dependencies. This row is inserted by a patch layer,
// so it can mount before the web app's own service rows settle; reading them
// with ctx.get() at apply time then returned undefined and the bridge silently
// never mounted — the harness log showed "webServer service is unavailable" on
// every boot. Declaring inject makes Cordis wait for the service and re-apply.
export const inject = ['timer', 'webServer']

// Resolved from this module's own location so the package stays relocatable;
// config.uiPath still wins when a deployment wants the file somewhere else.
const DEFAULT_UI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ui.html')
const MAX_WAIT = 25000
const ONLINE_WINDOW = 60000

export function apply(ctx, config) {
  const settings = config || {}
  const uiPath = typeof settings.uiPath === 'string' && settings.uiPath ? settings.uiPath : DEFAULT_UI_PATH

  const webServer = ctx.webServer
  const llm = ctx.get('llm')
  const defaults = ctx.get('agentDefaultModel')

  let nextId = 1
  const state = {
    client: '',
    lastSeen: 0,
    queue: [],
    pending: new Map(),
    waiters: [],
    events: [],
    eventSeq: 0,
    handled: 0,
  }

  const jsonHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  }

  const isOnline = () => state.lastSeen > 0 && Date.now() - state.lastSeen < ONLINE_WINDOW

  const sendJson = (res, status, value) => {
    if (res.writableEnded) return
    res.writeHead(status, jsonHeaders)
    res.end(JSON.stringify(value))
  }

  const sendText = (res, status, text, type) => {
    if (res.writableEnded) return
    res.writeHead(status, { 'content-type': type || 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }

  const preflight = (req, res) => {
    if (req.method !== 'OPTIONS') return false
    res.writeHead(204, jsonHeaders)
    res.end()
    return true
  }

  const readJson = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { if (raw.length < 8000000) raw += String(chunk) })
    req.on('end', () => {
      if (!raw) { resolve(null); return }
      try { resolve(JSON.parse(raw)) } catch (error) { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })

  const param = (url, key) => {
    const text = String(url || '')
    const at = text.indexOf('?')
    if (at < 0) return null
    const pairs = text.slice(at + 1).split('&')
    for (let i = 0; i < pairs.length; i++) {
      const eq = pairs[i].indexOf('=')
      const name = eq < 0 ? pairs[i] : pairs[i].slice(0, eq)
      if (name === key) return eq < 0 ? '' : pairs[i].slice(eq + 1)
    }
    return null
  }

  const err = (error) => String((error && error.message) || error)

  const flushWaiters = () => {
    while (state.waiters.length > 0 && state.queue.length > 0) {
      const waiter = state.waiters.shift()
      waiter()
    }
  }

  // ---- mail bridge ---------------------------------------------------------

  const pollHandler = (req, res) => {
    if (preflight(req, res)) return
    state.lastSeen = Date.now()
    state.client = param(req.url, 'client') || state.client || 'thunderbird'
    const rawWait = Number(param(req.url, 'wait'))
    const waitMs = Math.min(Math.max(Number.isFinite(rawWait) ? rawWait : 20000, 0), MAX_WAIT)

    let settled = false
    let disposeTimer = null
    const waiter = () => {
      if (settled) return
      settled = true
      if (disposeTimer !== null) disposeTimer()
      const commands = state.queue.splice(0, state.queue.length)
      state.handled += commands.length
      sendJson(res, 200, { commands, serverTime: Date.now(), client: state.client })
    }
    const dropWaiter = () => {
      const at = state.waiters.indexOf(waiter)
      if (at >= 0) state.waiters.splice(at, 1)
    }

    if (state.queue.length > 0) { waiter(); return }
    if (waitMs <= 0) {
      settled = true
      sendJson(res, 200, { commands: [], serverTime: Date.now(), client: state.client })
      return
    }
    state.waiters.push(waiter)
    disposeTimer = ctx.timeout(() => {
      dropWaiter()
      if (settled) return
      settled = true
      sendJson(res, 200, { commands: [], serverTime: Date.now(), client: state.client })
    }, waitMs)
    req.on('close', () => {
      dropWaiter()
      if (disposeTimer !== null && !settled) disposeTimer()
      settled = true
    })
  }

  const resultHandler = async (req, res) => {
    if (preflight(req, res)) return
    const body = await readJson(req)
    state.lastSeen = Date.now()
    if (body === null || typeof body.id !== 'number') {
      sendJson(res, 400, { accepted: false, error: 'expected {id:number, ok:boolean, result?|error?}' })
      return
    }
    const settle = state.pending.get(body.id)
    if (settle !== undefined) {
      state.pending.delete(body.id)
      settle({
        ok: body.ok !== false,
        result: body.result === undefined ? null : body.result,
        error: body.error === undefined || body.error === null ? null : String(body.error),
      })
    }
    sendJson(res, 200, { accepted: true, matched: settle !== undefined })
  }

  const eventHandler = async (req, res) => {
    if (preflight(req, res)) return
    const body = await readJson(req)
    state.lastSeen = Date.now()
    if (body !== null && body.type) {
      state.eventSeq += 1
      state.events.push({
        seq: state.eventSeq,
        type: String(body.type),
        at: typeof body.at === 'number' ? body.at : Date.now(),
        data: body.data === undefined ? null : body.data,
      })
      if (state.events.length > 100) state.events.splice(0, state.events.length - 100)
    }
    sendJson(res, 200, { accepted: true })
  }

  const eventsHandler = (req, res) => {
    if (preflight(req, res)) return
    const since = Number(param(req.url, 'since')) || 0
    sendJson(res, 200, { seq: state.eventSeq, events: state.events.filter((e) => e.seq > since) })
  }

  const statusHandler = (req, res) => {
    if (preflight(req, res)) return
    sendJson(res, 200, {
      ok: true,
      online: isOnline(),
      client: state.client,
      lastSeen: state.lastSeen,
      queued: state.queue.length,
      inFlight: state.pending.size,
      events: state.eventSeq,
      handled: state.handled,
      endpoints: ['/api/thunderbird/poll', '/api/thunderbird/result', '/api/thunderbird/event', '/api/thunderbird/rpc', '/api/thunderbird/ai', '/api/thunderbird/ui', '/api/thunderbird/session/list'],
    })
  }

  const rpcHandler = async (req, res) => {
    if (preflight(req, res)) return
    const method = param(req.url, 'method')
    if (!method) {
      sendJson(res, 400, { ok: false, error: 'method query parameter is required' })
      return
    }
    let params = {}
    const rawParams = param(req.url, 'params')
    if (rawParams) {
      try { params = JSON.parse(decodeURIComponent(rawParams)) } catch (error) { params = {} }
    }
    const timeoutMs = Number(param(req.url, 'timeoutMs')) || 20000
    sendJson(res, 200, await rpc(String(method), params, timeoutMs))
  }

  const uiHandler = async (req, res) => {
    if (preflight(req, res)) return
    // Plain Node read: this is a real module in the harness process, so the panel
    // HTML needs neither the fs service nor its sandbox policy.
    try {
      const text = await readFile(uiPath, 'utf8')
      sendText(res, 200, text, 'text/html; charset=utf-8')
    } catch (error) {
      sendText(res, 500, 'cannot read ' + uiPath + ': ' + err(error))
    }
  }

  const rpc = (method, params, timeoutMs) => new Promise((resolve) => {
    if (!isOnline()) {
      resolve({ ok: false, offline: true, error: 'Thunderbird 未连接（未收到任何轮询）' })
      return
    }
    const id = nextId
    nextId += 1
    let dispose = null
    const finish = (payload) => {
      if (dispose !== null) dispose()
      resolve(payload)
    }
    state.pending.set(id, finish)
    state.queue.push({ id, method, params: params === undefined || params === null ? {} : params })
    dispose = ctx.timeout(() => {
      state.pending.delete(id)
      resolve({ ok: false, timeout: true, error: 'Thunderbird 响应超时：' + method })
    }, Math.max(1000, Number(timeoutMs) || 20000))
    flushWaiters()
  })

  // ---- AI actions ----------------------------------------------------------

  const AI_BASE = '你是嵌入 DSH 侧边栏的邮件助手。默认用中文回答，保持简洁，不要寒暄，不要解释你在做什么。'

  const clip = (text, limit) => {
    const value = String(text === undefined || text === null ? '' : text)
    const max = limit || 24000
    return value.length > max ? value.slice(0, max) + '\n\n[内容过长已截断]' : value
  }

  async function complete(system, user, maxTokens) {
    if (llm === undefined) throw new Error('llm 服务不可用')
    if (defaults === undefined) throw new Error('agentDefaultModel 服务不可用')
    const selection = defaults.currentSelection()
    if (!selection || !selection.provider || !selection.model) throw new Error('没有可用的默认模型')

    const options = {
      provider: selection.provider,
      model: selection.model,
      system,
      messages: [{
        id: 'tbm-ai-1',
        role: 'user',
        content: [{ type: 'text', text: user }],
        source: { kind: 'plugin', plugin: 'dsh-thunderbird' },
      }],
      maxTokens: maxTokens || 1400,
    }
    if (selection.reasoningEffort) options.reasoningEffort = selection.reasoningEffort

    let text = ''
    let failure = null
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        failure = (chunk.reason.failure && chunk.reason.failure.message) || chunk.reason.kind
      }
    }
    if (!text && failure) throw new Error('模型返回失败：' + failure)
    return { text, model: selection.provider + '/' + selection.model }
  }

  function buildPrompt(input) {
    const action = String(input.action || '')
    const text = clip(input.text)
    const instruction = String(input.instruction || '').trim()
    const targetLang = String(input.targetLang || '中文').trim()
    const subject = String(input.subject || '').trim()
    const from = String(input.from || '').trim()
    const head = (subject ? '主题：' + subject + '\n' : '') + (from ? '发件人：' + from + '\n' : '')

    if (action === 'summarize') {
      return { system: AI_BASE, user: '请总结下面的邮件，用三段式输出：\n1. 一句话结论\n2. 关键要点（最多 5 条）\n3. 需要我处理的事 / 截止时间（没有就写“无”）\n\n' + head + '\n--- 邮件正文 ---\n' + text }
    }
    if (action === 'translate') {
      return { system: AI_BASE, user: '把下面的邮件翻译成' + targetLang + '，保留邮件语气、称呼、分段和署名，只输出译文：\n\n' + text }
    }
    if (action === 'rewrite') {
      return { system: AI_BASE, user: '按下面的要求改写这封邮件' + (instruction ? '：' + instruction : '：让它更专业、简洁、礼貌') + '。只输出改写后的正文，不要加任何说明：\n\n' + text }
    }
    if (action === 'reply') {
      return { system: AI_BASE, user: '基于下面这封邮件起草一封回复' + (instruction ? '，要求：' + instruction : '') + '。输出格式：第一行“主题：xxx”，空一行后是回复正文（含称呼与署名占位）：\n\n' + head + '\n--- 原邮件 ---\n' + text }
    }
    if (action === 'draft') {
      return { system: AI_BASE, user: '帮我写一封邮件。要求：' + (instruction || '（未填，请根据背景自行判断）') + (text ? '\n\n背景资料：\n' + text : '') + '\n\n输出格式：第一行“主题：xxx”，空一行后是正文（含称呼与署名占位）。' }
    }
    if (action === 'classify') {
      return { system: AI_BASE + '你只输出 JSON。', user: '根据下面的邮件内容判断分类并给出建议动作。\n可选分类：' + (instruction || '账单/发票、客户询价、物流、内部通知、营销推广、其他') + '\n输出 JSON：{"category":"...","confidence":0-1,"actions":["标记已读"|"加星标"|"归档"|"删除"|"回复"],"reason":"..."}\n\n' + head + '\n--- 邮件正文 ---\n' + text }
    }
    if (action === 'ask') {
      return { system: AI_BASE + '你有邮件上下文，直接回答，不要重复原文。', user: (text ? '参考资料（邮件内容）：\n' + text + '\n\n' : '') + '问题：' + (instruction || '这封邮件讲了什么？') }
    }
    throw new Error('unknown action: ' + action)
  }

  const aiHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    if (input === null) { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return }
    try {
      const prompt = buildPrompt(input)
      const out = await complete(prompt.system, prompt.user, Number(input.maxTokens) || 1400)
      sendJson(res, 200, { ok: true, text: out.text, model: out.model, action: String(input.action || '') })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: err(error), action: String(input.action || '') })
    }
  }

  const aiStatusHandler = (req, res) => {
    let selection = null
    try { selection = defaults ? defaults.currentSelection() : null } catch (error) { selection = null }
    sendJson(res, 200, {
      ok: true,
      llm: llm !== undefined,
      defaultModel: selection,
      endpoint: '/api/thunderbird/ai',
      actions: ['summarize', 'translate', 'rewrite', 'reply', 'draft', 'classify', 'ask'],
    })
  }

  // ---- mail sessions -------------------------------------------------------
  //
  // An aggregated subject can own a real DSH workspace. The binding materialises
  // as a directory holding the thread as plain readable files; the client half
  // registers that directory as a workspace and connects a session to it, so the
  // conversation about a thread is an ordinary DSH session with the mail sitting
  // in its working directory. Everything is recorded in one registry file plus
  // two files inside the thread directory, so the binding outlives the panel.

  const HOME_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
  const STORE_DIR = join(HOME_DIR, 'dsh-thunderbird')
  const REGISTRY_PATH = join(STORE_DIR, 'mail-sessions.json')
  const DEFAULT_SESSION_ROOT = join(STORE_DIR, 'mail')
  const THREAD_FILE = 'thread.md'
  const AI_LOG_FILE = 'ai-log.md'

  const store = { version: 1, root: DEFAULT_SESSION_ROOT, sessions: {} }
  let storeLoaded = false

  async function loadStore () {
    if (storeLoaded) return
    storeLoaded = true
    try {
      const parsed = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.root === 'string' && parsed.root) store.root = parsed.root
        if (parsed.sessions && typeof parsed.sessions === 'object') store.sessions = parsed.sessions
      }
    } catch (error) { /* first run: defaults are already in place */ }
  }

  async function saveStore () {
    await mkdir(STORE_DIR, { recursive: true })
    await writeFile(REGISTRY_PATH, JSON.stringify(store, null, 2), 'utf8')
  }

  // A path segment that survives Windows and still reads like the subject.
  const slugify = (value, limit) => {
    const slug = String(value === undefined || value === null ? '' : value)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/^[.\-\s]+/, '')
      .replace(/[.\-\s]+$/, '')
      .slice(0, limit || 42)
    return slug || 'thread'
  }

  const keyOf = (folderId, subject) => createHash('sha1')
    .update(String(folderId || '') + '\u0000' + String(subject || ''))
    .digest('hex')
    .slice(0, 12)

  // The bridge answers {ok, result} | {ok:false, error}; tools want an exception.
  async function bridge (method, params, timeoutMs) {
    const out = await rpc(method, params, timeoutMs || 60000)
    if (!out || out.ok !== true) throw new Error((out && out.error) || ('bridge call failed: ' + method))
    return out.result
  }

  const when = (ms) => {
    const n = Number(ms)
    return n > 0 ? new Date(n).toISOString().replace('T', ' ').slice(0, 16) : ''
  }

  const clipText = (value, limit) => {
    const text = String(value === undefined || value === null ? '' : value)
    const max = limit || 20000
    return text.length > max ? text.slice(0, max) + '\n\n[已截断 ' + (text.length - max) + ' 字]' : text
  }

  // Renders one aggregated thread as the markdown the session works from.
  async function buildThreadMarkdown (input) {
    const messageIds = (Array.isArray(input.messageIds) ? input.messageIds : []).slice(0, 12)
    const subject = String(input.subject || '(无主题)')
    const out = []
    out.push('# ' + subject)
    out.push('')
    out.push('| 项 | 值 |')
    out.push('| --- | --- |')
    out.push('| 文件夹 | `' + String(input.folderId || '') + '` |')
    out.push('| 邮件数 | ' + messageIds.length + ' |')
    out.push('| 导出时间 | ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' |')
    out.push('')
    out.push('> 本目录是 DSH 里这条邮件线的工作区。正文来自 Thunderbird，只读；')
    out.push('> AI 的产出记在 `' + AI_LOG_FILE + '`，重新同步本文件会覆盖它。')
    out.push('')

    const attachments = []
    let index = 0
    for (const messageId of messageIds) {
      index += 1
      let header = null
      try {
        header = await bridge('messages.get', { messageId }, 30000)
      } catch (error) { /* a message may be gone; keep the rest of the thread */ }
      let body = null
      try {
        body = await bridge('messages.body', { messageId, preferHtml: false }, 120000)
      } catch (error) { /* large or unreadable body: header only */ }

      out.push('## ' + index + '. ' + (header && header.subject ? header.subject : '(邮件 ' + messageId + ')'))
      out.push('')
      out.push('- 发件人：' + ((header && header.author) || '未知'))
      out.push('- 收件人：' + (((header && header.recipients) || []).join(', ') || '-'))
      if (header && header.ccList && header.ccList.length) out.push('- 抄送：' + header.ccList.join(', '))
      out.push('- 时间：' + when(header && header.date))
      out.push('- messageId：`' + messageId + '`')
      if (header && header.hasAttachment) out.push('- 含附件：是')
      out.push('')
      const text = body && body.text ? clipText(body.text, 20000) : '(未能读取正文)'
      out.push(text)
      out.push('')
      const files = (body && body.attachments) || []
      for (const file of files) {
        attachments.push({ name: file.name, size: file.size, messageId })
      }
      out.push('---')
      out.push('')
    }

    if (attachments.length > 0) {
      out.push('## 附件清单')
      out.push('')
      for (const file of attachments) {
        out.push('- `' + String(file.name || '(未命名)') + '` · ' + (file.size || 0) + ' B · messageId ' + file.messageId)
      }
      out.push('')
    }
    return out.join('\n')
  }

  const sessionRecord = (key) => store.sessions[key]

  async function writeThreadFile (record, markdown) {
    await mkdir(record.dir, { recursive: true })
    await writeFile(join(record.dir, THREAD_FILE), markdown, 'utf8')
  }

  async function appendAiRecord (record, entry) {
    record.ai = Array.isArray(record.ai) ? record.ai : []
    record.ai.push(entry)
    if (record.ai.length > 300) record.ai.splice(0, record.ai.length - 300)
    await mkdir(record.dir, { recursive: true })
    const stamp = new Date(entry.at).toISOString().replace('T', ' ').slice(0, 19)
    const head = '\n## ' + stamp + ' · ' + String(entry.action || 'ai') + (entry.model ? ' · ' + entry.model : '') + '\n'
    const ask = entry.question ? '\n**问：** ' + String(entry.question).replace(/\s+/g, ' ').slice(0, 500) + '\n' : ''
    const block = head + ask + '\n' + String(entry.text || '').trim() + '\n'
    await writeFile(join(record.dir, AI_LOG_FILE), block, { encoding: 'utf8', flag: 'a' })
  }

  const sessionListHandler = async (req, res) => {
    if (preflight(req, res)) return
    await loadStore()
    const items = Object.keys(store.sessions).map((key) => {
      const record = store.sessions[key]
      return {
        key,
        folderId: record.folderId,
        subject: record.subject,
        title: record.title,
        dir: record.dir,
        workspaceId: record.workspaceId || null,
        sessionId: record.sessionId || null,
        messageCount: record.messageCount || 0,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        syncedAt: record.syncedAt || null,
        aiCount: Array.isArray(record.ai) ? record.ai.length : 0,
        lastAction: Array.isArray(record.ai) && record.ai.length ? record.ai[record.ai.length - 1].action : null,
      }
    }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    sendJson(res, 200, { ok: true, root: store.root, registry: REGISTRY_PATH, sessions: items })
  }

  const sessionCreateHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    if (input === null || !input.subject) { sendJson(res, 400, { ok: false, error: 'expected {subject, folderId, messageIds}' }); return }
    try {
      await loadStore()
      const subject = String(input.subject)
      const folderId = String(input.folderId || '')
      const key = String(input.key || '').replace(/[^a-z0-9]/gi, '').slice(0, 32) || keyOf(folderId, subject)
      const existing = sessionRecord(key)
      const dir = (existing && existing.dir) || join(store.root, slugify(subject) + '-' + key)
      const now = Date.now()
      const record = existing || {
        key,
        subject,
        folderId,
        title: subject,
        dir,
        createdAt: now,
        ai: [],
      }
      record.subject = subject
      record.folderId = folderId
      record.messageCount = Array.isArray(input.messageIds) ? input.messageIds.length : 0
      record.updatedAt = now
      store.sessions[key] = record

      const markdown = await buildThreadMarkdown({ subject, folderId, messageIds: input.messageIds })
      await writeThreadFile(record, markdown)
      record.syncedAt = Date.now()
      if (!record.aiFileReady) {
        record.aiFileReady = true
        await writeFile(join(record.dir, AI_LOG_FILE),
          '# AI 记录 · ' + subject + '\n\n> 面板里每一次 AI 动作都会追加到这里。\n',
          { encoding: 'utf8', flag: 'a' })
      }
      await saveStore()
      sendJson(res, 200, { ok: true, session: store.sessions[key] })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: err(error) })
    }
  }

  const sessionSyncHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    if (input === null || !input.key) { sendJson(res, 400, { ok: false, error: 'expected {key, messageIds}' }); return }
    try {
      await loadStore()
      const record = sessionRecord(String(input.key))
      if (!record) { sendJson(res, 200, { ok: false, error: 'unknown session key' }); return }
      const markdown = await buildThreadMarkdown({
        subject: record.subject,
        folderId: record.folderId,
        messageIds: input.messageIds,
      })
      await writeThreadFile(record, markdown)
      record.messageCount = Array.isArray(input.messageIds) ? input.messageIds.length : record.messageCount
      record.syncedAt = Date.now()
      record.updatedAt = Date.now()
      await saveStore()
      sendJson(res, 200, { ok: true, session: record })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: err(error) })
    }
  }

  const sessionAttachHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    if (input === null || !input.key) { sendJson(res, 400, { ok: false, error: 'expected {key, workspaceId, sessionId}' }); return }
    await loadStore()
    const record = sessionRecord(String(input.key))
    if (!record) { sendJson(res, 200, { ok: false, error: 'unknown session key' }); return }
    if (input.workspaceId) record.workspaceId = String(input.workspaceId)
    if (input.sessionId) record.sessionId = String(input.sessionId)
    record.updatedAt = Date.now()
    await saveStore()
    sendJson(res, 200, { ok: true, session: record })
  }

  const sessionLogHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    if (input === null || !input.key) { sendJson(res, 400, { ok: false, error: 'expected {key, action, text}' }); return }
    try {
      await loadStore()
      const record = sessionRecord(String(input.key))
      if (!record) { sendJson(res, 200, { ok: false, error: 'unknown session key' }); return }
      await appendAiRecord(record, {
        at: Date.now(),
        action: String(input.action || 'ai'),
        model: input.model ? String(input.model) : '',
        question: input.question ? String(input.question) : '',
        text: String(input.text || ''),
      })
      record.updatedAt = Date.now()
      await saveStore()
      sendJson(res, 200, { ok: true, count: record.ai.length })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: err(error) })
    }
  }

  const sessionRemoveHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    if (input === null || !input.key) { sendJson(res, 400, { ok: false, error: 'expected {key}' }); return }
    await loadStore()
    const record = sessionRecord(String(input.key))
    if (!record) { sendJson(res, 200, { ok: true, removed: false }); return }
    delete store.sessions[String(input.key)]
    await saveStore()
    let filesRemoved = false
    if (input.deleteFiles === true) {
      try { await rm(record.dir, { recursive: true, force: true }); filesRemoved = true } catch (error) { /* keep the directory */ }
    }
    sendJson(res, 200, { ok: true, removed: true, filesRemoved })
  }

  // A session deleted in DSH must not leave the mail line pointing at it.
  //
  // The client half watches DSH's session list and reports the ids that are gone;
  // this clears the binding but KEEPS the exported directory and the panel's own
  // ai-log, so the thread still has its record of what was said and can be
  // re-attached later. Deleting the files here would destroy history the user did
  // not ask to destroy — they deleted a CONVERSATION, not the mail.
  const sessionDetachHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    const gone = Array.isArray(input && input.sessionIds) ? input.sessionIds.map(String) : []
    if (!gone.length) { sendJson(res, 200, { ok: true, detached: [] }); return }
    await loadStore()
    const lookup = {}
    for (let i = 0; i < gone.length; i++) lookup[gone[i]] = true
    const detached = []
    for (const key of Object.keys(store.sessions || {})) {
      const record = store.sessions[key]
      if (!record || !record.sessionId) continue
      if (!lookup[String(record.sessionId)]) continue
      record.sessionId = ''
      if (record.workspaceId) record.workspaceId = ''
      record.detachedAt = Date.now()
      record.detachedReason = 'session-removed'
      record.updatedAt = record.detachedAt
      detached.push({ key: key, subject: record.subject || '' })
    }
    if (detached.length) await saveStore()
    sendJson(res, 200, { ok: true, detached: detached })
  }

  // A bound thread's conversation lives in a real DSH session, and the host
  // session store can read it back: Session.snapshotEvents() returns the log, so
  // the panel shows the same turns DSH shows instead of keeping its own copy.
  // Only leaf fields cross this boundary — never the live event objects.
  const transcriptText = (blocks) => {
    const parts = []
    for (const block of blocks || []) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }

  const transcriptHandler = async (req, res) => {
    if (preflight(req, res)) return
    await loadStore()
    const record = sessionRecord(String(param(req.url, 'key') || ''))
    if (!record) { sendJson(res, 200, { ok: false, error: 'unknown session key' }); return }
    const limit = Math.min(Math.max(Number(param(req.url, 'limit')) || 60, 1), 200)
    if (!record.sessionId) { sendJson(res, 200, { ok: true, live: false, running: false, messages: [] }); return }

    const sessions = ctx.get('sessions')
    if (sessions === undefined) { sendJson(res, 200, { ok: false, error: 'sessions 服务不可用' }); return }
    const session = sessions.get(record.sessionId)
    if (session === undefined) {
      sendJson(res, 200, {
        ok: true, live: false, running: false, messages: [], seq: 0,
        note: '会话当前不在内存里（在 DSH 里打开一次就会加载）',
      })
      return
    }

    let running = false
    let lastTurn = null
    const messages = []
    let events = []
    try { events = session.snapshotEvents() } catch (error) { events = [] }
    for (const event of events) {
      if (!event || typeof event.type !== 'string') continue
      if (event.type === 'turn/start') { running = true; continue }
      if (event.type === 'turn/end') {
        running = false
        const reason = event.data && event.data.reason
        lastTurn = reason && reason.kind ? String(reason.kind) : null
        continue
      }
      if (event.type === 'user/message') {
        const text = transcriptText(event.data && event.data.content)
        if (text) messages.push({ role: 'user', text: clipText(text, 8000), seq: event.seq, time: event.time })
        continue
      }
      if (event.type === 'assistant/message') {
        const text = transcriptText(event.data && event.data.message && event.data.message.content)
        const source = event.data && event.data.message && event.data.message.source
        messages.push({
          role: 'assistant',
          text: clipText(text, 12000),
          model: source && source.model ? String(source.provider || '') + '/' + String(source.model) : '',
          seq: event.seq,
          time: event.time,
        })
        continue
      }
      if (event.type === 'tool/call') {
        messages.push({ role: 'tool', name: String((event.data && event.data.name) || ''), text: '', seq: event.seq, time: event.time })
      }
    }

    sendJson(res, 200, {
      ok: true,
      live: true,
      running,
      lastTurn,
      seq: messages.length ? messages[messages.length - 1].seq : 0,
      total: messages.length,
      messages: messages.slice(-limit),
    })
  }

  // Remote images in mail are fetched by this process rather than by the panel.
  // Two reasons: the panel can then sample them (a cross-origin image taints the
  // canvas, so a white-backed logo could never be adapted), and the user's mail
  // client is not the one talking to a tracking host.
  // ------------------------------------------------------------- 远程图片代理
  //
  // Every remote image in a mail comes through this one route, so this is what
  // decides whether a picture appears at all. It used to fetch each image fresh,
  // with no cache and no ceiling on how many ran at once: a mail carrying thirty
  // pictures fired thirty simultaneous upstream fetches, all sharing a single 15s
  // timeout, so the slow ones failed together and rendered as broken images — and
  // then every re-render fetched the whole set again. That is the "炸图" report.
  //
  // Three things changed, and the third is what the user asked for:
  //   · a disk cache keyed by URL, so a picture is fetched once, ever — which also
  //     makes a re-render free instead of a stampede;
  //   · a concurrency gate, so thirty pictures do not become thirty sockets;
  //   · a persisted host allow-list (settings.imageHosts / imageStrict), because
  //     which hosts this panel is willing to contact is a privacy decision, and a
  //     decision the user cannot keep is not really a decision.
  const IMAGE_CACHE_DIR = join(STORE_DIR, 'image-cache')
  const IMAGE_MAX_BYTES = 6 * 1024 * 1024
  const IMAGE_TIMEOUT_MS = 15000
  const IMAGE_CONCURRENCY = 6
  let imageActive = 0
  const imageWaiting = []
  const imageInflight = new Map()

  function imageGate () {
    if (imageActive < IMAGE_CONCURRENCY) {
      imageActive += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => imageWaiting.push(resolve))
  }

  function imageRelease () {
    const next = imageWaiting.shift()
    // Handing the slot straight to the next waiter keeps `imageActive` honest:
    // decrementing and re-incrementing would let one extra request slip through
    // every time a queued one starts.
    if (next) next()
    else imageActive -= 1
  }

  const imageCacheKey = (url) => createHash('sha1').update(String(url)).digest('hex')

  function sendImage (res, type, bytes, how) {
    if (res.writableEnded) return
    res.writeHead(200, {
      'content-type': type,
      'content-length': bytes.length,
      'cache-control': 'private, max-age=3600',
      'access-control-allow-origin': '*',
      'x-tb-image': how,
    })
    res.end(bytes)
  }

  async function fetchImage (url, file, meta) {
    await imageGate()
    try {
      const controller = new AbortController()
      const timer = ctx.timeout(() => controller.abort(), IMAGE_TIMEOUT_MS)
      try {
        const upstream = await fetch(url, { signal: controller.signal, redirect: 'follow' })
        if (!upstream.ok) throw new Error('HTTP ' + upstream.status)
        const type = upstream.headers.get('content-type') || 'application/octet-stream'
        if (!/^image\//i.test(type)) throw new Error('not an image: ' + type)
        const body = Buffer.from(await upstream.arrayBuffer())
        if (body.length > IMAGE_MAX_BYTES) throw new Error('image larger than 6 MB')
        await mkdir(IMAGE_CACHE_DIR, { recursive: true })
        // Written under a temporary name first: an interrupted write must never
        // leave a half image that the cache would then serve forever.
        await writeFile(file + '.tmp', body)
        await writeFile(meta + '.tmp', JSON.stringify({ type, at: Date.now() }), 'utf8')
        await rm(file, { force: true })
        await rm(meta, { force: true })
        await rename(file + '.tmp', file)
        await rename(meta + '.tmp', meta)
        return { type, body }
      } finally {
        timer()
      }
    } finally {
      imageRelease()
    }
  }

  const imageProxyHandler = async (req, res) => {
    if (preflight(req, res)) return
    const target = param(req.url, 'url')
    if (!target) { sendJson(res, 400, { ok: false, error: 'url query parameter is required' }); return }
    // `param` does NOT decode, and the panel sends `encodeURIComponent(url)`. This
    // handler never decoded, so `new URL('https%3A%2F%2F…')` threw on every single
    // proxied image and the route answered "not a valid url" — which the panel's
    // fallbackProxiedImages then papered over by pointing the <img> straight at the
    // remote host. That is why there were no cache hits to speak of and why a mail
    // full of pictures fell apart: instead of one controlled, cached, gated fetch
    // per image, every render fired a burst of direct cross-origin loads.
    let decoded = String(target)
    try { decoded = decodeURIComponent(decoded) } catch (error) { /* already decoded */ }
    let parsed
    try {
      parsed = new URL(decoded)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'not a valid url' })
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      sendJson(res, 400, { ok: false, error: 'only http(s) images' })
      return
    }
    const current = await loadSettings()
    const host = parsed.host.toLowerCase()
    const trusted = (current.imageHosts || []).map((entry) => String(entry).toLowerCase())
    // `host` carries the port, the allow-list entries do not, so compare both the
    // full host and the bare hostname — otherwise a host trusted at :443 is never
    // recognised at :8080 and the user cannot tell why.
    const bare = parsed.hostname.toLowerCase()
    if (current.imageStrict === true && trusted.indexOf(host) < 0 && trusted.indexOf(bare) < 0) {
      // A distinguishable answer, not a broken image: the panel turns this into a
      // "信任此域" affordance instead of an empty box.
      sendJson(res, 200, { ok: false, error: 'host not trusted', host: bare, strict: true })
      return
    }
    const file = join(IMAGE_CACHE_DIR, imageCacheKey(parsed.toString()))
    const meta = file + '.json'
    try {
      const head = JSON.parse(await readFile(meta, 'utf8'))
      const bytes = await readFile(file)
      if (bytes.length && head && typeof head.type === 'string') {
        sendImage(res, head.type, bytes, 'hit')
        return
      }
    } catch (error) { /* not cached yet */ }
    try {
      // One upstream request per URL, however many <img> tags ask for it.
      let work = imageInflight.get(file)
      if (work === undefined) {
        work = fetchImage(parsed.toString(), file, meta)
        imageInflight.set(file, work)
        // The map is cleaned up on settle, not on success: a failed fetch must not
        // be remembered as in-flight forever.
        work.then(() => imageInflight.delete(file), () => imageInflight.delete(file))
      }
      const out = await work
      sendImage(res, out.type, out.body, 'miss')
    } catch (error) {
      sendJson(res, 200, { ok: false, error: err(error), host: bare })
    }
  }

  const sessionFileHandler = async (req, res) => {
    if (preflight(req, res)) return
    await loadStore()
    const record = sessionRecord(String(param(req.url, 'key') || ''))
    if (!record) { sendJson(res, 200, { ok: false, error: 'unknown session key' }); return }
    const which = param(req.url, 'file') === AI_LOG_FILE ? AI_LOG_FILE : THREAD_FILE
    try {
      const text = await readFile(join(record.dir, which), 'utf8')
      sendJson(res, 200, { ok: true, file: which, dir: record.dir, text })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: err(error), dir: record.dir })
    }
  }

  // ---- DSH tools -----------------------------------------------------------
  //
  // Registering the bridge as tools is what actually mounts the mail capability
  // into DSH: every session — including the ones bound to a thread — can read,
  // search and answer mail with its own model and its own tools.

  const toolText = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  const toolOutput = (schema) => ({ schema, render: (args, value) => toolText(value) })
  const str = (description) => ({ type: 'string', description })
  const num = (description) => ({ type: 'number', description })

  const folderOptions = async () => {
    // folders.tree answers one entry per ACCOUNT, each carrying a rootFolder.
    const accounts = await bridge('folders.tree', {}, 60000)
    const flat = []
    const walk = (folder) => {
      if (!folder || !folder.id) return
      flat.push({ id: folder.id, name: folder.name, path: folder.path })
      for (const child of folder.subFolders || []) walk(child)
    }
    for (const account of accounts || []) walk(account.rootFolder)
    return flat
  }

  const formatHeader = (header) => [
    '#' + header.id + '  ' + when(header.date),
    '  ' + (header.author || '未知'),
    '  ' + (header.subject || '(无主题)'),
    header.read ? '  已读' : '  未读',
  ].join('\n')

  async function collectThreadMessages (subject, folderId) {
    // The bridge searches server-side, so the thread is not limited by whatever
    // page the panel happens to have loaded.
    const found = await bridge('messages.search', { text: subject, limit: 40 }, 180000)
    const wanted = String(subject || '').replace(/^(\s*(re|fw|fwd|回复|答复|转发)\s*[:：]\s*)+/i, '').trim().toLowerCase()
    const same = (value) => String(value || '')
      .replace(/^(\s*(re|fw|fwd|回复|答复|转发)\s*[:：]\s*)+/i, '')
      .trim().toLowerCase() === wanted
    const hits = (found && found.messages ? found.messages : []).filter((m) => same(m.subject))
    if (folderId) return hits.filter((m) => String(m.folderId || '') === String(folderId))
    return hits
  }

  function registerTools () {
    const tools = ctx.get('tools')
    if (tools === undefined) {
      console.error('[dsh-thunderbird] tools service is unavailable; mail tools not registered')
      return
    }
    const definitions = [
      {
        name: 'thunderbird_folders',
        description: 'List Thunderbird mail folders as {id, name, path}. Use the id with the other thunderbird tools.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: toolOutput({ type: 'object' }),
        execute: async () => {
          const flat = await folderOptions()
          return flat.map((f) => f.id + '  ' + f.name + '  (' + f.path + ')').join('\n') || '(没有文件夹)'
        },
      },
      {
        name: 'thunderbird_search',
        description: 'Search the user\'s mail in Thunderbird (server-side, whole mailbox, not just the loaded page). Returns id, date, sender and subject of each hit.',
        parameters: {
          type: 'object',
          properties: {
            query: str('Text to search for: subject, sender or body content.'),
            folderId: str('Optional folder id from thunderbird_folders; omit to search every folder.'),
            limit: num('Maximum hits to return, default 20.'),
          },
          required: ['query'],
          additionalProperties: false,
        },
        output: toolOutput({ type: 'object' }),
        execute: async (args) => {
          const input = args || {}
          const found = await bridge('messages.search', {
            text: String(input.query || ''),
            limit: Math.min(Math.max(Number(input.limit) || 20, 1), 100),
          }, 180000)
          let messages = (found && found.messages) || []
          if (input.folderId) messages = messages.filter((m) => String(m.folderId || '') === String(input.folderId))
          if (messages.length === 0) return '没有匹配的邮件。'
          return messages.map(formatHeader).join('\n\n')
        },
      },
      {
        name: 'thunderbird_thread',
        description: 'Read one aggregated mail thread (all messages sharing a subject) as a single markdown digest with full bodies. This is the tool to use before answering, summarising, translating or drafting a reply to a thread.',
        parameters: {
          type: 'object',
          properties: {
            subject: str('Thread subject, with or without a Re:/Fwd: prefix.'),
            folderId: str('Optional folder id to restrict the thread to one folder.'),
          },
          required: ['subject'],
          additionalProperties: false,
        },
        output: toolOutput({ type: 'object' }),
        execute: async (args) => {
          const input = args || {}
          const subject = String(input.subject || '')
          const messages = await collectThreadMessages(subject, input.folderId)
          if (messages.length === 0) return '没有找到主题匹配「' + subject + '」的邮件。'
          const digest = await buildThreadMarkdown({
            subject: messages[0].subject || subject,
            folderId: input.folderId || messages[0].folderId || '',
            messageIds: messages.map((m) => m.id).slice(0, 12),
          })
          return digest
        },
      },
      {
        name: 'thunderbird_message',
        description: 'Read one message by id: headers plus the plain-text body (HTML-only mail is reduced to text).',
        parameters: {
          type: 'object',
          properties: { messageId: num('The numeric message id (an integer, not the rfc Message-ID).') },
          required: ['messageId'],
          additionalProperties: false,
        },
        output: toolOutput({ type: 'object' }),
        execute: async (args) => {
          const messageId = (args || {}).messageId
          const header = await bridge('messages.get', { messageId }, 60000)
          const body = await bridge('messages.body', { messageId, preferHtml: false }, 180000)
          const attachments = (body && body.attachments) || []
          return [
            'id: ' + messageId,
            'Date: ' + when(header && header.date),
            'From: ' + ((header && header.author) || '未知'),
            'To: ' + (((header && header.recipients) || []).join(', ') || '-'),
            'Subject: ' + ((header && header.subject) || '(无主题)'),
            attachments.length ? 'Attachments: ' + attachments.map((a) => a.name + ' (' + a.size + ' B)').join(', ') : '',
            '',
            clipText((body && body.text) || '(没有可读正文)', 30000),
          ].filter((line) => line !== '').join('\n')
        },
      },
      {
        name: 'thunderbird_flag',
        description: 'Change the read/flagged state of one message in Thunderbird.',
        parameters: {
          type: 'object',
          properties: {
            messageId: num('The numeric message id.'),
            read: { type: 'boolean', description: 'Mark as read (true) or unread (false).' },
            flagged: { type: 'boolean', description: 'Star (true) or unstar (false).' },
          },
          required: ['messageId'],
          additionalProperties: false,
        },
        output: toolOutput({ type: 'object' }),
        execute: async (args) => {
          const input = args || {}
          const params = { messageId: input.messageId }
          if (typeof input.read === 'boolean') params.read = input.read
          if (typeof input.flagged === 'boolean') params.flagged = input.flagged
          const out = await bridge('messages.update', params, 60000)
          return JSON.stringify(out)
        },
      },
      {
        name: 'thunderbird_send',
        description: 'Send an email through the user\'s Thunderbird account. This really sends mail: only call it when the user asked for it.',
        parameters: {
          type: 'object',
          properties: {
            to: str('Comma-separated recipients.'),
            subject: str('Subject line.'),
            body: str('Plain-text body.'),
            cc: str('Optional comma-separated carbon copy.'),
          },
          required: ['to', 'subject', 'body'],
          additionalProperties: false,
        },
        output: toolOutput({ type: 'object' }),
        execute: async (args) => {
          const input = args || {}
          const split = (value) => String(value || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)
          const out = await bridge('messages.send', {
            to: split(input.to),
            cc: split(input.cc),
            subject: String(input.subject || ''),
            body: String(input.body || ''),
          }, 180000)
          return JSON.stringify(out)
        },
      },
      {
        name: 'thunderbird_rules',
        description: 'List or run the local classification rules stored inside the Thunderbird add-on (they run on new mail even when DSH is closed).',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'run'], description: 'list the rules, or run them over a folder.' },
            folderId: str('Folder id for action=run.'),
            dryRun: { type: 'boolean', description: 'For action=run: only report what would match.' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: toolOutput({ type: 'object' }),
        execute: async (args) => {
          const input = args || {}
          if (input.action === 'list') return JSON.stringify(await bridge('rules.get', {}, 60000), null, 2)
          return JSON.stringify(await bridge('rules.run', {
            folderId: input.folderId,
            dryRun: input.dryRun !== false,
          }, 180000), null, 2)
        },
      },
    ]

    for (const definition of definitions) {
      try {
        ctx.effect(() => tools.register(definition))
      } catch (error) {
        console.error('[dsh-thunderbird] tool ' + definition.name + ' not registered: ' + err(error))
      }
    }
    console.log('[dsh-thunderbird] registered ' + definitions.length + ' mail tools')
  }

  // Local images a signature points at. A file:// URL cannot load in the browser,
  // so the panel asks for the bytes instead. Confined to configured roots, because
  // an unconfined version of this would be a general file-read endpoint handed to
  // a web page.
  //
  // The default is what Thunderbird's own signatures actually reference — Foxmail
  // stores them under its install directory, NOT wherever the user keeps their
  // logo files, so a "sensible" default guess produced a 403 on every request.
  const LOCAL_IMAGE_ROOTS = (Array.isArray(settings.imageRoots) && settings.imageRoots.length
    ? settings.imageRoots
    : [
      'C:\\Foxmail 7.2\\Global\\Signatures',
      'C:\\Foxmail 7.2\\Global\\Signatures\\images',
      'D:\\Logo',
    ]).map((root) => String(root))

  const normalizePath = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

  const localImageHandler = async (req, res) => {
    if (preflight(req, res)) return
    let target = String(param(req.url, 'path') || '')
    if (!target) { sendJson(res, 400, { ok: false, error: 'path query parameter is required' }); return }
    try { target = decodeURIComponent(target) } catch (error) { /* already decoded */ }
    if (/^file:/i.test(target)) {
      try { target = fileURLToPath(target) } catch (error) { sendJson(res, 400, { ok: false, error: 'not a file url' }); return }
    }
    const normalized = normalizePath(target)
    const allowed = LOCAL_IMAGE_ROOTS.some((root) => {
      const base = normalizePath(root)
      return base !== '' && (normalized === base || normalized.startsWith(base + '/'))
    })
    if (!allowed) {
      sendJson(res, 403, { ok: false, error: 'path is outside the allowed image roots: ' + LOCAL_IMAGE_ROOTS.join(', ') })
      return
    }
    try {
      const bytes = await readFile(target)
      if (bytes.length > 6 * 1024 * 1024) { sendJson(res, 200, { ok: false, error: 'image larger than 6 MB' }); return }
      const type = /\.png$/i.test(target) ? 'image/png'
        : /\.(jpe?g)$/i.test(target) ? 'image/jpeg'
          : /\.gif$/i.test(target) ? 'image/gif'
            : /\.webp$/i.test(target) ? 'image/webp'
              : /\.svg$/i.test(target) ? 'image/svg+xml'
                : 'application/octet-stream'
      if (res.writableEnded) return
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'private, max-age=600',
        'access-control-allow-origin': '*',
      })
      res.end(bytes)
    } catch (error) {
      sendJson(res, 200, { ok: false, error: err(error) })
    }
  }

  // ------------------------------------------------------- 邮件名片（联系人）
  //
  // Every address seen in a message header becomes a durable contact card, and
  // everyone on the same message is associated with everyone else, so a card can
  // show who that person actually corresponds with.
  //
  // The card is keyed by the ADDRESS, not by the display name: the same person
  // writes with several names, and two people never share an address. Names are
  // therefore collected as variants with counts and the best one is chosen, which
  // is what keeps "Iris Zhu" from being replaced by a signature-mangled variant on
  // the next message.
  const CONTACTS_PATH = join(STORE_DIR, 'contacts.json')
  const contacts = { version: 1, list: {} }
  let contactsLoaded = false
  let contactsSaveTimer = null

  const contactId = (address) => 'c_' + createHash('sha1')
    .update(String(address || '').trim().toLowerCase())
    .digest('hex').slice(0, 12)

  // "Iris Zhu <a@b>" | "\"Zhu, Iris\" <a@b>" | "a@b" -> "a@b"
  function addrOf (value) {
    const text = String(value === undefined || value === null ? '' : value).trim()
    if (!text) return ''
    const angled = /<([^>]*)>/.exec(text)
    const inner = angled ? angled[1] : text
    const cleaned = inner.replace(/[\s"';,<>]+/g, '').toLowerCase()
    if (cleaned.indexOf('@') < 1 || cleaned.indexOf('@') === cleaned.length - 1) return ''
    return cleaned
  }

  // The display half of a header address, or '' — never invented from the local
  // part. A made-up name is worse than no name: it looks authoritative and is not.
  function displayOf (value) {
    const text = String(value === undefined || value === null ? '' : value).trim()
    if (!text) return ''
    const angled = /^(.*?)<[^>]*>\s*$/.exec(text)
    const raw = angled ? angled[1] : (/@/.test(text) ? '' : text)
    return raw.replace(/^[\s"']+|[\s"']+$/g, '').replace(/\s+/g, ' ').trim()
  }

  const CJK = /[\u3400-\u9fff\u3040-\u30ff]/
  const COMPOUND = ['欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙', '慕容',
    '司徒', '令狐', '宇文', '长孙', '南宫', '独孤', '轩辕', '夏侯', '闻人', '贺兰', '澹台']

  // 名字自动整理：中文按姓+名切（认复姓），西文按最后一段当姓。
  function splitName (display) {
    const name = String(display || '').trim()
    if (!name) return { given: '', family: '' }
    if (CJK.test(name)) {
      for (let i = 0; i < COMPOUND.length; i++) {
        if (name.indexOf(COMPOUND[i]) === 0) return { family: COMPOUND[i], given: name.slice(COMPOUND[i].length) }
      }
      return { family: name.slice(0, 1), given: name.slice(1) }
    }
    const parts = name.split(/\s+/).filter(Boolean)
    if (parts.length <= 1) return { given: parts[0] || '', family: '' }
    return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1] }
  }

  async function loadContacts () {
    if (contactsLoaded) return
    contactsLoaded = true
    try {
      const parsed = JSON.parse(await readFile(CONTACTS_PATH, 'utf8'))
      if (parsed && parsed.list && typeof parsed.list === 'object') contacts.list = parsed.list
    } catch (error) { /* first run */ }
  }

  function saveContactsSoon () {
    if (contactsSaveTimer !== null) return
    contactsSaveTimer = setTimeout(async () => {
      contactsSaveTimer = null
      try {
        await mkdir(STORE_DIR, { recursive: true })
        await writeFile(CONTACTS_PATH, JSON.stringify({ version: 1, list: contacts.list }), 'utf8')
      } catch (error) { console.error('[dsh-thunderbird] contacts save failed: ' + err(error)) }
    }, 1500)
    if (contactsSaveTimer && typeof contactsSaveTimer.unref === 'function') contactsSaveTimer.unref()
  }

  // Choose the display name from the variants seen so far: most frequent wins, and
  // a tie goes to the longer one, which is almost always the fuller form
  // ("Iris Zhu" over "Iris"). A hand-edited card is never touched.
  function applyAutoName (card) {
    if (card.edited && card.display) return
    let best = ''
    let bestCount = -1
    const keys = Object.keys(card.names || {})
    for (let i = 0; i < keys.length; i++) {
      const count = card.names[keys[i]] || 0
      if (count > bestCount || (count === bestCount && keys[i].length > best.length)) {
        best = keys[i]
        bestCount = count
      }
    }
    if (!best) return
    card.display = best
    if (!card.given && !card.family) {
      const parts = splitName(best)
      card.given = parts.given || ''
      card.family = parts.family || ''
    }
  }

  function ensureCard (address) {
    const id = contactId(address)
    let card = contacts.list[id]
    if (!card) {
      card = contacts.list[id] = {
        id: id,
        emails: [address],
        names: {},
        display: '', given: '', family: '', courtesy: '',
        company: '', title: '', phone: '', note: '', tags: [],
        accounts: [], peers: {},
        avatar: { kind: 'auto' },
        firstSeen: Date.now(), lastSeen: 0, seen: 0,
        edited: false,
      }
    }
    return card
  }

  // One message -> cards for the author and every recipient, plus a peer edge
  // between all of them. `accountId` decides which account a card belongs to, and
  // that is what the composer's suggestions filter on.
  function harvestMessages (messages, accountId) {
    const list = Array.isArray(messages) ? messages : []
    let touched = 0
    for (let m = 0; m < list.length; m++) {
      const header = list[m] || {}
      const raw = [header.author].concat(header.recipients || [])
      const seenHere = []
      for (let r = 0; r < raw.length; r++) {
        const address = addrOf(raw[r])
        if (!address || seenHere.indexOf(address) >= 0) continue
        seenHere.push(address)
        const card = ensureCard(address)
        card.seen += 1
        card.lastSeen = Math.max(card.lastSeen, Number(header.date) || Date.now())
        const display = displayOf(raw[r])
        if (display) card.names[display] = (card.names[display] || 0) + 1
        if (accountId && card.accounts.indexOf(accountId) < 0) card.accounts.push(accountId)
        touched += 1
      }
      // 收发件人关联: everyone on this message is related to everyone else on it.
      for (let a = 0; a < seenHere.length; a++) {
        const card = contacts.list[contactId(seenHere[a])]
        if (!card) continue
        for (let b = 0; b < seenHere.length; b++) {
          if (a === b) continue
          card.peers[seenHere[b]] = (card.peers[seenHere[b]] || 0) + 1
        }
      }
      for (let k = 0; k < seenHere.length; k++) applyAutoName(contacts.list[contactId(seenHere[k])])
    }
    if (touched) saveContactsSoon()
    return touched
  }

  const contactsArray = () => Object.keys(contacts.list).map((id) => contacts.list[id])
  const contactSortKey = (c) => String((c.display || c.emails[0] || '')).toLowerCase()

  const contactsListHandler = async (req, res) => {
    if (preflight(req, res)) return
    await loadContacts()
    const accountId = String(param(req.url, 'accountId') || '')
    const query = String(param(req.url, 'q') || '').trim().toLowerCase()
    let list = contactsArray()
    if (accountId) list = list.filter((c) => (c.accounts || []).indexOf(accountId) >= 0)
    if (query) {
      list = list.filter((c) => {
        if (String(c.display || '').toLowerCase().indexOf(query) >= 0) return true
        if (String(c.given || '').toLowerCase().indexOf(query) >= 0) return true
        if (String(c.family || '').toLowerCase().indexOf(query) >= 0) return true
        if (String(c.courtesy || '').toLowerCase().indexOf(query) >= 0) return true
        if (String(c.company || '').toLowerCase().indexOf(query) >= 0) return true
        return (c.emails || []).some((e) => e.indexOf(query) >= 0)
      })
    }
    list.sort((a, b) => (b.seen || 0) - (a.seen || 0) || contactSortKey(a).localeCompare(contactSortKey(b)))
    const limit = Math.max(1, Math.min(Number(param(req.url, 'limit')) || 400, 2000))
    sendJson(res, 200, {
      ok: true,
      total: contactsArray().length,
      shown: Math.min(list.length, limit),
      list: list.slice(0, limit).map((c) => ({
        id: c.id, display: c.display, emails: c.emails, company: c.company,
        accounts: c.accounts, seen: c.seen, lastSeen: c.lastSeen, edited: c.edited,
        avatar: c.avatar, hasName: !!c.display,
      })),
    })
  }

  const contactsGetHandler = async (req, res) => {
    if (preflight(req, res)) return
    await loadContacts()
    const id = String(param(req.url, 'id') || '')
    const card = contacts.list[id]
    if (!card) { sendJson(res, 200, { ok: false, error: 'unknown contact' }); return }
    // Resolve the peer associations into something renderable: who this person
    // actually appears on messages with, most often first.
    const peers = Object.keys(card.peers || {}).map((address) => {
      const other = contacts.list[contactId(address)]
      return {
        address: address,
        name: other ? (other.display || '') : '',
        count: card.peers[address],
        id: contactId(address),
      }
    }).sort((a, b) => b.count - a.count).slice(0, 40)
    sendJson(res, 200, { ok: true, contact: card, peers: peers })
  }

  const contactsSaveHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    const id = String((input && input.id) || '')
    if (!id) { sendJson(res, 400, { ok: false, error: 'expected {id, patch}' }); return }
    await loadContacts()
    const card = contacts.list[id]
    if (!card) { sendJson(res, 404, { ok: false, error: 'unknown contact' }); return }
    const patch = (input && input.patch) || {}
    const textFields = ['display', 'given', 'family', 'courtesy', 'company', 'title', 'phone', 'note']
    for (let i = 0; i < textFields.length; i++) {
      const key = textFields[i]
      if (typeof patch[key] === 'string') card[key] = patch[key].trim()
    }
    if (Array.isArray(patch.tags)) card.tags = patch.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
    if (patch.avatar && typeof patch.avatar === 'object') {
      const kind = String(patch.avatar.kind || 'auto')
      // A data URL is the only shape stored inline; everything else is a reference.
      // Capped, because a card file that grows without bound is a bad file.
      if (kind === 'data') {
        const value = String(patch.avatar.value || '')
        if (value.indexOf('data:image/') !== 0 || value.length > 400000) {
          sendJson(res, 400, { ok: false, error: '头像数据过大或不是图片' })
          return
        }
        card.avatar = { kind: 'data', value: value }
      } else if (kind === 'url') {
        const value = String(patch.avatar.value || '').trim()
        card.avatar = value ? { kind: 'url', value: value } : { kind: 'auto' }
      } else {
        card.avatar = { kind: 'auto' }
      }
    }
    // An explicit edit is authoritative from now on: applyAutoName must never
    // overwrite what a person typed.
    card.edited = true
    card.updatedAt = Date.now()
    saveContactsSoon()
    sendJson(res, 200, { ok: true, contact: card })
  }

  const contactsDeleteHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    const id = String((input && input.id) || '')
    await loadContacts()
    if (!contacts.list[id]) { sendJson(res, 404, { ok: false, error: 'unknown contact' }); return }
    delete contacts.list[id]
    saveContactsSoon()
    sendJson(res, 200, { ok: true })
  }

  const contactsHarvestHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    await loadContacts()
    const before = contactsArray().length
    const touched = harvestMessages((input && input.messages) || [], String((input && input.accountId) || ''))
    const after = contactsArray().length
    sendJson(res, 200, { ok: true, touched: touched, created: after - before, total: after })
  }

  const contactsSuggestHandler = async (req, res) => {
    if (preflight(req, res)) return
    await loadContacts()
    const accountId = String(param(req.url, 'accountId') || '')
    const query = String(param(req.url, 'q') || '').trim().toLowerCase()
    const limit = Math.max(1, Math.min(Number(param(req.url, 'limit')) || 8, 40))
    // 只候选和当前账号关联的 —— a contact belongs to an account when mail for it
    // was actually seen in that account. A missing accountId yields NOTHING rather
    // than the whole book: a caller that forgets the account must not leak every
    // address into a composer.
    if (!accountId) { sendJson(res, 200, { ok: true, list: [] }); return }
    let list = contactsArray().filter((c) => (c.accounts || []).indexOf(accountId) >= 0)
    if (query) {
      const scored = []
      for (let i = 0; i < list.length; i++) {
        const c = list[i]
        const name = String(c.display || '').toLowerCase()
        const mail = (c.emails || []).join(' ').toLowerCase()
        let score = -1
        if (name.indexOf(query) === 0) score = 0
        else if (name.indexOf(query) > 0) score = 1
        else if (mail.indexOf(query) === 0) score = 2
        else if (mail.indexOf(query) > 0) score = 3
        else if (String(c.company || '').toLowerCase().indexOf(query) >= 0) score = 4
        if (score >= 0) scored.push({ c: c, score: score })
      }
      scored.sort((a, b) => a.score - b.score || (b.c.seen || 0) - (a.c.seen || 0))
      list = scored.map((s) => s.c)
    } else {
      list = list.slice().sort((a, b) => (b.seen || 0) - (a.seen || 0))
    }
    sendJson(res, 200, {
      ok: true,
      list: list.slice(0, limit).map((c) => ({
        id: c.id, display: c.display, email: (c.emails || [])[0] || '',
        company: c.company, seen: c.seen, avatar: c.avatar,
      })),
    })
  }

  // ------------------------------------------------------------- 邮件记忆库 (P1)
  //
  // Selected mail folders are written out as ONE Markdown file per mail, so that
  // 灵枢's own `index_doc` can turn each file into a knowledge node whose doc_ref
  // points back at it.
  //
  // Everything here was verified against the live memory plugin (0.4.8) before it
  // was written:
  //   - `index_doc` accepts a directory OUTSIDE the memory root (3/3 files indexed
  //     from a probe dir, 0 errors), and records the absolute root in doc_ref, so
  //     the export dir must be STABLE;
  //   - it produces ONE node per top-level heading, so one mail per FILE is what
  //     yields one mail per node;
  //   - it does NOT dedupe by the content-prefix signature that `write` uses, so
  //     two mails with identical openings both survive;
  //   - it honours the sensitivity it is given (private, here), and marks the
  //     nodes verification_basis=data — the difference between this and the
  //     contextual layer, where 0 of 58 nodes have any verification basis.
  //
  // This half deliberately does NOT write into the memory plugin's own store:
  // that would bypass its forgetting gate, dedup, review queue, conflict check,
  // sensitivity handling and ingest watermarks. The plugin prepares files; 灵枢's
  // own tools are what turn them into memory.
  const KB_ROOT = join(STORE_DIR, 'mail-kb')
  const KB_JOBS = new Map()
  let kbJobSeq = 0

  // ---------------------------------------------------------------- 设置 (可写)
  //
  // Everything here used to be a literal in this file or in ui.html, which meant
  // changing any of it required editing code and restarting DSH. Defaults are
  // exactly those old literals, so an untouched install behaves identically.
  //
  // `config` (the Cordis plugin config) is a SEPARATE thing and stays read-only:
  // it is deployment wiring chosen by whoever installed the plugin, whereas these
  // are per-user preferences the panel may change at runtime.
  const SETTINGS_PATH = join(STORE_DIR, 'settings.json')
  const DEFAULT_SETTINGS = {
    kbRoot: KB_ROOT,
    kbLimit: 50,          // mails per folder per export
    distillBudget: 20,    // the P2 cap, and the only thing standing between this and
                          // a runaway model bill — so it is configurable instead of a
                          // magic number buried inside a prompt string
    sensitivity: 'private',
    autoIndex: false,     // after an export, open a session that indexes it
    pollMs: 1200,
    // Which hosts this panel may fetch remote images from. An empty list with
    // imageStrict=false is the behaviour that was hardcoded before (fetch
    // anything); turning strict on makes the list an ALLOW-list. "Which hosts may
    // this panel talk to" is a privacy decision the user should be able to make
    // and then keep, which is why it lives in settings.json and not in memory.
    imageHosts: [],
    imageStrict: false,
  }
  const SENSITIVITIES = ['public', 'internal', 'private']

  let settingsCache = null

  // `base` is what an INVALID or ABSENT patch field falls back to. The first
  // version fell back to the built-in default for invalid values, so sending
  // `sensitivity: "nonsense"` silently reset a working `internal` back to
  // `private` — a bad value must keep what was already there, not discard it.
  function normalizeSettings (patch, base) {
    const out = Object.assign({}, DEFAULT_SETTINGS, base || null)
    const input = patch && typeof patch === 'object' ? patch : {}
    if (typeof input.kbRoot === 'string' && input.kbRoot.trim()) out.kbRoot = input.kbRoot.trim()
    if (Number.isFinite(Number(input.kbLimit))) out.kbLimit = Math.max(1, Math.min(500, Math.round(Number(input.kbLimit))))
    if (Number.isFinite(Number(input.distillBudget))) out.distillBudget = Math.max(1, Math.min(500, Math.round(Number(input.distillBudget))))
    if (SENSITIVITIES.indexOf(String(input.sensitivity)) >= 0) out.sensitivity = String(input.sensitivity)
    if (typeof input.autoIndex === 'boolean') out.autoIndex = input.autoIndex
    if (Number.isFinite(Number(input.pollMs))) out.pollMs = Math.max(300, Math.min(10000, Math.round(Number(input.pollMs))))
    // Hosts are normalised to lower case and de-duplicated, because the same host
    // arrives spelled differently from different mails and a duplicate entry is
    // indistinguishable from a bug when someone reads the file.
    if (Array.isArray(input.imageHosts)) {
      const seen = {}
      const list = []
      for (const raw of input.imageHosts) {
        const host = String(raw || '').trim().toLowerCase().replace(/^\.+/, '')
        if (!host || seen[host]) continue
        seen[host] = true
        list.push(host)
      }
      out.imageHosts = list.slice(0, 500)
    }
    if (typeof input.imageStrict === 'boolean') out.imageStrict = input.imageStrict
    return out
  }

  async function loadSettings () {
    if (settingsCache) return settingsCache
    try {
      settingsCache = normalizeSettings(JSON.parse(await readFile(SETTINGS_PATH, 'utf8')), null)
    } catch (error) {
      settingsCache = normalizeSettings(null, null)
    }
    return settingsCache
  }

  async function saveSettings (patch) {
    const current = await loadSettings()
    // Merge, do not replace: the panel saves one section at a time, and replacing
    // would silently reset every field that section did not carry.
    //
    // A null patch means RESET, and a reset must not merge — merging with the
    // current values is what made `reset:true` a no-op that reported success.
    const base = patch && typeof patch === 'object' ? current : null
    settingsCache = normalizeSettings(patch, base)
    await mkdir(STORE_DIR, { recursive: true })
    await writeFile(SETTINGS_PATH, JSON.stringify(settingsCache, null, 2), 'utf8')
    return settingsCache
  }

  const settingsGetHandler = async (req, res) => {
    if (preflight(req, res)) return
    const current = await loadSettings()
    sendJson(res, 200, { ok: true, settings: current, defaults: DEFAULT_SETTINGS, store: STORE_DIR, path: SETTINGS_PATH })
  }

  const settingsSetHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    if (!input || typeof input !== 'object') { sendJson(res, 400, { ok: false, error: 'expected a settings object' }); return }
    try {
      // `reset: true` restores the defaults, which is the way back if a bad kbRoot
      // ever makes the features unusable.
      const saved = input.reset === true ? await saveSettings(null) : await saveSettings(input)
      sendJson(res, 200, { ok: true, settings: saved })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: err(error) })
    }
  }

  const kbDate = (ms) => {
    const d = new Date(Number(ms) || Date.now())
    const p = (n) => (n < 10 ? '0' : '') + n
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  // One mail -> one file with exactly one level-1 heading, because that is the
  // unit index_doc turns into a node. The sub-headings become that node's 子节.
  const kbDocFor = (folder, header, bodyText) => {
    const subject = String((header && header.subject) || '(无主题)')
    const lines = [
      '# ' + subject,
      '',
      '## 邮件信息',
      '- 文件夹：' + String((folder && (folder.path || folder.name)) || folder || '-'),
      '- 发件人：' + String((header && header.author) || '-'),
      '- 收件人：' + (((header && header.recipients) || []).join(', ') || '-'),
      '- 时间：' + new Date(Number((header && header.date) || Date.now())).toISOString(),
      '- messageId：' + String((header && header.id) || '-'),
      '',
      '## 正文',
      '',
      String(bodyText || '(没有可读正文)').trim(),
      '',
    ]
    return lines.join('\n')
  }

  async function kbRun (job, folders, limit, root) {
    try {
      await mkdir(root, { recursive: true })
      const index = ['# 邮件记忆库', '', '导出目录：`' + root + '`', '']
      job.state = 'running'
      for (let f = 0; f < folders.length; f++) {
        if (job.cancel) break
        const folder = folders[f]
        job.folder = String((folder && (folder.name || folder.path)) || folder.id)
        const list = await bridge('messages.list', { folderId: folder.id, limit: limit }, 180000)
        const messages = (list && list.messages) || []
        const dir = join(root, slugify(String(folder.accountId || 'acc')) + '__' + slugify(folder.name || folder.path, 32))
        await mkdir(dir, { recursive: true })
        let wrote = 0
        for (let i = 0; i < messages.length; i++) {
          if (job.cancel) break
          const header = messages[i]
          job.done += 1
          job.current = String(header.subject || header.id || '')
          let text = ''
          try {
            const body = await bridge('messages.body', { messageId: header.id, preferHtml: false }, 180000)
            text = (body && body.text) || ''
          } catch (error) {
            job.errors.push({ id: header.id, error: err(error) })
            continue
          }
          // The id is in the name on purpose: two mails can share a date and a
          // subject, and one file per mail is the whole point.
          const name = kbDate(header.date) + '-' + slugify(header.subject, 40) + '-' + String(header.id) + '.md'
          await writeFile(join(dir, name), kbDocFor(folder, header, text), 'utf8')
          wrote += 1
          job.files += 1
        }
        index.push('## ' + String(folder.name || folder.path) + '（' + wrote + ' 封）', '')
        index.push('目录：`' + dir + '`', '')
        job.folders.push({ id: folder.id, name: folder.name || folder.path, messages: wrote, dir: dir })
      }
      index.push('## 下一步', '', '在 DSH 会话里对这个目录运行 `lingshu_cg(op="index_doc", path=…)`，', '即可把每封邮件变成一条 knowledge 节点，正文用 `op=ref` 回读。', '')
      await writeFile(join(root, 'INDEX.md'), index.join('\n'), 'utf8')
      await writeFile(join(root, 'state.json'), JSON.stringify({
        root: root,
        exportedAt: Date.now(),
        folders: job.folders,
      }, null, 2), 'utf8')
      job.state = job.cancel ? 'cancelled' : 'done'
    } catch (error) {
      job.state = 'error'
      job.errors.push({ error: err(error) })
    }
    job.finishedAt = Date.now()
  }

  const kbExportHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    const folders = Array.isArray(input && input.folders) ? input.folders : []
    if (!folders.length) { sendJson(res, 400, { ok: false, error: 'expected {folders: [{id, name, accountId}]}' }); return }
    const current = await loadSettings()
    // The request may carry a per-run limit and root; the saved settings are the
    // default, so "导出 selected folders" obeys the config without the panel
    // having to echo it back.
    const root = (typeof (input && input.root) === 'string' && input.root.trim()) ? input.root.trim() : current.kbRoot
    const limit = Math.max(1, Math.min(Number(input && input.limit) || current.kbLimit, 500))
    const job = {
      id: 'kb' + (++kbJobSeq) + '-' + Date.now().toString(36),
      state: 'starting', startedAt: Date.now(), finishedAt: 0,
      folder: '', current: '', done: 0, files: 0, folders: [], errors: [], cancel: false,
      total: folders.length,
      root: root,
    }
    KB_JOBS.set(job.id, job)
    // Fire and forget: the panel polls kb/status. A folder can hold thousands of
    // mails and one body fetch is one round trip to the extension.
    kbRun(job, folders, limit, root)
    sendJson(res, 200, { ok: true, job: job.id, root: root, limit: limit, sensitivity: current.sensitivity })
  }

  const kbStatusHandler = async (req, res) => {
    if (preflight(req, res)) return
    const id = String(param(req.url, 'job') || '')
    // `param` returns NULL when the key is absent, and `null !== undefined` is
    // true — so `!== undefined` here cancelled every job on the first status poll
    // instead of reporting it, and the export stopped after one mail.
    if (param(req.url, 'cancel') !== null) {
      const job = KB_JOBS.get(id)
      if (job) job.cancel = true
      sendJson(res, 200, { ok: true, cancelled: !!job })
      return
    }
    if (id) {
      const job = KB_JOBS.get(id)
      if (!job) { sendJson(res, 200, { ok: false, error: 'unknown job' }); return }
      sendJson(res, 200, {
        ok: true, id: job.id, state: job.state, root: job.root,
        folder: job.folder, current: job.current,
        done: job.done, files: job.files, folders: job.folders,
        errorCount: job.errors.length, errors: job.errors.slice(0, 5),
      })
      return
    }
    // No id: report the last export and the directory, so the panel can show
    // what is already there after a restart (jobs do not survive one).
    const current = await loadSettings()
    let state = null
    try { state = JSON.parse(await readFile(join(current.kbRoot, 'state.json'), 'utf8')) } catch (error) { state = null }
    sendJson(res, 200, { ok: true, root: current.kbRoot, state: state, jobs: KB_JOBS.size })
  }

  // -------------------------------------------------------- 邮件列表磁盘缓存
  //
  // The panel already cached each folder's page, but in localStorage — a ~5MB
  // store, so it was capped and trimmed to six folders of 120 headers, and it did
  // not outlive a DSH restart. That is the "有缓存了，但重启还要重新加载" report.
  //
  // localStorage stays exactly as it is, because it is the only SYNCHRONOUS store
  // and it is what paints the first frame before any request has returned. This is
  // the durable copy behind it: no size cap worth worrying about, no trimming, and
  // it survives a restart. Two tiers, each doing the thing it is good at.
  const CACHE_DIR = join(STORE_DIR, 'cache')
  const CACHE_FILE = join(CACHE_DIR, 'lists.json')

  const cacheGetHandler = async (req, res) => {
    if (preflight(req, res)) return
    try {
      const lists = JSON.parse(await readFile(CACHE_FILE, 'utf8'))
      sendJson(res, 200, { ok: true, lists: lists && typeof lists === 'object' ? lists : {} })
    } catch (error) {
      // No cache yet is the normal first-run answer, not an error.
      sendJson(res, 200, { ok: true, lists: null })
    }
  }

  const cacheSetHandler = async (req, res) => {
    if (preflight(req, res)) return
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const input = await readJson(req)
    const lists = input && input.lists
    if (!lists || typeof lists !== 'object') { sendJson(res, 400, { ok: false, error: 'expected {lists}' }); return }
    try {
      await mkdir(CACHE_DIR, { recursive: true })
      await writeFile(CACHE_FILE, JSON.stringify(lists), 'utf8')
      sendJson(res, 200, { ok: true, folders: Object.keys(lists).length })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: err(error) })
    }
  }

  // ---- mount ---------------------------------------------------------------

  const routes = [
    ['/api/thunderbird/poll', pollHandler],
    ['/api/thunderbird/result', resultHandler],
    ['/api/thunderbird/event', eventHandler],
    ['/api/thunderbird/events', eventsHandler],
    ['/api/thunderbird/status', statusHandler],
    ['/api/thunderbird/rpc', rpcHandler],
    ['/api/thunderbird/ui', uiHandler],
    ['/api/thunderbird/ai', aiHandler],
    ['/api/thunderbird/ai/status', aiStatusHandler],
    ['/api/thunderbird/session/list', sessionListHandler],
    ['/api/thunderbird/session/create', sessionCreateHandler],
    ['/api/thunderbird/session/sync', sessionSyncHandler],
    ['/api/thunderbird/session/attach', sessionAttachHandler],
    ['/api/thunderbird/session/log', sessionLogHandler],
    ['/api/thunderbird/session/remove', sessionRemoveHandler],
    ['/api/thunderbird/session/detach', sessionDetachHandler],
    ['/api/thunderbird/kb/export', kbExportHandler],
    ['/api/thunderbird/cache', cacheGetHandler],
    ['/api/thunderbird/cache/set', cacheSetHandler],
    ['/api/thunderbird/kb/status', kbStatusHandler],
    ['/api/thunderbird/contacts/list', contactsListHandler],
    ['/api/thunderbird/contacts/get', contactsGetHandler],
    ['/api/thunderbird/contacts/save', contactsSaveHandler],
    ['/api/thunderbird/contacts/delete', contactsDeleteHandler],
    ['/api/thunderbird/contacts/harvest', contactsHarvestHandler],
    ['/api/thunderbird/contacts/suggest', contactsSuggestHandler],
    ['/api/thunderbird/settings', settingsGetHandler],
    ['/api/thunderbird/settings/set', settingsSetHandler],
    ['/api/thunderbird/session/file', sessionFileHandler],
    ['/api/thunderbird/session/transcript', transcriptHandler],
    ['/api/thunderbird/image', imageProxyHandler],
    ['/api/thunderbird/local-image', localImageHandler],
  ]
  const disposers = []
  for (let i = 0; i < routes.length; i++) {
    try {
      disposers.push(webServer.register({ kind: 'exact', path: routes[i][0], handler: routes[i][1] }))
    } catch (error) {
      console.error('[dsh-thunderbird] route already registered, skipping ' + routes[i][0] + ': ' + err(error))
    }
  }
  ctx.effect(() => () => {
    for (let i = 0; i < disposers.length; i++) {
      try { disposers[i]() } catch (error) { /* already released by the fiber */ }
    }
  })

  ctx.effect(() => () => {
    const pending = Array.from(state.pending.values())
    state.pending.clear()
    for (let i = 0; i < pending.length; i++) {
      try { pending[i]({ ok: false, error: 'bridge stopped' }) } catch (error) { /* ignore */ }
    }
  })

  registerTools()
  loadStore().then(() => {
    const count = Object.keys(store.sessions).length
    console.log('[dsh-thunderbird] ' + count + ' mail session(s) recorded in ' + REGISTRY_PATH)
  }).catch((error) => {
    console.error('[dsh-thunderbird] session registry unreadable: ' + err(error))
  })

  console.log('[dsh-thunderbird] bridge mounted at /api/thunderbird/* (ui: ' + uiPath + ')')
}
