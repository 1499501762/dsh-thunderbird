/**
 * dsh-thunderbird — client half.
 *
 * Behaves like the other sidebar views in this profile (the tududi Kanban /
 * Calendar rows): a normal entry button in the left sidebar, and a view panel
 * mounted into the centre column that hides the conversation while it is open.
 * Plain DOM only, so the shell's React reconciliation is never disturbed.
 *
 * Protocol copied from dsh-tududi-views (the working reference on this build):
 *   - entry: <button data-dsh-thunderbird-entry> beside the sibling entries
 *   - view:  [data-dsh-thunderbird-view] appended to [data-pane='conversation']
 *            or [class*='centerCol'], shown by html[data-dsh-thunderbird-active]
 *   - mutual exclusion via the `dsh-panel-activate` document event plus sibling
 *     active attributes, so only one panel is ever visible.
 *
 * The view body is a same-origin iframe onto /api/thunderbird/ui, which the
 * host half of this package serves.
 */
window.__ModuleLoader__.load({
  id: 'dsh-thunderbird',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var ENTRY_ATTR = 'data-dsh-thunderbird-entry'
    var VIEW_ATTR = 'data-dsh-thunderbird-view'
    var ACTIVE_ATTR = 'data-dsh-thunderbird-active'
    var SHIELD_ATTR = 'data-dsh-thunderbird-shield'
    var STYLE_ID = 'dsh-thunderbird-css'
    var ENTRY_SELECTOR = '[' + ENTRY_ATTR + ']'
    var VIEW_SELECTOR = '[' + VIEW_ATTR + ']'

    var UI_URL = '/api/thunderbird/ui'
    var LABEL = 'Thunderbird'

    // Other panels in this profile that must close when this one opens.
    var SIBLING_ATTRS = ['data-dsh-tududi-active', 'data-dsh-taskboard-active', 'data-dsh-ssh-active']
    var SIBLING_ROWS = '[data-dsh-tududi-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-skill-explorer-entry]'

    var CSS = [
      "[data-pane='conversation'], [class*='centerCol'] { position: relative; }",
      '[' + VIEW_ATTR + '] { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: none; flex-direction: column; z-index: 60; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1f2430); font-size: 13px; line-height: 1.5; -webkit-app-region: no-drag; }',
      '[' + VIEW_ATTR + '] * { box-sizing: border-box; }',
      'html[' + ACTIVE_ATTR + ']:not([data-dsh-tududi-active]):not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [' + VIEW_ATTR + '] { display: flex; }',
      'html[' + ACTIVE_ATTR + ']:not([data-dsh-tududi-active]):not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-pane=\'conversation\'] > :not([' + VIEW_ATTR + ']),',
      'html[' + ACTIVE_ATTR + ']:not([data-dsh-tududi-active]):not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [class*=\'centerCol\'] > :not([' + VIEW_ATTR + ']) { display: none !important; }',
      '[' + ENTRY_ATTR + '] { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; height: 36px; padding: 0 10px; background: transparent; border: none; border-radius: 8px; color: var(--dsw-alias-label-secondary, #6b7280); cursor: pointer; font-size: 13px; white-space: nowrap; transition: background .12s, color .12s; }',
      '[' + ENTRY_ATTR + ']:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); color: var(--dsw-alias-label-primary, #111); }',
      '[' + ENTRY_ATTR + '][data-active] { background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,.08)); color: var(--dsw-alias-label-primary, #111); font-weight: 600; }',
      '[' + ENTRY_ATTR + '] .dshTbIcon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex: none; }',
      '[' + ENTRY_ATTR + '] .dshTbIcon svg { display: block; width: 17px; height: 17px; }',
      '[' + ENTRY_ATTR + '] .dshTbLabel { overflow: hidden; text-overflow: ellipsis; }',
      "[data-dsh-frame][data-sidebar-collapsed] [" + ENTRY_ATTR + '], [data-sidebar-collapsed] [' + ENTRY_ATTR + '] { justify-content: center; padding: 0; width: 36px; height: 36px; margin: 0 auto 12px; border-radius: 50%; }',
      "[data-dsh-frame][data-sidebar-collapsed] [" + ENTRY_ATTR + '] .dshTbLabel, [data-sidebar-collapsed] [' + ENTRY_ATTR + '] .dshTbLabel { display: none; }',
      '.dshTb-bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; flex: none; border-bottom: 1px solid var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.22)); }',
      '.dshTb-brand { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-secondary, #6b7280); }',
      '.dshTb-brandDot { width: 8px; height: 8px; border-radius: 50%; background: linear-gradient(135deg, #1d9bf0, #22d3ee); }',
      '.dshTb-spacer { flex: 1 1 auto; }',
      '.dshTb-state { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #9ca3af); white-space: nowrap; max-width: 42vw; overflow: hidden; text-overflow: ellipsis; }',
      '.dshTb-stateDot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: #10b981; }',
      ".dshTb-state[data-bad='1'] .dshTb-stateDot { background: #ef4444; }",
      '.dshTb-icon { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; flex: none; border: none; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary, #6b7280); cursor: pointer; transition: background .12s, color .12s; }',
      '.dshTb-icon:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); color: var(--dsw-alias-label-primary, #111); }',
      '[' + VIEW_ATTR + '] iframe { flex: 1 1 auto; width: 100%; min-height: 0; border: 0; display: block; background: transparent; }',
    ].join('\n')

    var ICON_MAIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"></rect><path d="M3.2 7.3l7.6 5.2a2 2 0 0 0 2.4 0l7.6-5.2"></path></svg>'
    var ICON_REFRESH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"></path><path d="M21 4v4h-4"></path></svg>'
    var ICON_CLOSE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>'

    var entryEl = null
    var viewEl = null
    var frameEl = null
    var stateEl = null
    var shieldEl = null
    var observer = null
    var open = false
    var probeTimer = null

    function el (tag, attrs, kids) {
      var node = document.createElement(tag)
      if (attrs) {
        for (var key in attrs) {
          if (key === 'text') node.textContent = attrs[key]
          else if (key === 'html') node.innerHTML = attrs[key]
          else if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, attrs[key])
        }
      }
      if (kids) {
        for (var i = 0; i < kids.length; i++) {
          var kid = kids[i]
          if (kid === null || kid === undefined || kid === false) continue
          // Plain strings become text nodes: appendChild rejects anything that
          // is not a Node, and passing a bare string here threw before.
          node.appendChild(typeof kid === 'object' && kid.nodeType ? kid : document.createTextNode(String(kid)))
        }
      }
      return node
    }

    function injectCss () {
      if (document.getElementById(STYLE_ID) !== null) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ---- sidebar entry ------------------------------------------------------

    function sidebarRoot () {
      var explicit = document.querySelector('[data-dsh-sidebar-root]')
      if (explicit !== null) return explicit
      var column = document.querySelector("[data-pane='sidebar'], [class*='sidebarCol']")
      if (column === null) return null
      var logoRow = column.querySelector("[class*='logoRow']")
      var owner = logoRow !== null ? logoRow.parentElement : null
      return owner || column.firstElementChild
    }

    function newSessionRow (root) {
      var button = root.querySelector("[class*='newSession']")
      if (button === null) return null
      var node = button
      while (node.parentElement !== null && node.parentElement !== root) node = node.parentElement
      return node.parentElement === root ? node : null
    }

    function createEntry () {
      var entry = el('button', {
        type: 'button',
        role: 'button',
        'data-dsh-no-drag': '',
        'aria-label': LABEL,
        title: LABEL,
      }, [
        el('span', { class: 'dshTbIcon', html: ICON_MAIL }),
        el('span', { class: 'dshTbLabel', text: LABEL }),
      ])
      entry.setAttribute(ENTRY_ATTR, '')
      entry.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        if (open) closePanel()
        else openPanel()
      })
      return entry
    }

    // Anchor on the sibling view entries wherever they actually live — they are
    // not always direct children of [data-dsh-sidebar-root] — and sit right
    // after the last one, so this row joins the same group as 任务看板 / SSH /
    // 技能中心 / 项目看板 / 订单看板 / 日历.
    function placeEntry () {
      if (entryEl === null) return false
      var siblings = document.querySelectorAll(SIBLING_ROWS)
      if (siblings.length > 0) {
        var last = siblings[siblings.length - 1]
        var parent = last.parentElement
        if (parent === null) return false
        if (entryEl.parentElement !== parent || entryEl.previousElementSibling !== last) {
          parent.insertBefore(entryEl, last.nextElementSibling)
        }
        return true
      }
      var root = sidebarRoot()
      if (root !== null) {
        var row = newSessionRow(root)
        var anchor = row !== null ? row.nextElementSibling : root.firstElementChild
        if (entryEl.parentElement !== root || entryEl.nextElementSibling !== anchor) {
          root.insertBefore(entryEl, anchor)
        }
        return true
      }
      if (!entryEl.isConnected) document.body.appendChild(entryEl)
      return true
    }

    var SIBLING_ENTRY_ATTRS = ['data-dsh-tududi-entry', 'data-dsh-taskboard-entry', 'data-dsh-ssh-entry', 'data-dsh-skill-explorer-entry']

    // Cheap check so the common re-mount pass does not re-query the document.
    function placementLooksRight () {
      if (entryEl === null || !entryEl.isConnected) return false
      var prev = entryEl.previousElementSibling
      if (prev === null) return false
      for (var i = 0; i < SIBLING_ENTRY_ATTRS.length; i++) {
        if (prev.hasAttribute(SIBLING_ENTRY_ATTRS[i])) return true
      }
      return false
    }

    function ensureEntry () {
      if (entryEl === null || !entryEl.isConnected) {
        var existing = document.querySelector(ENTRY_SELECTOR)
        entryEl = existing !== null ? existing : createEntry()
      }
      injectCss()
      // Re-place on every mount pass: the first pass can run before the sibling
      // rows exist, and a stale position would otherwise never be corrected.
      if (!placementLooksRight()) placeEntry()
    }

    // ---- centre-column view -------------------------------------------------

    function centerColumn () {
      return document.querySelector("[data-pane='conversation'], [class*='centerCol']")
    }

    // ---- window-drag carve-out ------------------------------------------------
    // The shell covers the top strip with a -webkit-app-region:drag element, and
    // Chromium does not honour no-drag from inside an iframe. This half runs in
    // the PARENT document, where it can: a pointer-events:none, app-region:no-drag
    // rectangle over the panel's own top strip subtracts that area from the drag
    // region, so the panel's toolbar can sit at y=0 and still receive clicks.
    function stripHeight () {
      var raw = getComputedStyle(document.documentElement).getPropertyValue('--dsh-titlebar-safe-inset-top')
      var px = parseFloat(raw)
      return isFinite(px) && px > 0 ? px : 36
    }

    function syncShield () {
      if (!open) {
        if (shieldEl !== null) shieldEl.remove()
        return
      }
      var column = centerColumn()
      if (column === null) return
      if (shieldEl === null) {
        shieldEl = document.createElement('div')
        shieldEl.setAttribute(SHIELD_ATTR, '')
        shieldEl.setAttribute('data-dsh-no-drag', '')
        shieldEl.style.cssText = 'position:fixed;pointer-events:none;background:transparent;z-index:11;-webkit-app-region:no-drag'
      }
      if (!shieldEl.isConnected) document.body.appendChild(shieldEl)
      var rect = column.getBoundingClientRect()
      shieldEl.style.left = Math.round(rect.left) + 'px'
      shieldEl.style.width = Math.round(rect.width) + 'px'
      shieldEl.style.top = '0px'
      shieldEl.style.height = stripHeight() + 'px'
    }

    function ensureView () {
      if (viewEl !== null && viewEl.isConnected) return viewEl
      var column = centerColumn()
      if (column === null || column === undefined) return null
      viewEl = null

      var view = el('div', null, [])
      view.setAttribute(VIEW_ATTR, '')
      view.setAttribute('data-dsh-no-drag', '')

      var stateWrap = el('span', { class: 'dshTb-state' }, [el('span', { class: 'dshTb-stateDot' })])
      stateEl = el('span', { text: '连接中…' })
      stateWrap.appendChild(stateEl)

      var refresh = el('button', { type: 'button', class: 'dshTb-icon', title: '刷新', html: ICON_REFRESH })
      refresh.addEventListener('click', function () { reload() })

      // No close button: the shell's own panel chip already closes this view.
      var bar = el('div', { class: 'dshTb-bar' }, [
        el('span', { class: 'dshTb-brand' }, [el('span', { class: 'dshTb-brandDot' }), 'Thunderbird']),
        el('span', { class: 'dshTb-spacer' }),
        stateWrap,
        refresh,
      ])

      // `shielded=1` tells the panel it may use the full height: the no-drag
      // shield below carves this strip out of the window drag region.
      var frame = el('iframe', { title: LABEL, src: UI_URL + '?shielded=1' })
      frameEl = frame

      view.appendChild(bar)
      view.appendChild(frame)
      column.appendChild(view)
      viewEl = view
      pollStatus()
      return view
    }

    function reload () {
      if (frameEl !== null) frameEl.src = UI_URL + '?t=' + Date.now()
    }

    function pollStatus () {
      if (probeTimer !== null) return
      probeTimer = setInterval(function () {
        if (!open) return
        fetch('/api/thunderbird/status', { cache: 'no-store' }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json()
        }).then(function (data) {
          if (stateEl === null) return
          stateEl.textContent = data && data.online ? '已连接 Thunderbird' : '等待 Thunderbird 连接'
          stateEl.parentElement.removeAttribute('data-bad')
          if (frameEl !== null && frameEl.getAttribute('data-kind') === 'notfound') {
            frameEl.setAttribute('data-kind', 'ok')
            reload()
          }
        }).catch(function () {
          if (stateEl === null) return
          stateEl.textContent = '网关未就绪（/api/thunderbird 未注册）'
          stateEl.parentElement.setAttribute('data-bad', '1')
          if (frameEl !== null) frameEl.setAttribute('data-kind', 'notfound')
        })
      }, 5000)
    }

    // ---- open / close -------------------------------------------------------

    function syncEntry () {
      if (entryEl === null) return
      if (open) entryEl.setAttribute('data-active', 'true')
      else entryEl.removeAttribute('data-active')
    }

    function openPanel () {
      // Build the view FIRST: if anything throws while building it, the centre
      // column must never be left hidden with nothing to show.
      var view = ensureView()
      if (view === null) {
        open = false
        document.documentElement.removeAttribute(ACTIVE_ATTR)
        syncEntry()
        return
      }
      open = true
      document.documentElement.setAttribute(ACTIVE_ATTR, 'true')
      for (var i = 0; i < SIBLING_ATTRS.length; i++) document.documentElement.removeAttribute(SIBLING_ATTRS[i])
      try { document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'thunderbird' })) } catch (error) { /* older shells */ }
      syncShield()
      syncEntry()
    }

    function closePanel () {
      open = false
      document.documentElement.removeAttribute(ACTIVE_ATTR)
      syncShield()
      syncEntry()
    }

    function onPanelActivate (event) {
      if (open && event && event.detail !== 'thunderbird') closePanel()
    }

    function onDocumentClick (event) {
      if (!open) return
      var target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(ENTRY_SELECTOR) !== null) return
      if (target.closest(VIEW_SELECTOR) !== null) return
      if (target.closest("[class*='sessionRow'], [class*='projectRow'], [class*='newSession']") !== null) closePanel()
    }

    function onDocumentKey (event) {
      if (open && event.key === 'Escape') closePanel()
    }

    function tryMount () {
      if (!document.body) return
      ensureEntry()
      if (open && (viewEl === null || !viewEl.isConnected)) ensureView()
      syncShield()
    }

    function apply (ctx) {
      try { injectCss() } catch (error) { /* styles are optional */ }
      document.addEventListener('dsh-panel-activate', onPanelActivate)
      document.addEventListener('click', onDocumentClick, true)
      document.addEventListener('keydown', onDocumentKey, true)
      tryMount()
      observer = new MutationObserver(function () { try { tryMount() } catch (error) { /* never break the shell */ } })
      observer.observe(document.documentElement, { childList: true, subtree: true })
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            try { if (observer !== null) observer.disconnect() } catch (error) { /* ignore */ }
            if (probeTimer !== null) { clearInterval(probeTimer); probeTimer = null }
            document.removeEventListener('dsh-panel-activate', onPanelActivate)
            document.removeEventListener('click', onDocumentClick, true)
            document.removeEventListener('keydown', onDocumentKey, true)
            if (entryEl !== null) entryEl.remove()
            if (viewEl !== null) viewEl.remove()
            if (shieldEl !== null) shieldEl.remove()
            document.documentElement.removeAttribute(ACTIVE_ATTR)
            entryEl = null
            viewEl = null
            frameEl = null
            stateEl = null
          }
        }, 'dsh-thunderbird: ui')
      }
    }

    var inject = []
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
