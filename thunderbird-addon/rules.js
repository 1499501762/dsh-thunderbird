'use strict'

// 分类规则引擎 —— 与 background.js 共用同一个后台页作用域。
//
// 这里是 classic script，所以能直接复用 background.js 里的 api / methods /
// box / toMessageId / normHeader / messageListFrom / pushEvent。本文件只做两件事：
//   1. 往共享的 methods 表里追加 rules.* 方法；
//   2. 自己挂一个 onNewMailReceived 监听器，在邮件到达时立即执行规则。
//
// 为什么规则放在插件侧而不是 DSH 侧：Thunderbird WebExtension API 不暴露原生过滤器
// （messenger.filters 不存在），所以"匹配"只能自己算；但把它放进后台页意味着只要
// Thunderbird 开着规则就生效，不依赖 DSH 在线，也不受 DSH 会话重启影响。
// 规则集存在 browser.storage.local，天然持久。
//
// 动作全部是原生操作：messages.update（已读/星标/垃圾/标签）、messages.move、
// messages.delete。

const RULES_KEY = 'dsh-tb-rules.v1'

async function loadRules () {
  const stored = await api.storage.local.get({ [RULES_KEY]: [] })
  const list = stored[RULES_KEY]
  return Array.isArray(list) ? list : []
}

async function saveRules (rules) {
  await api.storage.local.set({ [RULES_KEY]: rules })
  return rules
}

function textHas (haystack, needle) {
  if (!needle) return true
  return String(haystack === undefined || haystack === null ? '' : haystack)
    .toLowerCase()
    .indexOf(String(needle).toLowerCase()) >= 0
}

function ruleMatches (rule, message) {
  if (!rule || rule.enabled === false) return false
  const match = rule.match || {}
  if (match.folderId && String(message.folderId || '') !== String(match.folderId)) return false
  if (match.unreadOnly && message.read) return false
  if (!textHas(message.author, match.from)) return false
  if (!textHas(message.subject, match.subject)) return false
  if (!textHas((message.recipients || []).join(', '), match.to)) return false
  return true
}

function describeMatch (rule) {
  const match = (rule && rule.match) || {}
  const bits = []
  if (match.from) bits.push('发件人含“' + match.from + '”')
  if (match.subject) bits.push('主题含“' + match.subject + '”')
  if (match.to) bits.push('收件人含“' + match.to + '”')
  if (match.folderId) bits.push('仅在指定文件夹')
  if (match.unreadOnly) bits.push('仅未读')
  return bits.length ? bits.join(' 且 ') : '任意邮件'
}

function describeActions (rule) {
  const actions = (rule && rule.actions) || {}
  const bits = []
  if (actions.markRead === true) bits.push('标为已读')
  if (actions.flag === true) bits.push('加星标')
  if (actions.flag === false) bits.push('取消星标')
  if (actions.junk === true) bits.push('标为垃圾')
  if (actions.tag) bits.push('加标签 ' + actions.tag)
  if (actions.moveTo) bits.push('移动到 ' + actions.moveTo)
  if (actions.delete === true) bits.push('删除')
  return bits.length ? bits.join('、') : '无动作'
}

async function applyActions (message, actions, dryRun) {
  const applied = []
  const props = {}
  if (actions.markRead === true) props.read = true
  if (typeof actions.flag === 'boolean') props.flagged = actions.flag
  if (typeof actions.junk === 'boolean') props.junk = actions.junk
  if (actions.tag) {
    const tags = (message.tags || []).slice()
    if (tags.indexOf(actions.tag) < 0) tags.push(actions.tag)
    props.tags = tags
  }
  if (Object.keys(props).length > 0) {
    if (!dryRun) await api.messages.update(toMessageId(message.id), props)
    applied.push('update(' + Object.keys(props).join(',') + ')')
  }
  if (actions.moveTo) {
    if (!dryRun) await api.messages.move([toMessageId(message.id)], String(actions.moveTo))
    applied.push('move')
  }
  if (actions.delete === true) {
    if (!dryRun) await api.messages.delete([toMessageId(message.id)])
    applied.push('delete')
  }
  return applied
}

// 按顺序匹配；默认"首个命中即停"，rule.continue 为 true 时继续往下匹配。
async function runRules (messages, options) {
  const dryRun = !!(options && options.dryRun)
  const only = options && options.onlyRuleId ? String(options.onlyRuleId) : ''
  const rules = await loadRules()
  const results = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    for (let j = 0; j < rules.length; j++) {
      const rule = rules[j]
      if (only && String(rule.id) !== only) continue
      if (!ruleMatches(rule, message)) continue
      let applied = []
      try {
        applied = await applyActions(message, rule.actions || {}, dryRun)
      } catch (error) {
        applied = ['error: ' + String((error && error.message) || error)]
      }
      results.push({
        messageId: message.id,
        subject: String(message.subject || ''),
        author: String(message.author || ''),
        ruleId: rule.id,
        ruleName: String(rule.name || '(未命名规则)'),
        applied,
      })
      if (!rule.continue) break
    }
  }
  return results
}

async function collectMessages (params) {
  const limit = Math.max(1, Math.min(Number(params.limit) || 50, 200))
  const messages = []
  if (Array.isArray(params.messageIds) && params.messageIds.length > 0) {
    for (let i = 0; i < params.messageIds.length; i++) {
      try {
        messages.push(normHeader(await api.messages.get(toMessageId(params.messageIds[i]))))
      } catch (error) { /* 取不到的跳过 */ }
    }
    return messages
  }
  if (params.folderId) {
    const list = await api.messages.query({
      folderId: String(params.folderId),
      messagesPerPage: limit,
      autoPaginationTimeout: 0,
    })
    const page = messageListFrom(list)
    return page.messages.slice(0, limit).map(normHeader)
  }
  return messages
}

Object.assign(methods, {
  'rules.get': async () => ({ rules: await loadRules() }),

  'rules.set': async (params) => {
    const rules = Array.isArray(params.rules) ? params.rules : []
    await saveRules(rules)
    return { rules, saved: rules.length }
  },

  'rules.run': async (params) => {
    const messages = await collectMessages(params)
    const dryRun = !!params.dryRun
    const results = await runRules(messages, { dryRun, onlyRuleId: params.ruleId })
    return {
      scanned: messages.length,
      matched: results.length,
      dryRun,
      results: results.slice(0, 60),
    }
  },

  'rules.describe': async () => {
    const rules = await loadRules()
    return {
      rules: rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled !== false,
        match: describeMatch(rule),
        actions: describeActions(rule),
        continue: !!rule.continue,
      })),
    }
  },
})

// 新邮件到达就立刻执行规则；执行结果作为事件回传 DSH，面板可见。
try {
  if (api.messages.onNewMailReceived) {
    api.messages.onNewMailReceived.addListener((folder, received) => {
      let messages = []
      try {
        messages = messageListFrom(received).messages.map(normHeader)
      } catch (error) {
        messages = []
      }
      if (!messages.length) return
      runRules(messages, { dryRun: false }).then((results) => {
        if (results.length > 0) {
          pushEvent('rules/applied', {
            folderId: folder ? box(folder.id) : null,
            folderName: folder ? box(folder.name) : '',
            count: results.length,
            results: results.slice(0, 10),
          })
        }
      }).catch(() => { /* 规则失败不影响收信 */ })
    })
  }
} catch (error) { /* 事件可选 */ }
