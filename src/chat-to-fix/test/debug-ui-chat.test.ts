import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { buildChat, renderMarkdown, CHAT_CSS, CHAT_JS, BOT_ROLES } from '../scripts/debug-ui/chat.ts'

const lines = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
// A task as GET /tasks/:id returns it, rebuilt from the run's first record ("run 1 created: group G, bots main=ID ...").
function taskOf(records) {
  const created = records[0].text
  const bots = Object.fromEntries([...created.matchAll(/(\w+)=(session-[\w-]+)/g)].map((m) => [m[1], m[2]]))
  return { id: 'T-1', state: 'done', step: 'close', origin: { user: { id: 'U-FAKE', name: 'tester' }, permalink: 'fake://slack/C0456/1' }, runs: [{ no: 1, groupId: 'g', bots }] }
}
const RUNS: [string, any[]][] = [['run 1 (first real run)', lines('chat-run1-records.jsonl')], ['run 2', lines('chat-run2-records.jsonl')]]
const norm = (t) => String(t).replace(/\s+/g, ' ').trim()

for (const [label, records] of RUNS) {
  const chat = buildChat(records, taskOf(records))

  test(`${label}: members are the five bots (with their @mention names) and the Slack user`, () => {
    assert.deepEqual(chat.members.map((m) => m.role), [...BOT_ROLES, 'user'])
    assert.deepEqual(chat.members.slice(0, 5).map((m) => m.name), ['Main-1', 'Slack-1', 'Jira-1', 'Pipeline-1', 'Coding-1'])
    assert.equal(chat.members.at(-1).name, 'tester')
    assert.ok(chat.members.every((m) => /^#[0-9a-f]{6}$/i.test(m.color)))
    assert.equal(chat.title, 'Fix T-1')
  })

  test(`${label}: recordIds are valid, ordered and cover every record at most once`, () => {
    const seen = new Set()
    let lastFirst = -1
    for (const m of chat.messages) {
      assert.ok(m.recordIds.length >= 1)
      for (const id of m.recordIds) {
        assert.ok(Number.isInteger(id) && id >= 0 && id < records.length, `id ${id}`)
        assert.ok(!seen.has(id), `record ${id} used twice`)
        seen.add(id)
      }
      assert.ok(m.recordIds[0] > lastFirst, 'messages follow the record order')
      lastFirst = m.recordIds[0]
    }
    // every record that carries content ends up in a message (an empty round end is the only thing skipped)
    const missing = records.map((_, i) => i).filter((i) => !seen.has(i) && String(records[i].text ?? '').trim() !== '')
    assert.deepEqual(missing, [])
    assert.deepEqual(chat.messages.map((m) => m.id), chat.messages.map((_, i) => `m${i}`))
  })

  test(`${label}: a round_end and its mirrored group line are one message (no duplicated text)`, () => {
    const spoken = chat.messages.filter((m) => m.kind === 'message' && m.role !== 'user')
    assert.ok(spoken.length > 0)
    const roundEnds = records.map((r, i) => [r, i]).filter(([r]) => r.type === 'round_end')
    assert.ok(roundEnds.length >= 5)
    for (const [r, i] of roundEnds) {
      const holder = chat.messages.filter((m) => m.recordIds.includes(i))
      assert.equal(holder.length, 1)
      // its mirrored line (same bot, same text, next records) sits in the same message
      const mirror = records.findIndex((x, j) => j > i && j <= i + 3 && x.type === 'line' && x.botId === r.botId && norm(x.text) === norm(r.text))
      if (mirror >= 0) assert.ok(holder[0].recordIds.includes(mirror), `line ${mirror} merged with round end ${i}`)
    }
    // the same bot never shows the same text twice in a row
    const lastText = new Map()
    for (const m of spoken) {
      assert.notEqual(lastText.get(m.botId), norm(m.text), `duplicate: ${m.text.slice(0, 40)}`)
      lastText.set(m.botId, norm(m.text))
    }
  })

  test(`${label}: tool calls and results are one row under the bot that made them`, () => {
    const roleOf = (i) => records[i].role
    const tools = chat.messages.filter((m) => m.kind === 'tool')
    assert.equal(tools.length, records.filter((r) => r.type === 'tool_call').length)
    for (const t of tools) {
      const call = records[t.recordIds[0]]
      assert.equal(call.type, 'tool_call')
      assert.equal(t.role, call.role)
      assert.equal(t.botId, call.botId)
      assert.equal(t.tool, call.tool)
      assert.ok(!t.text.startsWith(t.tool), 'args only, the tool name is its own field')
      if (t.recordIds.length === 2) {
        const result = records[t.recordIds[1]]
        assert.equal(result.type, 'tool_result')
        assert.equal(roleOf(t.recordIds[1]), t.role)
        assert.equal(result.tool, t.tool)
        assert.equal(t.ok, result.ok)
        assert.equal(t.ms, result.ms)
        assert.equal(t.result, result.text)
      }
    }
    assert.ok(tools.filter((t) => t.ok === true).length >= 10)
    assert.ok(tools.some((t) => t.role === 'coding'))
  })

  test(`${label}: the kick-off line is the Slack user's message, events are centred system rows`, () => {
    const first = chat.messages.find((m) => m.recordIds.includes(1))
    assert.equal(first.role, 'user')
    assert.equal(first.kind, 'message')
    assert.match(first.text, /applyDiscount\(100, 10\)/)
    assert.ok(!first.text.includes('BEGIN MATERIAL'))
    assert.match(first.text, /\[Slack 讨论\]\(fake:\/\/slack\/C0456\/1\)/)
    const system = chat.messages.filter((m) => m.kind === 'system')
    assert.ok(system.some((m) => /运行已创建，5 个 bot 入群/.test(m.text)))
    assert.equal(system.filter((m) => /步骤推进/.test(m.text)).length, records.filter((r) => r.type === 'advance').length)
    assert.ok(system.some((m) => /步骤推进：取讨论 → 建工单/.test(m.text)))
    assert.ok(system.some((m) => /任务已关闭：done/.test(m.text)))
    assert.ok(system.some((m) => /运行结束：done \(completed\)/.test(m.text)))
    assert.ok(system.every((m) => m.role === null))
  })
}

test('notices, refusals, tool errors and approvals become the right rows', () => {
  const r = (o) => ({ at: '2026-11-12T10:00:00.000Z', taskId: 'T-9', run: 1, step: 'code', role: 'coding', botId: 'b1', ...o })
  const chat = buildChat([
    r({ type: 'notice', role: null, botId: null, text: 'Still working on it' }),
    r({ type: 'refusal', text: '▸ denied: rm -rf' }),
    r({ type: 'tool_error', text: '▸ tool error: boom' }),
    r({ type: 'approval', role: 'coding', tool: 'bash', text: 'bash: ls -> reject' }),
    r({ type: 'system', role: null, botId: null, text: 'notice stalled: The task seems stuck.' }),
    r({ type: 'round_end', failed: true, text: '' }),
    r({ type: 'tool_call', tool: 'jira_create_issue', text: 'jira_create_issue {"title":"x"}' }),
    r({ type: 'line', text: 'hello @Jira-2' }),
  ], { runs: [{ bots: { coding: 'b1' } }] })
  assert.deepEqual(chat.messages.map((m) => m.kind), ['notice', 'refusal', 'refusal', 'refusal', 'notice', 'refusal', 'tool', 'message'])
  assert.equal(chat.messages[4].text, 'The task seems stuck.')
  assert.ok(chat.messages.slice(1, 4).every((m) => m.ok === false && m.role === 'coding'))
  assert.equal(chat.messages[6].ok, undefined, 'a call without a result yet has no verdict')
  assert.equal(chat.messages[6].text, '{"title":"x"}')
  assert.deepEqual(chat.members.map((m) => m.role), ['coding'])
})

test('buildChat copes with empty input, a missing task and odd records', () => {
  assert.deepEqual(buildChat([], undefined).messages, [])
  assert.deepEqual(buildChat(undefined as any, undefined).members, [])
  const chat = buildChat([null, 3, { type: 'mystery', text: 'x' }, { type: 'tool_result', tool: 't', ok: false, ms: 3, text: 'late' }] as any, {})
  assert.deepEqual(chat.messages.map((m) => m.kind), ['system', 'tool'])
  assert.equal(chat.messages[1].result, 'late')
  assert.deepEqual(chat.messages[1].recordIds, [3])
})

test('a later identical answer is not merged into an earlier one', () => {
  const r = (o) => ({ at: 'x', step: 'code', role: 'main', botId: 'b', ...o })
  const chat = buildChat([r({ type: 'round_end', text: 'ok' }), r({ type: 'line', text: 'ok' }), r({ type: 'line', text: 'busy' }), r({ type: 'tool_call', tool: 'a', text: 'a {}' }), r({ type: 'tool_result', tool: 'a', ok: true, ms: 1, text: 'r' }), r({ type: 'round_end', text: 'ok' })], {})
  assert.deepEqual(chat.messages.filter((m) => m.kind === 'message').map((m) => m.recordIds), [[0, 1], [2], [5]])
})

// ------------------------------------------------------------------ Markdown (the code the browser runs)

test('Markdown: bold, italic, code, lists, code blocks, headings, quotes', () => {
  assert.equal(renderMarkdown('**bold** and *it* and `x < y`'), '<p><strong>bold</strong> and <em>it</em> and <code>x &lt; y</code></p>')
  assert.equal(renderMarkdown('- a\n- b\n  - c\n1. one'), '<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><ol><li>one</li></ol>')
  assert.equal(renderMarkdown('```js\nif (a < b) { **no** }\n```\nafter'), '<pre class="cx-pre"><code>if (a &lt; b) { **no** }</code></pre><p>after</p>')
  assert.equal(renderMarkdown('# Title\n> quoted\nline1\nline2'), '<div class="cx-h cx-h1">Title</div><blockquote><p>quoted</p></blockquote><p>line1<br>line2</p>')
  assert.equal(renderMarkdown('snake_case_name and 2 * 3 * 4'), '<p>snake_case_name and 2 * 3 * 4</p>')
  assert.equal(renderMarkdown('| a | b |\n|---|---|\n| 1 | **2** |'), '<table class="cx-table"><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table>')
  assert.equal(renderMarkdown(''), '')
  assert.equal(renderMarkdown(undefined as any), '')
})

test('Markdown: all HTML is escaped, nothing the model writes becomes a tag', () => {
  const evil = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg/onload=alert(1)>', '`<b>`', '```\n<iframe src=x>\n```',
    '**<u>x</u>**', '[<img src=x onerror=1>](http://a.example/)', '> <details open ontoggle=alert(1)>', '| <i> |\n|---|\n| <b> |', '# <h1>', '- <li onclick=1>',
    '@<script>', "x' onmouseover='alert(1)",
  ]
  for (const text of evil) {
    const html = renderMarkdown(text, { names: ['<b>x'], colors: { '<b>x': '#fff" onmouseover="1' } })
    const tags = [...html.matchAll(/<\/?([a-z][a-z0-9]*)/gi)].map((m) => m[1].toLowerCase())
    const allowed = new Set(['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'div', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'span'])
    for (const tag of tags) assert.ok(allowed.has(tag), `tag <${tag}> from ${JSON.stringify(text)} -> ${html}`)
    assert.ok(!/<(script|img|svg|iframe|u|b|i|h1|details)\b/i.test(html), html)
    assert.ok(!/\son\w+\s*=/i.test(html.replace(/&[a-z#0-9]+;/g, '')) || !/<[^>]*\son\w+\s*=/i.test(html), html)
  }
})

test('Markdown: links are limited to http(s) and fake:, new tab, no javascript:', () => {
  const html = renderMarkdown('[ok](https://a.example/x?a=1&b=2) [mr](fake://gitlab/mr/1) see https://b.example/p, and fake://jira/DEMO-1，并 done')
  assert.match(html, /<a href="https:\/\/a\.example\/x\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">ok<\/a>/)
  assert.match(html, /<a href="fake:\/\/gitlab\/mr\/1" target="_blank"/)
  assert.match(html, /<a href="https:\/\/b\.example\/p"[^>]*>https:\/\/b\.example\/p<\/a>,/)
  assert.match(html, /<a href="fake:\/\/jira\/DEMO-1"[^>]*>fake:\/\/jira\/DEMO-1<\/a>，并/)
  for (const bad of [
    '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](java\tscript:alert(1))', '[x](data:text/html;base64,AAAA)', '[x](vbscript:msgbox(1))', '[x](//evil.example/)',
    '[x](/relative)', '[x](#frag)', '[x](file:///etc/passwd)', '[x](javascript&#58;alert(1))', '[x](&#106;avascript:alert(1))', '<a href="javascript:alert(1)">x</a>', '[x](ftp://a.example/)',
  ]) {
    const out = renderMarkdown(bad)
    assert.ok(!/<a\b/i.test(out) || !/href="(?!https?:\/\/|fake:\/\/)/i.test(out), `${bad} -> ${out}`)
    assert.ok(!/href="\s*(javascript|data|vbscript|file)/i.test(out), `${bad} -> ${out}`)
  }
  // the label of a dropped link stays as plain text
  assert.equal(renderMarkdown('[click me](javascript:alert(1))'), '<p>click me</p>')
  // a link around a code span keeps the code
  assert.match(renderMarkdown('[`x`](http://a.example/)'), /<a href="http:\/\/a\.example\/"[^>]*><code>x<\/code><\/a>/)
})

test('Markdown: @mentions of members and @Name-1 words are highlighted, e-mail addresses are not', () => {
  const html = renderMarkdown('@Slack-1 请看 @小明，mail a@b.example', { names: ['小明'], colors: { 'Slack-1': '#ec2f6b', 小明: 'red' } })
  assert.match(html, /<span class="cx-at" style="--c:#ec2f6b">@Slack-1<\/span> 请看 <span class="cx-at">@小明<\/span>，mail a@b\.example/)
  assert.ok(!/style="--c:red"/.test(html), 'only hex colours are used')
})

test('Markdown: a very long input renders in linear time', () => {
  const t0 = Date.now()
  renderMarkdown('*a '.repeat(20000) + '\n' + '`'.repeat(5000) + '\n' + '[x]('.repeat(3000) + '_ '.repeat(10000))
  assert.ok(Date.now() - t0 < 3000)
})

// ------------------------------------------------------------------ browser code

test('CHAT_JS parses, defines the contract and can be inlined in a page', () => {
  new Script(CHAT_JS)
  assert.match(CHAT_JS, /window\.renderChat\s*=/)
  assert.match(CHAT_JS, /window\.highlightChat\s*=/)
  assert.ok(!/<\/script/i.test(CHAT_JS) && !CHAT_JS.includes('<!--'), 'safe to inline in a <script>')
  assert.ok(!/<\/style/i.test(CHAT_CSS), 'safe to inline in a <style>')
  // self-contained: no module syntax, no network
  assert.ok(!/^\s*(import|export)\s/m.test(CHAT_JS))
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|@import|url\(\s*['"]?https?:/.test(CHAT_JS + CHAT_CSS))
  assert.match(CHAT_CSS, /prefers-color-scheme:\s*dark/)
})

test('CHAT_JS builds DOM through createElement/textContent: the only innerHTML takes chatMarkdown output', () => {
  const uses = [...CHAT_JS.matchAll(/innerHTML|insertAdjacentHTML|document\.write|outerHTML/g)]
  assert.equal(uses.length, 1)
  assert.match(CHAT_JS, /function setHtml\(node, html\) \{ node\.innerHTML = html \}/)
  assert.equal([...CHAT_JS.matchAll(/setHtml\(/g)].length, 2) // the definition and its one call, on chatMarkdown output
  assert.match(CHAT_JS, /setHtml\(text, chatMarkdown\(m\.text, st\.mdOpts\)\)/)
})

// ---- token billing: the bill in the members row, the total, and the cost of a round next to its message

const U = (o: any = {}) => ({
  type: 'usage', at: '2026-11-12T10:00:09.000Z', run: 1, step: 'issue', role: 'jira', botId: 'b-jira', model: 'claude-sonnet-5-5', source: 'dsh',
  input: 4, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: 0.5, unpriced: false, durationMs: 2000, outputTps: 50, tpsBasis: 'dsh-decode', text: 'usage ...', ...o,
})
const BILL_RECORDS = [
  { at: '2026-11-12T10:00:00.000Z', type: 'system', step: 'fetch', role: null, botId: null, text: 'run 1 created: group g1, bots main=b-main jira=b-jira coding=b-coding' },
  U(),
  { at: '2026-11-12T10:00:10.000Z', type: 'round_end', step: 'issue', role: 'jira', botId: 'b-jira', text: 'DEMO-1 已建' },
  U({ role: 'coding', botId: 'b-coding', step: 'code', source: 'cli', model: 'claude-opus-5-5', costUsd: 1.5, tpsBasis: 'cli-api', outputTps: 200, output: 400, effort: 'high' }),
  { at: '2026-11-12T10:00:20.000Z', type: 'round_end', step: 'code', role: 'coding', botId: 'b-coding', text: '改好了' },
  U({ role: 'main', botId: 'b-main', model: 'mystery', costUsd: null, unpriced: true }),
]

test('usage records make no chat rows; members carry their bill and the chat the total, built from the records when the task has none', () => {
  const chat: any = buildChat(BILL_RECORDS, { id: 'T-1', runs: [{ no: 1, bots: { main: 'b-main', jira: 'b-jira', coding: 'b-coding' } }] })
  assert.equal(chat.messages.some((m) => /usage|\[usage\]/.test(m.text)), false)
  const jira = chat.members.find((m) => m.role === 'jira').usage
  assert.deepEqual([jira.modelText, jira.costText, jira.tpsText, jira.tpsTag], ['claude-sonnet-5-5', '$0.50', '50 tok/s', 'DSH'])
  const coding = chat.members.find((m) => m.role === 'coding').usage
  assert.deepEqual([coding.modelText, coding.costText, coding.tpsText, coding.tpsTag, coding.effort], ['claude-opus-5-5', '$1.50', '200 tok/s', '推算', 'high'])
  assert.match(coding.tpsLabel, /CLI 输出 token ÷ duration_api_ms/)
  assert.equal(chat.members.find((m) => m.role === 'main').usage.costText, '$0（含未定价）')
  assert.equal(chat.usage.costText, '$2.00（含未定价）')
  assert.match(chat.usage.line, /^花费 \$2\.00（含未定价） · 输入 12 \/ 输出 600 \/ 缓存读 0 · 平均 /)
  assert.equal(chat.members.find((m) => m.role === 'user'), undefined)
})

test('a bot\'s message carries what its round cost; the next round starts from zero; the task summary wins over the records', () => {
  const chat: any = buildChat(BILL_RECORDS, { id: 'T-1', usage: { calls: 1, totalUsd: 9, usd: 9, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, byRole: {} }, runs: [{ no: 1, bots: { main: 'b-main', jira: 'b-jira', coding: 'b-coding' } }] })
  const said = chat.messages.filter((m) => m.kind === 'message')
  assert.deepEqual(said.map((m) => [m.role, m.usage?.brief]), [['jira', '$0.50 · 50 tok/s DSH'], ['coding', '$1.50 · 200 tok/s 推算']])
  assert.match(said[0].usage.lines[0], /^claude-sonnet-5-5 · 花费 \$0\.50/)
  assert.equal(chat.usage.costText, '$9.00', 'the running summary of the task is the bill')
  assert.equal(buildChat([BILL_RECORDS[2]], {}).usage, null, 'no usage, no bill')
})

test('the chat client prints the bill: total line, a row per bot with model, cost and speed tag, the cost of a round beside its time', () => {
  assert.match(CHAT_JS, /chat\.usage\.line/)
  assert.match(CHAT_JS, /cx-mem-use/)
  assert.match(CHAT_JS, /m\.usage\.tpsTag/)
  assert.match(CHAT_JS, /m\.usage\.brief/)
  assert.match(CHAT_CSS, /\.cx-mems/)
  assert.doesNotThrow(() => new Script(CHAT_JS))
})
