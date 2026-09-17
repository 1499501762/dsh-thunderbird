// Dump small inline (cid:) images that look like emoji, so we can see whether the
// white tile around them is painted by the panel or baked into the bitmap.
import { writeFileSync, mkdirSync } from 'node:fs'

const base = 'http://127.0.0.1:43129/api/thunderbird/rpc'

async function rpc (method, params, timeoutMs) {
  const u = new URL(base)
  u.searchParams.set('method', method)
  if (params) u.searchParams.set('params', JSON.stringify(params))
  if (timeoutMs) u.searchParams.set('timeoutMs', String(timeoutMs))
  const res = await fetch(u, { cache: 'no-store' })
  const body = await res.json()
  if (!body.ok) throw new Error(method + ': ' + JSON.stringify(body).slice(0, 200))
  return body.result
}

const out = process.argv[2] || 'dist/emoji-probe'
mkdirSync(out, { recursive: true })

function pngInfo (dataUrl) {
  const comma = dataUrl.indexOf(',')
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64')
  const sig = buf.slice(0, 8).toString('hex')
  if (sig !== '89504e470d0a1a0a') return { bytes: buf.length, format: 'not-png', sig }
  const colorType = buf[25]
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  // Walk the chunks and report whether a tRNS chunk exists (palette alpha)
  let hasTrns = false
  let at = 8
  const chunks = []
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at)
    const type = buf.slice(at + 4, at + 8).toString('ascii')
    chunks.push(type)
    if (type === 'tRNS') hasTrns = true
    if (type === 'IEND') break
    at += 12 + len
  }
  return {
    bytes: buf.length,
    format: 'png',
    width, height,
    colorType,                       // 6 = RGBA, 2 = RGB (no alpha), 3 = palette
    alphaChannel: colorType === 4 || colorType === 6,
    hasTrns,
    chunks: chunks.slice(0, 20),
  }
}

const list = await rpc('messages.list', { folderId: 'account1://INBOX', limit: Number(process.argv[3] || 12) }, 180000)
let saved = 0
for (const m of list.messages) {
  let inline
  try {
    inline = await rpc('messages.inlineImages', { messageId: m.id }, 120000)
  } catch (error) { continue }
  const images = (inline && inline.images) || []
  for (const img of images) {
    if (!img.dataUrl) continue
    const head = img.dataUrl.slice(0, 40)
    const info = head.indexOf('image/png') >= 0 ? pngInfo(img.dataUrl) : { format: img.contentType, prefix: head }
    if ((info.bytes || 0) > 60000) continue
    const name = `${m.id}-${String(img.contentId).replace(/[^A-Za-z0-9._-]/g, '_').slice(-40)}.png`
    const dataUrl = img.dataUrl
    if (dataUrl.indexOf('image/png') >= 0) {
      writeFileSync(`${out}/${name}`, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
      saved++
    }
    console.log(JSON.stringify({ message: m.id, subject: (m.subject || '').slice(0, 30), cid: img.contentId, ...info }))
  }
}
console.log('saved', saved, 'small images to', out)
