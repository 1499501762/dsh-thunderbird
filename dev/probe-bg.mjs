// Attach to Thunderbird's WebExtension background page over the remote
// debugging protocol and report whether the bridge loop is actually alive.
//
//   thunderbird.exe --remote-debugging-port=9222
//   node dev/probe-bg.mjs [uuid-or-id-substring]

const match = process.argv[2] || 'dsh-thunderbird'

async function list () {
  const res = await fetch('http://127.0.0.1:9222/json/list')
  return res.json()
}

let targets = []
for (let i = 0; i < 30; i++) {
  try {
    targets = await list()
    if (targets.length) break
  } catch (e) { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 1000))
}

console.log('=== targets (' + targets.length + ') ===')
for (const t of targets) {
  console.log([t.type, t.url, t.title].join(' | '))
}

const hit = targets.find((t) => (t.url || '').includes(match) || (t.title || '').includes(match))
if (!hit) {
  console.log('NO BACKGROUND TARGET for ' + match)
  process.exit(0)
}

console.log('=== evaluating in ' + hit.url + ' ===')
const ws = new WebSocket(hit.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})

function send (method, params) {
  const id = ++seq
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const probe = `
(() => {
  const out = {}
  try { out.online = online } catch (e) { out.onlineErr = String(e) }
  try { out.config = JSON.parse(JSON.stringify(config)) } catch (e) { out.configErr = String(e) }
  try { out.inFlight = inFlight } catch (e) {}
  try { out.methods = Object.keys(methods).length } catch (e) { out.methodsErr = String(e) }
  try { out.rules = typeof rules } catch (e) { out.rulesErr = String(e) }
  try { out.hasFetch = typeof fetch } catch (e) {}
  try { out.baseUrlPref = String(config && config.baseUrl) } catch (e) {}
  return JSON.stringify(out)
})()
`

const res = await send('Runtime.evaluate', { expression: probe, returnByValue: true })
console.log(JSON.stringify(res, null, 2))

// Now ask it to do one live round trip so we can tell an unreachable host from
// a dead loop.
const live = await send('Runtime.evaluate', {
  expression: `(async () => {
    try {
      const r = await fetch(config.baseUrl + '/api/thunderbird/status', { cache: 'no-store' })
      return 'STATUS ' + r.status + ' ' + (await r.text()).slice(0, 200)
    } catch (e) { return 'FETCH FAILED: ' + String(e && e.message || e) }
  })()`,
  awaitPromise: true,
  returnByValue: true,
})
console.log('=== live fetch from the background page ===')
console.log(JSON.stringify(live, null, 2))

ws.close()
process.exit(0)
