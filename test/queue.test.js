import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQueue } from '../src/task/queue.js'

function setup({ maxConcurrent = 1, queueMax = 20, queueWaitHours = 4 } = {}) {
  const tasks = new Map()
  const store = {
    async listTasks({ state } = {}) { return [...tasks.values()].filter((t) => state === undefined || t.state === state) },
    async getTask(id) { return tasks.get(id) },
    async patchTask(id, patch) { const t = { ...tasks.get(id), ...patch }; tasks.set(id, t); return t },
  }
  const started = []
  const notices = []
  let failStart = false
  const runner = { start(id) { started.push(id); if (failStart) throw new Error('boom') } }
  const clock = { t: Date.parse('2026-11-12T00:00:00Z') }
  const queue = createQueue({
    store, limits: { maxConcurrent, queueMax, queueWaitHours }, runner,
    notify: (task, kind) => notices.push([task.id, kind]), now: () => clock.t,
  })
  const add = (id) => tasks.set(id, { id, state: 'queued', queuedAt: null })
  return { tasks, store, started, notices, queue, clock, add, setFail: (v) => { failStart = v } }
}
const run = (s, id) => s.tasks.set(id, { ...s.tasks.get(id), state: 'running' })

test('enqueue stamps queuedAt and starts the first task at once', async () => {
  const s = setup(); s.add('T-1')
  const r = await s.queue.enqueue('T-1')
  assert.equal(r.position, 1)
  assert.deepEqual(s.started, ['T-1'])
  assert.equal(s.tasks.get('T-1').queuedAt, '2026-11-12T00:00:00.000Z')
})

test('first come first served by queuedAt, concurrency 1', async () => {
  const s = setup()
  for (const id of ['T-1', 'T-2', 'T-3']) { s.add(id); s.clock.t += 1000; await s.queue.enqueue(id); if (id === 'T-1') run(s, 'T-1') }
  assert.deepEqual(s.started, ['T-1'])
  assert.equal(await s.queue.position('T-3'), 2)
  s.tasks.get('T-1').state = 'done'; s.queue.release('T-1'); await s.queue.dispatch()
  assert.deepEqual(s.started, ['T-1', 'T-2'])
  run(s, 'T-2'); s.tasks.get('T-2').state = 'done'; s.queue.release('T-2'); await s.queue.dispatch()
  assert.deepEqual(s.started, ['T-1', 'T-2', 'T-3'])
})

test('order follows queuedAt, not creation order (a re-queued task goes to the back)', async () => {
  const s = setup()
  s.add('T-1'); s.add('T-2'); s.add('T-3')
  s.tasks.set('T-1', { id: 'T-1', state: 'running', queuedAt: null })
  s.clock.t += 1000; await s.queue.enqueue('T-3')
  s.clock.t += 1000; await s.queue.enqueue('T-2')
  s.tasks.get('T-1').state = 'done'; s.queue.release('T-1'); await s.queue.dispatch()
  assert.deepEqual(s.started, ['T-3'])
})

test('concurrency 2 starts two, a third waits', async () => {
  const s = setup({ maxConcurrent: 2 })
  for (const id of ['T-1', 'T-2', 'T-3']) { s.add(id); s.clock.t += 1000; await s.queue.enqueue(id) }
  assert.deepEqual(s.started, ['T-1', 'T-2'])
  assert.equal(await s.queue.position('T-3'), 1)
})

test('a dispatched task counts as running before the store shows it running; dispatch twice does not double start', async () => {
  const s = setup()
  s.add('T-1'); s.add('T-2')
  await s.queue.enqueue('T-1'); s.clock.t += 1; await s.queue.enqueue('T-2')
  await s.queue.dispatch(); await s.queue.dispatch()
  assert.deepEqual(s.started, ['T-1'])
})

test('running tasks found in the store (restart) take slots', async () => {
  const s = setup()
  s.tasks.set('T-1', { id: 'T-1', state: 'running' })
  s.add('T-2'); await s.queue.enqueue('T-2')
  assert.deepEqual(s.started, [])
})

test('release then dispatch hands the slot on', async () => {
  const s = setup()
  s.add('T-1'); s.add('T-2')
  await s.queue.enqueue('T-1'); s.clock.t += 1; await s.queue.enqueue('T-2')
  run(s, 'T-1'); await s.queue.dispatch()
  assert.deepEqual(s.started, ['T-1'])
  s.tasks.get('T-1').state = 'done'
  s.queue.release('T-1')
  assert.deepEqual(await s.queue.dispatch(), ['T-2'])
})

test('queue length limit', async () => {
  const s = setup({ queueMax: 2 })
  s.tasks.set('T-0', { id: 'T-0', state: 'running' })
  for (const id of ['T-1', 'T-2']) { assert.equal(await s.queue.full(), false); s.add(id); await s.queue.enqueue(id) }
  assert.equal(await s.queue.full(), true)
})

test('expiry: waited longer than queueWaitHours -> expired, queue_expired, notice', async () => {
  const s = setup({ queueWaitHours: 4 })
  s.tasks.set('T-0', { id: 'T-0', state: 'running' })
  s.add('T-1'); await s.queue.enqueue('T-1')
  s.clock.t += 4 * 3_600_000
  assert.deepEqual(await s.queue.expire(), [])
  s.add('T-2'); await s.queue.enqueue('T-2')
  s.clock.t += 1
  assert.deepEqual(await s.queue.expire(), ['T-1'])
  assert.equal(s.tasks.get('T-1').state, 'expired')
  assert.equal(s.tasks.get('T-1').endReason, 'queue_expired')
  assert.deepEqual(s.notices, [['T-1', 'expired']])
  assert.equal(s.tasks.get('T-2').state, 'queued')
})

test('dispatch expires before it starts anything', async () => {
  const s = setup({ queueWaitHours: 1 })
  s.tasks.set('T-1', { id: 'T-1', state: 'queued', queuedAt: new Date(s.clock.t - 2 * 3_600_000).toISOString() })
  await s.queue.dispatch()
  assert.deepEqual(s.started, [])
  assert.equal(s.tasks.get('T-1').state, 'expired')
})

test('a runner that fails to start marks the task failed/start_failed and frees the slot', async () => {
  const s = setup(); s.setFail(true)
  s.add('T-1'); await s.queue.enqueue('T-1')
  await new Promise((r) => setImmediate(r))
  assert.equal(s.tasks.get('T-1').state, 'failed')
  assert.equal(s.tasks.get('T-1').endReason, 'start_failed')
  s.setFail(false); s.add('T-2'); await s.queue.enqueue('T-2')
  assert.deepEqual(s.started, ['T-1', 'T-2'])
})
