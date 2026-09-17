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
  timeout (callback, delay) {
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  },
  effect (fn) {
    const disposer = fn()
    effects.push(disposer)
    return () => { if (typeof disposer === 'function') disposer() }
  },
  get (name) { return name === 'tools' ? this.tools : undefined },
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

mock.kill()
server.close()
await rm(home, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
