'use strict'

const api = typeof browser !== 'undefined' ? browser : messenger
const DEFAULTS = { baseUrl: 'http://127.0.0.1:43129', pollWaitMs: 25000, retryMs: 3000 }

const $ = (id) => document.getElementById(id)

function show (text, kind) {
  const el = $('result')
  el.hidden = false
  el.textContent = text
  el.className = kind || ''
}

async function load () {
  const cfg = Object.assign({}, DEFAULTS, await api.storage.local.get(DEFAULTS))
  $('baseUrl').value = cfg.baseUrl
  $('pollWaitMs').value = cfg.pollWaitMs
  $('retryMs').value = cfg.retryMs
}

$('save').addEventListener('click', async () => {
  const cfg = {
    baseUrl: String($('baseUrl').value || '').trim().replace(/\/+$/, '') || DEFAULTS.baseUrl,
    pollWaitMs: Number($('pollWaitMs').value) || DEFAULTS.pollWaitMs,
    retryMs: Number($('retryMs').value) || DEFAULTS.retryMs,
  }
  await api.storage.local.set(cfg)
  show('已保存：' + cfg.baseUrl, 'ok')
})

$('test').addEventListener('click', async () => {
  const base = String($('baseUrl').value || '').trim().replace(/\/+$/, '')
  show('正在连接 ' + base + ' …')
  try {
    const res = await fetch(base + '/api/thunderbird/status', { cache: 'no-store' })
    const data = await res.json()
    show('连接成功。\n' + JSON.stringify(data, null, 2), 'ok')
  } catch (e) {
    show('连接失败：' + ((e && e.message) || e) + '\n\n请确认 DSH 正在运行，且 Thunderbird 侧边栏插件已加载。', 'bad')
  }
})

load()
