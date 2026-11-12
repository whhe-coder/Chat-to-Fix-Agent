import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import {
  textWidth, clipWidth, fitParts, stripAnsi, formatDuration, clock, pickTask, newestFirst, elapsedMs, stepStates, botStates,
  recordParts, recordPlain, recordLinePlain, layout, bodyHeight, scrollLimit, parseKeys, reduceKey, fetchSnapshot, plainStep,
  runPlain, runTui, parseArgs, connect, HEAD_ROWS,
} from '../scripts/watch.ts'

const TOKEN = 'secret-token-xyz'
const T0 = Date.parse('2026-11-12T10:00:00Z')

const task = (o: any = {}) => ({
  id: 'T-1', no: 1, state: 'running', endReason: null, createdAt: '2026-11-12T10:00:00Z', updatedAt: '2026-11-12T10:00:30Z', queuedAt: '2026-11-12T10:00:00Z',
  binding: { channel: 'C0456', repo: 'local/sample-shop' }, step: 'code', stepAt: '2026-11-12T10:00:20Z',
  jira: { key: 'DEMO-1', url: 'http://jira.test/browse/DEMO-1' }, repo: { dir: '/x', branch: 'fix/t-1', base: 'abc' }, mr: null,
  runs: [{ no: 1, groupId: 'g1', bots: {}, startedAt: '2026-11-12T10:00:05Z', endedAt: null, endReason: null }], ...o,
})
const rec = (o: any = {}) => ({ at: '2026-11-12T10:00:10Z', taskId: 'T-1', run: 1, step: 'code', role: 'coding', botId: 'b1', type: 'line', text: 'hello', ...o })
const widthsOk = (lines, width) => lines.every((l) => textWidth(stripAnsi(l)) <= width)

// ------------------------------------------------------------------ helpers

test('textWidth counts wide characters as two columns; clipWidth cuts on columns', () => {
  assert.equal(textWidth('abc'), 3)
  assert.equal(textWidth('取讨论'), 6)
  assert.equal(clipWidth('abcdef', 4), 'abc…')
  assert.equal(clipWidth('取讨论代码', 6), '取讨…')
  assert.equal(clipWidth('abc', 10), 'abc')
  assert.equal(clipWidth('abc', 0), '')
  assert.equal(textWidth(clipWidth('取讨论代码', 5)) <= 5, true)
})

test('fitParts keeps total width, styles only when asked', () => {
  const parts = [['red', 'abcd'], [null, 'efghij']]
  assert.equal(fitParts(parts, 8), 'abcdefg…')
  assert.equal(fitParts(parts, 3), 'ab…')
  assert.match(fitParts(parts, 20, true), /\x1b\[31mabcd\x1b\[0m/)
  assert.equal(stripAnsi(fitParts(parts, 20, true)), 'abcdefghij')
})

test('formatDuration, clock, elapsedMs', () => {
  assert.equal(formatDuration(45_000), '45s')
  assert.equal(formatDuration(192_000), '3m12s')
  assert.equal(formatDuration(3725_000), '1h02m05s')
  assert.equal(formatDuration(-1), '-')
  const d = new Date('2026-11-12T10:00:10Z')
  assert.equal(clock('2026-11-12T10:00:10Z'), `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:10`)
  assert.equal(clock('nonsense'), '--:--:--')
  assert.equal(elapsedMs(task(), T0 + 65_000), 60_000) // run started 5 s in
  assert.equal(elapsedMs(task({ state: 'done', runs: [{ startedAt: '2026-11-12T10:00:05Z', endedAt: '2026-11-12T10:02:05Z' }] })), 120_000)
  assert.equal(elapsedMs(task({ state: 'queued', runs: [] }), T0 + 10_000), 10_000)
  assert.ok(Number.isNaN(elapsedMs(undefined)))
})

test('pickTask: wanted id, else newest running, else newest; newestFirst sorts by number', () => {
  const tasks = [{ id: 'T-2', state: 'done' }, { id: 'T-10', state: 'failed' }, { id: 'T-3', state: 'running' }, { id: 'T-1', state: 'running' }]
  assert.deepEqual(newestFirst(tasks).map((t) => t.id), ['T-10', 'T-3', 'T-2', 'T-1'])
  assert.equal(pickTask(tasks, null).id, 'T-3')
  assert.equal(pickTask(tasks, 'T-2').id, 'T-2')
  assert.equal(pickTask(tasks, 'T-99'), undefined)
  assert.equal(pickTask(tasks.filter((t) => t.state !== 'running'), null).id, 'T-10')
  assert.equal(pickTask([], null), undefined)
})

test('stepStates: done before the current step, current marked, pending after', () => {
  const marks = (t) => stepStates(t).map((s) => s.mark)
  assert.deepEqual(marks(task({ step: 'code' })), ['done', 'done', 'done', 'current', 'pending', 'pending', 'pending'])
  assert.deepEqual(marks(task({ step: 'fetch' })), ['current', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending'])
  assert.deepEqual(marks(task({ state: 'done', step: 'close' })), Array(7).fill('done'))
  assert.equal(marks(task({ state: 'failed', step: 'mr' }))[4], 'failed')
  assert.deepEqual(marks(task({ step: null })), Array(7).fill('pending'))
  assert.deepEqual(stepStates(task()).map((s) => s.label), ['取讨论', '建工单', '准备代码', '写代码', '开 MR', '回写', '结束'])
  assert.deepEqual(marks(undefined), Array(7).fill('pending'))
})

test('botStates: five roles; working when the last record is not a round end or the step is theirs', () => {
  const by = (list) => Object.fromEntries(list.map((b) => [b.role, b.state]))
  assert.deepEqual(Object.keys(by(botStates(task()))), ['main', 'slack', 'jira', 'pipeline', 'coding'])
  // coding is in charge of "code" and has not answered in this step
  assert.equal(by(botStates(task(), []))['coding'], 'working')
  assert.equal(by(botStates(task(), []))['slack'], 'idle')
  // slack posted a line (not a round end): working
  assert.equal(by(botStates(task(), [rec({ role: 'slack' })]))['slack'], 'working')
  // slack ended its round: idle
  assert.equal(by(botStates(task(), [rec({ role: 'slack' }), rec({ role: 'slack', type: 'round_end' })]))['slack'], 'idle')
  // coding answered after the step began: idle
  assert.equal(by(botStates(task(), [rec({ role: 'coding', type: 'round_end', at: '2026-11-12T10:00:25Z' })]))['coding'], 'idle')
  // records of an earlier run do not count
  assert.equal(by(botStates(task({ runs: [{}, {}] }), [rec({ role: 'slack', run: 1 })]))['slack'], 'idle')
  // an ended or waiting task has no working bots
  for (const state of ['done', 'failed', 'queued']) assert.ok(botStates(task({ state }), []).every((b) => b.state === 'off'))
})

// ------------------------------------------------------------------ records

test('record formatting: every known type, compact tool lines, collapsed whitespace', () => {
  assert.equal(recordPlain(rec({ text: 'a\n  b\tc' })), 'a b c')
  assert.equal(recordPlain(rec({ type: 'notice', text: 'idle' })), '[notice] idle')
  assert.equal(recordPlain(rec({ type: 'tool_call', tool: 'repo_prepare', text: 'repo_prepare {"x":1}' })), '[call] repo_prepare {"x":1}')
  assert.equal(recordPlain(rec({ type: 'tool_call', tool: '', text: 'jira_get_issue {}' })), '[call] jira_get_issue {}')
  assert.equal(recordPlain(rec({ type: 'tool_result', tool: 'repo_prepare', ok: true, ms: 120, text: 'ok' })), '[ok 120ms] repo_prepare ok')
  assert.equal(recordPlain(rec({ type: 'tool_result', tool: 'repo_prepare', ok: false, ms: 5, text: 'boom' })), '[FAILED 5ms] repo_prepare boom')
  assert.equal(recordPlain(rec({ type: 'round_end', text: 'done it' })), '[round end] done it')
  assert.equal(recordPlain(rec({ type: 'round_end', failed: true, text: 'x' })), '[round FAILED] x')
  for (const type of ['advance', 'refused', 'limit', 'approval', 'system']) assert.equal(recordPlain(rec({ type, text: 't' })), `[${type}] t`)
})

test('unknown record types and odd values render generically and never throw', () => {
  assert.equal(recordPlain(rec({ type: 'brand_new', text: 'hi' })), '[brand_new] hi')
  assert.match(recordPlain({ type: 'brand_new', foo: 1, nested: { a: 2 } }), /^\[brand_new\] \{"foo":1,"nested":\{"a":2\}\}$/)
  assert.equal(recordPlain({}), '[unknown]')
  assert.equal(recordPlain(null), '')
  assert.equal(recordPlain('just a string'), 'just a string')
  const cyclic: any = { type: 'weird' }; cyclic.self = cyclic
  assert.doesNotThrow(() => recordPlain(cyclic))
  assert.doesNotThrow(() => recordLinePlain(undefined))
  assert.doesNotThrow(() => recordPlain({ type: 'line', text: { not: 'a string' } }))
})

test('recordLinePlain: time, role column, content', () => {
  const line = recordLinePlain(rec({ role: 'pipeline', text: 'x' }))
  assert.match(line, /^\d\d:\d\d:\d\d pipeline x$/)
  assert.match(recordLinePlain(rec({ role: null })), /^\d\d:\d\d:\d\d -        hello$/)
})

// ------------------------------------------------------------------ layout

const sample = (n = 30) => Array.from({ length: n }, (_, i) => rec({ text: `record number ${i}`, at: new Date(T0 + i * 1000).toISOString() }))

test('layout: exactly height lines, none wider than width, for many sizes', () => {
  const tasks = [{ id: 'T-1', state: 'running' }, { id: 'T-2', state: 'done' }]
  for (const [width, height] of [[80, 24], [40, 12], [20, 5], [200, 50], [1, 1], [10, 3], [120, 8]]) {
    for (const error of [null, '控制接口连不上']) {
      const lines = layout({ width, height, tasks, task: task(), records: sample(), error, now: T0 + 60_000 })
      assert.equal(lines.length, height, `${width}x${height}`)
      assert.ok(widthsOk(lines, width), `${width}x${height}: ${lines.map((l) => textWidth(l)).join(',')}`)
      const coloured = layout({ width, height, tasks, task: task(), records: sample(), error, now: T0 + 60_000, color: true })
      assert.equal(coloured.length, height)
      assert.ok(widthsOk(coloured, width))
    }
  }
})

test('layout: header shows id, state, channel, repo, Jira, MR, elapsed, steps, bots', () => {
  const text = layout({ width: 120, height: 24, tasks: [{ id: 'T-1', state: 'running' }], task: task({ mr: { url: 'http://gl.test/mr/1' } }), records: sample(3), now: T0 + 65_000 }).join('\n')
  for (const needle of ['T-1', '运行中', 'C0456', 'local/sample-shop', 'DEMO-1', 'http://gl.test/mr/1', '经过 1m00s', '[x]取讨论', '[x]准备代码', '[>]写代码', '[ ]开 MR', '[ ]结束', '主控', 'Slack', 'Jira', '流水线', '写代码 工作中', 'record number 2', '跟随最新']) {
    assert.ok(text.includes(needle), `missing ${needle}`)
  }
})

test('layout: no task yet, no Jira and no MR', () => {
  const lines = layout({ width: 80, height: 14, tasks: [], task: undefined, records: [], now: T0 })
  assert.equal(lines.length, 14)
  assert.ok(lines.join('\n').includes('还没有任务'))
  const noJira = layout({ width: 100, height: 14, tasks: [{ id: 'T-1', state: 'queued' }], task: task({ state: 'queued', jira: { key: null, url: null }, mr: null, step: null, runs: [] }), records: [], now: T0 }).join('\n')
  assert.ok(noJira.includes('排队中'))
  assert.ok(noJira.includes('Jira -'))
})

test('layout: banner row appears with the error text and takes one record row', () => {
  const withBanner = layout({ width: 80, height: 20, task: task(), records: sample(), error: '令牌不对 (HTTP 401)', now: T0 })
  assert.ok(withBanner[0].includes('令牌不对 (HTTP 401)'))
  assert.equal(withBanner.length, 20)
  const without = layout({ width: 80, height: 20, task: task(), records: sample(), now: T0 })
  assert.equal(bodyHeight(20, true), bodyHeight(20, false) - 1)
  assert.ok(!without[0].includes('!'))
})

test('layout: newest records fill the body; scrolling shows older ones and the footer says paused', () => {
  const height = 20
  const rows = bodyHeight(height)
  assert.equal(rows, height - 1 - HEAD_ROWS)
  const records = sample(40)
  const follow = layout({ width: 100, height, task: task(), records, scroll: 0, now: T0 }).join('\n')
  assert.ok(follow.includes('record number 39'))
  assert.ok(!follow.includes(`record number ${39 - rows}`))
  assert.ok(follow.includes('record number ' + (40 - rows)))
  const up = layout({ width: 100, height, task: task(), records, scroll: 5, now: T0 }).join('\n')
  assert.ok(!up.includes('record number 39 '.trim() + '\n'))
  assert.ok(up.includes('record number 34') && !up.includes('record number 35'))
  assert.ok(up.includes('已暂停 (距最新 5 条)'))
  // scroll beyond the limit is clamped to the oldest page
  const top = layout({ width: 100, height, task: task(), records, scroll: 9999, now: T0 }).join('\n')
  assert.ok(top.includes('record number 0') && !top.includes('record number 40'))
  assert.equal(scrollLimit(40, height), 40 - rows)
  assert.equal(scrollLimit(3, height), 0)
})

test('layout: long record text is cut to the line, one line per record', () => {
  const lines = layout({ width: 60, height: 14, task: task(), records: [rec({ text: 'x'.repeat(500) }), rec({ text: '汉字'.repeat(100), role: 'jira' })], now: T0 })
  assert.ok(widthsOk(lines, 60))
  assert.ok(lines.some((l) => l.endsWith('…')))
})

test('layout: role colours differ per bot and survive stripAnsi', () => {
  const coloured = layout({ width: 100, height: 20, task: task(), records: [rec({ role: 'slack' }), rec({ role: 'jira' }), rec({ role: 'coding' })], now: T0, color: true })
  const body = coloured.filter((l) => /\d\d:\d\d:\d\d/.test(stripAnsi(l)))
  const colours = body.map((l) => l.match(/\x1b\[(3\d)m(slack|jira|coding)/)?.[1])
  assert.equal(new Set(colours).size, 3)
  assert.ok(!colours.includes(undefined))
})

test('layout tolerates odd data without throwing', () => {
  assert.doesNotThrow(() => layout({ width: 80, height: 20, task: { id: 'T-9', state: 'strange' }, records: [{}, null, 'x', { type: 'zzz' }], tasks: [{ id: 'T-9' }], now: T0 }))
})

// ------------------------------------------------------------------ keys

test('parseKeys: letters, arrows, paging, end, quit, Ctrl-C, several keys in one chunk', () => {
  assert.deepEqual(parseKeys('q'), ['quit'])
  assert.deepEqual(parseKeys('\x03'), ['quit'])
  assert.deepEqual(parseKeys('\x1b[A\x1b[B'), ['up', 'down'])
  assert.deepEqual(parseKeys('kj'), ['up', 'down'])
  assert.deepEqual(parseKeys('\x1b[5~\x1b[6~'), ['pageup', 'pagedown'])
  assert.deepEqual(parseKeys('G\x1b[F\x1bOF'), ['end', 'end', 'end'])
  assert.deepEqual(parseKeys('g\x1b[H'), ['home', 'home'])
  assert.deepEqual(parseKeys('t'), ['cycle'])
  assert.deepEqual(parseKeys('zzz'), [])
})

test('reduceKey: scroll stops following, End resumes, t cycles and pins', () => {
  const ctx = { page: 5, limit: 20, taskIds: ['T-3', 'T-2', 'T-1'], currentId: 'T-3' }
  let ui = { pinned: null, scroll: 0 }
  ui = reduceKey(ui, 'up', ctx); assert.equal(ui.scroll, 1)
  ui = reduceKey(ui, 'pageup', ctx); assert.equal(ui.scroll, 6)
  ui = reduceKey(ui, 'down', ctx); assert.equal(ui.scroll, 5)
  assert.equal(reduceKey(ui, 'home', ctx).scroll, 20)
  assert.equal(reduceKey({ ...ui, scroll: 20 }, 'up', ctx).scroll, 20)
  assert.equal(reduceKey(ui, 'end', ctx).scroll, 0)
  assert.equal(reduceKey({ pinned: null, scroll: 0 }, 'down', ctx).scroll, 0)
  const cycled = reduceKey(ui, 'cycle', ctx)
  assert.deepEqual(cycled, { pinned: 'T-2', scroll: 0 })
  assert.equal(reduceKey(cycled, 'cycle', { ...ctx, currentId: 'T-1' }).pinned, 'T-3') // wraps
  assert.equal(reduceKey(ui, 'cycle', { ...ctx, taskIds: [] }), ui)
  assert.equal(reduceKey(ui, 'nothing', ctx), ui)
})

// ------------------------------------------------------------------ control interface (stub)

let servers = []
afterEach(async () => { await Promise.all(servers.map((s) => new Promise((r) => { s.close(() => r(undefined)); s.closeAllConnections?.() }))); servers = [] })

const TASKS = { 'T-1': { ...task({ id: 'T-1', state: 'done', step: 'close' }), records: [rec({ text: 'one' })] }, 'T-2': { ...task({ id: 'T-2', state: 'running', no: 2 }), records: [rec({ text: 'two' }), rec({ text: 'three' })] } }

async function stub(handler?) {
  const calls = []
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, token: req.headers['x-chat-to-fix-token'] })
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers['x-chat-to-fix-token'] !== TOKEN) return send(401, { error: 'unauthorized' })
    if (handler?.(req, send)) return
    const url = new URL(req.url, 'http://x')
    if (req.method === 'GET' && url.pathname === '/tasks') return send(200, { tasks: Object.values(TASKS).map((t: any) => ({ id: t.id, state: t.state, step: t.step, jiraKey: t.jira.key, mrUrl: null })) })
    const m = url.pathname.match(/^\/tasks\/(T-\d+)$/)
    if (req.method === 'GET' && m) return TASKS[m[1]] ? send(200, url.searchParams.get('records') === '1' ? TASKS[m[1]] : { ...TASKS[m[1]], records: undefined }) : send(404, { error: 'task_not_found' })
    return send(404, { error: 'not_found' })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { conn: { url: `http://127.0.0.1:${(server.address() as any).port}`, token: TOKEN }, calls, server }
}

test('fetchSnapshot: newest running task by default, with its records; only GET with the token', async () => {
  const { conn, calls } = await stub()
  const snap: any = await fetchSnapshot({ conn })
  assert.equal(snap.ok, true)
  assert.deepEqual(snap.tasks.map((t) => t.id), ['T-2', 'T-1'])
  assert.equal(snap.task.id, 'T-2')
  assert.deepEqual(snap.records.map((r) => r.text), ['two', 'three'])
  assert.equal(snap.task.records, undefined)
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET'])
  assert.deepEqual(calls.map((c) => c.url), ['/tasks', '/tasks/T-2?records=1'])
  assert.ok(calls.every((c) => c.token === TOKEN))
})

test('fetchSnapshot: a wanted task, an unknown task, an empty list', async () => {
  const { conn } = await stub()
  assert.equal(((await fetchSnapshot({ conn, taskId: 'T-1' })) as any).task.id, 'T-1')
  const missing: any = await fetchSnapshot({ conn, taskId: 'T-9' })
  assert.equal(missing.ok, false); assert.equal(missing.kind, 'not_found')
  const empty = await stub((req, send) => (req.url === '/tasks' ? (send(200, { tasks: [] }), true) : false))
  const none: any = await fetchSnapshot({ conn: empty.conn })
  assert.equal(none.ok, true); assert.equal(none.task, undefined); assert.deepEqual(none.records, [])
})

test('fetchSnapshot: wrong token -> unauthorized; the token never appears in the message', async () => {
  const { conn } = await stub()
  const snap: any = await fetchSnapshot({ conn: { ...conn, token: 'not-the-token' } })
  assert.equal(snap.ok, false); assert.equal(snap.kind, 'unauthorized')
  assert.match(snap.message, /令牌不对/)
  assert.ok(!snap.message.includes('not-the-token') && !snap.message.includes(TOKEN))
})

test('fetchSnapshot: unreachable interface -> kind unreachable, no throw, no token in the message', async () => {
  const { conn, server } = await stub()
  await new Promise((r) => { server.close(() => r(undefined)); server.closeAllConnections?.() })
  const snap: any = await fetchSnapshot({ conn })
  assert.equal(snap.ok, false); assert.equal(snap.kind, 'unreachable')
  assert.match(snap.message, /控制接口连不上/)
  assert.ok(!snap.message.includes(TOKEN))
})

test('fetchSnapshot: server errors and garbage bodies are reported, not thrown', async () => {
  const broken = await stub((req, send) => (send(500, { error: 'internal_error' }), true))
  const snap: any = await fetchSnapshot({ conn: broken.conn })
  assert.equal(snap.ok, false); assert.match(snap.message, /500.*internal_error/)
  const garbage = await stub((req, res) => false)
  const odd: any = await fetchSnapshot({ conn: garbage.conn, fetchImpl: async () => ({ status: 200, ok: true, json: async () => { throw new Error('bad json') } }) })
  assert.equal(odd.ok, false)
  const throwing: any = await fetchSnapshot({ conn: garbage.conn, fetchImpl: async () => { throw new Error('x') } })
  assert.equal(throwing.kind, 'unreachable')
})

test('connect: --dir reads http-token and the port; --token-file with --url; token not in the result of parseArgs', () => {
  const files = { '/run/http-token': `${TOKEN}\n`, '/run/chat-to-fix.json': JSON.stringify({ httpPort: 3091 }), '/tmp/tok': 'other-token\n' }
  const read = (p) => files[p]
  assert.deepEqual(connect({ dir: '/run' }, {}, read), { url: 'http://127.0.0.1:3091', token: TOKEN })
  assert.deepEqual(connect({ url: 'http://127.0.0.1:9/', tokenFile: '/tmp/tok' }, {}, read), { url: 'http://127.0.0.1:9', token: 'other-token' })
  assert.throws(() => connect({}, {}, read), /no connection/)
  assert.deepEqual(parseArgs(['T-4', '--dir', '/d', '--interval', '1']), { id: 'T-4', dir: '/d', interval: '1' })
  assert.deepEqual(parseArgs(['--url', 'u', '--token-file', 'f']), { url: 'u', tokenFile: 'f' })
  assert.throws(() => parseArgs(['--token', 'x']), /unknown argument/)
  assert.throws(() => parseArgs(['--dir']), /needs a value/)
})

// ------------------------------------------------------------------ non-TTY output

test('plainStep: state line on change, new records appended once, errors once, ends on an end state', () => {
  let prev: any = { taskId: undefined, state: null, step: null, seen: 0, error: null }
  const snap = (t, records) => ({ ok: true, tasks: [], task: t, records })
  let r = plainStep(prev, snap(task(), [rec({ text: 'a' })]))
  assert.equal(r.lines.length, 2); assert.match(r.lines[0], /^== T-1 运行中 步骤 写代码/); assert.match(r.lines[1], /a$/)
  assert.equal(r.ended, false)
  r = plainStep(r.prev, snap(task(), [rec({ text: 'a' }), rec({ text: 'b' })]))
  assert.equal(r.lines.length, 1); assert.match(r.lines[0], /b$/)
  r = plainStep(r.prev, { ok: false, kind: 'unreachable', message: 'down' })
  assert.deepEqual(r.lines, ['!! down'])
  r = plainStep(r.prev, { ok: false, kind: 'unreachable', message: 'down' })
  assert.deepEqual(r.lines, [])
  r = plainStep(r.prev, snap(task({ state: 'done', step: 'close', mr: { url: 'http://mr' } }), [rec({ text: 'a' }), rec({ text: 'b' })]))
  assert.equal(r.lines[0], '-- 控制接口恢复'); assert.match(r.lines[1], /已完成.*MR http:\/\/mr/)
  assert.equal(r.ended, true)
  assert.deepEqual(plainStep(prev, snap(undefined, [])).lines, ['还没有任务'])
})

test('runPlain prints the records of a finished task and returns', async () => {
  const { conn } = await stub()
  const out = []
  await runPlain({ conn, taskId: 'T-1', out: (l) => out.push(l), intervalMs: 1, sleep: async () => {} })
  assert.ok(out[0].startsWith('== T-1 已完成'))
  assert.ok(out.some((l) => l.endsWith('one')))
  assert.ok(!out.join('\n').includes(TOKEN))
})

// ------------------------------------------------------------------ the terminal UI with fake streams

function fakeTerminal(columns = 100, rows = 24) {
  const input: any = new EventEmitter()
  const modes = []
  input.setRawMode = (on) => modes.push(on)
  input.resume = () => {}
  input.pause = () => {}
  const output: any = new EventEmitter()
  output.columns = columns; output.rows = rows
  output.chunks = []
  output.write = (s) => { output.chunks.push(String(s)); return true }
  return { input, output, modes, text: () => output.chunks.join('') }
}
const waitFor = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await new Promise((r) => setTimeout(r, 10)) }
  throw new Error('timed out waiting')
}

test('runTui: enters the alternate screen, draws the task, q restores the terminal', async () => {
  const { conn } = await stub()
  const term = fakeTerminal()
  const done = runTui({ conn, input: term.input, output: term.output, intervalMs: 20 })
  await waitFor(() => stripAnsi(term.text()).includes('three'))
  assert.ok(term.text().startsWith('\x1b[?1049h\x1b[?25l'))
  assert.ok(stripAnsi(term.text()).includes('T-2'))
  assert.deepEqual(term.modes, [true])
  term.input.emit('data', 'q')
  await done
  assert.ok(term.text().endsWith('\x1b[?25h\x1b[?1049l'))
  assert.deepEqual(term.modes, [true, false])
  assert.equal(term.input.listenerCount('data'), 0)
  assert.ok(!term.text().includes(TOKEN))
})

test('runTui: Ctrl-C quits and restores; further output after quitting is not written', async () => {
  const { conn } = await stub()
  const term = fakeTerminal()
  const done = runTui({ conn, input: term.input, output: term.output, intervalMs: 10 })
  await waitFor(() => term.output.chunks.length > 1)
  term.input.emit('data', '\x03')
  await done
  const count = term.output.chunks.length
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(term.output.chunks.length, count)
  assert.ok(term.output.chunks.at(-1).includes('\x1b[?1049l'))
})

test('runTui: t cycles to the other task, resize redraws at the new size', async () => {
  const { conn } = await stub()
  const term = fakeTerminal(100, 24)
  const done = runTui({ conn, input: term.input, output: term.output, intervalMs: 500 })
  await waitFor(() => stripAnsi(term.text()).includes('three'))
  term.input.emit('data', 't')
  await waitFor(() => stripAnsi(term.output.chunks.at(-1)).includes('one'))
  assert.ok(stripAnsi(term.output.chunks.at(-1)).includes('T-1'))
  term.output.rows = 10
  const before = term.output.chunks.length
  term.output.emit('resize')
  assert.equal(term.output.chunks.length, before + 1)
  assert.ok(term.output.chunks.at(-1).includes('\x1b[10;1H'))
  assert.ok(!term.output.chunks.at(-1).includes('\x1b[11;1H'))
  term.input.emit('data', 'q')
  await done
})

test('runTui: a wrong token shows the banner, a dead interface too, and the screen recovers', async () => {
  const { conn, server } = await stub()
  const term = fakeTerminal()
  const done = runTui({ conn: { ...conn, token: 'bad' }, input: term.input, output: term.output, intervalMs: 20 })
  await waitFor(() => stripAnsi(term.text()).includes('令牌不对'))
  assert.ok(!term.text().includes('bad\x1b') && !term.text().includes(TOKEN))
  term.input.emit('data', 'q')
  await done

  const term2 = fakeTerminal()
  await new Promise((r) => { server.close(() => r(undefined)); server.closeAllConnections?.() })
  const done2 = runTui({ conn, input: term2.input, output: term2.output, intervalMs: 20 })
  await waitFor(() => stripAnsi(term2.text()).includes('控制接口连不上'))
  term2.input.emit('data', 'q')
  await done2
  assert.ok(term2.text().endsWith('\x1b[?1049l'))
})

test('runTui: scrolling up stops following; End resumes', async () => {
  const { conn } = await stub()
  const term = fakeTerminal(100, 24)
  const many = Array.from({ length: 60 }, (_, i) => rec({ text: `rec ${i}` }))
  TASKS['T-2'].records = many
  try {
    const done = runTui({ conn, input: term.input, output: term.output, intervalMs: 500 })
    await waitFor(() => stripAnsi(term.text()).includes('rec 59'))
    term.input.emit('data', '\x1b[A')
    assert.ok(stripAnsi(term.output.chunks.at(-1)).includes('已暂停 (距最新 1 条)'))
    term.input.emit('data', 'G')
    assert.ok(stripAnsi(term.output.chunks.at(-1)).includes('跟随最新'))
    term.input.emit('data', 'q')
    await done
  } finally { TASKS['T-2'].records = [rec({ text: 'two' }), rec({ text: 'three' })] }
})
