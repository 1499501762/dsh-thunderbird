/**
 * dsh-thunderbird — client half.
 *
 * An entry button in the left sidebar, and a view panel that covers the centre
 * column. Plain DOM only, so the shell's React reconciliation is never disturbed.
 *
 * Protocol copied from dsh-tududi-views (the working reference on this build):
 *   - entry: <button data-dsh-thunderbird-entry> beside the sibling entries
 *   - view:  [data-dsh-thunderbird-view], a FIXED overlay on <body> positioned
 *            from the centre column's live rect, shown by
 *            html[data-dsh-thunderbird-active]
 *   - mutual exclusion via the `dsh-panel-activate` document event plus sibling
 *     active attributes, so only one panel is ever visible.
 *
 * ⚠️ The view is deliberately NOT a child of the centre column, and this sheet no
 * longer overrides anything on DSH's own containers. It used to do both — plus
 * hide every other child of the column with `display: none !important` — and the
 * result was a panel that escaped its block whenever DSH re-rendered. Reading the
 * column's rect is the only thing this half touches it for.
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
      // NOTHING here touches DSH's own containers any more.
      //
      // This sheet used to force `position: relative` on the centre column and
      // `display: none !important` on every child of it that was not ours, while
      // our view lived INSIDE that column as a foreign child. Three mutations of a
      // React-owned element at once, and the failure mode was exactly the report:
      // a re-render moved the panel out of its block, because we had changed what
      // its absolute children resolve against and had hidden the siblings its own
      // layout was computed from.
      //
      // The view is a fixed overlay on <body> now, positioned from the column's
      // live rect (same technique as the drag shield below, which has always been
      // body-level and has never misbehaved). DSH's element is only ever READ.
      // The frosted glass belongs HERE, on the overlay in DSH's own document, not
      // inside the iframe. Two reasons, both measured:
      //   - this element was `background: var(--dsw-alias-bg-base)` = an opaque
      //     rgb(21,21,23) slab. That single opaque fill is why the panel had no
      //     glass: every translucent layer inside the iframe composited onto it and
      //     came out looking like a flat solid.
      //   - a backdrop-filter only samples what is actually behind the element.
      //     Inside the iframe the backdrop is the iframe's own transparent root, so
      //     a blur there has nothing to smear. Out here the backdrop is the session
      //     content this overlay covers, so the blur is real.
      //
      // 76% + a 26px blur, tuned against the real thing. The blur is what makes a
      // low alpha safe here: the session content this overlay covers is smeared
      // beyond legibility, so what comes through is a soft tint rather than
      // readable text. The first attempt at 64% still read as a washed-out slab;
      // a fully opaque overlay is what the panel used to be, and that is the
      // "no frosted glass" this is fixing.
      '[' + VIEW_ATTR + '] { position: fixed; display: none; flex-direction: column; z-index: 60; overflow: hidden; background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 76%, transparent); backdrop-filter: saturate(1.15) blur(26px); -webkit-backdrop-filter: saturate(1.15) blur(26px); color: var(--dsw-alias-label-primary, #1f2430); font-size: 13px; line-height: 1.5; -webkit-app-region: no-drag; contain: layout paint; }',
      '[' + VIEW_ATTR + '] * { box-sizing: border-box; }',
      'html[' + ACTIVE_ATTR + ']:not([data-dsh-tududi-active]):not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [' + VIEW_ATTR + '] { display: flex; }',
      '[' + ENTRY_ATTR + '] { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; height: 36px; padding: 0 10px; background: transparent; border: none; border-radius: 8px; color: var(--dsw-alias-label-secondary, #6b7280); cursor: pointer; font-size: 13px; white-space: nowrap; transition: background .12s, color .12s; }',
      '[' + ENTRY_ATTR + ']:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); color: var(--dsw-alias-label-primary, #111); }',
      '[' + ENTRY_ATTR + '][data-active] { background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,.08)); color: var(--dsw-alias-label-primary, #111); font-weight: 600; }',
      '[' + ENTRY_ATTR + '] .dshTbIcon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex: none; }',
      '[' + ENTRY_ATTR + '] .dshTbIcon svg { display: block; width: 17px; height: 17px; }',
      '[' + ENTRY_ATTR + '] .dshTbLabel { overflow: hidden; text-overflow: ellipsis; }',
      "[data-dsh-frame][data-sidebar-collapsed] [" + ENTRY_ATTR + '], [data-sidebar-collapsed] [' + ENTRY_ATTR + '] { justify-content: center; padding: 0; width: 36px; height: 36px; margin: 0 auto 12px; border-radius: 50%; }',
      "[data-dsh-frame][data-sidebar-collapsed] [" + ENTRY_ATTR + '] .dshTbLabel, [data-sidebar-collapsed] [' + ENTRY_ATTR + '] .dshTbLabel { display: none; }',
      // DSH hides a section header's TITLE when the rail collapses but leaves the
      // 36px box and its 12px margin behind, so the region rail opens with a blank
      // slot. It reads as "the Thunderbird icon wrapped to its own row" because our
      // entry is the item directly above it — but hiding our entry does not remove
      // the gap, and the box is measurably empty (36x35, zero text, all three of its
      // children hidden by DSH's own collapsed styles). Icon centres in the
      // collapsed rail: 48,48,48,48,48,48,48,96 — the 96 is that box.
      //
      // Collapsed-only and style-only: no DOM is touched, and in the collapsed rail
      // a section header is an empty box by construction, so nothing visible is
      // lost. Verified by counting visible icons before and after.
      "[data-dsh-frame][data-sidebar-collapsed] [class*='_sectionHeader'], [data-sidebar-collapsed] [class*='_sectionHeader'] { display: none; }",
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
    var barEl = null
    var frameEl = null
    var stateEl = null
    var shieldEl = null
    var observer = null
    var open = false
    var probeTimer = null
    var activeCtx = null
    // Disposers for our own right-sidebar tab types, registered once on first
    // use. These MUST live at this scope: the message handler is re-created per
    // event, so a `var` inside it reset to null every time and the second open
    // tried to register a type that was already registered — which threw and sent
    // the open down the opaque-origin browser fallback.
    var tabDisposers = { ai: null, session: null }
    // The url each tab type was last opened with, so a repeated open of the same
    // target does not close and reopen the tab under the user.
    var lastOpenedUrl = { ai: null, session: null }

    // The two tabs this panel contributes to DSH's native right column.
    var TAB_TYPES = {
      ai: { id: 'dsh-thunderbird:ai', title: 'Thunderbird AI', description: '当前邮件线的 AI 输出' },
      session: { id: 'dsh-thunderbird:session', title: '邮件会话', description: '这条邮件线的 DSH 会话' },
    }

    function ensureTab (sidebar, react, kind) {
      var spec = TAB_TYPES[kind]
      if (tabDisposers[kind] !== null) return 'already'
      if (!react || typeof react.createElement !== 'function') return 'no-react'
      if (typeof sidebar.registerTab !== 'function') return 'no-registerTab'
      try {
        tabDisposers[kind] = sidebar.registerTab({
          id: spec.id,
          title: spec.title,
          description: spec.description,
          order: kind === 'ai' ? 60 : 58,
          // One tab per type focuses instead of stacking: this is a view of
          // "the current thing", not a document you open many of.
          single: true,
          component: function (props) {
            var meta = (props && props.tab && props.tab.meta) || {}
            var src = meta.url || (props && props.tab && props.tab.path) || (location.origin + UI_URL)
            return react.createElement('iframe', {
              src: src,
              title: spec.title,
              style: { flex: '1 1 auto', width: '100%', height: '100%', border: 0, background: 'transparent' },
            })
          },
        })
        return 'yes'
      } catch (error) {
        var message = String((error && error.message) || error)
        // A hot reload can leave the previous registration alive while this
        // instance's disposer is gone; the TYPE existing is all the open needs,
        // so treat that one error as done rather than falling back to the browser
        // tab, which would silently lose the theme and the bridge.
        if (message.indexOf('already registered') >= 0) {
          tabDisposers[kind] = function () {}
          return 'already-registered'
        }
        return 'threw: ' + message
      }
    }

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

    // ---- native right sidebar -------------------------------------------------
    // dsh-better-sidebar publishes `ctx.betterSidebar`, and an open carrying a
    // `url` is routed to DSH's native right Sidebar. The mail panel keeps living
    // in the centre column; it is the AI block — the long text you want to read
    // ALONGSIDE the mail — that is opened over there.
    function openAiTab () {
      var sidebar = serviceOf(activeCtx, 'betterSidebar')
      if (sidebar === undefined || typeof sidebar.openTab !== 'function') return false
      try {
        sidebar.openTab({
          type: 'browser',
          url: location.origin + UI_URL + '?view=ai',
          title: 'Thunderbird AI',
        })
        return true
      } catch (error) {
        return false
      }
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

    // A computed custom property is a token stream, not a number: the shell
    // declares the clearance as calc(var(--dsh-desktop-windows-caption-width,
    // 140px) + 44px). Do NOT evaluate it with a throwaway element — this half
    // observes the very tree it would mutate, so the probe re-triggers the mount
    // pass that measures again, forever. The Window Controls Overlay API is the
    // The window-caption clearance cluster used to live here (captionClusterWidth
    // / calcPx / safeRightInset / captionInset). Its last consumer was a bar padding
    // that is gone: the panel is a fixed overlay on <body> now, below the title row,
    // so the caption buttons are never beside anything it draws. It also measured
    // 1300px in the live GUI. See README.

    // Position the panel over the centre column WITHOUT being its child.
    //
    // Reading the column's rect is the only thing this half is allowed to do to
    // it. A rAF-coalesced tracker keeps the overlay aligned while the column
    // resizes or scrolls; `contain: layout paint` on the overlay additionally
    // guarantees our own contents can never affect the page's layout.
    var trackScheduled = false
    function trackOverlay () {
      if (trackScheduled) return
      trackScheduled = true
      var run = function () {
        trackScheduled = false
        if (!open || viewEl === null || !viewEl.isConnected) return
        var column = centerColumn()
        if (column === null) return
        var rect = column.getBoundingClientRect()
        // A collapsed or hidden column reports 0×0; keeping the last good box is
        // better than snapping the panel to nothing.
        if (rect.width < 2 || rect.height < 2) return
        viewEl.style.left = Math.round(rect.left) + 'px'
        viewEl.style.top = Math.round(rect.top) + 'px'
        viewEl.style.width = Math.round(rect.width) + 'px'
        viewEl.style.height = Math.round(rect.height) + 'px'
        // AFTER the box is set, never before: the clearance depends on where this
        // bar's right edge actually is, and a view with no geometry yet reports the
        // full window width. Measuring first reserved 205px of dead space in a shell
        // with no caption buttons at all.
        syncBarInset()
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
      else run()
    }

    // The caption cluster and the column box both move when the window resizes, so
    // one handler keeps the overlay and the bar's clearance in step.
    function onViewportChange () {
      trackOverlay()
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
      trackOverlay()
    }

    // How much of the title row the window's caption buttons own.
    //
    // The client half's OWN bar sits on that row — it is the row carrying the brand
    // and the connection state — so it has to reserve this, or the status text and
    // the refresh control end up underneath the window buttons. This was deleted
    // once on the reasoning that "every row that used it is below the title row";
    // true for the panel's toolbar, FALSE for this bar, which is exactly on it.
    //
    // Bounded on purpose. The earlier version measured 1300px in the live GUI — the
    // Window Controls Overlay probe reports the WHOLE titlebar in an embedded frame,
    // and that branch had no cap on it — which collapsed the bar instead of padding
    // it. A wrong-but-plausible number is worse than a conservative one, so every
    var CAPTION_CAP = 240
    var lastLoggedInset = -1
    // Reserve only as much of the title-row controls as actually OVERLAPS this bar.
    //
    // Measuring the distance from the window's right edge is wrong in general: the
    // bar does not always span the window (in the centre column it is ~400px wide,
    // nowhere near the caption buttons), and that mistake reserved 205px of dead
    // space in a shell with no caption buttons at all — the dead-strip regression
    // again, from the opposite direction.
    //
    // The candidates are the LEFT edges of everything that has to stay clickable,
    // and the answer is how far this bar's right edge reaches past the leftmost of
    // them. Collecting all of them instead of returning on the first match is what
    // catches DSH Desktop's injected control, which sits further left than the three
    // native buttons and is the one that was landing under the refresh icon.
    function captionInset () {
      if (barEl === null) return 0
      var win = window.innerWidth
      var lefts = []
      var root = getComputedStyle(document.documentElement)
      var body = document.body ? getComputedStyle(document.body) : root
      var declared = parseFloat(String(
        root.getPropertyValue('--dsh-desktop-windows-caption-width') ||
        body.getPropertyValue('--dsh-desktop-windows-caption-width') || ''))
      // +44 is the shell's own slack for the control it injects beside them.
      if (isFinite(declared) && declared >= 40) lefts.push(win - (declared + 44))

      // Anything painted OVER this bar in the title row. The centre column is
      // EXCLUDED: this bar is an opaque overlay covering it, so DSH's own controls
      // inside the column are already hidden and reserving room for them just left
      // dead space (they were the whole 193px). What matters is what sits outside
      // the column and on top — the native window buttons and the control DSH
      // Desktop injects beside them.
      var column = centerColumn()
      var nodes = document.querySelectorAll(
        'button, [role="button"], [class*="caption" i], [class*="windowControl"], [class*="window-control"]')
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        if (node.closest && node.closest(VIEW_SELECTOR) !== null) continue
        if (column !== null && column.contains(node)) continue
        var rect = node.getBoundingClientRect()
        if (rect.width < 12 || rect.height === 0 || rect.height > 64) continue
        // In the strip AND actually on screen: `top <= 16` alone caught a button
        // scrolled far above the viewport (top: -1136).
        if (rect.top > 16 || rect.bottom < 0) continue
        // A CONTROL, not furniture: the left edge in the right half and a small box
        // keep a full-width title-bar wrapper out. Without both, a full-width element
        // gives left ~0 and the answer pegs to the cap.
        if (rect.width > 220) continue
        if (rect.left < win * 0.5) continue
        lefts.push(rect.left)
      }
      // Nothing measurable: the shell draws them natively (Windows, ~138px) plus the
      // control it injects (44), so 182 — 138 alone was short by exactly the button
      // that overlapped.
      if (!lefts.length) {
        var shell = document.querySelector('#dsh-desktop-windows-drag-region') !== null ||
          document.querySelector('[data-dsh-windows-drag-region]') !== null
        if (shell && /Windows/i.test(String(navigator.userAgent || ''))) lefts.push(win - 182)
      }
      if (!lefts.length) return 0

      var minLeft = lefts[0]
      for (var k = 1; k < lefts.length; k++) if (lefts[k] < minLeft) minLeft = lefts[k]
      var barRight = barEl.getBoundingClientRect().right
      var overlap = barRight - minLeft
      var inset = overlap > 0 ? Math.min(overlap + 12, CAPTION_CAP) : 0
      // One line, only when it changes: this half cannot see the native caption
      // buttons, so the log is the only way to learn the real number in that shell.
      if (inset !== lastLoggedInset) {
        lastLoggedInset = inset
        console.log('[dsh-thunderbird] top-right clearance ' + inset + 'px'
          + ' (barRight=' + Math.round(barRight) + ', leftmost=' + Math.round(minLeft)
          + ', caption=' + declared + ', win=' + win + ')')
      }
      return inset
    }

    function syncBarInset () {
      if (barEl === null) return
      var inset = 0
      try { inset = captionInset() } catch (error) { inset = 0 }
      barEl.style.paddingRight = (12 + inset) + 'px'
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
      // The clearance is applied by trackOverlay once the overlay has its box; a
      // call here would measure a view with no geometry and reserve the window.
      barEl = bar

      // `shielded=1` tells the panel it may use the full height: the no-drag
      // shield below carves this strip out of the window drag region.
      var frame = el('iframe', { title: LABEL, src: UI_URL + '?shielded=1' })
      frameEl = frame

      view.appendChild(bar)
      view.appendChild(frame)
      document.body.appendChild(view)
      viewEl = view
      trackOverlay()
      pollStatus()
      return view
    }

    function reload () {
      if (frameEl === null) return
      // Carry the existing query through. Rebuilding the URL from scratch dropped
      // `shielded=1`, and the panel then re-applied the titlebar strip it had been
      // told to ignore — a blank band across the top of the view, which is exactly
      // the "refresh leaves an extra empty row" symptom.
      var params = new URLSearchParams()
      var current = String(frameEl.getAttribute('src') || '')
      var at = current.indexOf('?')
      if (at >= 0) {
        new URLSearchParams(current.slice(at + 1)).forEach(function (value, key) {
          if (key !== 't') params.set(key, value)
        })
      }
      params.set('t', String(Date.now()))
      frameEl.src = UI_URL + '?' + params.toString()
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

    // ---- mail-session bridge -------------------------------------------------
    // The panel is a same-origin iframe and cannot reach DSH services itself, so
    // it asks this half — which runs inside the shell — to register a thread
    // directory as a workspace and connect a session to it. The panel then keeps
    // the returned ids in its own durable record and can reopen the session.
    var HOST_ORIGIN = location.origin

    function replyTo (source, id, payload) {
      if (!source || typeof source.postMessage !== 'function') return
      var message = { from: 'dsh-thunderbird', id: id, ok: payload.ok !== false }
      if (payload.ok === false) message.error = String(payload.error || 'failed')
      else message.result = payload.result === undefined ? null : payload.result
      try { source.postMessage(message, HOST_ORIGIN) } catch (error) { /* frame gone */ }
    }

    function serviceOf (ctx, name) {
      if (!ctx || typeof ctx.get !== 'function') return undefined
      return ctx.get(name)
    }

    function workspaceIdOf (view) {
      if (!view) return null
      if (view.id) return String(view.id)
      if (view.workspaceId) return String(view.workspaceId)
      if (view.workspace && view.workspace.id) return String(view.workspace.id)
      return null
    }

    async function createMailSession (ctx, msg) {
      var workspaces = serviceOf(ctx, 'workspaces')
      var uiWorkspace = serviceOf(ctx, 'uiWorkspace')
      if (workspaces === undefined) throw new Error('DSH workspaces 服务不可用')
      if (uiWorkspace === undefined) throw new Error('DSH uiWorkspace 服务不可用')
      if (!msg.dir) throw new Error('缺少工作区目录')

      var view = await workspaces.create({ path: String(msg.dir) })
      var workspaceId = workspaceIdOf(view)
      if (!workspaceId) throw new Error('DSH 未返回 workspaceId')
      if (msg.title) {
        try { await workspaces.rename(workspaceId, String(msg.title)) } catch (error) { /* title is cosmetic */ }
      }
      var sessionId = await uiWorkspace.connectWorkspace(workspaceId)
      if (!sessionId) throw new Error('DSH 未返回 sessionId')
      // The session is born from the directory, so its title is the directory name
      // — slug plus hash, which is not what the user calls this thread. Rename it
      // to the subject. The binding key is the hash and is unaffected either way.
      if (msg.title) {
        try {
          var session = mailSession(ctx, sessionId)
          if (typeof session.rename === 'function') await session.rename(String(msg.title))
        } catch (error) { /* the workspace title is already right; this is cosmetic */ }
      }
      return { workspaceId: workspaceId, sessionId: String(sessionId) }
    }

    function onWindowMessage (ctx) {
      return function (event) {
        if (event.origin !== HOST_ORIGIN) return
        // Accept the mail panel's frame wherever it is mounted: the centre-column
        // view, or a native right-sidebar tab (which nests it one level deeper).
        // Same origin plus the panel's own path is the guard — never just "any
        // embedder on this page".
        var sourceWindow = event.source
        var sourcePath = ''
        try { sourcePath = String((sourceWindow && sourceWindow.location && sourceWindow.location.pathname) || '') } catch (error) { sourcePath = '' }
        if (sourcePath.indexOf(UI_URL) !== 0) return
        var msg = event.data
        if (!msg || msg.to !== 'dsh-thunderbird' || typeof msg.id !== 'string') return

        if (msg.type === 'ping') {
          replyTo(event.source, msg.id, {
            ok: true,
            result: {
              workspaces: serviceOf(ctx, 'workspaces') !== undefined,
              uiWorkspace: serviceOf(ctx, 'uiWorkspace') !== undefined,
              sessions: serviceOf(ctx, 'sessions') !== undefined,
              layout: serviceOf(ctx, 'layout') !== undefined,
              betterSidebar: serviceOf(ctx, 'betterSidebar') !== undefined,
            },
          })
          return
        }

        if (msg.type === 'probe/services') {
          // Temporary diagnostic: what can the client half actually reach, and
          // what does each surface offer? Guessing here costs a restart per try.
          var describe = function (name) {
            var svc = serviceOf(ctx, name)
            if (svc === undefined) return { name: name, present: false }
            var own = []
            var proto = []
            try { own = Object.keys(svc) } catch (error) { own = ['<unreadable>'] }
            try {
              var p = Object.getPrototypeOf(svc)
              if (p && p !== Object.prototype) proto = Object.getOwnPropertyNames(p)
            } catch (error) { /* ignore */ }
            return { name: name, present: true, own: own, proto: proto }
          }
          replyTo(event.source, msg.id, {
            ok: true,
            result: {
              services: (Array.isArray(msg.names) && msg.names.length
                ? msg.names
                : ['layout', 'sessions', 'uiWorkspace', 'workspaces', 'betterSidebar']
              ).map(describe),
              tabs: (function () {
                var sidebar = serviceOf(ctx, 'betterSidebar')
                if (sidebar === undefined) return []
                try {
                  return sidebar.getTabs().map(function (t) {
                    return { id: t.id, enabled: sidebar.isTabEnabled(t.id) }
                  })
                } catch (error) { return ['<threw: ' + String(error && error.message) + '>'] }
              })(),
            },
          })
          return
        }

        // Open one of our own tab types in DSH's native right column.
        //
        // Registering our OWN type rather than using the built-in browser one is
        // not cosmetic: the browser builtin renders a sandbox WITHOUT
        // allow-same-origin (it needs a loopback whitelist too), so inside it the
        // panel would be a different origin and theme mirroring plus the
        // postMessage bridge would both die.
        //
        // `url` is what makes the open land in the NATIVE column: the sidebar
        // routes an open carrying a path/url through its native surface, and an
        // open without one into its own bottom workbench.
        // Open one of our own tab types in DSH's native right column.
        //
        // Registering our OWN type rather than using the built-in browser one is
        // not cosmetic: the browser builtin renders a sandbox WITHOUT
        // allow-same-origin (it needs a loopback whitelist too), so inside it the
        // panel would be a different origin and theme mirroring plus the
        // postMessage bridge would both die.
        //
        // `url` is what makes the open land in the NATIVE column: the sidebar
        // routes an open carrying a path/url through its native surface, and an
        // open without one into its own bottom workbench.
        // NOTE: there is deliberately no `session/ensure` here. Materialising a
        // saved session was tried through every read-only door the client face
        // offers — binding / scope / materializeScope / resolve / sessionOf — and
        // NONE of them brings it into the host's registry: binding and scope
        // return objects, materializeScope throws "already has a bound scope",
        // sessionOf is undefined. `sessions.open` is the only thing that works, so
        // that is what the panel uses, and it is honest about the side effect
        // (it makes that session current).
        if (msg.type === 'probe/composer') {
          // What does DSH's own composer expose to a plugin? Writing a lookalike
          // from scratch would miss attachments, model and the token meter, so
          // the point is to reach the REAL one.
          var conv = serviceOf(ctx, 'conversation')
          var out = { present: conv !== undefined }
          var show = function (name, limit) {
            try {
              var fn = conv[name]
              if (typeof fn !== 'function') return { name: name, type: typeof fn }
              return { name: name, arity: fn.length, src: String(fn).slice(0, limit || 260) }
            } catch (error) { return { name: name, error: String(error && error.message) } }
          }
          if (conv) {
            out.own = Object.keys(conv)
            out.methods = ['send', 'sendSession', 'createDrafts', 'beginFileUpload', 'resolveDraftAttachments'].map(function (n) { return show(n) })
            out.inputKeys = conv.input ? Object.keys(conv.input) : null
          }
          var sessions = serviceOf(ctx, 'sessions')
          if (sessions && msg.sessionId) {
            try {
              var scoped = sessions.scope(String(msg.sessionId))
              out.scopeKeys = scoped ? Object.keys(scoped).slice(0, 40) : null
              if (scoped && conv && conv.input && typeof conv.input.for === 'function') {
                var handle = conv.input.for(scoped)
                out.inputFor = handle ? Object.keys(handle) : null
                if (handle && handle.state && typeof handle.state.getSnapshot === 'function') {
                  out.draft = handle.state.getSnapshot()
                }
                var describe2 = function (bag, label) {
                  if (!bag) return null
                  var result = { label: label, keys: Object.keys(bag).slice(0, 30) }
                  result.fns = {}
                  Object.keys(bag).slice(0, 30).forEach(function (k) {
                    if (typeof bag[k] === 'function') result.fns[k] = bag[k].length
                    else if (bag[k] && typeof bag[k] === 'object') result.fns[k] = 'obj:' + Object.keys(bag[k]).slice(0, 8).join(',')
                  })
                  return result
                }
                out.actions = describe2(handle && handle.actions, 'actions')
                out.core = describe2(handle && handle.core, 'core')
              }
            } catch (error) { out.scopeError = String((error && error.message) || error) }
          }
          var candidates = ['modelSelection', 'model', 'tokenMeter', 'permissionPresets', 'permissions',
            'approval', 'goal', 'commands', 'command', 'inputTrigger', 'sessionTitle', 'usage', 'meter']
          out.candidates = candidates.map(function (name) {
            var svc = serviceOf(ctx, name)
            if (svc === undefined) return { name: name, present: false }
            var own = []
            try { own = Object.keys(svc).slice(0, 24) } catch (error) { own = ['<unreadable>'] }
            var proto = []
            try {
              var p = Object.getPrototypeOf(svc)
              if (p && p !== Object.prototype) proto = Object.getOwnPropertyNames(p).slice(1, 25)
            } catch (error) { /* ignore */ }
            return { name: name, present: true, own: own, proto: proto }
          })
          replyTo(event.source, msg.id, { ok: true, result: out })
          return
        }


        // Send through DSH's OWN composer for that session.
        //
        // `conversation.input.for(sessions.scope(id))` is the input machine the
        // native composer drives, and its actions are setDraft / addAttachments /
        // submit. Using it means attachments upload, the model and approval
        // settings apply, and the turn is indistinguishable from one typed by
        // hand — none of which a plugin can reproduce by calling prompt() itself.
        //
        // This handler was once deleted by accident (a line-range edit aimed at the
        // probe helpers above took it too), and the only symptom was that 发送 did
        // nothing. `dev/check-panel.mjs` now diffs the panel's dshCall types
        // against these handlers so that cannot happen quietly again.
        if (msg.type === 'session/compose') {
          var conv = serviceOf(ctx, 'conversation')
          var sess = serviceOf(ctx, 'sessions')
          if (conv === undefined || sess === undefined) {
            replyTo(event.source, msg.id, { ok: false, error: 'conversation / sessions 服务不可用' })
            return
          }
          var sid = String(msg.sessionId || '')
          if (!sid) { replyTo(event.source, msg.id, { ok: false, error: '缺少 sessionId' }); return }
          var handle = null
          try { handle = conv.input.for(sess.scope(sid)) } catch (error) { handle = null }
          if (!handle || !handle.actions || typeof handle.actions.submit !== 'function') {
            replyTo(event.source, msg.id, { ok: false, error: '拿不到这个会话的输入框' })
            return
          }
          var files = Array.isArray(msg.files) ? msg.files : []
          var text = String(msg.text || '')
          // A dry run never submits, so it is also allowed to set an EMPTY draft —
          // which is how a diagnostic can put the composer back as it found it.
          if (!text && !files.length && msg.dryRun !== true) {
            replyTo(event.source, msg.id, { ok: false, error: '没有内容可发送' })
            return
          }
          var report = { steps: [] }

          var send = function () {
            // setDraft and submit are two writes into the same input machine, and
            // submit reads the draft it holds. Firing them in the same tick sent an
            // EMPTY turn — which is exactly what "发送没生效" looked like from the
            // panel: no error, no message. Let the state settle, then confirm the
            // draft actually took before submitting.
            var held = ''
            try {
              var snap = handle.state.getSnapshot()
              held = String((snap && snap.draft) || '')
            } catch (error) { held = '' }
            if (text && held.indexOf(text.slice(0, 24)) < 0) {
              replyTo(event.source, msg.id, { ok: false, error: '草稿没有写进会话输入框，已中止发送（' + report.steps.join(' ') + '）' })
              return
            }
            if (msg.dryRun === true) {
              replyTo(event.source, msg.id, { ok: true, result: { dryRun: true, held: held.length, steps: report.steps } })
              return
            }
            try {
              handle.actions.submit()
              replyTo(event.source, msg.id, { ok: true, result: { steps: report.steps } })
            } catch (error) {
              replyTo(event.source, msg.id, { ok: false, error: '提交失败：' + String((error && error.message) || error) })
            }
          }

          // An upload is asynchronous: submitting while the queue is still busy
          // would send the message without its attachments.
          var waitForQueue = function (left) {
            var queue = []
            try {
              var snap = handle.state.getSnapshot()
              queue = (snap && snap.queue) || []
            } catch (error) { queue = [] }
            if (!queue.length || left <= 0) { report.steps.push('queue=' + (queue.length ? 'timed-out' : 'clear')); send(); return }
            setTimeout(function () { waitForQueue(left - 1) }, 250)
          }

          if (files.length) {
            try {
              // The sequence the native composer uses, copied from
              // dsh-client-ui-conversation: createDrafts registers the files and
              // starts their uploads, then the ids go into the draft.
              var drafts = conv.createDrafts(sid, files)
              var ids = (drafts || []).map(function (d) { return d.id })
              var accepted = handle.actions.addAttachments(ids)
              report.steps.push('drafts=' + ids.length + ' accepted=' + accepted)
              if (accepted === false && typeof conv.releaseDraftAttachments === 'function') {
                conv.releaseDraftAttachments(drafts)
                replyTo(event.source, msg.id, { ok: false, error: '这个会话不接受这些附件' })
                return
              }
              waitForQueue(80)
            } catch (error) {
              replyTo(event.source, msg.id, { ok: false, error: '附件上传失败：' + String((error && error.message) || error) })
            }
            return
          }

          try { handle.actions.setDraft(text) } catch (error) {
            replyTo(event.source, msg.id, { ok: false, error: '写入草稿失败：' + String((error && error.message) || error) })
            return
          }
          report.steps.push('setDraft=ok')
          // Two turns of the event loop: enough for the input machine to commit
          // the draft, and far below anything a person would notice.
          setTimeout(send, 0)
          return
        }

        // Show or hide DSH's own right column.
        //
        // `openRightbar` is called automatically when a tab opens, but there was
        // no way to ask for the COLUMN itself — so when it folded away there was
        // nothing left to click. `setRightbar` is the precise op; the open/close
        // pair is the fallback.
        if (msg.type === 'panel/rightbar') {
          var lyt = serviceOf(activeCtx, 'layout')
          if (lyt === undefined) { replyTo(event.source, msg.id, { ok: false, error: 'layout 服务不可用' }); return }
          var want = msg.open === true
          var how = ''
          try {
            if (lyt.panels && typeof lyt.panels.setRightbar === 'function') { lyt.panels.setRightbar(want); how = 'setRightbar' }
            else if (want && typeof lyt.openRightbar === 'function') { lyt.openRightbar(); how = 'openRightbar' }
            else if (!want && typeof lyt.closeRightbar === 'function') { lyt.closeRightbar(); how = 'closeRightbar' }
            else { replyTo(event.source, msg.id, { ok: false, error: '没有可用的右侧栏开关' }); return }
          } catch (error) {
            replyTo(event.source, msg.id, { ok: false, error: String((error && error.message) || error) })
            return
          }
          replyTo(event.source, msg.id, { ok: true, result: { how: how, open: want } })
          return
        }

        // The panel's settings page needs an absolute directory, and DSH already
        // owns a native folder chooser. Relaying it means the user never has to
        // type a Windows path into a text box.
        if (msg.type === 'ui/pick-directory') {
          var uiws = serviceOf(activeCtx, 'uiWorkspace')
          if (uiws === undefined || typeof uiws.pickDirectory !== 'function') {
            replyTo(event.source, msg.id, { ok: false, error: 'uiWorkspace.pickDirectory 不可用' })
            return
          }
          Promise.resolve(uiws.pickDirectory()).then(function (path) {
            replyTo(event.source, msg.id, { ok: true, result: { path: path || '' } })
          }).catch(function (error) {
            replyTo(event.source, msg.id, { ok: false, error: String((error && error.message) || error) })
          })
          return
        }

        if (msg.type === 'panel/open-ai' || msg.type === 'panel/open-tab') {
          var facts = []
          var sidebar = serviceOf(activeCtx, 'betterSidebar')
          if (sidebar === undefined) {
            replyTo(event.source, msg.id, {
              ok: false,
              error: 'ctx.get("betterSidebar") 返回 undefined —— 服务没注册到我这个 ctx 上',
            })
            return
          }
          // `panel/open-ai` is kept as a name because the panel's mirror flow asks
          // for it by name; it is the AI case of the same open.
          var kind = msg.type === 'panel/open-ai' ? 'ai' : (msg.kind === 'session' ? 'session' : 'ai')
          var spec = TAB_TYPES[kind]
          var react = null
          try { react = require('react') } catch (error) { react = null }
          facts.push('version=' + String(sidebar.version || '?'))
          facts.push('features=' + String((sidebar.features || []).join('|') || '-'))
          facts.push('react=' + (react ? 'yes' : 'no'))
          facts.push('getSnapshot=' + (typeof sidebar.getSnapshot === 'function'))
          facts.push('registerTab=' + (typeof sidebar.registerTab === 'function'))
          facts.push('registered=' + ensureTab(sidebar, react, kind))

          var url = location.origin + UI_URL + (msg.url || (kind === 'ai' ? '?view=ai' : ''))
          var title = msg.title || spec.title

          if (tabDisposers[kind] === null) {
            // No React, so our own tab type cannot exist. Fall back to the builtin
            // browser tab and SAY SO, because it will look wrong (opaque origin).
            try {
              sidebar.openTab({ type: 'browser', url: url, title: title })
              replyTo(event.source, msg.id, { ok: false, error: '只能退回内置 browser 标签（跨源，面板会失去主题和会话桥）：' + facts.join(' ') })
            } catch (error) {
              replyTo(event.source, msg.id, { ok: false, error: facts.join(' ') + ' / openTab threw: ' + String((error && error.message) || error) })
            }
            return
          }

          // The native column is DSH's, and it can be collapsed. An open into a
          // collapsed column looks EXACTLY like "the button did nothing", which
          // is the report this whole path exists to answer — so open it, then
          // MEASURE it and say what actually happened instead of assuming.
          var layout = serviceOf(activeCtx, 'layout')
          if (layout !== undefined && typeof layout.openRightbar === 'function') {
            try { layout.openRightbar(); facts.push('rightbar=open') } catch (error) { facts.push('rightbar=' + String((error && error.message) || error)) }
          } else {
            facts.push('rightbar=unavailable')
          }
          // Measure OUR OWN tab frame. Every other candidate lies: the column is
          // a zero-width grid track (the sidebar draws as an absolutely
          // positioned overlay inside it), and `nativeTabHost` also matches the
          // centre column's host. What matters is only whether the frame we just
          // asked for is painted with a real width. -1 means "cannot tell", and
          // the panel stays quiet for it rather than crying wolf.
          var ourTabWidth = function () {
            var frames = document.querySelectorAll('iframe')
            for (var i = 0; i < frames.length; i++) {
              var src = String(frames[i].src || '')
              if (src.indexOf('/api/thunderbird/ui') < 0) continue
              if (src.indexOf('view=') < 0) continue
              var rect = frames[i].getBoundingClientRect()
              if (rect.width > 0) return Math.round(rect.width)
            }
            return -1
          }

          // A `single: true` type dedupes onto the instance already open, and a
          // dedupe focus does NOT carry the new seed. `updateTab` patches the
          // record but does NOT remount the tab body, so an iframe that is already
          // mounted keeps pointing at its OLD src — which is how the AI tab ended
          // up as a bare /ui with no ?view=ai. Closing first forces a fresh mount
          // that reads the seed. The last-open url is remembered so repeated opens
          // of the same target do not flicker.
          if (lastOpenedUrl[kind] !== url) {
            try { sidebar.closeTab(spec.id) } catch (error) { /* not open */ }
            lastOpenedUrl[kind] = url
            facts.push('reopened')
          }

          try {
            sidebar.openTab({ type: spec.id, url: url, title: title })
          } catch (error) {
            replyTo(event.source, msg.id, { ok: false, error: facts.join(' ') + ' / openTab threw: ' + String((error && error.message) || error) })
            return
          }

          // A `single: true` type dedupes onto the instance that is already open,
          // and a dedupe focus does NOT carry the new seed. Patching the record
          // with `updateTab` is not enough: the tab BODY reads the seed when it
          // renders, and the patch does not make it render again.
          // What does work — measured, not assumed — is issuing the open a second
          // time: the tab already exists, so this focuses it AND applies the seed,
          // and the frame lands on the right page. One open alone left the AI tab
          // pointing at a bare /ui.
          var reissue = function () {
            try { sidebar.openTab({ type: spec.id, url: url, title: title }) } catch (error) { /* already open */ }
          }
          setTimeout(reissue, 250)
          setTimeout(reissue, 900)

          if (typeof sidebar.updateTab === 'function') {
            try {
              sidebar.updateTab(spec.id, { path: url, title: title })
              facts.push('retargeted')
            } catch (error) { facts.push('updateTab=' + String((error && error.message) || error)) }
          }

          // openTab returns silently for an unknown or disabled type, so verify
          // against the snapshot instead of believing the call.
          // There is NO local way to verify a native-sidebar open: the right column
          // belongs to DSH, and getSnapshot() only reports this plugin's OWN bottom
          // workbench (SidebarState carries bottomSplits, not the native tabs). An
          // earlier version counted tabs there and reported failure for an open
          // that had actually worked. The honest signals are that the type is
          // registered, that it is not switched off in the side-card settings, and
          // how wide the column ended up.
          var enabled = typeof sidebar.isTabEnabled === 'function' ? sidebar.isTabEnabled(spec.id) : true
          facts.push('enabled=' + enabled)
          // The column is React state; its width can land a frame later. Frame
          // callbacks are NOT reliable here — a panel iframe that is obscured or
          // in a background tab gets no frames at all, and the reply then never
          // arrives, which looks exactly like the dead button this whole path
          // exists to explain. A timer always fires.
          var settle = function () {
            var width = ourTabWidth()
            replyTo(event.source, msg.id, enabled
              ? { ok: true, result: { facts: facts.join(' '), title: title, rightbarWidth: width } }
              : { ok: false, error: '这个标签类型在右侧边栏设置里被关掉了，启用它即可：' + facts.join(' ') })
          }
          if (ourTabWidth() > 0) settle()
          else setTimeout(settle, 250)
          return
        }

        if (msg.type === 'session/create') {
          createMailSession(ctx, msg).then(function (result) {
            replyTo(event.source, msg.id, { ok: true, result: result })
          }).catch(function (error) {
            replyTo(event.source, msg.id, { ok: false, error: String((error && error.message) || error) })
          })
          return
        }

        if (msg.type === 'session/open' || msg.type === 'session/open-main') {
          var sessions = serviceOf(ctx, 'sessions')
          var workspace = serviceOf(ctx, 'uiWorkspace')
          try {
            if (!msg.sessionId) throw new Error('缺少 sessionId')
            // uiWorkspace.openSession is the domain op the workspace UI itself
            // uses to actually OPEN a session. sessions.open only selects it in
            // the sidebar, which is why the first click looked half-done.
            if (workspace !== undefined && typeof workspace.openSession === 'function') {
              workspace.openSession(String(msg.sessionId))
            } else if (sessions !== undefined) {
              sessions.open(String(msg.sessionId))
            } else {
              throw new Error('DSH 会话服务不可用')
            }
            // Deliberately NOT calling layout.openRightbar: the right bar mirrors
            // the active session, but opening it without selecting one of its own
            // tabs renders an EMPTY column — which is the blank panel the second
            // click produced.
            if (msg.type === 'session/open-main') closePanel()
            replyTo(event.source, msg.id, { ok: true, result: true })
          } catch (error) {
            replyTo(event.source, msg.id, { ok: false, error: String((error && error.message) || error) })
          }
          return
        }

        if (msg.type === 'session/fork') {
          var uiWs = serviceOf(ctx, 'uiWorkspace')
          try {
            if (uiWs === undefined || !msg.sessionId) throw new Error('无法复制会话')
            uiWs.forkSession(String(msg.sessionId))
            replyTo(event.source, msg.id, { ok: true, result: true })
          } catch (error) {
            replyTo(event.source, msg.id, { ok: false, error: String((error && error.message) || error) })
          }
          return
        }

        // Driving a session: ctx.sessions.binding(id) hands back the client-side
        // session object, and its prompt() is exactly what the DSH composer
        // calls. The panel can therefore run a turn inside the thread's real
        // session instead of only making its own one-shot model call.
        if (msg.type === 'session/prompt' || msg.type === 'session/cancel' || msg.type === 'session/state') {
          handleSessionOp(ctx, msg, event.source)
        }
      }
    }

    function mailSession (ctx, sessionId) {
      var sessions = serviceOf(ctx, 'sessions')
      if (sessions === undefined) throw new Error('DSH sessions 服务不可用')
      if (!sessionId) throw new Error('缺少 sessionId')
      var binding = sessions.binding(String(sessionId))
      if (!binding || !binding.session) throw new Error('DSH 里还没有这个会话的客户端绑定')
      return binding.session
    }

    function handleSessionOp (ctx, msg, source) {
      var fail = function (error) {
        replyTo(source, msg.id, { ok: false, error: String((error && error.message) || error) })
      }
      var session
      try {
        session = mailSession(ctx, msg.sessionId)
      } catch (error) { fail(error); return }

      if (msg.type === 'session/state') {
        try {
          var snap = session.getSnapshot()
          replyTo(source, msg.id, {
            ok: true,
            result: {
              running: snap.running === true,
              awaitingFirstTurn: snap.awaitingFirstTurn === true,
              promptError: snap.promptError ? String(snap.promptError.message || snap.promptError) : '',
              lastAgentError: snap.lastAgentError ? String(snap.lastAgentError.message || snap.lastAgentError) : '',
            },
          })
        } catch (error) { fail(error) }
        return
      }

      if (msg.type === 'session/cancel') {
        Promise.resolve().then(function () { return session.cancel() })
          .then(function () { replyTo(source, msg.id, { ok: true, result: true }) })
          .catch(fail)
        return
      }

      var mode = msg.mode === 'steer' ? 'steer' : 'queue'
      Promise.resolve()
        .then(function () { return session.prompt([{ type: 'text', text: String(msg.text || '') }], mode) })
        .then(function (result) {
          if (result && result.ok === false) {
            var detail = result.error || {}
            fail(new Error(String(detail.code || 'prompt') + (detail.message ? ': ' + String(detail.message) : '')))
            return
          }
          replyTo(source, msg.id, { ok: true, result: true })
        })
        .catch(fail)
    }

    // Watch DSH's own session list and tell the host about ids that disappear.
    //
    // Deleting a conversation in DSH left the mail line still pointing at it, so
    // the panel showed a session that no longer existed and every prompt into it
    // failed. The list feed is the only place that removal is observable, and the
    // host is the only side that owns the binding.
    var sessionIds = null
    var sessionListUnsub = null

    function watchSessionRemovals (ctx) {
      var sessions = serviceOf(ctx, 'sessions')
      if (sessions === undefined || !sessions.list || typeof sessions.list.subscribe !== 'function') return
      var read = function () {
        try {
          var snap = sessions.list.getSnapshot()
          var rows = Array.isArray(snap) ? snap : ((snap && (snap.sessions || snap.items)) || [])
          var ids = []
          for (var i = 0; i < rows.length; i++) {
            var id = rows[i] && (rows[i].id || rows[i].sessionId)
            if (id) ids.push(String(id))
          }
          return ids
        } catch (error) { return null }
      }
      sessionIds = read()
      sessionListUnsub = sessions.list.subscribe(function () {
        var next = read()
        if (next === null || sessionIds === null) { sessionIds = next; return }
        var still = {}
        for (var i = 0; i < next.length; i++) still[next[i]] = true
        var gone = sessionIds.filter(function (id) { return !still[id] })
        sessionIds = next
        if (!gone.length) return
        // The host is a plain HTTP server, so this needs no channel and works even
        // with every panel closed.
        try {
          fetch(location.origin + '/api/thunderbird/session/detach', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionIds: gone }),
          }).catch(function () { /* the binding stays; a later list change retries */ })
        } catch (error) { /* ignore */ }
        // No cross-frame event here on purpose: the panel is one frame deeper
        // than this window, so a post to `window` would land on the shell rather
        // than on the panel. The panel refreshes the list while its 会话 window is
        // open instead, which needs no plumbing.
      })
    }

    function apply (ctx) {
      activeCtx = ctx
      try { injectCss() } catch (error) { /* styles are optional */ }
      document.addEventListener('dsh-panel-activate', onPanelActivate)
      document.addEventListener('click', onDocumentClick, true)
      document.addEventListener('keydown', onDocumentKey, true)
      var onMessage = onWindowMessage(ctx)
      window.addEventListener('message', onMessage)
      // Keep the body-level overlay aligned with the column it covers. Passive +
      // capture: the column may scroll inside a scroller we do not own.
      window.addEventListener('resize', onViewportChange)
      document.addEventListener('scroll', trackOverlay, true)
      tryMount()
      try { watchSessionRemovals(ctx) } catch (error) { /* the rest of the panel still works */ }
      observer = new MutationObserver(function () { try { tryMount() } catch (error) { /* never break the shell */ } })
      observer.observe(document.documentElement, { childList: true, subtree: true })
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            try { if (observer !== null) observer.disconnect() } catch (error) { /* ignore */ }
            if (probeTimer !== null) { clearInterval(probeTimer); probeTimer = null }
            try { if (typeof sessionListUnsub === 'function') sessionListUnsub() } catch (error) { /* ignore */ }
            sessionListUnsub = null
            window.removeEventListener('message', onMessage)
            window.removeEventListener('resize', onViewportChange)
            document.removeEventListener('scroll', trackOverlay, true)
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

