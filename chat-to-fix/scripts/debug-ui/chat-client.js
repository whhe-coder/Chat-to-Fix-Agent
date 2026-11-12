// Browser code of the bot group chat pane (inlined by the debug page as CHAT_JS; no imports, no external resources).
// Defines window.renderChat(container, chat, { onSelect(recordIds) }), window.highlightChat(container, recordIds) and
// window.chatMarkdown(text, { names, colors }) (the Markdown renderer, also run by the tests through chat.ts).
//
// Ported from the old DS Bot web client (git 263a272, bot/src/client/), adapted to plain DOM:
//   styles.js   bubble shape and spacing (.bt-bubble, .bt-msg, .bt-time), colour tokens (--bt-ink, --bt-bubble, --bt-line ...)  -> chat.css
//   inks.js     the ink colours of the bot marks (INKS)                                                                       -> chat.ts ROLE_COLOR
//   text.js     the @mention rule (linkMentions), message clock (messageClock) and the long-text fold (fold.js, FOLD_AT)      -> chatMarkdown / clock / .cx-clip
//   mark.js     the round bot mark, reduced to a coloured disc with the initial
// Everything that came from models or Slack is untrusted: text is HTML-escaped before any markup is added, nodes are made
// with createElement/textContent, and only http(s) and fake: links survive.
(function () {
  'use strict'

  // ---------------------------------------------------------------------------------------------- escaping
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ESC[c] }) }
  function unesc(s) { return String(s).replace(/&#39;|&quot;|&gt;|&lt;|&amp;/g, function (e) { return { '&#39;': "'", '&quot;': '"', '&gt;': '>', '&lt;': '<', '&amp;': '&' }[e] }) }

  // A link survives only with an http(s) or fake: scheme (whitespace and control characters inside the scheme are stripped
  // first, so "java\tscript:" cannot slip through; every other scheme, relative links and "#" are dropped).
  function safeUrl(raw) {
    var url = unesc(raw).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    return /^(https?|fake):\/\/[^\s]+$/i.test(url) ? url : null
  }
  function anchor(url, innerHtml) {
    return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer nofollow">' + innerHtml + '</a>'
  }

  // ---------------------------------------------------------------------------------------------- Markdown
  // Inline: code spans, links, bare URLs, bold, italic, strike and @mentions. Finished HTML is parked in `stash` behind
  // NUL-delimited placeholders so later rules cannot touch it (the input has its NULs removed first).
  function inline(raw, opts) {
    var stash = []
    function park(html) { stash.push(html); return '\u0000' + (stash.length - 1) + '\u0000' }
    var s = String(raw).replace(/\u0000/g, '')
    // code spans (`code`, ``a ` b``)
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, function (_, _t, code) { return park('<code>' + esc(code.replace(/^ (.*) $/, '$1')) + '</code>') })
    s = esc(s)
    // [text](url): the url is checked on its unescaped form
    s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)*)\)/g, function (all, text, url) {
      var ok = safeUrl(url)
      return ok ? park(anchor(ok, emphasis(text))) : park(emphasis(text))
    })
    // bare http(s):// and fake:// URLs; stops at whitespace, entities other than &amp;, and CJK text or punctuation
    s = s.replace(/(^|[^\w/"=])((?:https?|fake):\/\/(?:[^\s&<\u3000-\u303f\uff00-\uffef\u4e00-\u9fff\u0000]|&amp;)+)/gi, function (all, lead, url) {
      var tail = ''
      var m = /[.,;:!?)\]]+$/.exec(url)
      if (m) { tail = m[0]; url = url.slice(0, -tail.length) }
      var ok = safeUrl(url)
      return ok ? lead + park(anchor(ok, url)) + tail : all
    })
    s = emphasis(s)
    s = mentions(s, opts)
    // parked HTML may itself hold placeholders of earlier items (a link around a code span): resolve until none is left
    var guard = 0
    while (/\u0000\d+\u0000/.test(s) && guard++ < 8) s = s.replace(/\u0000(\d+)\u0000/g, function (_, n) { return stash[+n] })
    return s
  }
  function emphasis(s) {
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1<em>$2</em>')
    s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    return s
  }
  // @mentions: the member names given in opts.names (longest first, any script) and any ASCII "@Name-1" word. The colour
  // is only used when it is a plain hex colour.
  function mentions(s, opts) {
    var names = (opts && opts.names ? Array.prototype.slice.call(opts.names) : []).filter(function (n) { return typeof n === 'string' && n !== '' })
    names.sort(function (a, b) { return b.length - a.length })
    var alt = names.map(function (n) { return esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') })
    alt.push('[A-Za-z][\\w-]*')
    var re = new RegExp('(^|[^\\w@/.])@(' + alt.join('|') + ')', 'gi')
    return s.replace(re, function (all, lead, name) {
      var color = opts && opts.colors ? lookup(opts.colors, unesc(name)) : null
      var style = typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color) ? ' style="--c:' + color + '"' : ''
      return lead + '<span class="cx-at"' + style + '>@' + name + '</span>'
    })
  }
  function lookup(map, key) {
    var low = String(key).toLowerCase()
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k) && k.toLowerCase() === low) return map[k]
    return null
  }

  var FENCE = /^ {0,3}(`{3,}|~{3,})/
  var LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
  var HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
  var HR = /^ {0,3}([-*_])( *\1){2,} *$/
  function isTableSep(line) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.indexOf('-') >= 0 }
  function cells(line) { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim() }) }
  function startsBlock(line, next) {
    return FENCE.test(line) || HEADING.test(line) || HR.test(line) || /^ {0,3}>/.test(line) || LIST.test(line) || (line.indexOf('|') >= 0 && next !== undefined && isTableSep(next))
  }

  function blocks(lines, opts) {
    var out = []
    var i = 0
    while (i < lines.length) {
      var line = lines[i]
      var m
      if (line.trim() === '') { i += 1; continue }
      if ((m = FENCE.exec(line))) {
        var marker = m[1]
        var code = []
        i += 1
        while (i < lines.length) {
          var close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i])
          if (close && close[1][0] === marker[0] && close[1].length >= marker.length) { i += 1; break }
          code.push(lines[i]); i += 1
        }
        out.push('<pre class="cx-pre"><code>' + esc(code.join('\n')) + '</code></pre>')
        continue
      }
      if ((m = HEADING.exec(line))) { out.push('<div class="cx-h cx-h' + m[1].length + '">' + inline(m[2], opts) + '</div>'); i += 1; continue }
      if (HR.test(line)) { out.push('<hr>'); i += 1; continue }
      if (/^ {0,3}>/.test(line)) {
        var quote = []
        while (i < lines.length && /^ {0,3}>/.test(lines[i])) { quote.push(lines[i].replace(/^ {0,3}> ?/, '')); i += 1 }
        out.push('<blockquote>' + blocks(quote, opts) + '</blockquote>')
        continue
      }
      if (line.indexOf('|') >= 0 && lines[i + 1] !== undefined && isTableSep(lines[i + 1])) {
        var head = cells(line)
        i += 2
        var rows = []
        while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') >= 0) { rows.push(cells(lines[i])); i += 1 }
        out.push('<table class="cx-table"><thead><tr>' + head.map(function (c) { return '<th>' + inline(c, opts) + '</th>' }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inline(c, opts) + '</td>' }).join('') + '</tr>' }).join('') + '</tbody></table>')
        continue
      }
      if (LIST.test(line)) {
        var items = []
        while (i < lines.length) {
          var lm = LIST.exec(lines[i])
          if (lm) { items.push({ indent: lm[1].replace(/\t/g, '    ').length, ordered: /\d/.test(lm[2]), text: lm[3] }); i += 1; continue }
          // an indented non-list line continues the item above
          if (items.length > 0 && lines[i].trim() !== '' && /^\s{2,}/.test(lines[i]) && !FENCE.test(lines[i])) { items[items.length - 1].text += '\n' + lines[i].trim(); i += 1; continue }
          break
        }
        out.push(renderList(items, opts))
        continue
      }
      var para = [line]
      i += 1
      while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i], lines[i + 1])) { para.push(lines[i]); i += 1 }
      out.push('<p>' + para.map(function (l) { return inline(l, opts) }).join('<br>') + '</p>')
    }
    return out.join('')
  }
  function renderList(items, opts) {
    var html = ''
    var stack = [] // { indent, ordered }
    items.forEach(function (it) {
      while (stack.length > 0 && it.indent < stack[stack.length - 1].indent) { html += '</li></' + (stack.pop().ordered ? 'ol' : 'ul') + '>' }
      // a bullet list followed by a numbered one at the same indent is two lists
      if (stack.length > 0 && it.indent === stack[stack.length - 1].indent && it.ordered !== stack[stack.length - 1].ordered) html += '</li></' + (stack.pop().ordered ? 'ol' : 'ul') + '>'
      if (stack.length > 0 && it.indent === stack[stack.length - 1].indent) html += '</li>'
      else if (stack.length === 0 || it.indent > stack[stack.length - 1].indent) { stack.push({ indent: it.indent, ordered: it.ordered }); html += it.ordered ? '<ol>' : '<ul>' }
      html += '<li>' + it.text.split('\n').map(function (l) { return inline(l, opts) }).join('<br>')
    })
    while (stack.length > 0) html += '</li></' + (stack.pop().ordered ? 'ol' : 'ul') + '>'
    return html
  }
  // text -> HTML. Block structure is read from the raw text; every text span goes through esc() before markup is added.
  function chatMarkdown(text, opts) {
    return blocks(String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n'), opts)
  }
  window.chatMarkdown = chatMarkdown

  // ---------------------------------------------------------------------------------------------- helpers
  var STEP_LABEL = { fetch: '取讨论', issue: '建工单', prepare: '准备代码', code: '写代码', mr: '开 MR', ci: 'CI', writeback: '回写', close: '结束' }
  var STATE_LABEL = { queued: '排队中', running: '运行中', done: '已完成', needs_info: '需要补充信息', failed: '失败', timed_out: '超时', stopped: '已停止', expired: '已过期' }
  function pad(n) { return n < 10 ? '0' + n : '' + n }
  // The message clock (text.js messageClock, here always the clock with seconds: the pane is for debugging).
  function clock(at) {
    var d = new Date(at)
    return isNaN(d.getTime()) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = text
    return n
  }
  function prettyJson(text) {
    var t = String(text == null ? '' : text).trim()
    if (t === '' || (t[0] !== '{' && t[0] !== '[')) return String(text == null ? '' : text)
    try { return JSON.stringify(JSON.parse(t), null, 2) } catch (e) { return String(text) }
  }
  function colorOk(c) { return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#8a8f98' }
  function initial(name) { var ch = Array.from(String(name || '?'))[0] || '?'; return ch.toUpperCase() }
  function mark(member, size) {
    var m = el('span', 'cx-mark' + (size === 'sm' ? ' cx-mark-sm' : ''), initial(member && member.name))
    m.style.setProperty('--c', colorOk(member && member.color))
    if (member) m.title = member.name
    return m
  }
  function setHtml(node, html) { node.innerHTML = html } // html always comes from chatMarkdown, which escapes first

  // ---------------------------------------------------------------------------------------------- chat view
  function init(container) {
    container.textContent = ''
    container.classList.add('cx-chat')
    var st = { nodes: new Map(), expanded: new Set(), selected: null, seen: 0, unread: 0, onSelect: null, headSig: '' }
    st.head = el('div', 'cx-head')
    st.scroller = el('div', 'cx-scroll')
    st.list = el('div', 'cx-list')
    st.empty = el('div', 'cx-empty', '还没有消息')
    st.more = el('button', 'cx-new')
    st.more.type = 'button'
    st.more.hidden = true
    st.more.addEventListener('click', function () { st.scroller.scrollTop = st.scroller.scrollHeight; st.unread = 0; st.more.hidden = true })
    st.scroller.appendChild(st.list)
    st.scroller.addEventListener('scroll', function () { if (atBottom(st)) { st.unread = 0; st.more.hidden = true } })
    container.appendChild(st.head)
    container.appendChild(st.scroller)
    container.appendChild(st.more)
    container.__cx = st
    return st
  }
  function atBottom(st) { return st.scroller.scrollHeight - st.scroller.scrollTop - st.scroller.clientHeight < 48 }

  // Lays the messages out as items: one per bubble / notice / refusal, and one per run of tool rows of the same bot. `head` is
  // true where a new speaker starts (mark, name and time are shown there).
  function layout(chat) {
    var msgs = chat.messages || []
    var items = []
    var prev = null
    for (var i = 0; i < msgs.length; i += 1) {
      var m = msgs[i]
      if (m.kind === 'system' || m.kind === 'notice') { items.push({ type: m.kind, ms: [m], head: false }); prev = null; continue }
      var who = (m.role || '') + '|' + (m.botId || '')
      var head = who !== prev
      if (m.kind === 'tool') {
        var group = [m]
        while (i + 1 < msgs.length && msgs[i + 1].kind === 'tool' && (msgs[i + 1].role || '') + '|' + (msgs[i + 1].botId || '') === who) { i += 1; group.push(msgs[i]) }
        items.push({ type: 'tools', ms: group, head: head })
      } else items.push({ type: m.kind === 'refusal' ? 'refusal' : 'message', ms: [m], head: head })
      prev = who
    }
    return items
  }

  function renderChat(container, chat, opts) {
    chat = chat || { members: [], messages: [] }
    var st = container.__cx || init(container)
    st.onSelect = opts && typeof opts.onSelect === 'function' ? opts.onSelect : null
    var members = {}
    var names = []
    var colors = {}
    ;(chat.members || []).forEach(function (m) { members[m.role] = m; names.push(m.name); colors[m.name] = m.color })
    st.members = members
    st.mdOpts = { names: names, colors: colors }

    var stick = st.seen === 0 || atBottom(st)
    var items = layout(chat)
    var next = new Map()
    var fresh = 0
    items.forEach(function (it) {
      var key = it.ms[0].id
      var sig = it.type + '|' + it.head + '|' + JSON.stringify(it.ms) + '|' + (st.selected && it.ms.some(function (m) { return m.id === st.selected }) ? 's' : '')
      var old = st.nodes.get(key)
      if (old && old.sig === sig) { next.set(key, old); return }
      var node = build(st, it)
      if (!old) fresh += 1
      next.set(key, { sig: sig, el: node, item: it })
    })
    // sync the DOM with the new order, touching only what changed
    var ref = st.list.firstChild
    items.forEach(function (it) {
      var rec = next.get(it.ms[0].id)
      if (rec.el === ref) { ref = ref.nextSibling; return }
      st.list.insertBefore(rec.el, ref)
    })
    while (ref) { var drop = ref; ref = ref.nextSibling; st.list.removeChild(drop) }
    st.nodes = next

    renderHead(st, chat)
    if (items.length === 0) { if (!st.empty.parentNode) st.list.appendChild(st.empty) } else if (st.empty.parentNode) st.empty.parentNode.removeChild(st.empty)

    measure(st)
    if (stick) { st.scroller.scrollTop = st.scroller.scrollHeight; st.unread = 0; st.more.hidden = true }
    else if (fresh > 0 && st.seen > 0) { st.unread += fresh; st.more.textContent = '↓ ' + st.unread + ' 条新消息'; st.more.hidden = false }
    st.seen = items.length || 1
  }

  function renderHead(st, chat) {
    var sig = JSON.stringify([chat.title, chat.state, chat.step, chat.members, chat.usage && chat.usage.line])
    if (st.headSig === sig) return
    st.headSig = sig
    st.head.textContent = ''
    var text = el('div', 'cx-head-text')
    text.appendChild(el('div', 'cx-title', chat.title || '群聊'))
    var bots = (chat.members || []).filter(function (m) { return m.role !== 'user' }).length
    var sub = [bots + ' 个 bot']
    if (chat.state) sub.push(STATE_LABEL[chat.state] || chat.state)
    if (chat.step) sub.push(STEP_LABEL[chat.step] || chat.step)
    text.appendChild(el('div', 'cx-sub', sub.join(' · ')))
    var stack = el('div', 'cx-stack')
    ;(chat.members || []).forEach(function (m) { stack.appendChild(mark(m, 'sm')) })
    st.head.appendChild(text)
    st.head.appendChild(stack)
    // The bill. Strings come ready from the server (src/task/usage.ts usageView): the total line, and one entry per bot with its model,
    // cost and latest output speed, tagged DSH (measured by DSH, API bots) or 推算 (derived from the Claude Code result).
    if (chat.usage && chat.usage.line) {
      var bill = el('div', 'cx-bill', chat.usage.line)
      bill.title = chat.usage.title || ''
      st.head.appendChild(bill)
      var mems = el('div', 'cx-mems')
      ;(chat.members || []).forEach(function (m) {
        if (!m.usage) return
        var item = el('span', 'cx-mem')
        item.appendChild(mark(m, 'sm'))
        item.appendChild(el('span', 'cx-mem-name', m.name))
        var tps = m.usage.tpsText ? ' · ' + m.usage.tpsText + (m.usage.tpsTag ? ' ' + m.usage.tpsTag : '') : ''
        item.appendChild(el('small', 'cx-mem-use', m.usage.modelText + ' · ' + m.usage.costText + tps))
        item.title = m.usage.subtitle + (m.usage.tpsLabel ? '\n速度：' + m.usage.tpsLabel : '') + '\n' + m.usage.tokensText + (m.usage.effort ? '\neffort ' + m.usage.effort : '')
        mems.appendChild(item)
      })
      if (mems.childNodes.length > 0) st.head.appendChild(mems)
    }
  }

  function memberOf(st, m) {
    return st.members[m.role] || { role: m.role || '', name: m.role || (m.botId ? String(m.botId).slice(0, 12) : '系统'), color: '#8a8f98' }
  }

  function headLine(st, m) {
    var who = memberOf(st, m)
    var line = el('div', 'cx-who')
    var name = el('span', 'cx-name', who.name)
    name.style.setProperty('--c', colorOk(who.color))
    line.appendChild(name)
    if (m.role === 'user') line.appendChild(el('span', 'cx-tag', 'Slack'))
    var t = clock(m.at)
    var step = m.step ? (STEP_LABEL[m.step] || m.step) : ''
    var meta = [t, step].filter(Boolean).join(' · ')
    if (meta) line.appendChild(el('span', 'cx-time', meta))
    // what this round cost, next to the time (the full lines are in the tooltip and in the diagram's popup)
    if (m.usage && m.usage.brief) {
      var use = el('span', 'cx-time cx-use', m.usage.brief)
      use.title = [m.usage.title].concat(m.usage.lines || []).join('\n')
      line.appendChild(use)
    }
    return line
  }

  // One row = [mark column | body column]; the mark shows only where `head` is true.
  function row(st, it, cls) {
    var r = el('div', 'cx-row ' + cls)
    var side = el('div', 'cx-side')
    if (it.head) side.appendChild(mark(memberOf(st, it.ms[0])))
    var body = el('div', 'cx-body')
    if (it.head) body.appendChild(headLine(st, it.ms[0]))
    r.appendChild(side)
    r.appendChild(body)
    r.setAttribute('data-rids', it.ms.reduce(function (a, m) { return a.concat(m.recordIds || []) }, []).join(','))
    return { row: r, body: body }
  }

  function select(st, ids, id, node) {
    var sel = window.getSelection && window.getSelection()
    if (sel && String(sel).length > 0) return // the reader is selecting text, not clicking
    var prev = st.list.querySelector('.cx-sel')
    if (prev) prev.classList.remove('cx-sel')
    st.selected = id
    node.classList.add('cx-sel')
    if (st.onSelect) st.onSelect((ids || []).slice())
  }

  function expandable(st, id, body) {
    // A text longer than ~8 lines is clipped; measure() adds the 展开 button when it really overflows.
    body.classList.add('cx-clip')
    if (st.expanded.has(id)) body.classList.remove('cx-clip')
    return body
  }

  function build(st, it) {
    var m = it.ms[0]
    var node
    if (it.type === 'system' || it.type === 'notice') {
      node = el('div', 'cx-sys' + (it.type === 'notice' ? ' cx-notice' : ''))
      node.setAttribute('data-rids', (m.recordIds || []).join(','))
      if (it.type === 'notice') node.appendChild(el('b', null, '看门狗 '))
      node.appendChild(document.createTextNode(m.text))
      var sk = el('span', 'cx-time', clock(m.at))
      if (sk.textContent) { node.appendChild(document.createTextNode(' ')); node.appendChild(sk) }
      if (m.text.length > 160) { node.classList.add('cx-sys-long') }
      node.addEventListener('click', function () { select(st, m.recordIds, m.id, node) })
      if (st.selected === m.id) node.classList.add('cx-sel')
      return node
    }
    if (it.type === 'tools') return buildTools(st, it)
    var r = row(st, it, it.type === 'refusal' ? 'cx-refusal-row' : 'cx-msg-row')
    var bubble = el('div', 'cx-bubble' + (it.type === 'refusal' ? ' cx-refusal' : '') + (m.role === 'user' ? ' cx-user' : '') + (m.ok === false && it.type !== 'refusal' ? ' cx-failed' : ''))
    if (it.type === 'refusal') bubble.appendChild(el('span', 'cx-refusal-icon', '⚠'))
    var text = el('div', 'cx-text')
    setHtml(text, chatMarkdown(m.text, st.mdOpts))
    expandable(st, m.id, text)
    bubble.appendChild(text)
    var btn = el('button', 'cx-more', '展开 ▾')
    btn.type = 'button'
    btn.hidden = true
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation()
      var open = !st.expanded.has(m.id)
      if (open) st.expanded.add(m.id); else st.expanded.delete(m.id)
      text.classList.toggle('cx-clip', !open)
      btn.textContent = open ? '收起 ▴' : '展开 ▾'
    })
    bubble.appendChild(btn)
    bubble.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('a')) return // a link opens, it does not select
      select(st, m.recordIds, m.id, bubble)
    })
    if (st.selected === m.id) bubble.classList.add('cx-sel')
    r.body.appendChild(bubble)
    return r.row
  }

  function buildTools(st, it) {
    var r = row(st, it, 'cx-tools-row')
    var chips = el('div', 'cx-chips')
    var details = el('div', 'cx-details')
    it.ms.forEach(function (m) {
      var state = m.ok === true ? 'ok' : m.ok === false ? 'bad' : 'wait'
      var chip = el('button', 'cx-chip cx-' + state)
      chip.type = 'button'
      chip.setAttribute('data-rids', (m.recordIds || []).join(','))
      chip.appendChild(el('span', 'cx-dot'))
      chip.appendChild(el('span', 'cx-tool', m.tool || '工具'))
      if (typeof m.ms === 'number') chip.appendChild(el('span', 'cx-ms', m.ms + 'ms'))
      if (state === 'bad') chip.appendChild(el('span', 'cx-ms', '失败'))
      chip.appendChild(el('span', 'cx-caret', '▸'))
      var detail = el('div', 'cx-detail')
      detail.hidden = true
      detail.setAttribute('data-rids', (m.recordIds || []).join(','))
      var any = false
      function section(label, body) {
        if (body == null || String(body).trim() === '' || String(body).trim() === '{}') return
        any = true
        detail.appendChild(el('div', 'cx-dl', label))
        detail.appendChild(el('pre', 'cx-dpre', prettyJson(body)))
      }
      section('参数', m.text)
      section(state === 'bad' ? '结果（失败）' : '结果', m.result)
      if (!any) detail.appendChild(el('div', 'cx-dl', state === 'wait' ? '还没有结果' : '没有参数和结果'))
      function toggle(open) { detail.hidden = !open; chip.classList.toggle('cx-open', open); chip.setAttribute('aria-expanded', open ? 'true' : 'false') }
      toggle(st.expanded.has(m.id))
      chip.addEventListener('click', function () {
        var open = detail.hidden
        if (open) st.expanded.add(m.id); else st.expanded.delete(m.id)
        toggle(open)
        select(st, m.recordIds, m.id, chip)
      })
      if (st.selected === m.id) chip.classList.add('cx-sel')
      chips.appendChild(chip)
      details.appendChild(detail)
    })
    r.body.appendChild(chips)
    r.body.appendChild(details)
    return r.row
  }

  // Shows 展开 on the bubbles whose text really passes the clip (a hidden container measures 0 and is retried next render).
  function measure(st) {
    st.list.querySelectorAll('.cx-bubble').forEach(function (bubble) {
      if (bubble.__measured) return
      var text = bubble.querySelector('.cx-text')
      var btn = bubble.querySelector('.cx-more')
      if (!text || !btn || text.clientHeight === 0) return
      bubble.__measured = true
      var clipped = text.classList.contains('cx-clip')
      var over = clipped ? text.scrollHeight > text.clientHeight + 2 : true
      btn.hidden = !over
      if (!clipped) btn.textContent = '收起 ▴'
      if (!over) text.classList.remove('cx-clip')
    })
  }

  function highlightChat(container, recordIds) {
    var st = container && container.__cx
    if (!st) return
    var ids = {}
    ;(recordIds || []).forEach(function (n) { ids[String(n)] = true })
    var target = null
    var all = st.list.querySelectorAll('[data-rids]')
    // the most specific node wins: a chip or notice before the row that holds it
    for (var i = 0; i < all.length && !target; i += 1) {
      var n = all[i]
      if (n.classList.contains('cx-row') && n.querySelector('.cx-chip')) continue
      var own = (n.getAttribute('data-rids') || '').split(',')
      if (own.some(function (v) { return v !== '' && ids[v] })) target = n
    }
    if (!target) return
    var box = target.getBoundingClientRect()
    var from = st.scroller.getBoundingClientRect()
    var top = st.scroller.scrollTop + (box.top - from.top) - (st.scroller.clientHeight - box.height) / 2
    st.scroller.scrollTo ? st.scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }) : (st.scroller.scrollTop = Math.max(0, top))
    var mark_ = target.classList.contains('cx-chip') || target.classList.contains('cx-sys') ? target : (target.querySelector('.cx-bubble') || target)
    mark_.classList.remove('cx-flash')
    void mark_.offsetWidth
    mark_.classList.add('cx-flash')
    setTimeout(function () { mark_.classList.remove('cx-flash') }, 1800)
  }

  window.renderChat = renderChat
  window.highlightChat = highlightChat
})()
