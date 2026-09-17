'use strict'

// DSH Thunderbird Bridge — MailExtension half.
//
// Direction: this add-on is the HTTP CLIENT. DSH hosts the endpoints
// (/api/thunderbird/poll|result|event) on its own web server, so no socket has
// to be opened from inside Thunderbird and no native-messaging host is needed.
//
// Loop: long-poll DSH for commands -> run them against the Thunderbird
// WebExtension APIs -> POST the result back. Unsolicited events (new mail) are
// pushed through /api/thunderbird/event.

const api = typeof browser !== 'undefined' ? browser : messenger

const DEFAULTS = { baseUrl: 'http://127.0.0.1:43129', pollWaitMs: 25000, retryMs: 3000 }
let config = Object.assign({}, DEFAULTS)
let online = false
let inFlight = 0

// In-memory breadcrumbs. The polling loop must never depend on storage being
// healthy, so this stays a plain object and is only reported on request.
const diag = {
  bootedAt: Date.now(),
  polls: 0,
  commands: 0,
  lastPollAt: 0,
  lastOkAt: 0,
  lastError: '',
  lastErrorAt: 0,
  storageOk: null,
  transport: '',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const box = (v) => (v == null ? '' : String(v))

// MessageId is an integer in current Thunderbird schemas (TB 122+). Keep the
// caller's value intact and coerce only a purely numeric string.
const toMessageId = (value) => {
  if (typeof value === 'number') return value
  const text = box(value).trim()
  if (text !== '' && String(Number(text)) === text) return Number(text)
  return value
}

const usableId = (id) => id !== null && id !== undefined && id !== ''

function setStatus (next) {
  if (online === next) { online = next; return }
  online = next
  try {
    if (api.browserAction && api.browserAction.setBadgeText) {
      api.browserAction.setBadgeText({ text: next ? '' : '×' })
      api.browserAction.setBadgeBackgroundColor({ color: next ? '#2e9e5b' : '#c0392b' })
      api.browserAction.setTitle({ title: next ? 'DSH Thunderbird Bridge：已连接' : 'DSH Thunderbird Bridge：未连接' })
    }
  } catch (e) { /* browserAction is optional */ }
}

// ---------------------------------------------------------------- normalizers

function normIdentity (i) {
  if (!i) return null
  return {
    id: box(i.id),
    name: box(i.name),
    email: box(i.email),
    replyTo: box(i.replyTo),
    organization: box(i.organization),
    // The identity's own signature as Thunderbird stores it, plus which flavour
    // it is. Both come back empty when this Thunderbird build does not expose
    // them under the granted permissions, in which case the panel falls back to
    // its own per-account signature library.
    signature: box(i.signature),
    signatureIsHTML: i.signatureIsHTML === true,
  }
}

function normFolder (f, depth) {
  if (!f) return null
  const d = depth || 0
  return {
    id: box(f.id),
    name: box(f.name),
    path: box(f.path),
    accountId: box(f.accountId),
    specialUse: f.specialUse || (f.type ? [f.type] : []),
    depth: d,
    subFolders: (f.subFolders || []).map((s) => normFolder(s, d + 1)),
  }
}

function normHeader (h) {
  if (!h) return null
  const when = h.date ? new Date(h.date).getTime() : 0
  return {
    id: h.id,
    author: box(h.author),
    recipients: (h.recipients || []).map(box),
    ccList: (h.ccList || []).map(box),
    bccList: (h.bccList || []).map(box),
    subject: box(h.subject),
    date: Number.isFinite(when) ? when : 0,
    read: !!h.read,
    flagged: !!h.flagged,
    junk: !!h.junk,
    isNew: !!h.new,
    headersOnly: !!h.headersOnly,
    external: !!h.external,
    size: h.size || 0,
    tags: h.tags || [],
    priority: box(h.priority),
    headerMessageId: box(h.headerMessageId),
    folderId: h.folder ? box(h.folder.id) : null,
    folderName: h.folder ? box(h.folder.name) : '',
    accountId: h.folder ? box(h.folder.accountId) : '',
  }
}

function collectParts (part, out, depth) {
  if (!part || typeof part !== 'object') return out
  const level = depth || 0
  if (level > 8) return out
  const ct = String(part.contentType || '').toLowerCase()
  if (ct.indexOf('text/') === 0 && typeof part.body === 'string' && part.body.length) {
    out.push({ contentType: ct, body: part.body })
  }
  const kids = part.parts || []
  for (let i = 0; i < kids.length; i++) collectParts(kids[i], out, level + 1)
  return out
}

// Compact structural summary, used only to explain an unreadable body.
function describePart (part) {
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 3) return ''
    const ct = String(node.contentType || '-')
    const size = typeof node.body === 'string' ? 'body:' + node.body.length : 'nobody'
    const kids = (node.parts || []).map((k) => walk(k, depth + 1)).filter(Boolean).join(',')
    return ct + '(' + size + ')' + (kids ? '[' + kids + ']' : '')
  }
  if (!part || typeof part !== 'object') return 'not-an-object'
  return walk(part, 0) || 'keys=' + Object.keys(part).join(',')
}

function splitRecipients (value) {
  if (Array.isArray(value)) return value.map(box).filter(Boolean)
  return String(value || '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function escapeHtml (text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function textToHtml (text) {
  return '<div>' + escapeHtml(text).replace(/\r?\n/g, '<br>') + '</div>'
}

function messageListFrom (value) {
  if (!value) return { listId: null, messages: [] }
  if (Array.isArray(value)) return { listId: null, messages: value }
  return { listId: value.id ? String(value.id) : null, messages: value.messages || [] }
}

// ------------------------------------------------------------------- methods
// Each entry answers one DSH command. They return plain JSON only.

const methods = {}

methods.ping = async () => {
  let accountCount = 0
  try { accountCount = (await api.accounts.list(false)).length } catch (e) { accountCount = -1 }
  return {
    thunderbird: true,
    version: api.runtime.getManifest().version,
    accounts: accountCount,
    capabilities: {
      compose: !!(api.compose && api.compose.beginNew),
      sendDirect: !!(api.messages && api.messages.sendMessage),
      folders: !!(api.folders && api.folders.query),
    },
  }
}

methods['accounts.list'] = async () => {
  const accounts = await api.accounts.list(true)
  return accounts.map((a) => ({
    id: box(a.id),
    name: box(a.name),
    type: box(a.type),
    identities: (a.identities || []).map(normIdentity),
    rootFolder: normFolder(a.rootFolder, 0),
  }))
}

methods['folders.tree'] = async () => {
  const accounts = await api.accounts.list(true)
  return accounts.map((a) => ({
    accountId: box(a.id),
    accountName: box(a.name),
    rootFolder: normFolder(a.rootFolder, 0),
  }))
}

methods['folders.list'] = async () => {
  const folders = await api.folders.query({})
  return folders.map((f) => ({
    id: box(f.id),
    name: box(f.name),
    path: box(f.path),
    accountId: box(f.accountId),
    specialUse: f.specialUse || [],
  }))
}

methods['messages.list'] = async (params) => {
  const folderId = box(params.folderId)
  const limit = Math.max(1, Math.min(Number(params.limit) || 60, 2000))
  const unreadOnly = !!params.unreadOnly

  // messages.list() is the only call that accepts server-side sort keys
  // (sortType/sortOrder, TB 148+). messages.query() silently ignores them and
  // hands back the folder in ASCENDING order, so "first N" used to mean the
  // OLDEST N — the panel showed old mail and never reached the newest.
  let list = null
  try {
    list = await api.messages.list(folderId, { sortType: 'date', sortOrder: 'descending' })
  } catch (error) {
    list = null
  }
  if (list === null) {
    const queryInfo = { folderId, messagesPerPage: Math.min(limit * 2, 1000), autoPaginationTimeout: 0 }
    if (unreadOnly) queryInfo.unread = true
    try {
      list = await api.messages.query(queryInfo)
    } catch (error) {
      list = await api.messages.list(folderId)
    }
  }

  const page = messageListFrom(list)
  let messages = page.messages.map(normHeader)
  // Sort the whole page before slicing: slicing first is what lost the newest mail.
  messages.sort((a, b) => (b.date || 0) - (a.date || 0))
  if (unreadOnly) messages = messages.filter((m) => !m.read)
  return { listId: page.listId, total: page.messages.length, messages: messages.slice(0, limit) }
}

methods['messages.get'] = async (params) => normHeader(await api.messages.get(toMessageId(params.messageId)))

methods['messages.body'] = async (params) => {
  const messageId = toMessageId(params.messageId)
  const notes = []
  let text = ''
  let html = ''

  // TB 128+ exposes the readable inline parts directly.
  if (api.messages.listInlineTextParts) {
    try {
      const parts = await api.messages.listInlineTextParts(messageId)
      notes.push('inline:' + ((parts && parts.length) || 0))
      for (let i = 0; i < (parts || []).length; i++) {
        const part = parts[i]
        const ct = String(part.contentType || '').toLowerCase()
        const body = typeof part.body === 'string' ? part.body : ''
        if (!body.trim()) continue
        // Longest wins: Word/VML business mail often ships a short plain-text
        // stub beside the real HTML body, and taking the first part truncated it.
        if (ct.indexOf('text/plain') === 0 && body.length > text.length) text = body
        if (ct.indexOf('text/html') === 0 && body.length > html.length) html = body
      }
    } catch (error) {
      notes.push('inline failed: ' + ((error && error.message) || error))
    }
  }

  if (!text && !html) {
    let size = 0
    try {
      const header = await api.messages.get(messageId)
      size = (header && header.size) || 0
    } catch (error) { /* size is advisory only */ }
    notes.push('size:' + size)
    if (size > 8000000) {
      // getFull with decodeContent pulls the whole message plus attachments.
      notes.push('skipped: larger than 8MB')
    } else {
      try {
        const full = await api.messages.getFull(messageId, { decodeContent: true })
        const parts = collectParts(full, [], 0)
        notes.push('full:' + parts.length)
        for (let i = 0; i < parts.length; i++) {
          if (parts[i].contentType.indexOf('text/plain') === 0 && parts[i].body.length > text.length) text = parts[i].body
          if (parts[i].contentType.indexOf('text/html') === 0 && parts[i].body.length > html.length) html = parts[i].body
        }
        if (!parts.length) notes.push('shape=' + describePart(full))
      } catch (error) {
        notes.push('full failed: ' + ((error && error.message) || error))
      }
    }
  }

  let attachments = []
  if (api.messages.listAttachments) {
    try {
      const list = await api.messages.listAttachments(messageId)
      attachments = (list || []).map((a) => ({
        name: box(a.name),
        size: a.size || 0,
        contentType: box(a.contentType),
        partName: box(a.partName),
        // Related parts (inline images) carry a content-id that the HTML body
        // references as src="cid:<contentId>".
        contentId: box(a.contentId),
      }))
    } catch (error) {
      notes.push('attachments failed: ' + ((error && error.message) || error))
    }
  }

  return { text, html, notes, attachments }
}

// Inline images, fetched lazily and returned as data: URLs so the panel can
// resolve src="cid:<contentId>" without any second request.
const INLINE_IMAGE_LIMIT = 12
const INLINE_IMAGE_MAX_BYTES = 4000000

function fileToDataUrl (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

methods['messages.inlineImages'] = async (params) => {
  const messageId = toMessageId(params.messageId)
  if (!api.messages.listAttachments || !api.messages.getAttachmentFile) return { images: [] }
  const list = await api.messages.listAttachments(messageId)
  const wanted = (list || []).filter((a) => {
    return String(a.contentType || '').indexOf('image/') === 0 && (a.size || 0) <= INLINE_IMAGE_MAX_BYTES
  }).slice(0, INLINE_IMAGE_LIMIT)

  const images = []
  for (let i = 0; i < wanted.length; i++) {
    const part = wanted[i]
    try {
      const file = await api.messages.getAttachmentFile(messageId, box(part.partName))
      images.push({
        partName: box(part.partName),
        contentId: box(part.contentId),
        name: box(part.name),
        contentType: box(part.contentType),
        size: part.size || 0,
        dataUrl: await fileToDataUrl(file),
      })
    } catch (error) {
      images.push({
        partName: box(part.partName),
        contentId: box(part.contentId),
        name: box(part.name),
        contentType: box(part.contentType),
        size: part.size || 0,
        error: String((error && error.message) || error),
      })
    }
  }
  return { images }
}

// Diagnostic: WebExtension APIs are exposed per granted permission, so a missing
// API is usually a missing permission rather than a missing version.
methods['debug.api'] = async () => {
  const keysOf = (value) => (value ? Object.keys(value).sort() : null)
  let granted = null
  try {
    granted = api.permissions && api.permissions.getAll ? await api.permissions.getAll() : null
  } catch (error) {
    granted = String((error && error.message) || error)
  }
  return {
    version: api.runtime.getManifest().version,
    manifestPermissions: (api.runtime.getManifest().permissions || []).slice(),
    messages: keysOf(api.messages),
    tags: keysOf(api.messages && api.messages.tags),
    windows: keysOf(api.windows),
    granted,
    diag: Object.assign({}, diag, {
      online,
      inFlight,
      config: Object.assign({}, config),
      now: Date.now(),
    }),
  }
}

// Escape hatch: open the message in a real Thunderbird tab (attachments,
// message/rfc822 nests, and anything else this panel does not render).
methods['mail.open'] = async (params) => {
  if (!api.messageDisplay || !api.messageDisplay.open) {
    throw new Error('this Thunderbird build has no messageDisplay.open')
  }
  const opened = await api.messageDisplay.open({ messageId: toMessageId(params.messageId) })
  // Raising Thunderbird is the ADD-ON's job: the caller is another application,
  // and `focused: true` alone routinely leaves the window behind it on Windows.
  // Restore first (a minimized window cannot take focus), then focus AND ask for
  // attention, which is what actually pulls it to the front.
  try {
    const windows = api.windows && api.windows.getAll
      ? await api.windows.getAll({ windowTypes: ['normal'] })
      : []
    for (let i = 0; i < windows.length; i++) {
      if (windows[i].state === 'minimized') {
        try { await api.windows.update(windows[i].id, { state: 'normal' }) } catch (e) { /* optional */ }
      }
    }
    const target = opened && opened.windowId !== undefined
      ? opened.windowId
      : (windows.length ? windows[0].id : undefined)
    if (target !== undefined) {
      await api.windows.update(target, { focused: true, drawAttention: true })
    }
  } catch (error) { /* focus is best-effort; the message is already open */ }
  return { opened: true, messageId: toMessageId(params.messageId) }
}

// Search is server-side, so it is NOT limited by how much of the list the panel
// has loaded. fullText alone returned nothing here (it depends on Thunderbird's
// global index, which may still be building), so run the cheap header matches
// too and merge the hits.
methods['messages.search'] = async (params) => {
  // Field-specific search: subject / author / fullText are PREDICATES, and
  // messages.query ANDs them, so asking for two fields is one query — not the
  // three merged strategies the plain-text path needs. `text` stays supported
  // for the callers that only have a blob to search for.
  const subject = box(params.subject).trim()
  const author = box(params.author).trim()
  const fullText = box(params.fullText !== undefined && params.fullText !== null ? params.fullText : params.text).trim()
  if (!subject && !author && !fullText) return { messages: [], strategies: [] }
  const limit = Math.max(1, Math.min(Number(params.limit) || 60, 300))
  const base = { messagesPerPage: Math.min(limit * 3, 500), autoPaginationTimeout: 0 }
  if (params.folderId) base.folderId = box(params.folderId)

  const predicates = []
  if (subject) predicates.push(['subject', subject])
  if (author) predicates.push(['author', author])
  if (fullText) predicates.push(['fullText', fullText])

  // The plain-text path (no explicit field, or fullText alone) keeps the merged
  // strategies: a bare word may live in the subject, the sender or the body.
  if (subject || author) {
    const info = Object.assign({}, base)
    for (let i = 0; i < predicates.length; i++) info[predicates[i][0]] = predicates[i][1]
    try {
      const page = messageListFrom(await api.messages.query(info))
      const messages = page.messages.map(normHeader).sort((a, b) => (b.date || 0) - (a.date || 0))
      return { messages: messages.slice(0, limit), strategies: [predicates.map((p) => p[0]).join('+') + ':' + messages.length] }
    } catch (error) {
      return { messages: [], strategies: ['query:err:' + String((error && error.message) || error)] }
    }
  }

  const attempts = ['subject', 'author', 'fullText']
  const collected = []
  const seen = {}
  const strategies = []
  for (let i = 0; i < attempts.length; i++) {
    const field = attempts[i]
    const info = Object.assign({}, base)
    info[field] = fullText
    try {
      const page = messageListFrom(await api.messages.query(info))
      strategies.push(field + ':' + page.messages.length)
      for (let j = 0; j < page.messages.length; j++) {
        const item = normHeader(page.messages[j])
        const key = String(item.id)
        if (seen[key]) continue
        seen[key] = true
        collected.push(item)
      }
    } catch (error) {
      strategies.push(field + ':err')
    }
    if (collected.length >= limit) break
  }
  collected.sort((a, b) => (b.date || 0) - (a.date || 0))
  return { messages: collected.slice(0, limit), strategies }
}

methods['messages.update'] = async (params) => {
  const props = {}
  if (typeof params.read === 'boolean') props.read = params.read
  if (typeof params.flagged === 'boolean') props.flagged = params.flagged
  if (typeof params.junk === 'boolean') props.junk = params.junk
  if (Array.isArray(params.tags)) props.tags = params.tags.map(box)
  await api.messages.update(toMessageId(params.messageId), props)
  return { updated: true, applied: Object.keys(props) }
}

methods['messages.delete'] = async (params) => {
  const ids = (params.messageIds || []).map(toMessageId).filter(usableId)
  if (!ids.length) return { deleted: 0 }
  // No options argument: let Thunderbird use its own policy (move to Trash when
  // the account has one) instead of passing `true`, which means delete permanently.
  await api.messages.delete(ids)
  return { deleted: ids.length }
}

methods['messages.move'] = async (params) => {
  const ids = (params.messageIds || []).map(toMessageId).filter(usableId)
  if (!ids.length || !params.destination) return { moved: 0 }
  await api.messages.move(ids, box(params.destination))
  return { moved: ids.length }
}

methods['messages.send'] = async (params) => {
  const details = { subject: box(params.subject) }
  const to = splitRecipients(params.to)
  const cc = splitRecipients(params.cc)
  const bcc = splitRecipients(params.bcc)
  if (to.length) details.to = to
  if (cc.length) details.cc = cc
  if (bcc.length) details.bcc = bcc
  if (params.identityId) details.identityId = box(params.identityId)
  const body = box(params.body)
  if (params.isPlainText) {
    details.plainTextBody = body
    details.isPlainText = true
  } else {
    details.body = textToHtml(body)
  }
  if (!to.length && !cc.length && !bcc.length) throw new Error('至少需要一个收件人')
  if (api.compose && api.compose.beginNew) {
    const tab = await api.compose.beginNew(null, details)
    try {
      await api.compose.sendMessage(tab.id, { mode: 'sendNow' })
    } catch (e) {
      if (api.compose.close) { try { await api.compose.close(tab.id) } catch (ignored) {} }
      throw e
    }
    return { sent: true, via: 'compose', tabId: tab.id }
  }
  if (api.messages.sendMessage) {
    await api.messages.sendMessage(details)
    return { sent: true, via: 'messages.sendMessage' }
  }
  throw new Error('当前 Thunderbird 版本没有可用的发送接口')
}

methods['tags.list'] = async () => {
  const tags = await api.messages.listTags()
  return tags.map((t) => ({ key: box(t.key), tag: box(t.tag), color: box(t.color), ordinal: box(t.ordinal) }))
}

methods['addressBooks.list'] = async () => {
  const books = await api.addressBooks.list(true)
  return books.map((b) => ({
    id: box(b.id),
    name: box(b.name),
    contacts: (b.contacts || []).map((c) => ({
      id: box(c.id),
      name: box(c.properties && c.properties.DisplayName),
      email: box(c.properties && c.properties.PrimaryEmail),
    })),
  }))
}

// ---------------------------------------------------------------------- loop

async function fetchWithTimeout (url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, Object.assign({ cache: 'no-store' }, options || {}, { signal: controller.signal }))
  } finally {
    clearTimeout(timer)
  }
}

// XMLHttpRequest is the transport MailExtensions have supported the longest, so
// it is kept as a fallback for builds where fetch() is unavailable or blocked.
function xhrRequest (method, url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url, true)
    xhr.timeout = timeoutMs
    if (body != null) xhr.setRequestHeader('content-type', 'application/json')
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText })
    xhr.onerror = () => reject(new Error('XMLHttpRequest network error'))
    xhr.ontimeout = () => reject(new Error('XMLHttpRequest timeout'))
    xhr.onabort = () => reject(new Error('XMLHttpRequest aborted'))
    try {
      xhr.send(body == null ? null : JSON.stringify(body))
    } catch (error) {
      reject(error)
    }
  })
}

async function httpRequest (method, url, body, timeoutMs) {
  let fetchError = null
  try {
    const res = await fetchWithTimeout(url, {
      method,
      headers: body == null ? undefined : { 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    }, timeoutMs)
    diag.transport = 'fetch'
    return { status: res.status, text: await res.text() }
  } catch (error) {
    fetchError = error
  }
  if (typeof XMLHttpRequest === 'undefined') throw fetchError
  const res = await xhrRequest(method, url, body, timeoutMs)
  diag.transport = 'xhr'
  return res
}

async function postJson (path, payload) {
  const res = await httpRequest('POST', config.baseUrl + path, payload, 20000)
  if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status)
  return res
}

async function runCommand (cmd) {
  try {
    const fn = methods[cmd.method]
    if (typeof fn !== 'function') throw new Error('unknown method: ' + cmd.method)
    return { id: cmd.id, ok: true, result: await fn(cmd.params || {}) }
  } catch (e) {
    return { id: cmd.id, ok: false, error: String((e && e.message) || e) }
  }
}

async function loop () {
  while (true) {
    try {
      const url = config.baseUrl + '/api/thunderbird/poll?wait=' + config.pollWaitMs + '&client=thunderbird'
      const res = await httpRequest('GET', url, null, Number(config.pollWaitMs) + 15000)
      if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status)
      const data = JSON.parse(res.text)
      diag.polls += 1
      diag.lastPollAt = Date.now()
      diag.lastOkAt = diag.lastPollAt
      setStatus(true)
      const commands = (data && data.commands) || []
      diag.commands += commands.length
      // Dispatch concurrently: decoding one large message over IMAP must not
      // block the status/list calls queued behind it.
      for (let i = 0; i < commands.length; i++) {
        const command = commands[i]
        inFlight += 1
        runCommand(command)
          .then((payload) => postJson('/api/thunderbird/result', payload))
          .catch(() => { /* DSH restarted; the next poll re-syncs */ })
          .then(() => { inFlight -= 1 })
      }
      while (inFlight > 6) await sleep(50)
    } catch (e) {
      diag.lastError = String((e && e.message) || e)
      diag.lastErrorAt = Date.now()
      setStatus(false)
      await sleep(config.retryMs)
    }
  }
}

async function pushEvent (type, data) {
  try { await postJson('/api/thunderbird/event', { type, data, at: Date.now() }) } catch (e) { /* offline */ }
}

function wireEvents () {
  try {
    if (api.messages.onNewMailReceived) {
      api.messages.onNewMailReceived.addListener((folder, received) => {
        const page = messageListFrom(received)
        pushEvent('newMail', {
          folderId: folder ? box(folder.id) : null,
          folderName: folder ? box(folder.name) : '',
          count: page.messages.length,
          messages: page.messages.slice(0, 20).map(normHeader),
        })
      })
    }
  } catch (e) { /* event is optional */ }
}

// Storage is a *convenience* here: a hung or half-migrated storage backend must
// never be able to keep the bridge off the wire, so the read is time-boxed and
// the poll loop is started first.
async function loadConfig () {
  try {
    const stored = await Promise.race([
      api.storage.local.get(DEFAULTS),
      sleep(4000).then(() => null),
    ])
    if (stored) {
      config = Object.assign({}, DEFAULTS, stored)
      diag.storageOk = true
    } else {
      diag.storageOk = false
      diag.lastError = 'storage.local.get timed out; using defaults'
      diag.lastErrorAt = Date.now()
    }
  } catch (e) {
    diag.storageOk = false
    diag.lastError = 'storage.local.get failed: ' + String((e && e.message) || e)
    diag.lastErrorAt = Date.now()
  }
  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      const keys = Object.keys(DEFAULTS)
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]
        if (changes[k]) config[k] = changes[k].newValue
      }
    })
  } catch (e) { /* storage listener is optional */ }
}

function main () {
  wireEvents()
  setStatus(false)
  loadConfig()
  // Heartbeat so DSH can tell "add-on never started" from "add-on started but
  // cannot reach DSH"; it also flips the host to online immediately.
  pushEvent('bridge/start', {
    version: api.runtime.getManifest().version,
    baseUrl: config.baseUrl,
    bootedAt: diag.bootedAt,
  })
  loop()
}

main()
