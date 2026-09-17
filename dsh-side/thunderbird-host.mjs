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
import { readFile } from 'node:fs/promises'

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
      endpoints: ['/api/thunderbird/poll', '/api/thunderbird/result', '/api/thunderbird/event', '/api/thunderbird/rpc', '/api/thunderbird/ai', '/api/thunderbird/ui'],
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

  console.log('[dsh-thunderbird] bridge mounted at /api/thunderbird/* (ui: ' + uiPath + ')')
}
