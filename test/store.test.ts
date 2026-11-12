import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { createStore } from '../src/task/store.ts'

const dirs = []
async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-store-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true })
})

const quiet = { warn: () => {} }
const open = dir => createStore({ dataDir: dir, ...quiet })
const origin = (over = {}) => ({
  eventId: 'Ev1', channel: 'C1', threadTs: '100.1', messageTs: '100.1',
  user: { id: 'U1', name: 'tester' }, text: 'broken button', files: [], permalink: 'https://x/p1', ...over,
})
const binding = { repo: 'g/p', defaultBranch: 'master', jiraProject: 'DEMO', issueType: 'Bug', labels: ['chat-to-fix'] }
const bots = { main: 'm', slack: 's', jira: 'j', pipeline: 'p', coding: 'c' }

test('createTask writes all fields (null, not omitted), the index and numbers tasks', async () => {
  const dir = await fresh()
  const store = open(dir)
  const a = await store.createTask(origin(), binding)
  const b = await store.createTask(origin({ eventId: 'Ev2', threadTs: '200.1' }), binding)
  assert.equal(a.id, 'T-1')
  assert.equal(b.id, 'T-2')
  assert.equal(a.no, 1)
  assert.equal(a.state, 'queued')
  assert.equal(a.endReason, null)
  assert.equal(a.queuedAt, a.createdAt)
  for (const key of ['step', 'stepAt', 'review', 'mr']) assert.equal(a[key], null, key)
  assert.deepEqual(a.needsInfo, { main: null, coding: null })
  assert.deepEqual(a.jira, { key: null, url: null, commentedMr: false, status: null })
  assert.deepEqual(a.repo, { dir: null, branch: null, base: null })
  assert.deepEqual(a.runs, [])
  const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
  assert.equal(index.nextNo, 3)
  assert.deepEqual(index.events, { Ev1: 'T-1', Ev2: 'T-2' })
  assert.deepEqual(index.threads, { 'C1:100.1': 'T-1', 'C1:200.1': 'T-2' })
  assert.deepEqual(await readdir(join(dir, 'tasks', 'T-1')), ['task.json'])
})

test('restart: a second store on the same dir sees tasks, runs, records and the number', async () => {
  const dir = await fresh()
  const one = open(dir)
  await one.createTask(origin(), binding)
  await one.startRun('T-1', { groupId: 'g1', bots })
  await one.appendRecord('T-1', { run: 1, step: 'fetch', type: 'system', text: 'hello' })
  await one.endRun('T-1', 'done', 'completed')
  const before = await one.getTask('T-1')

  const two = open(dir)
  assert.equal(two.knownEvent('Ev1'), 'T-1')
  assert.deepEqual(await two.getTask('T-1'), before)
  assert.equal((await two.findByThread('C1', '100.1')).id, 'T-1')
  assert.deepEqual((await two.readRecords('T-1')).map(r => r.text), ['hello'])
  assert.equal((await two.createTask(origin({ eventId: 'Ev9', threadTs: '9.9' }), binding)).id, 'T-2')
})

test('opening a store changes nothing on disk', async () => {
  const dir = await fresh()
  open(dir)
  assert.deepEqual(await readdir(dir), [])
})

test('duplicate event: knownEvent returns the task id, unknown event returns undefined', async () => {
  const store = open(await fresh())
  assert.equal(store.knownEvent('Ev1'), undefined)
  await store.createTask(origin(), binding)
  assert.equal(store.knownEvent('Ev1'), 'T-1')
  assert.equal(store.knownEvent('__proto__'), undefined)
  assert.equal(store.knownEvent('toString'), undefined)
})

test('thread mapping: none -> undefined; new task overwrites the mapping after an ended state', async () => {
  const store = open(await fresh())
  assert.equal(await store.findByThread('C1', '100.1'), undefined)
  await store.createTask(origin(), binding)
  assert.equal((await store.findByThread('C1', '100.1')).state, 'queued')
  await store.startRun('T-1', { groupId: 'g', bots })
  assert.equal((await store.findByThread('C1', '100.1')).state, 'running')
  await store.endRun('T-1', 'failed', 'needs_person')
  assert.equal((await store.findByThread('C1', '100.1')).state, 'failed')
  await store.createTask(origin({ eventId: 'Ev2' }), binding)
  assert.equal((await store.findByThread('C1', '100.1')).id, 'T-2')
  assert.equal(store.knownEvent('Ev1'), 'T-1')
  assert.equal(await store.findByThread('C1', '999.9'), undefined)
  assert.equal(await store.findByThread('C2', '100.1'), undefined)
})

test('thread mapping: needs_info keeps the task, and a new run starts on it', async () => {
  const store = open(await fresh())
  await store.createTask(origin(), binding)
  await store.startRun('T-1', { groupId: 'g1', bots })
  await store.endRun('T-1', 'needs_info', 'needs_info')
  const found = await store.findByThread('C1', '100.1')
  assert.equal(found.id, 'T-1')
  assert.equal(found.state, 'needs_info')
  const again = await store.startRun(found.id, { groupId: 'g2', bots })
  assert.equal(again.state, 'running')
  assert.equal(again.runs.length, 2)
  assert.equal((await store.findByThread('C1', '100.1')).id, 'T-1')
})

test('patchTask merges objects deeply, replaces arrays and scalars, updates updatedAt', async () => {
  let tick = 0
  const store = createStore({ dataDir: await fresh(), now: () => `2026-11-12T00:00:${String(tick++).padStart(2, '0')}Z`, ...quiet })
  const task = await store.createTask(origin(), binding)
  const patched = await store.patchTask('T-1', {
    jira: { key: 'DEMO-7' },
    slack: { sent: { ack: true } },
    binding: { labels: ['x'] },
    stepResults: { fetch: { slack: { text: 'sum', at: 't' } } },
    review: { verdict: 'pass', comments: 'ok', rounds: 1, at: 't' },
  })
  assert.deepEqual(patched.jira, { key: 'DEMO-7', url: null, commentedMr: false, status: null })
  assert.deepEqual(patched.slack.sent, { ack: true, question: false, result: false })
  assert.equal(patched.slack.readAt, null)
  assert.deepEqual(patched.binding.labels, ['x'])
  assert.equal(patched.binding.repo, 'g/p')
  assert.notEqual(patched.updatedAt, task.updatedAt)
  const more = await store.patchTask('T-1', { stepResults: { fetch: { jira: { text: 'j' } }, issue: { jira: { text: 'i' } } }, review: null })
  assert.deepEqual(Object.keys(more.stepResults), ['fetch', 'issue'])
  assert.deepEqual(Object.keys(more.stepResults.fetch), ['slack', 'jira'])
  assert.equal(more.review, null)
  const kept = await store.patchTask('T-1', { id: 'T-99', no: 99, step: 'issue', jira: { url: undefined } })
  assert.equal(kept.id, 'T-1')
  assert.equal(kept.no, 1)
  assert.equal(kept.step, 'issue')
  assert.equal(kept.jira.key, 'DEMO-7')
  await assert.rejects(store.patchTask('T-77', { step: 'x' }), /No such task/)
})

test('concurrent patches to one task lose nothing', async () => {
  const store = open(await fresh())
  await store.createTask(origin(), binding)
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.patchTask('T-1', { stepResults: { [`s${i}`]: { main: { text: String(i) } } } })))
  const task = await store.getTask('T-1')
  assert.equal(Object.keys(task.stepResults).length, 30)
  const mixed = await Promise.all([
    store.patchTask('T-1', { jira: { key: 'K-1' } }),
    store.patchTask('T-1', { jira: { url: 'u' } }),
    store.patchTask('T-1', { repo: { dir: '/d' } }),
  ])
  assert.equal(mixed[2].jira.key, 'K-1')
  assert.equal(mixed[2].jira.url, 'u')
  assert.equal(mixed[2].repo.dir, '/d')
})

test('concurrent createTask calls get different numbers', async () => {
  const store = open(await fresh())
  const made = await Promise.all([1, 2, 3, 4, 5].map(i => store.createTask(origin({ eventId: `E${i}`, threadTs: `${i}.0` }), binding)))
  assert.deepEqual(made.map(t => t.id).sort(), ['T-1', 'T-2', 'T-3', 'T-4', 'T-5'])
})

test('startRun on a fresh task: appends run 1, running, step fetch', async () => {
  const store = open(await fresh())
  await store.createTask(origin(), binding)
  const task = await store.startRun('T-1', { groupId: 'g1', bots })
  assert.equal(task.state, 'running')
  assert.equal(task.step, 'fetch')
  assert.ok(task.stepAt)
  assert.equal(task.runs.length, 1)
  const run = task.runs[0]
  assert.equal(run.no, 1)
  assert.equal(run.groupId, 'g1')
  assert.deepEqual(run.bots, bots)
  assert.ok(run.startedAt)
  assert.equal(run.endedAt, null)
  assert.equal(run.endReason, null)
})

test('startRun on a rerun clears needsInfo, review, stepResults and keeps jira, repo, mr, ack', async () => {
  const store = open(await fresh())
  await store.createTask(origin(), binding)
  await store.startRun('T-1', { groupId: 'g1', bots })
  await store.patchTask('T-1', {
    step: 'code',
    stepResults: { fetch: { slack: { text: 's', at: 't' } } },
    review: { verdict: 'fail', comments: 'c', rounds: 2, at: 't' },
    mr: { url: 'https://mr/1' },
    jira: { key: 'DEMO-7', url: 'https://j/7', commentedMr: true },
    repo: { dir: '/w/T-1', branch: 'ai/DEMO-7', base: 'abc' },
    needsInfo: { main: { text: 'a', at: 't' }, coding: { text: 'b', at: 't' } },
    slack: { readAt: 't', sent: { ack: true, question: true, result: false } },
  })
  await store.endRun('T-1', 'needs_info', 'needs_info')
  const task = await store.startRun('T-1', { groupId: 'g2', bots: { ...bots, main: 'm2' } })
  assert.equal(task.state, 'running')
  assert.equal(task.endReason, null)
  assert.equal(task.step, 'fetch')
  assert.deepEqual(task.stepResults, {})
  assert.equal(task.review, null)
  assert.deepEqual(task.needsInfo, { main: null, coding: null })
  assert.equal(task.mr.url, 'https://mr/1')
  assert.deepEqual(task.jira, { key: 'DEMO-7', url: 'https://j/7', commentedMr: true, status: null })
  assert.deepEqual(task.repo, { dir: '/w/T-1', branch: 'ai/DEMO-7', base: 'abc' })
  assert.equal(task.slack.sent.ack, true)
  assert.equal(task.slack.sent.question, false)
  assert.equal(task.slack.readAt, null)
  assert.equal(task.runs.length, 2)
  assert.equal(task.runs[0].endReason, 'needs_info')
  assert.equal(task.runs[1].no, 2)
  assert.equal(task.runs[1].bots.main, 'm2')
})

test('endRun maps every end reason to its state and closes the current run', async () => {
  const table = [
    ['done', 'completed'], ['needs_info', 'needs_info'], ['failed', 'needs_person'],
    ['failed', 'step_timeout'], ['failed', 'stalled'], ['failed', 'idle_relay'], ['failed', 'engine_silent'],
    ['failed', 'start_failed'], ['failed', 'restart'], ['timed_out', 'task_timeout'], ['timed_out', 'coding_timeout'],
    ['failed', 'store_corrupt'], ['stopped', 'stopped'], ['expired', 'queue_expired'],
    ['failed', 'The login page could not be reproduced'],
  ]
  const store = open(await fresh())
  for (const [i, [state, reason]] of table.entries()) {
    const id = `T-${i + 1}`
    await store.createTask(origin({ eventId: `E${i}`, threadTs: `${i}.0` }), binding)
    await store.startRun(id, { groupId: 'g', bots })
    const task = await store.endRun(id, state, reason)
    assert.equal(task.state, state, reason)
    assert.equal(task.endReason, reason)
    assert.equal(task.runs[0].endReason, reason)
    assert.ok(task.runs[0].endedAt)
  }
})

test('endRun rejects a state that does not fit the end reason, and an unknown state', async () => {
  const store = open(await fresh())
  await store.createTask(origin(), binding)
  await store.startRun('T-1', { groupId: 'g', bots })
  await assert.rejects(store.endRun('T-1', 'done', 'step_timeout'), /belongs to state failed/)
  await assert.rejects(store.endRun('T-1', 'done', 'some free text'), /only for state failed/)
  await assert.rejects(store.endRun('T-1', 'running', 'completed'), /Not an end state/)
  await assert.rejects(store.endRun('T-1', 'bogus', 'completed'), /Not an end state/)
  assert.equal((await store.getTask('T-1')).state, 'running')
})

test('endRun on a queued task (no run) still ends the task', async () => {
  const store = open(await fresh())
  await store.createTask(origin(), binding)
  const task = await store.endRun('T-1', 'expired', 'queue_expired')
  assert.equal(task.state, 'expired')
  assert.deepEqual(task.runs, [])
})

test('records: append-only, in order, filter by step, text cut to 2000', async () => {
  const dir = await fresh()
  const store = open(dir)
  await store.createTask(origin(), binding)
  await store.appendRecord('T-1', { run: 1, step: 'fetch', role: 'slack', botId: 's', type: 'tool_call', tool: 'slack_read', text: 'a' })
  await store.appendRecord('T-1', { run: 1, step: 'issue', role: 'jira', botId: 'j', type: 'tool_result', tool: 'jira_create_issue', ok: true, text: 'b'.repeat(2500), ms: 840 })
  await store.appendRecord('T-1', { run: 1, step: 'fetch', type: 'advance', text: 'fetch -> issue' })
  const all = await store.readRecords('T-1')
  assert.equal(all.length, 3)
  assert.deepEqual(all.map(r => r.type), ['tool_call', 'tool_result', 'advance'])
  assert.equal(all[1].text.length, 2000)
  assert.equal(all[1].ms, 840)
  assert.equal(all[0].taskId, 'T-1')
  assert.ok(all[0].at)
  assert.equal(all[2].role, null)
  assert.equal(all[2].botId, null)
  assert.equal(all[0].text, 'a')
  assert.deepEqual((await store.readRecords('T-1', { step: 'fetch' })).map(r => r.type), ['tool_call', 'advance'])
  assert.deepEqual(await store.readRecords('T-1', { step: 'close' }), [])
  const lines = (await readFile(join(dir, 'tasks', 'T-1', 'records.jsonl'), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 3)
  assert.deepEqual(await store.readRecords('T-1', { step: undefined }), all)
})

test('records: concurrent appends all land; unknown task and write failure do not throw', async () => {
  const warnings = []
  const store = createStore({ dataDir: await fresh(), warn: (...args) => warnings.push(args) })
  await store.createTask(origin(), binding)
  await Promise.all(Array.from({ length: 50 }, (_, i) => store.appendRecord('T-1', { type: 'system', text: String(i) })))
  assert.equal((await store.readRecords('T-1')).length, 50)
  await store.appendRecord('T-9', { type: 'system', text: 'x' })
  assert.equal(warnings.length, 1)
  assert.deepEqual(await store.readRecords('T-9'), [])
  assert.deepEqual(await store.readRecords('T-1x'), [])
})

test('listTasks filters by state and sorts by creation time', async () => {
  const times = ['2026-11-12T03:00:00Z', '2026-11-12T01:00:00Z', '2026-11-12T02:00:00Z']
  let call = 0
  const store = createStore({ dataDir: await fresh(), now: () => times[call++] ?? '2026-11-13T00:00:00Z', ...quiet })
  await store.createTask(origin({ eventId: 'a', threadTs: '1' }), binding)
  await store.createTask(origin({ eventId: 'b', threadTs: '2' }), binding)
  await store.createTask(origin({ eventId: 'c', threadTs: '3' }), binding)
  assert.deepEqual((await store.listTasks()).map(t => t.id), ['T-2', 'T-3', 'T-1'])
  await store.startRun('T-3', { groupId: 'g', bots })
  assert.deepEqual((await store.listTasks({ state: 'running' })).map(t => t.id), ['T-3'])
  assert.deepEqual((await store.listTasks({ state: 'queued' })).map(t => t.id), ['T-2', 'T-1'])
  assert.deepEqual(await store.listTasks({ state: 'done' }), [])
  assert.deepEqual(await open(await fresh()).listTasks(), [])
})

test('corrupt task.json: only that task becomes failed with store_corrupt', async () => {
  const dir = await fresh()
  const store = open(dir)
  await store.createTask(origin(), binding)
  await store.createTask(origin({ eventId: 'Ev2', threadTs: '2.0' }), binding)
  await store.startRun('T-2', { groupId: 'g', bots })
  await writeFile(join(dir, 'tasks', 'T-1', 'task.json'), '{"id": "T-1", "state": "runn', 'utf8')

  const reopened = open(dir)
  const broken = await reopened.getTask('T-1')
  assert.equal(broken.id, 'T-1')
  assert.equal(broken.state, 'failed')
  assert.equal(broken.endReason, 'store_corrupt')
  const other = await reopened.getTask('T-2')
  assert.equal(other.state, 'running')
  assert.equal(other.endReason, null)
  // The failed state was written back, the bad file was kept aside, and it reads the same again.
  assert.deepEqual(await reopened.getTask('T-1'), broken)
  const names = await readdir(join(dir, 'tasks', 'T-1'))
  assert.ok(names.some(n => n.startsWith('task.json.broken-')))
  assert.deepEqual((await reopened.listTasks({ state: 'failed' })).map(t => t.id), ['T-1'])
  assert.equal((await reopened.findByThread('C1', '100.1')).state, 'failed')
})

test('corrupt task.json found by patchTask: task is marked failed and the patch is not applied', async () => {
  const dir = await fresh()
  const store = open(dir)
  await store.createTask(origin(), binding)
  await writeFile(join(dir, 'tasks', 'T-1', 'task.json'), 'not json', 'utf8')
  const result = await store.patchTask('T-1', { step: 'code' })
  assert.equal(result.state, 'failed')
  assert.equal(result.endReason, 'store_corrupt')
  assert.equal(result.step, null)
})

test('getTask: unknown and malformed ids read as not there', async () => {
  const store = open(await fresh())
  assert.equal(await store.getTask('T-5'), undefined)
  assert.equal(await store.getTask('../index'), undefined)
  assert.equal(await store.getTask(undefined), undefined)
})

test('writes leave no temporary files behind', async () => {
  const dir = await fresh()
  const store = open(dir)
  await store.createTask(origin(), binding)
  await Promise.all([store.patchTask('T-1', { step: 'a' }), store.patchTask('T-1', { step: 'b' })])
  assert.deepEqual((await readdir(join(dir, 'tasks', 'T-1'))).sort(), ['task.json'])
  assert.deepEqual((await readdir(dir)).sort(), ['index.json', 'tasks'])
})
