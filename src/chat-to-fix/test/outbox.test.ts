// The outbox (core/task/outbox.ts): append-only <dataDir>/outbox.jsonl, global seq, paging, taskId from the thread.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOutbox } from '../core/task/outbox.ts'

const dir = () => mkdtemp(join(tmpdir(), 'chat-to-fix-outbox-'))
const msg = (o = {}) => ({ channel: 'C1', threadTs: '1.1', purpose: 'ack', text: 'hi', ...o })
const clock = () => '2026-11-12T10:00:00.000Z'

test('append gives seq 1, 2, 3 and the fields of the message; read returns them oldest first', async () => {
  const outbox = createOutbox({ dataDir: await dir(), now: clock })
  const a = await outbox.append(msg())
  const b = await outbox.append(msg({ purpose: 'system', kind: 'failed', text: 'two', taskId: 'T-7' }))
  assert.deepEqual(a, { seq: 1, at: clock(), taskId: null, channel: 'C1', threadTs: '1.1', purpose: 'ack', kind: null, text: 'hi' })
  assert.deepEqual(b, { seq: 2, at: clock(), taskId: 'T-7', channel: 'C1', threadTs: '1.1', purpose: 'system', kind: 'failed', text: 'two' })
  const page = await outbox.read()
  assert.deepEqual(page.messages.map((m) => m.seq), [1, 2])
  assert.equal(page.next, 2)
  assert.deepEqual(page.messages[1], b)
})

test('read: after and limit page through; next stays at after when there is nothing new', async () => {
  const outbox = createOutbox({ dataDir: await dir() })
  for (let i = 1; i <= 5; i++) await outbox.append(msg({ text: `m${i}` }))
  const first = await outbox.read(0, 2)
  assert.deepEqual(first.messages.map((m) => m.text), ['m1', 'm2']); assert.equal(first.next, 2)
  const second = await outbox.read(first.next, 2)
  assert.deepEqual(second.messages.map((m) => m.text), ['m3', 'm4']); assert.equal(second.next, 4)
  const rest = await outbox.read(4)
  assert.deepEqual(rest.messages.map((m) => m.text), ['m5']); assert.equal(rest.next, 5)
  assert.deepEqual(await outbox.read(5), { messages: [], next: 5 })
  assert.deepEqual(await outbox.read(99), { messages: [], next: 99 })
})

test('read: limit defaults to 50 and is at most 200', async () => {
  const outbox = createOutbox({ dataDir: await dir() })
  await Promise.all(Array.from({ length: 230 }, (_, i) => outbox.append(msg({ text: `m${i}` }))))
  assert.equal((await outbox.read()).messages.length, 50)
  assert.equal((await outbox.read(0, 1000)).messages.length, 200)
  assert.equal((await outbox.read(0, 0)).messages.length, 50)
})

test('appends at the same time get different seq numbers, in the order they were made', async () => {
  const outbox = createOutbox({ dataDir: await dir() })
  const sent = await Promise.all(['a', 'b', 'c', 'd'].map((text) => outbox.append(msg({ text }))))
  assert.deepEqual(sent.map((m) => m.seq), [1, 2, 3, 4])
  assert.deepEqual((await outbox.read()).messages.map((m) => m.text), ['a', 'b', 'c', 'd'])
})

test('a new outbox on the same folder carries on after the last seq; the file has one JSON line per message', async () => {
  const dataDir = await dir()
  const one = createOutbox({ dataDir })
  await one.append(msg({ text: 'a' })); await one.append(msg({ text: 'b' }))
  const two = createOutbox({ dataDir })
  assert.equal((await two.append(msg({ text: 'c' }))).seq, 3)
  const lines = (await readFile(join(dataDir, 'outbox.jsonl'), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 3)
  assert.deepEqual(lines.map((l) => JSON.parse(l).seq), [1, 2, 3])
  assert.deepEqual((await createOutbox({ dataDir }).read(1)).messages.map((m) => m.text), ['b', 'c'])
})

test('a half-written last line is skipped when the last seq is recovered', async () => {
  const dataDir = await dir()
  await writeFile(join(dataDir, 'outbox.jsonl'), `${JSON.stringify({ seq: 4, text: 'x', channel: 'C1', threadTs: '1.1' })}\n{"seq":5,"te`)
  const outbox = createOutbox({ dataDir })
  assert.equal((await outbox.append(msg())).seq, 5)
  assert.deepEqual((await outbox.read()).messages.map((m) => m.seq), [4, 5])
})

test('taskId is filled from the discussion when not given; an unknown discussion or a failing lookup gives null', async () => {
  const asked = []
  const store = { findByThread: async (c, t) => { asked.push([c, t]); if (t === 'boom') throw new Error('disk'); return t === '1.1' ? { id: 'T-3' } : undefined } }
  const outbox = createOutbox({ dataDir: await dir(), store })
  assert.equal((await outbox.append(msg())).taskId, 'T-3')
  assert.equal((await outbox.append(msg({ taskId: 'T-9' }))).taskId, 'T-9')
  assert.equal((await outbox.append(msg({ threadTs: '2.2' }))).taskId, null)
  assert.equal((await outbox.append(msg({ threadTs: 'boom' }))).taskId, null)
  assert.deepEqual(asked, [['C1', '1.1'], ['C1', '2.2'], ['C1', 'boom']])
})

test('append refuses a message without channel, threadTs or text', async () => {
  const outbox = createOutbox({ dataDir: await dir() })
  await assert.rejects(outbox.append(msg({ channel: '' })), /channel and threadTs/)
  await assert.rejects(outbox.append(msg({ threadTs: undefined })), /channel and threadTs/)
  await assert.rejects(outbox.append(msg({ text: ' ' })), /text/)
  assert.equal((await outbox.append(msg())).seq, 1) // a refused append takes no seq
})

// ---- the whole chain: POST /events -> task layer -> monitor -> outbox adapter -> GET /outbox ----

test('adapters.slack "outbox" in the app: fix, mention (in progress, no task) and a bound-channel refusal reach GET /outbox', async (t) => {
  const { loadConfig } = await import('../core/config.ts')
  const { createApp } = await import('../core/app.ts')
  const { createFakeBotLayer } = await import('./helpers/fake-botlayer.ts')
  const root = await dir()
  const configPath = join(root, 'config.json')
  await writeFile(configPath, JSON.stringify({
    dataDir: join(root, 'data'), worktreesDir: join(root, 'worktrees'), httpPort: 0, apiModel: 'anthropic/test', language: 'zh',
    adapters: { slack: 'outbox' }, bindings: [{ channel: 'C1', repo: 'group/project', jiraProject: 'DEMO' }],
  }))
  const config = loadConfig({ path: configPath, env: {} })
  const app = createApp({ config, botlayer: createFakeBotLayer(), token: 'tok', warn: () => {} })
  const port = await app.start()
  t.after(() => app.stop())
  const call = async (method, path, body?) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-chat-to-fix-token': 'tok', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  const ev = (o) => ({ source: 'fix', eventId: 'slash:1', channel: 'C1', threadTs: '5.1', messageTs: '5.1', user: { id: 'U1' }, text: 'button typo', ...o })

  const started = await call('POST', '/events', ev({}))
  assert.equal(started.status, 202)
  const id = started.body.taskId
  const busy = await call('POST', '/events', ev({ source: 'mention', eventId: 'Ev-2', messageTs: '5.2', text: 'more info' }))
  assert.equal(busy.status, 200); assert.equal(busy.body.inProgress, true)
  const none = await call('POST', '/events', ev({ source: 'mention', eventId: 'Ev-3', threadTs: '9.9', messageTs: '9.10', text: 'hello?' }))
  assert.equal(none.status, 409); assert.deepEqual(none.body, { error: 'no_open_task' })
  const unbound = await call('POST', '/events', ev({ eventId: 'slash:2', channel: 'CX', threadTs: '6.1', messageTs: '6.1' }))
  assert.equal(unbound.status, 422)

  const out = await call('GET', '/outbox')
  assert.equal(out.status, 200)
  const rows = out.body.messages.filter((m) => m.purpose === 'system')
  assert.deepEqual(rows.map((m) => m.kind), ['in_progress', 'no_open_task', 'channel_not_bound'])
  assert.deepEqual(rows.map((m) => m.seq), rows.map((_, i) => rows[0].seq + i))
  assert.equal(rows[0].taskId, id); assert.equal(rows[0].channel, 'C1'); assert.equal(rows[0].threadTs, '5.1')
  assert.equal(rows[1].taskId, null); assert.equal(rows[1].threadTs, '9.9')
  assert.equal(rows[1].text, '这个讨论串里没有在处理的任务，新问题请用 /fix 提交。')
  assert.equal(rows[2].channel, 'CX')
  // the follow-up is part of the discussion the bots read
  const task = await app.store.getTask(id)
  assert.deepEqual(task.origin.followUps.map((f) => f.text), ['more info'])
  // restart: a new outbox on the same data folder continues the numbering
  const last = out.body.next
  const next = await app.outbox.append({ channel: 'C1', threadTs: '5.1', purpose: 'result', text: 'done' })
  assert.equal(next.seq, last + 1)
})
