import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHttp } from '../src/task/http.ts'
import { createQueue } from '../src/task/queue.ts'

const TOKEN = 'test-token'
const binding = { channel: 'C1', repo: 'g/p', jiraProject: 'DEMO', issueType: 'Bug', labels: [], defaultBranch: 'master' }
const event = (o = {}) => ({ eventId: 'Ev1', channel: 'C1', threadTs: '1.1', messageTs: '1.1', user: { id: 'U1', name: 'n' }, text: 'broken', ...o })

let tasks, events, threads, records, runnerCalls, notices, srv, base, clock, n, maxConcurrent, queueMax

function fakeStore() {
  return {
    knownEvent: (id) => events.get(id),
    async createTask(origin, b) {
      n += 1
      const t = { id: `T-${n}`, no: n, state: 'queued', origin, binding: b, queuedAt: null, step: 'fetch', jira: { key: null }, mr: null }
      tasks.set(t.id, t); events.set(origin.eventId, t.id); threads.set(`${origin.channel}/${origin.threadTs}`, t.id)
      return t
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
  const http = createHttp({ config: { httpPort: 0, bindings: [binding], limits }, token: TOKEN, store, queue, runner, notify: (t, k) => notices.push([t.id, k]) })
  await http.listen()
  srv = http
  base = `http://127.0.0.1:${http.port}`
}

beforeEach(async () => {
  tasks = new Map(); events = new Map(); threads = new Map(); records = new Map()
  runnerCalls = []; notices = []; n = 0; clock = { t: Date.parse('2026-11-12T00:00:00Z') }
  maxConcurrent = 1; queueMax = 20
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
  assert.deepEqual(all.body.tasks[0], { id: 'T-1', state: 'running', step: 'code', jiraKey: 'DEMO-7', mrUrl: 'http://mr/1' })
  assert.deepEqual(Object.keys(all.body.tasks[1]).sort(), ['id', 'jiraKey', 'mrUrl', 'state', 'step'])
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
  assert.deepEqual(r.body, { up: true, queued: 1, running: 1, maxConcurrent: 1 })
})

test('unknown route -> 404 JSON with error', async () => {
  const r = await call('GET', '/nope')
  assert.equal(r.status, 404); assert.ok(r.body.error)
})
