import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHttp } from '../src/task/http.ts'
import { createQueue } from '../src/task/queue.ts'
import { createOutbox } from '../src/task/outbox.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = 'test-token'
const binding = { channel: 'C1', repo: 'g/p', jiraProject: 'DEMO', issueType: 'Bug', labels: [], defaultBranch: 'master' }
const event = (o = {}) => ({ eventId: 'Ev1', channel: 'C1', threadTs: '1.1', messageTs: '1.1', user: { id: 'U1', name: 'n' }, text: 'broken', ...o })

let outbox, tasks, events, threads, records, runnerCalls, notices, srv, base, clock, n, maxConcurrent, queueMax, opened, startThreadImpl

function fakeStore() {
  return {
    knownEvent: (id) => events.get(id),
    async createTask(origin, b) {
      n += 1
      const t = { id: `T-${n}`, no: n, state: 'queued', origin, binding: b, queuedAt: null, step: 'fetch', jira: { key: null }, mr: null }
      tasks.set(t.id, t); events.set(origin.eventId, t.id); threads.set(`${origin.channel}/${origin.threadTs}`, t.id)
      return t
    },
    async addFollowUp(id, eventId, message) {
      const t = tasks.get(id)
      tasks.set(id, { ...t, origin: { ...t.origin, followUps: [...(t.origin.followUps ?? []), message] } })
      events.set(eventId, id)
      return tasks.get(id)
    },
    async getTask(id) { return tasks.get(id) },
    async findByThread(c, t) { return tasks.get(threads.get(`${c}/${t}`)) },
    async patchTask(id, patch) { const t = { ...tasks.get(id), ...patch }; tasks.set(id, t); return t },
    async listTasks({ state }: any = {}) { return [...tasks.values()].filter((t) => state === undefined || t.state === state) },
    async readRecords(id) { return records.get(id) ?? [] },
  }
}

async function start() {
  const store = fakeStore()
  const runner = {
    start: (id) => runnerCalls.push(['start', id]),
    end: async (id, state, reason) => { runnerCalls.push(['end', id, state, reason]); await store.patchTask(id, { state, endReason: reason }) },
  }
  const limits = { maxConcurrent, queueMax, queueWaitHours: 4 }
  const queue = createQueue({ store, limits, runner, notify: (t, k) => notices.push([t.id, k]), now: () => clock.t })
  outbox = createOutbox({ dataDir: mkdtempSync(join(tmpdir(), 'chat-to-fix-http-outbox-')), store })
  const http = createHttp({ config: { httpPort: 0, bindings: [binding], limits }, token: TOKEN, store, outbox, queue, runner, notify: (t, k) => notices.push([t.id, k]), startThread: (channel, text) => startThreadImpl(channel, text) })
  await http.listen()
  srv = http
  base = `http://127.0.0.1:${http.port}`
}

beforeEach(async () => {
  tasks = new Map(); events = new Map(); threads = new Map(); records = new Map()
  runnerCalls = []; notices = []; n = 0; clock = { t: Date.parse('2026-11-12T00:00:00Z') }
  maxConcurrent = 1; queueMax = 20
  opened = []
  startThreadImpl = async (channel, text) => { opened.push({ channel, text }); return { ts: `9${opened.length}.000100`, permalink: `https://slack.test/archives/${channel}/p9${opened.length}` } }
  await start()
})
afterEach(() => srv.close())

async function call(method, path, body?, headers: any = { 'x-chat-to-fix-token': TOKEN }) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) })
  return { status: res.status, body: await res.json() }
}
const post = (b) => call('POST', '/events', b)

test('listens on 127.0.0.1 with a real port', () => {
  assert.ok(srv.port > 0)
})

test('bad or missing token -> 401 with error field, on every route', async () => {
  for (const [m, p] of [['POST', '/events'], ['GET', '/health'], ['GET', '/tasks'], ['GET', '/tasks/T-1'], ['POST', '/tasks/T-1/stop']]) {
    for (const headers of [{}, { 'x-chat-to-fix-token': 'wrong' }]) {
      const r = await call(m, p, m === 'POST' ? {} : undefined, headers)
      assert.equal(r.status, 401); assert.equal(r.body.error, 'unauthorized')
    }
  }
})

test('4.1 row 1: missing required fields -> 400, nothing created', async () => {
  for (const drop of ['eventId', 'channel', 'threadTs', 'messageTs', 'text']) {
    const e = event(); delete e[drop]
    const r = await post(e)
    assert.equal(r.status, 400); assert.match(r.body.error, new RegExp(drop))
  }
  const e = event(); delete e.user
  assert.match((await post(e)).body.error, /user\.id/)
  assert.equal((await post('not json')).status, 400)
  assert.equal(tasks.size, 0)
})

test('4.1 last row: new event creates and queues a task -> 202, dispatches it', async () => {
  const r = await post(event())
  assert.equal(r.status, 202)
  assert.deepEqual(r.body, { taskId: 'T-1', state: 'queued', position: 1 })
  assert.deepEqual(runnerCalls, [['start', 'T-1']])
  assert.equal(tasks.get('T-1').origin.text, 'broken')
  assert.equal(tasks.get('T-1').binding.jiraProject, 'DEMO')
})

test('4.1 duplicate event -> 200 duplicate, no second task', async () => {
  await post(event())
  const r = await post(event())
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { taskId: 'T-1', state: 'queued', duplicate: true })
  assert.equal(tasks.size, 1)
})

test('4.1 channel not bound -> 422, notice, nothing created', async () => {
  const r = await post(event({ channel: 'CX' }))
  assert.equal(r.status, 422); assert.deepEqual(r.body, { error: 'channel_not_bound' })
  assert.deepEqual(notices, [[null, 'channel_not_bound']])
  assert.equal(tasks.size, 0)
})

test('4.1 discussion already queued or running -> 200 inProgress, notice, no new task', async () => {
  await post(event())
  tasks.get('T-1').state = 'running'
  const r = await post(event({ eventId: 'Ev2', messageTs: '1.2' }))
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { taskId: 'T-1', state: 'running', inProgress: true })
  assert.deepEqual(notices, [['T-1', 'in_progress']])
  assert.equal(tasks.size, 1)
  assert.deepEqual(tasks.get('T-1').origin.followUps.map((f) => f.text), ['broken']) // the @ is kept on the task as a follow-up
  tasks.get('T-1').state = 'queued'
  assert.equal((await post(event({ eventId: 'Ev3' }))).body.state, 'queued')
})

test('4.1 needs_info thread -> 202 rerun of the original task, queued again', async () => {
  await post(event())
  tasks.set('T-1', { ...tasks.get('T-1'), state: 'needs_info' })
  runnerCalls.length = 0
  clock.t += 5000
  const r = await post(event({ eventId: 'Ev2', messageTs: '1.5' }))
  assert.equal(r.status, 202)
  assert.deepEqual(r.body, { taskId: 'T-1', state: 'queued', position: 1, rerun: true })
  assert.equal(tasks.size, 1)
  assert.equal(tasks.get('T-1').queuedAt, new Date(clock.t).toISOString())
  assert.deepEqual(runnerCalls, [['start', 'T-1']])
  assert.deepEqual(tasks.get('T-1').origin.followUps.map((f) => f.messageTs), ['1.5']) // the answer is stored
  assert.deepEqual(notices, [['T-1', 'resumed']])
})

test('4.1 queue full -> 429, notice, nothing created', async () => {
  queueMax = 1
  await srv.close(); await start()
  await post(event({ eventId: 'E1', threadTs: '1' }))      // starts at once
  tasks.get('T-1').state = 'running'
  await post(event({ eventId: 'E2', threadTs: '2' }))      // waits: queue length 1
  const r = await post(event({ eventId: 'E3', threadTs: '3' }))
  assert.equal(r.status, 429); assert.deepEqual(r.body, { error: 'queue_full' })
  assert.deepEqual(notices, [[null, 'queue_full']])
  assert.equal(tasks.size, 2)
})

test('4.1 a finished earlier task in the thread does not block a new one', async () => {
  await post(event())
  tasks.get('T-1').state = 'done'
  const r = await post(event({ eventId: 'Ev2' }))
  assert.equal(r.status, 202); assert.equal(r.body.taskId, 'T-2')
})

test('the second task waits at position 1 when concurrency is 1', async () => {
  await post(event({ eventId: 'E1', threadTs: '1' }))
  const r = await post(event({ eventId: 'E2', threadTs: '2' }))
  assert.equal(r.body.position, 1)
  assert.deepEqual(runnerCalls, [['start', 'T-1']])
})

test('GET /tasks/:id with and without records; 404', async () => {
  await post(event())
  records.set('T-1', [{ type: 'system', text: 'created' }])
  const a = await call('GET', '/tasks/T-1')
  assert.equal(a.status, 200); assert.equal(a.body.id, 'T-1'); assert.equal('records' in a.body, false)
  const b = await call('GET', '/tasks/T-1?records=1')
  assert.deepEqual(b.body.records, [{ type: 'system', text: 'created' }])
  const c = await call('GET', '/tasks/T-99')
  assert.equal(c.status, 404); assert.ok(c.body.error)
})

test('GET /tasks lists short entries, filtered by state', async () => {
  await post(event({ eventId: 'E1', threadTs: '1' }))
  await post(event({ eventId: 'E2', threadTs: '2' }))
  tasks.set('T-1', { ...tasks.get('T-1'), state: 'running', step: 'code', jira: { key: 'DEMO-7' }, mr: { url: 'http://mr/1' } })
  const all = await call('GET', '/tasks')
  assert.equal(all.body.tasks.length, 2)
  assert.deepEqual(all.body.tasks[0], { id: 'T-1', state: 'running', step: 'code', jiraKey: 'DEMO-7', mrUrl: 'http://mr/1', totalUsd: 0, unpriced: false })
  assert.deepEqual(Object.keys(all.body.tasks[1]).sort(), ['id', 'jiraKey', 'mrUrl', 'state', 'step', 'totalUsd', 'unpriced'])
  tasks.set('T-2', { ...tasks.get('T-2'), usage: { totalUsd: 0.42, unpriced: true } })
  const priced = await call('GET', '/tasks')
  assert.deepEqual([priced.body.tasks[1].totalUsd, priced.body.tasks[1].unpriced], [0.42, true])
  const q = await call('GET', '/tasks?state=queued')
  assert.deepEqual(q.body.tasks.map((t) => t.id), ['T-2'])
  assert.equal((await call('GET', '/tasks?state=bogus')).status, 400)
})

test('stop: a queued task goes straight to stopped, with a notice', async () => {
  await post(event({ eventId: 'E1', threadTs: '1' })); tasks.get('T-1').state = 'running'
  await post(event({ eventId: 'E2', threadTs: '2' }))
  const r = await call('POST', '/tasks/T-2/stop')
  assert.equal(r.status, 200); assert.deepEqual(r.body, { stopped: true })
  assert.equal(tasks.get('T-2').state, 'stopped'); assert.equal(tasks.get('T-2').endReason, 'stopped')
  assert.deepEqual(notices, [['T-2', 'stopped']])
  assert.deepEqual(runnerCalls.filter((c) => c[0] === 'end'), [])
})

test('stop: a running task calls runner.end(id, "stopped", "stopped")', async () => {
  await post(event()); tasks.get('T-1').state = 'running'
  const r = await call('POST', '/tasks/T-1/stop')
  assert.deepEqual(r.body, { stopped: true })
  assert.deepEqual(runnerCalls.at(-1), ['end', 'T-1', 'stopped', 'stopped'])
})

test('stop: 409 for a task that is neither queued nor running; 404 for unknown', async () => {
  await post(event())
  for (const state of ['done', 'failed', 'needs_info', 'stopped', 'expired', 'timed_out']) {
    tasks.get('T-1').state = state
    const r = await call('POST', '/tasks/T-1/stop')
    assert.equal(r.status, 409); assert.ok(r.body.error)
  }
  assert.equal((await call('POST', '/tasks/T-9/stop')).status, 404)
})

test('health', async () => {
  maxConcurrent = 1
  await post(event({ eventId: 'E1', threadTs: '1' })); tasks.get('T-1').state = 'running'
  await post(event({ eventId: 'E2', threadTs: '2' }))
  const r = await call('GET', '/health')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { up: true, queued: 1, running: 1, maxConcurrent: 1, queueMax: 20, queueFull: false })
})

test('health: queueFull turns true when the queue is at queueMax', async () => {
  await srv.close(); maxConcurrent = 1; queueMax = 1; await start()
  await post(event({ eventId: 'E1', threadTs: '1' })); tasks.get('T-1').state = 'running'
  await post(event({ eventId: 'E2', threadTs: '2' }))
  const r = await call('GET', '/health')
  assert.equal(r.body.queueMax, 1)
  assert.equal(r.body.queueFull, true)
})

test('unknown route -> 404 JSON with error', async () => {
  const r = await call('GET', '/nope')
  assert.equal(r.status, 404); assert.ok(r.body.error)
})

// ---- /fix: source "slash" (research note fix-slash-entry, 4.1) ----
const slash = (o = {}) => ({ source: 'slash', eventId: 'slash:T1', channel: 'C1', user: { id: 'U1', name: 'ann' }, text: 'login page is broken', ...o })

test('slash: opens the thread, creates the task in it, replies 202 { taskId, permalink }', async () => {
  const r = await post(slash())
  assert.equal(r.status, 202)
  assert.deepEqual(r.body, { taskId: 'T-1', permalink: 'https://slack.test/archives/C1/p91' })
  assert.deepEqual(opened, [{ channel: 'C1', text: '<@U1> 用 /fix 提了一个修复请求：\n> login page is broken\n进度会回在这条消息的讨论串里。' }])
  const t = tasks.get('T-1')
  assert.equal(t.origin.threadTs, '91.000100'); assert.equal(t.origin.messageTs, '91.000100')
  assert.deepEqual(t.origin.user, { id: 'U1', name: 'ann' })
  assert.equal(t.origin.text, 'login page is broken')
  assert.equal(t.origin.permalink, 'https://slack.test/archives/C1/p91')
  assert.equal(t.origin.eventId, 'slash:T1')
  assert.equal(t.binding.jiraProject, 'DEMO')
  assert.deepEqual(runnerCalls, [['start', 'T-1']])
  assert.deepEqual(notices, [])
})

test('slash: the opening message quotes every line and neutralises broadcasts', async () => {
  await post(slash({ text: 'ping <!channel> and @here\nsecond line' }))
  assert.equal(opened.length, 1)
  assert.equal(opened[0].text, '<@U1> 用 /fix 提了一个修复请求：\n> ping @\u200bchannel and @\u200bhere\n> second line\n进度会回在这条消息的讨论串里。')
  assert.doesNotMatch(opened[0].text, /<!channel>|@here/)
  // the task keeps the command text as typed
  assert.equal(tasks.get('T-1').origin.text, 'ping <!channel> and @here\nsecond line')
})

test('slash: openingMessage names the command it is given (config.slack.slashCommand, default /fix)', async () => {
  const text = (await import('../src/task/http.ts')).openingMessage('/repair', 'U9', 'x')
  assert.match(text, /^<@U9> 用 \/repair 提了/)
})

test('slash: required fields are checked by source; no threadTs or messageTs needed', async () => {
  for (const drop of ['eventId', 'channel', 'text']) {
    const e = slash(); delete e[drop]
    const r = await post(e)
    assert.equal(r.status, 400); assert.match(r.body.error, new RegExp(drop))
  }
  const e = slash(); delete e.user
  assert.match((await post(e)).body.error, /user\.id/)
  assert.equal((await post(slash({ user: { id: 'U1>x' } }))).status, 400)
  assert.equal((await post(slash({ text: '   ' }))).status, 400)
  assert.equal(tasks.size, 0); assert.equal(opened.length, 0)
  // the same body without source "slash" still needs threadTs and messageTs (the @ path is unchanged)
  const mention = slash({ source: undefined })
  assert.match((await post(mention)).body.error, /threadTs, messageTs/)
})

test('slash: a repeated eventId -> 200 duplicate with the permalink, no second opening message, no second task', async () => {
  await post(slash())
  const r = await post(slash())
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { taskId: 'T-1', state: 'queued', permalink: 'https://slack.test/archives/C1/p91', duplicate: true })
  assert.equal(opened.length, 1); assert.equal(tasks.size, 1)
})

test('slash: two retries at the same moment post one opening message and create one task', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  startThreadImpl = async (channel, text) => { opened.push({ channel, text }); await gate; return { ts: '77.000100', permalink: 'https://slack.test/p77' } }
  const a = post(slash()); const b = post(slash()); const c = post(slash())
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(opened.length, 1)
  release()
  const results = await Promise.all([a, b, c])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 202])
  for (const r of results) assert.equal(r.body.taskId, 'T-1')
  assert.equal(results.filter((r) => r.body.duplicate === true).length, 2)
  assert.equal(opened.length, 1); assert.equal(tasks.size, 1)
  assert.deepEqual(runnerCalls, [['start', 'T-1']])
})

test('slash: channel not bound -> 422, nothing posted, no notice, nothing created', async () => {
  const r = await post(slash({ channel: 'CX' }))
  assert.equal(r.status, 422); assert.deepEqual(r.body, { error: 'channel_not_bound' })
  assert.deepEqual(opened, []); assert.deepEqual(notices, []); assert.equal(tasks.size, 0)
})

test('slash: queue full -> 429, nothing posted, no notice, nothing created', async () => {
  queueMax = 1
  await srv.close(); await start()
  await post(event({ eventId: 'E1', threadTs: '1' }))
  tasks.get('T-1').state = 'running'
  await post(event({ eventId: 'E2', threadTs: '2' }))
  const r = await post(slash())
  assert.equal(r.status, 429); assert.deepEqual(r.body, { error: 'queue_full' })
  assert.deepEqual(opened, []); assert.deepEqual(notices, []); assert.equal(tasks.size, 2)
})

test('slash: startThread fails -> 502 with the adapter code, nothing queued; a retry can still succeed', async () => {
  startThreadImpl = async () => { throw Object.assign(new Error('Slack chat.postMessage: not_in_channel: secret detail'), { code: 'not_in_channel' }) }
  const r = await post(slash())
  assert.equal(r.status, 502); assert.deepEqual(r.body, { error: 'not_in_channel' })
  assert.equal(tasks.size, 0); assert.deepEqual(runnerCalls, []); assert.equal(events.has('slash:T1'), false)
  // an error without a code, and a reply without a ts
  startThreadImpl = async () => { throw new Error('boom') }
  assert.deepEqual((await post(slash())).body, { error: 'slack_error' })
  startThreadImpl = async () => ({ permalink: 'x' })
  assert.deepEqual((await post(slash())).body, { error: 'slack_bad_response' })
  // the failed attempts did not leave the event id stuck
  startThreadImpl = async (channel, text) => { opened.push({ channel, text }); return { ts: '5.000100', permalink: null } }
  const ok = await post(slash())
  assert.equal(ok.status, 202); assert.deepEqual(ok.body, { taskId: 'T-1', permalink: null })
  assert.equal('permalink' in tasks.get('T-1').origin, false)
})

test('slash: without a startThread function in the wiring -> 502 no_adapter', async () => {
  const store = fakeStore()
  const http = createHttp({ config: { httpPort: 0, bindings: [binding], limits: {} }, token: TOKEN, store, queue: { full: async () => false, enqueue: async () => ({ position: 1 }) }, runner: {}, notify: async () => {} })
  await http.listen()
  try {
    const res = await fetch(`http://127.0.0.1:${http.port}/events`, { method: 'POST', headers: { 'x-chat-to-fix-token': TOKEN }, body: JSON.stringify(slash()) })
    assert.equal(res.status, 502); assert.deepEqual(await res.json(), { error: 'no_adapter' })
  } finally { await http.close() }
})

test('slash: a later @ in the opening thread finds the task: in progress -> inProgress, needs_info -> rerun', async () => {
  const first = await post(slash())
  const ts = tasks.get(first.body.taskId).origin.threadTs
  assert.equal((await fakeStore().findByThread('C1', ts)).id, 'T-1')
  const mention = (o = {}) => event({ eventId: 'Ev9', threadTs: ts, messageTs: '99.000200', ...o })
  const busy = await post(mention())
  assert.equal(busy.status, 200); assert.equal(busy.body.inProgress, true); assert.equal(busy.body.taskId, 'T-1')
  tasks.set('T-1', { ...tasks.get('T-1'), state: 'needs_info' })
  runnerCalls.length = 0
  const again = await post(mention({ eventId: 'Ev10' }))
  assert.equal(again.status, 202)
  assert.deepEqual(again.body, { taskId: 'T-1', state: 'queued', position: 1, rerun: true })
  assert.deepEqual(runnerCalls, [['start', 'T-1']])
  assert.equal(tasks.size, 1); assert.equal(opened.length, 1)
})


// ---- source "fix" and "mention" (the company Slack Bot, spec slackbot.md 4.2 (1)) ----

const fix = (o = {}) => event({ source: 'fix', eventId: 'slash:T1', threadTs: '50.000100', messageTs: '50.000100', ...o })
const mention = (o = {}) => event({ source: 'mention', eventId: 'Ev-m1', threadTs: '50.000100', messageTs: '50.000300', text: 'it says Add to crat', ...o })

test('source fix: creates the task in the Slack Bot\'s thread -> 202 queued, no opening message from the server', async () => {
  const r = await post(fix())
  assert.equal(r.status, 202)
  assert.equal(r.body.taskId, 'T-1'); assert.equal(r.body.state, 'queued')
  assert.equal(tasks.get('T-1').origin.threadTs, '50.000100')
  assert.equal(tasks.get('T-1').origin.earlier, undefined)
  assert.equal(opened.length, 0)
  assert.deepEqual(runnerCalls, [['start', 'T-1']])
})

test('source fix: missing fields 400 (source and eventId and threadTs and messageTs and user.id and text), unknown source 400', async () => {
  const r = await post({ source: 'fix' })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /^missing_fields: eventId, channel, threadTs, messageTs, text, user\.id$/)
  for (const k of ['threadTs', 'messageTs', 'text', 'eventId', 'channel']) assert.equal((await post(fix({ [k]: '' }))).status, 400, k)
  assert.equal((await post(fix({ user: {} }))).status, 400)
  assert.deepEqual((await post(fix({ source: 'bogus' }))).body, { error: 'invalid_source' })
  assert.equal(tasks.size, 0)
})

test('source fix: the same eventId again -> 200 duplicate, also when two arrive at the same time', async () => {
  const [a, b] = await Promise.all([post(fix()), post(fix())])
  assert.deepEqual([a.status, b.status].sort(), [200, 202])
  assert.equal(tasks.size, 1)
  const again = await post(fix())
  assert.equal(again.status, 200); assert.equal(again.body.duplicate, true); assert.equal(again.body.taskId, 'T-1')
})

test('source fix: channel not bound -> 422 and a notice; queue full -> 429 and a notice; nothing created', async () => {
  const unbound = await post(fix({ channel: 'CX' }))
  assert.equal(unbound.status, 422); assert.deepEqual(unbound.body, { error: 'channel_not_bound' })
  queueMax = 1
  await srv.close(); await start()
  await post(fix({ eventId: 'E1', threadTs: '1.1', messageTs: '1.1' }))
  tasks.get('T-1').state = 'running'
  await post(fix({ eventId: 'E2', threadTs: '2.1', messageTs: '2.1' }))
  notices.length = 0
  const full = await post(fix({ eventId: 'E3', threadTs: '3.1', messageTs: '3.1' }))
  assert.equal(full.status, 429); assert.deepEqual(full.body, { error: 'queue_full' })
  assert.deepEqual(notices, [[null, 'queue_full']])
  assert.equal(tasks.size, 2)
})

test('source fix: a finished task in the same thread does not carry its messages (no origin.earlier)', async () => {
  await post(fix())
  tasks.get('T-1').state = 'done'
  const r = await post(fix({ eventId: 'slash:T2' }))
  assert.equal(r.status, 202); assert.equal(r.body.taskId, 'T-2')
  assert.equal(tasks.get('T-2').origin.earlier, undefined)
})

test('source mention: a queued or running task keeps the follow-up -> 200 inProgress and the in_progress notice', async () => {
  await post(fix())
  tasks.get('T-1').state = 'running'
  notices.length = 0
  const r = await post(mention())
  assert.equal(r.status, 200); assert.deepEqual(r.body, { taskId: 'T-1', state: 'running', inProgress: true })
  assert.deepEqual(notices, [['T-1', 'in_progress']])
  const [kept] = tasks.get('T-1').origin.followUps
  assert.equal(kept.text, 'it says Add to crat'); assert.equal(kept.messageTs, '50.000300'); assert.equal(kept.user.id, 'U1')
  assert.equal(tasks.size, 1)
  const again = await post(mention())
  assert.equal(again.body.duplicate, true); assert.equal(tasks.get('T-1').origin.followUps.length, 1)
})

test('source mention: a task that needs info -> 202 rerun, queued again, follow-up kept, resumed notice', async () => {
  await post(fix())
  tasks.set('T-1', { ...tasks.get('T-1'), state: 'needs_info' })
  runnerCalls.length = 0; notices.length = 0
  const r = await post(mention())
  assert.equal(r.status, 202); assert.deepEqual(r.body, { taskId: 'T-1', state: 'queued', position: 1, rerun: true })
  assert.deepEqual(runnerCalls, [['start', 'T-1']])
  assert.deepEqual(notices, [['T-1', 'resumed']])
  assert.equal(tasks.get('T-1').origin.followUps[0].text, 'it says Add to crat')
})

test('source mention: no task in the thread, or an ended one -> 409 no_open_task, a notice to that thread, nothing created or stored', async () => {
  const none = await post(mention({ threadTs: '70.000100' }))
  assert.equal(none.status, 409); assert.deepEqual(none.body, { error: 'no_open_task' })
  assert.deepEqual(notices, [[null, 'no_open_task']])
  await post(fix())
  for (const state of ['done', 'failed', 'stopped', 'expired', 'timed_out']) {
    tasks.get('T-1').state = state
    notices.length = 0
    const r = await post(mention({ eventId: `Ev-${state}` }))
    assert.equal(r.status, 409, state); assert.deepEqual(r.body, { error: 'no_open_task' })
    assert.deepEqual(notices, [[null, 'no_open_task']], state)
  }
  assert.equal(tasks.size, 1); assert.equal(tasks.get('T-1').origin.followUps, undefined)
})

test('source mention: channel not bound -> 422 and a notice; missing fields -> 400', async () => {
  const r = await post(mention({ channel: 'CX' }))
  assert.equal(r.status, 422); assert.deepEqual(notices, [[null, 'channel_not_bound']])
  assert.equal((await post(mention({ messageTs: undefined }))).status, 400)
})

test('no source: the older format still starts a task from an @ and carries an ended task\'s messages', async () => {
  await post(event())
  tasks.get('T-1').state = 'done'
  const r = await post(event({ eventId: 'Ev2', text: 'again' }))
  assert.equal(r.status, 202)
  assert.deepEqual(tasks.get('T-2').origin.earlier.map((m) => m.text), ['broken'])
})

test('GET /outbox: messages after a cursor, limit, next; token required; bad after or limit -> 400', async () => {
  assert.deepEqual(await (await call('GET', '/outbox')).body, { messages: [], next: 0 })
  for (const text of ['a', 'b', 'c']) await outbox.append({ channel: 'C1', threadTs: '1.1', purpose: 'ack', text })
  const all = await call('GET', '/outbox')
  assert.equal(all.status, 200)
  assert.deepEqual(all.body.messages.map((m) => [m.seq, m.text]), [[1, 'a'], [2, 'b'], [3, 'c']]); assert.equal(all.body.next, 3)
  const page = await call('GET', '/outbox?after=1&limit=1')
  assert.deepEqual(page.body.messages.map((m) => m.seq), [2]); assert.equal(page.body.next, 2)
  assert.deepEqual((await call('GET', '/outbox?after=3')).body, { messages: [], next: 3 })
  assert.equal((await call('GET', '/outbox?limit=1000')).status, 200)
  for (const q of ['after=-1', 'after=x', 'after=1.5', 'limit=0', 'limit=x', 'limit=']) assert.equal((await call('GET', `/outbox?${q}`)).status, 400, q)
  assert.equal((await call('GET', '/outbox', undefined, {})).status, 401)
  assert.equal((await call('GET', '/outbox', undefined, { 'x-chat-to-fix-token': 'wrong' })).status, 401)
})
