// Mounts the host half of the package against a stub Cordis context and a real
// HTTP server, points the protocol double at it, and drives the mail-session
// endpoints end to end. This is how the host half is verified without
// restarting DSH.
//
//   node dev/test-host.mjs
//
// Exit code 0 means every assertion held.

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.TEST_PORT || 43131)
const BASE = 'http://127.0.0.1:' + PORT

const home = await mkdtemp(join(tmpdir(), 'dsh-tb-test-'))
process.env.DSH_HOME = home

const routes = new Map()
const effects = []
const registeredTools = new Map()
// Stand-in for one live DSH session: the transcript endpoint reads
// snapshotEvents() off whatever ctx.sessions.get(id) returns.
const fakeEvents = [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 1001, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '这条线讲了什么？' }], source: { kind: 'user' } } },
  { type: 'tool/call', seq: 3, time: 1002, data: { turn: 1, step: 1, callId: 'c1', name: 'thunderbird_thread', arguments: '{}' } },
  {
    type: 'assistant/message',
    seq: 4,
    time: 1003,
    data: {
      turn: 1,
      step: 1,
      message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '这是一条测试回复。' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
    },
  },
  { type: 'turn/end', seq: 5, time: 1004, data: { turn: 1, reason: { kind: 'completed' } } },
]
const liveSessions = new Map([['sess-test', { snapshotEvents: () => fakeEvents }]])
const stubSessions = { get: (id) => liveSessions.get(String(id)) }
const stub = {
  webServer: {
    register (route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  tools: {
    register (definition) {
      registeredTools.set(definition.name, definition)
      return () => registeredTools.delete(definition.name)
    },
  },
  sessions: stubSessions,
  timeout (callback, delay) {
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  },
  effect (fn) {
    const disposer = fn()
    effects.push(disposer)
    return () => { if (typeof disposer === 'function') disposer() }
  },
  get (name) { return this[name] },
}

const mod = await import(new URL('../dsh-side/thunderbird-host.mjs', import.meta.url))
mod.apply(stub, {})

const server = createServer((req, res) => {
  const path = String(req.url || '').split('?')[0]
  const handler = routes.get(path)
  if (!handler) { res.writeHead(404); res.end('no route ' + path); return }
  handler(req, res)
})
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

// The protocol double is the Thunderbird stand-in: it polls this server exactly
// like the real add-on does.
const mock = spawn(process.execPath, [join(here, 'mock-thunderbird.js'), BASE], { stdio: 'ignore' })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const get = async (path) => (await fetch(BASE + path, { cache: 'no-store' })).json()
const post = async (path, body) => (await fetch(BASE + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json()

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  ' + detail))
  if (!ok) failures += 1
}

let online = false
for (let attempt = 0; attempt < 40; attempt++) {
  const status = await get('/api/thunderbird/status').catch(() => null)
  if (status && status.online) { online = true; break }
  await wait(500)
}
check('bridge online with the protocol double', online)
if (!online) {
  mock.kill()
  server.close()
  await rm(home, { recursive: true, force: true })
  process.exit(1)
}

check('session routes registered', routes.has('/api/thunderbird/session/create') && routes.has('/api/thunderbird/session/list'))

const empty = await get('/api/thunderbird/session/list')
check('registry starts empty', empty.ok === true && empty.sessions.length === 0, 'root=' + empty.root)

// Discover a folder that actually holds messages, then build a thread the way
// the panel does: one shared subject.
const tree = await get('/api/thunderbird/rpc?method=folders.tree')
const folderIds = []
const walkFolders = (folder) => {
  if (!folder || !folder.id) return
  folderIds.push(folder.id)
  for (const child of folder.subFolders || []) walkFolders(child)
}
for (const account of tree.result || []) walkFolders(account.rootFolder)

let page = null
let folderId = null
for (const candidate of folderIds) {
  const out = await get('/api/thunderbird/rpc?method=messages.list&params=' +
    encodeURIComponent(JSON.stringify({ folderId: candidate, limit: 50 })))
  if (out.ok === true && out.result && out.result.messages && out.result.messages.length > 0) {
    page = out.result
    folderId = candidate
    break
  }
}
check('found a folder with mail', page !== null, 'folderId=' + folderId)
if (page === null) {
  console.log('debug  tree:', JSON.stringify(tree).slice(0, 300))
  console.log('debug  folders:', JSON.stringify(folderIds))
  const probe = await get('/api/thunderbird/rpc?method=messages.list&params=' +
    encodeURIComponent(JSON.stringify({ folderId: folderIds[0], limit: 50 })))
  console.log('debug  list:', JSON.stringify(probe).slice(0, 300))
  mock.kill(); server.close(); await rm(home, { recursive: true, force: true }); process.exit(1)
}

const subject = page.messages[0].subject
const sameThread = page.messages.filter((m) => m.subject === subject).map((m) => m.id)
check('found a thread to bind', sameThread.length > 0, JSON.stringify(subject))

const created = await post('/api/thunderbird/session/create', {
  subject,
  folderId,
  messageIds: sameThread,
})
check('session/create ok', created.ok === true, created.error || '')
const record = created.session || {}
check('thread directory created', typeof record.dir === 'string' && record.dir.startsWith(home), record.dir)

const threadText = await readFile(join(record.dir, 'thread.md'), 'utf8')
check('thread.md has the subject', threadText.includes(subject))
check('thread.md has a body', threadText.length > 400, threadText.length + ' chars')
check('thread.md lists the message ids', sameThread.every((id) => threadText.includes('`' + id + '`')))

const logged = await post('/api/thunderbird/session/log', {
  key: record.key, action: 'summarize', model: 'test/model', text: '这是一条记录。',
})
check('session/log ok', logged.ok === true, logged.error || '')
const logText = await readFile(join(record.dir, 'ai-log.md'), 'utf8')
check('ai-log.md keeps the record', logText.includes('summarize') && logText.includes('这是一条记录。'))

const attached = await post('/api/thunderbird/session/attach', {
  key: record.key, workspaceId: 'ws-test', sessionId: 'sess-test',
})
check('session/attach ok', attached.ok === true && attached.session.sessionId === 'sess-test')

const listed = await get('/api/thunderbird/session/list')
check('registry lists the binding', listed.sessions.length === 1 && listed.sessions[0].sessionId === 'sess-test')
check('registry counts the ai record', listed.sessions[0].aiCount === 1)

// The bound conversation is read back from the real DSH session log.
const transcript = await get('/api/thunderbird/session/transcript?key=' + record.key)
check('transcript reads the live session', transcript.ok === true && transcript.live === true, transcript.error || '')
check('transcript reports the turn state', transcript.running === false && transcript.lastTurn === 'completed')
check('transcript keeps roles and text',
  transcript.messages.length === 3 &&
  transcript.messages[0].role === 'user' && transcript.messages[0].text === '这条线讲了什么？' &&
  transcript.messages[1].role === 'tool' && transcript.messages[1].name === 'thunderbird_thread' &&
  transcript.messages[2].role === 'assistant' && transcript.messages[2].text === '这是一条测试回复。',
  JSON.stringify(transcript.messages.map((m) => m.role)))

liveSessions.delete('sess-test')
const cold = await get('/api/thunderbird/session/transcript?key=' + record.key)
check('transcript degrades when the session is not loaded', cold.ok === true && cold.live === false && cold.messages.length === 0)
liveSessions.set('sess-test', { snapshotEvents: () => fakeEvents })

const file = await get('/api/thunderbird/session/file?key=' + record.key + '&file=ai-log.md')
check('session/file reads the log', file.ok === true && file.text.includes('这是一条记录。'))

const synced = await post('/api/thunderbird/session/sync', { key: record.key, messageIds: sameThread })
check('session/sync ok', synced.ok === true && synced.session.syncedAt > 0)

const regText = await readFile(join(home, 'dsh-thunderbird', 'mail-sessions.json'), 'utf8')
check('registry file is durable json', JSON.parse(regText).sessions[record.key] !== undefined)

const removed = await post('/api/thunderbird/session/remove', { key: record.key })
check('session/remove ok', removed.ok === true && removed.removed === true)
const afterRemove = await get('/api/thunderbird/session/list')
check('registry is empty again', afterRemove.sessions.length === 0)

// ---- DSH tools -------------------------------------------------------------
// Registering the bridge as tools is what mounts mail into DSH: every session
// can then read, search and answer mail with its own model.

const EXPECTED_TOOLS = [
  'thunderbird_folders', 'thunderbird_search', 'thunderbird_thread',
  'thunderbird_message', 'thunderbird_flag', 'thunderbird_send', 'thunderbird_rules',
]
check('all mail tools registered', EXPECTED_TOOLS.every((name) => registeredTools.has(name)),
  [...registeredTools.keys()].join(', '))

let shapeProblems = 0
for (const definition of registeredTools.values()) {
  const params = definition.parameters || {}
  if (typeof definition.description !== 'string' || definition.description.length < 20) shapeProblems++
  if (params.type !== 'object' || typeof params.properties !== 'object') shapeProblems++
  if (typeof definition.execute !== 'function') shapeProblems++
  if (!definition.output || typeof definition.output.render !== 'function') shapeProblems++
}
check('every tool has a model-facing schema and an output renderer', shapeProblems === 0, shapeProblems + ' problem(s)')

const foldersTool = registeredTools.get('thunderbird_folders')
const foldersValue = await foldersTool.execute({}, {})
check('thunderbird_folders returns the tree', typeof foldersValue === 'string' && foldersValue.includes('folder2'), String(foldersValue).split('\n')[0])
const rendered = foldersTool.output.render({}, foldersValue)
check('tool output renders as a text content block', Array.isArray(rendered) && rendered[0].type === 'text' && rendered[0].text.length > 0)

const searchTool = registeredTools.get('thunderbird_search')
const searchValue = await searchTool.execute({ query: 'weekly', limit: 5 }, {})
check('thunderbird_search finds mail', typeof searchValue === 'string' && searchValue.includes('#'), String(searchValue).split('\n')[0])

const threadTool = registeredTools.get('thunderbird_thread')
const threadValue = await threadTool.execute({ subject: subject, folderId }, {})
check('thunderbird_thread returns a digest', typeof threadValue === 'string' && threadValue.includes(subject) && threadValue.length > 300,
  String(threadValue).length + ' chars')

const messageTool = registeredTools.get('thunderbird_message')
const messageValue = await messageTool.execute({ messageId: Number(sameThread[0]) }, {})
check('thunderbird_message returns headers and body', typeof messageValue === 'string' && messageValue.includes('Subject:'))

// ---- 邮件记忆库导出 (P1) ---------------------------------------------------
// This runs against a FRESH mount of the host half, which is the only way to test
// a host change without restarting the running DSH (its module is cached by URL).
const started = await post('/api/thunderbird/kb/export', {
  folders: [{ id: folderId, name: '收件箱', accountId: 'account1' }],
  limit: 5,
})
check('kb/export starts a job', started && started.ok === true && typeof started.job === 'string', JSON.stringify(started).slice(0, 120))

let job = null
for (let i = 0; i < 60; i++) {
  job = await get('/api/thunderbird/kb/status?job=' + encodeURIComponent(started.job))
  if (job && (job.state === 'done' || job.state === 'error' || job.state === 'cancelled')) break
  await wait(200)
}
check('kb job reaches done', job && job.state === 'done', job ? job.state + ' files=' + job.files : 'no job')
check('kb job wrote files', job && job.files > 0, job ? String(job.files) : '-')

const { readFile: readKb, readdir } = await import('node:fs/promises')
const indexDoc = await readKb(join(started.root, 'INDEX.md'), 'utf8')
check('kb INDEX.md is written', indexDoc.includes('# 邮件记忆库') && indexDoc.includes('index_doc'),
  indexDoc.split('\n')[0])

const dirs = await readdir(started.root)
const mailDir = dirs.find((name) => name.startsWith('account1__'))
check('kb writes one directory per folder', typeof mailDir === 'string', dirs.join(','))

const files = mailDir ? await readdir(join(started.root, mailDir)) : []
check('kb writes one markdown file per mail', files.length > 0 && files.every((f) => f.endsWith('.md')),
  files.slice(0, 2).join(' | '))

const firstDoc = files.length ? await readKb(join(started.root, mailDir, files[0]), 'utf8') : ''
const h1Count = (firstDoc.match(/^# /gm) || []).length
check('each mail file has exactly ONE level-1 heading', h1Count === 1,
  h1Count + ' h1 in ' + (files[0] || '-'))
// index_doc only takes level<=3 headings, and one top-level heading is what makes
// exactly one knowledge node per mail. The sub-headings become that node's 子节.
check('the mail doc carries 邮件信息 + 正文 sections',
  firstDoc.includes('## 邮件信息') && firstDoc.includes('## 正文') && firstDoc.includes('- messageId：'))
check('the file name is unique per message', files.some((f) => /-\d+\.md$/.test(f)),
  files[0] || '-')

// ---- 设置 (settings.json) ---------------------------------------------------
// Defaults must be exactly the old hardcoded literals, otherwise "I did not change
// anything" would not mean "nothing changed".
const defaults = await get('/api/thunderbird/settings')
check('settings defaults match the previous hardcoded values',
  defaults.settings.kbLimit === 50 && defaults.settings.distillBudget === 20 &&
  defaults.settings.sensitivity === 'private' && defaults.settings.autoIndex === false &&
  defaults.settings.pollMs === 1200,
  JSON.stringify(defaults.settings))
check('settings reports where it is stored',
  typeof defaults.path === 'string' && defaults.path.endsWith('settings.json'), defaults.path)

const customRoot = join(home, 'custom-kb')
const savedSettings = await post('/api/thunderbird/settings/set', { kbRoot: customRoot, kbLimit: 3, distillBudget: 9 })
check('settings save round-trips', savedSettings.ok === true && savedSettings.settings.kbLimit === 3 &&
  savedSettings.settings.distillBudget === 9 && savedSettings.settings.kbRoot === customRoot,
  JSON.stringify(savedSettings.settings))

// A partial patch must MERGE. The panel saves one section at a time, so a replace
// would silently wipe every field that section did not carry.
const partial = await post('/api/thunderbird/settings/set', { sensitivity: 'internal' })
check('a partial patch does not reset the other fields',
  partial.settings.sensitivity === 'internal' && partial.settings.kbLimit === 3 &&
  partial.settings.kbRoot === customRoot, JSON.stringify(partial.settings))

const bogus = await post('/api/thunderbird/settings/set', { kbLimit: 99999, sensitivity: 'nonsense', pollMs: 1 })
check('out-of-range numbers are clamped',
  bogus.settings.kbLimit === 500 && bogus.settings.pollMs === 300, JSON.stringify(bogus.settings))
check('an unknown sensitivity keeps the previous value', bogus.settings.sensitivity === 'internal', bogus.settings.sensitivity)

const onDisk = JSON.parse(await readKb(join(home, 'dsh-thunderbird', 'settings.json'), 'utf8'))
check('settings are durable json on disk', onDisk.kbRoot === customRoot && onDisk.kbLimit === 500,
  JSON.stringify(onDisk).slice(0, 120))

// The saved root must actually be obeyed, otherwise the setting is decoration.
await post('/api/thunderbird/settings/set', { kbRoot: customRoot, kbLimit: 2 })
const custom = await post('/api/thunderbird/kb/export', { folders: [{ id: folderId, name: '收件箱', accountId: 'account1' }] })
check('kb/export uses the configured root and limit',
  custom.root === customRoot && custom.limit === 2 && custom.sensitivity === 'internal',
  JSON.stringify({ root: custom.root, limit: custom.limit, sens: custom.sensitivity }))
let customJob = null
for (let i = 0; i < 60; i++) {
  customJob = await get('/api/thunderbird/kb/status?job=' + encodeURIComponent(custom.job))
  if (customJob && (customJob.state === 'done' || customJob.state === 'error')) break
  await wait(200)
}
check('the configured root is where the files land',
  customJob && customJob.state === 'done' && customJob.root === customRoot && customJob.files === 2,
  JSON.stringify({ state: customJob && customJob.state, root: customJob && customJob.root, files: customJob && customJob.files }))

const reset = await post('/api/thunderbird/settings/set', { reset: true })
check('reset restores every default',
  reset.settings.kbRoot === defaults.settings.kbRoot && reset.settings.kbLimit === 50 &&
  reset.settings.sensitivity === 'private', JSON.stringify(reset.settings))

// ---- 持久化邮件缓存 ---------------------------------------------------------
// The panel's localStorage tier survives a reload but not a DSH restart, and it is
// capped at six folders. This is the durable copy behind it.
const emptyCache = await get('/api/thunderbird/cache')
check('cache GET on a first run answers ok with no lists',
  emptyCache.ok === true && emptyCache.lists === null, JSON.stringify(emptyCache))

const cacheLists = { 'account1://INBOX': { messages: [{ id: 1, subject: '持久化验证' }], total: 1, at: 1234 } }
const wrote = await post('/api/thunderbird/cache/set', { lists: cacheLists })
check('cache POST reports how many folders it stored', wrote.ok === true && wrote.folders === 1, JSON.stringify(wrote))

const readBack = await get('/api/thunderbird/cache')
check('cache round-trips through disk',
  readBack.ok === true && readBack.lists && readBack.lists['account1://INBOX'] &&
  readBack.lists['account1://INBOX'].messages[0].subject === '持久化验证',
  JSON.stringify(readBack.lists).slice(0, 120))

const cacheOnDisk = JSON.parse(await readKb(join(home, 'dsh-thunderbird', 'cache', 'lists.json'), 'utf8'))
check('the cache file is real json on disk, outside localStorage',
  cacheOnDisk['account1://INBOX'].total === 1, JSON.stringify(cacheOnDisk).slice(0, 80))

const badCache = await post('/api/thunderbird/cache/set', { nope: true })
check('cache POST rejects a body without lists', badCache.ok === false, JSON.stringify(badCache))

// ---- 远程图片信任域 ---------------------------------------------------------
// "Which hosts may this panel contact" has to be a decision the user can keep, so
// it lives in settings.json and is normalised on the way in.
const hostSettings = await post('/api/thunderbird/settings/set', {
  imageHosts: ['Example.COM', 'example.com', '.cdn.example.net', '  ', 'Example.com'],
})
check('image hosts are lower-cased, de-duplicated and stripped of a leading dot',
  JSON.stringify(hostSettings.settings.imageHosts) === JSON.stringify(['example.com', 'cdn.example.net']),
  JSON.stringify(hostSettings.settings.imageHosts))
check('strict mode defaults to off, so nothing that worked before stops working',
  hostSettings.settings.imageStrict === false, String(hostSettings.settings.imageStrict))

await post('/api/thunderbird/settings/set', { imageStrict: true })
const refused = await get('/api/thunderbird/image?url=' + encodeURIComponent('https://tracker.example.org/pixel.gif'))
check('strict mode refuses an untrusted host by name, not with a broken image',
  refused.ok === false && refused.error === 'host not trusted' && refused.host === 'tracker.example.org',
  JSON.stringify(refused))
check('the refusal is a JSON answer the panel can turn into a 信任此域 button',
  typeof refused.host === 'string' && refused.strict === true, JSON.stringify(refused))

await post('/api/thunderbird/settings/set', { imageStrict: false, imageHosts: [] })
const notStrict = await get('/api/thunderbird/image?url=' + encodeURIComponent('not-a-url'))
check('a malformed url is still rejected regardless of the allow-list',
  notStrict.ok === false && notStrict.error === 'not a valid url', JSON.stringify(notStrict))

// ---- 邮件名片（联系人） ------------------------------------------------------
// The harvest input is exactly what the panel already holds after a list load, so
// this costs no extra bridge round trips.
const harvested = await post('/api/thunderbird/contacts/harvest', {
  accountId: 'account1',
  messages: [
    {
      author: '"Iris Zhu" <iriszhu@targotools.cn>',
      recipients: ['"吴琴叶" <wuqinye@prefollow.com>', 'iriszhu@targotools.cn'],
      date: 1789000000000,
    },
    {
      author: 'Iris Zhu <iriszhu@targotools.cn>',
      recipients: ['Jenny Wu <wuqinye@prefollow.com>'],
      date: 1789000001000,
    },
    {
      // Same person, a mangled variant of the name: the fuller form must win.
      author: 'iris <iriszhu@targotools.cn>',
      recipients: ['wuqinye@prefollow.com'],
      date: 1789000002000,
    },
  ],
})
check('contacts/harvest creates one card per address', harvested && harvested.ok === true && harvested.created === 2,
  JSON.stringify(harvested))
// Each message touches each DISTINCT address on it once — three messages with two
// distinct addresses each is 6, and the duplicate recipient in message 1 is folded
// into the author's own card rather than counted twice.
check('harvest counts each address once per message', harvested && harvested.touched === 6,
  String(harvested && harvested.touched))

const all = await get('/api/thunderbird/contacts/list')
check('contacts/list returns the book', all && all.ok === true && all.total === 2, String(all && all.total))
const iris = (all.list || []).find((c) => (c.emails || [])[0] === 'iriszhu@targotools.cn')
const wu = (all.list || []).find((c) => (c.emails || [])[0] === 'wuqinye@prefollow.com')
check('auto-naming picks the fuller variant', iris && iris.display === 'Iris Zhu', iris && iris.display)

const irisFull = await get('/api/thunderbird/contacts/get?id=' + (iris ? iris.id : ''))
check('contacts/get resolves the card', irisFull && irisFull.ok === true && irisFull.contact.emails.length === 1)
// 名字自动整理：西文按最后一段当姓；中文姓在前。
check('western name split', irisFull.contact.given === 'Iris' && irisFull.contact.family === 'Zhu',
  irisFull.contact.given + ' / ' + irisFull.contact.family)
const wuFull = await get('/api/thunderbird/contacts/get?id=' + (wu ? wu.id : ''))
check('CJK name split uses the leading surname', wuFull.contact.family === '吴' && wuFull.contact.given === '琴叶',
  wuFull.contact.family + ' / ' + wuFull.contact.given)
// 收发件人关联: they shared a message, so each lists the other.
check('reciprocal peer association is recorded',
  (irisFull.peers || []).some((p) => p.address === 'wuqinye@prefollow.com') &&
  (wuFull.peers || []).some((p) => p.address === 'iriszhu@targotools.cn'),
  JSON.stringify((irisFull.peers || []).map((p) => p.address + ':' + p.count)))

// 只候选和当前账号关联的
const suggest1 = await get('/api/thunderbird/contacts/suggest?accountId=account1&q=iris')
check('suggest honours the account filter',
  suggest1 && suggest1.list.length === 1 && suggest1.list[0].email === 'iriszhu@targotools.cn',
  JSON.stringify(suggest1 && suggest1.list))
const suggestOther = await get('/api/thunderbird/contacts/suggest?accountId=account9&q=iris')
check('suggest returns NOTHING for an unrelated account', suggestOther && suggestOther.list.length === 0,
  JSON.stringify(suggestOther && suggestOther.list))
const suggestNone = await get('/api/thunderbird/contacts/suggest?q=iris')
check('suggest with no account yields nothing, never the whole book', suggestNone && suggestNone.list.length === 0)

// A hand edit must survive later harvesting, or auto-naming quietly reverts the
// user's own corrections on the next list load.
const saved = await post('/api/thunderbird/contacts/save', {
  id: iris.id,
  patch: { display: '朱小姐', courtesy: '字·以宁', company: 'TARGO TOOLS', title: 'Sr. Account Executive' },
})
check('contacts/save stores the edit', saved && saved.ok === true && saved.contact.display === '朱小姐',
  saved && saved.contact && saved.contact.display)
check('the edit marks the card as edited', saved.contact.edited === true)
await post('/api/thunderbird/contacts/harvest', {
  accountId: 'account1',
  messages: [{ author: 'Iris Zhu <iriszhu@targotools.cn>', recipients: [], date: 1789000009000 }],
})
const afterEdit = await get('/api/thunderbird/contacts/get?id=' + iris.id)
check('auto-naming never overwrites a hand edit',
  afterEdit.contact.display === '朱小姐' && afterEdit.contact.courtesy === '字·以宁', afterEdit.contact.display)

const badAvatar = await post('/api/thunderbird/contacts/save', {
  id: iris.id,
  patch: { avatar: { kind: 'data', value: 'data:image/png;base64,' + 'A'.repeat(500000) } },
})
check('an oversized avatar is rejected rather than stored', badAvatar && badAvatar.ok === false,
  JSON.stringify(badAvatar).slice(0, 90))
const goodAvatar = await post('/api/thunderbird/contacts/save', {
  id: iris.id,
  patch: { avatar: { kind: 'data', value: 'data:image/png;base64,iVBORw0KGgo=' } },
})
check('a small avatar is accepted', goodAvatar && goodAvatar.ok === true && goodAvatar.contact.avatar.kind === 'data')

const cardGone = await post('/api/thunderbird/contacts/delete', { id: wu.id })
const afterDelete = await get('/api/thunderbird/contacts/list')
check('contacts/delete removes one card', cardGone.ok === true && afterDelete.total === 1, String(afterDelete.total))

mock.kill()
server.close()
await rm(home, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
