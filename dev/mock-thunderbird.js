'use strict'

// Mock Thunderbird bridge.
//
// Speaks the exact protocol the real MailExtension (thunderbird-addon/background.js)
// speaks, but with in-memory fake mail. Use it to exercise the DSH sidebar panel
// end-to-end without Thunderbird installed.
//
//   node mock-thunderbird.js [baseUrl] [--send-new-mail-every-ms]
//
// It is also the executable reference for the wire protocol: DSH serves
// /api/thunderbird/{poll,result,event}; the client (this file / the add-on)
// long-polls, executes, and posts results back.

const BASE = (process.argv[2] || 'http://127.0.0.1:43129').replace(/\/+$/, '')
const PING_MS = Number(process.argv[3]) || 0

const accounts = [
  {
    id: 'account1',
    name: 'demo@example.com',
    type: 'imap',
    identities: [{ id: 'id1', name: 'Demo User', email: 'demo@example.com', replyTo: '' }],
    rootFolder: {
      id: 'folder1',
      name: 'demo@example.com',
      path: '/',
      accountId: 'account1',
      specialUse: [],
      depth: 0,
      subFolders: [
        { id: 'folder2', name: 'Inbox', path: '/Inbox', accountId: 'account1', specialUse: ['inbox'], depth: 1, subFolders: [
          { id: 'folder3', name: 'Work', path: '/Inbox/Work', accountId: 'account1', specialUse: [], depth: 2, subFolders: [] },
        ] },
        { id: 'folder4', name: 'Drafts', path: '/Drafts', accountId: 'account1', specialUse: ['drafts'], depth: 1, subFolders: [] },
        { id: 'folder5', name: 'Sent', path: '/Sent', accountId: 'account1', specialUse: ['sent'], depth: 1, subFolders: [] },
        { id: 'folder6', name: 'Trash', path: '/Trash', accountId: 'account1', specialUse: ['trash'], depth: 1, subFolders: [] },
      ],
    },
  },
  {
    id: 'account2',
    name: 'local folders',
    type: 'none',
    identities: [{ id: 'id2', name: 'Local', email: 'local@localhost', replyTo: '' }],
    rootFolder: {
      id: 'folder10',
      name: 'Local Folders',
      path: '/',
      accountId: 'account2',
      specialUse: [],
      depth: 0,
      subFolders: [
        { id: 'folder11', name: 'Archive', path: '/Archive', accountId: 'account2', specialUse: ['archives'], depth: 1, subFolders: [] },
      ],
    },
  },
]

const AUTHORS = [
  'GitHub <noreply@github.com>',
  'Alice Zhang <alice@example.com>',
  'Build Bot <ci@example.com>',
  'Bob <bob@example.org>',
  'Mozilla <newsletter@mozilla.org>',
]
const SUBJECTS = [
  '[dsh] nightly build finished',
  'Re: 周报 / weekly report',
  'Your invoice is ready',
  'Welcome to the team',
  'Security alert: new sign-in',
  'Deploy succeeded on staging',
  'Re: Thunderbird bridge design',
  'Monthly newsletter',
]
const BODIES = [
  'Build #4211 finished in 3m12s.\n\nAll 218 tests passed. Artifacts are attached.',
  'Hi,\n\n这里是本周进展：桥接协议已跑通，长轮询稳定。\n下一步接入真实的 Thunderbird。\n\nThanks,\nAlice',
  'Your invoice for September is attached. Payment is due in 14 days.',
  'Welcome aboard! Your account has been provisioned. Ping me if anything is missing.',
  'A new sign-in to your account was detected from an unrecognized device.',
  'Staging deploy finished. Version 2.14.0-rc3 is live at https://staging.example.com',
  'The long-poll endpoint works. Next: real add-on wiring, then fold in compose.',
  'Here is what shipped this month: better search, faster sync, and a new sidebar.',
]

let nextId = 900
const messages = []
for (let i = 0; i < 14; i++) {
  messages.push({
    id: String(nextId++),
    folderId: i % 5 === 0 ? 'folder3' : 'folder2',
    author: AUTHORS[i % AUTHORS.length],
    recipients: ['demo@example.com'],
    ccList: [],
    bccList: [],
    subject: SUBJECTS[i % SUBJECTS.length],
    date: Date.now() - i * 3600 * 1000 * 7,
    read: i > 3,
    flagged: i === 2,
    junk: false,
    isNew: i < 2,
    headersOnly: false,
    external: false,
    size: 2048 + i * 128,
    tags: i === 1 ? ['$label1'] : [],
    priority: 'normal',
    headerMessageId: '<mock-' + i + '@example.com>',
    folderName: i % 5 === 0 ? 'Work' : 'Inbox',
    accountId: 'account1',
  })
}

const methods = {
  ping: async () => ({ thunderbird: false, mock: true, version: '0.0.0-mock', accounts: accounts.length }),
  'accounts.list': async () => accounts,
  'folders.tree': async () => accounts.map((a) => ({ accountId: a.id, accountName: a.name, rootFolder: a.rootFolder })),
  'folders.list': async () => accounts.flatMap((a) => a.rootFolder.subFolders),
  'messages.list': async (p) => ({
    listId: null,
    messages: messages
      .filter((m) => m.folderId === p.folderId && (!p.unreadOnly || !m.read))
      .slice(0, Number(p.limit) || 60),
  }),
  'messages.get': async (p) => messages.find((m) => String(m.id) === String(p.messageId)) || null,
  'messages.body': async (p) => {
    const m = messages.find((x) => String(x.id) === String(p.messageId))
    const idx = m ? Number(m.id) - 900 : 0
    return { text: BODIES[idx % BODIES.length], html: '', partTypes: ['text/plain'] }
  },
  'messages.search': async (p) => {
    const q = String(p.text || '').toLowerCase()
    return { listId: null, messages: messages.filter((m) => (m.subject + m.author).toLowerCase().includes(q)).slice(0, 60) }
  },
  'messages.update': async (p) => {
    const m = messages.find((x) => String(x.id) === String(p.messageId))
    if (m) {
      if (typeof p.read === 'boolean') m.read = p.read
      if (typeof p.flagged === 'boolean') m.flagged = p.flagged
    }
    return { updated: !!m }
  },
  'messages.delete': async (p) => {
    const ids = p.messageIds || []
    for (const id of ids) {
      const i = messages.findIndex((m) => String(m.id) === String(id))
      if (i >= 0) messages.splice(i, 1)
    }
    return { deleted: ids.length }
  },
  'messages.move': async (p) => {
    const ids = p.messageIds || []
    for (const id of ids) {
      const m = messages.find((x) => String(x.id) === String(id))
      if (m) m.folderId = p.destination
    }
    return { moved: ids.length }
  },
  'messages.send': async (p) => {
    console.log('[mock] send ->', JSON.stringify({ to: p.to, subject: p.subject, len: String(p.body || '').length }))
    const sent = {
      id: String(nextId++), folderId: 'folder5', author: 'Demo User <demo@example.com>',
      recipients: String(p.to || '').split(','), ccList: [], bccList: [], subject: String(p.subject || '(no subject)'),
      date: Date.now(), read: true, flagged: false, junk: false, isNew: false, headersOnly: false,
      external: false, size: String(p.body || '').length, tags: [], priority: 'normal',
      headerMessageId: '<mock-sent-' + nextId + '@example.com>', folderName: 'Sent', accountId: 'account1',
    }
    messages.unshift(sent)
    return { sent: true, via: 'mock' }
  },
  'tags.list': async () => [{ key: '$label1', tag: 'Important', color: 'red', ordinal: '0' }],
  'addressBooks.list': async () => [
    { id: 'book1', name: 'Personal Address Book', contacts: [{ id: 'c1', name: 'Alice Zhang', email: 'alice@example.com' }] },
  ],
}

async function fetchWithTimeout (url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, Object.assign({ cache: 'no-store' }, options || {}, { signal: controller.signal }))
  } finally {
    clearTimeout(timer)
  }
}

async function postJson (path, payload) {
  const res = await fetchWithTimeout(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, 20000)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res
}

async function loop () {
  let online = false
  for (;;) {
    try {
      const res = await fetchWithTimeout(BASE + '/api/thunderbird/poll?wait=25000&client=mock', {}, 40000)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      if (!online) { online = true; console.log('[mock] connected to ' + BASE) }
      for (const cmd of (data && data.commands) || []) {
        let payload
        try {
          const fn = methods[cmd.method]
          if (typeof fn !== 'function') throw new Error('unknown method: ' + cmd.method)
          payload = { id: cmd.id, ok: true, result: await fn(cmd.params || {}) }
        } catch (e) {
          payload = { id: cmd.id, ok: false, error: String((e && e.message) || e) }
        }
        await postJson('/api/thunderbird/result', payload).catch(() => {})
      }
    } catch (e) {
      if (online) { online = false; console.log('[mock] offline: ' + ((e && e.message) || e)) }
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

if (PING_MS > 0) {
  setInterval(() => {
    const fresh = Object.assign({}, messages[0], {
      id: String(nextId++),
      subject: '新邮件 #' + nextId,
      author: AUTHORS[nextId % AUTHORS.length],
      date: Date.now(),
      read: false,
      isNew: true,
      folderId: 'folder2',
    })
    messages.unshift(fresh)
    postJson('/api/thunderbird/event', { type: 'newMail', data: { folderId: 'folder2', folderName: 'Inbox', count: 1, messages: [fresh] } })
      .catch(() => {})
  }, PING_MS)
}

console.log('[mock] bridging to ' + BASE + ' (Ctrl+C to stop)')
loop()
