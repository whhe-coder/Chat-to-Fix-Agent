// Integration: the real config, store, gate, queue and HTTP modules wired together.
// The bot layer and the tools do not exist yet, so a fake runner starts a run without creating
// bots, and the test writes to the task what the tools will write (spec 1 section 2.3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { createStore } from '../src/task/store.ts'
import { createGate } from '../src/task/gate.ts'
import { createQueue } from '../src/task/queue.ts'
import { createHttp } from '../src/task/http.ts'
import { allBotDefs, validateRegistry } from '../src/registry/bots.ts'
import { validateFlow } from '../src/flow/steps.ts'

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-int-'))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify({
    dataDir: join(dir, 'data'),
    worktreesDir: join(dir, 'worktrees'),
    httpPort: 0,
    apiModel: 'anthropic/test',
    bindings: [{ channel: 'C1', repo: 'group/project', jiraProject: 'DEMO' }],
  }))
  const config = loadConfig({ path: configPath, env: {} })
  const store = createStore({ dataDir: config.dataDir })
  const notices = []
  const notify = async (task, kind) => { notices.push([task?.id ?? null, kind]) }
  const changed = { files: [] }
  const repo = { diff: async () => ({ files: changed.files, totalFiles: changed.files.length, totalLines: changed.files.length * 3 }) }
  let queue
  const runner = {
    started: [],
    async start(taskId) {
      runner.started.push(taskId)
      await store.startRun(taskId, { groupId: `group-${taskId}`, bots: { main: 'm', slack: 's', jira: 'j', pipeline: 'p', coding: 'c' } })
    },
    async end(taskId, state, endReason) {
      await store.endRun(taskId, state, endReason)
      await queue.release(taskId)
      await queue.dispatch()
    },
  }
  queue = createQueue({ store, limits: config.limits, runner, notify })
  const gate: any = createGate({ store, repo, limits: config.limits, onClosed: (id, state, reason) => runner.end(id, state, reason) })
  const http = createHttp({ config, token: 'tok', store, queue, runner, notify })
  const port = await http.listen()
  const call = async (method, path, body?) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'x-chat-to-fix-token': 'tok', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  const until = async (check) => {
    for (let i = 0; i < 100; i++) {
      const value = await check()
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('condition was not reached')
  }
  const running = id => until(async () => { const task = await store.getTask(id); return task?.state === 'running' ? task : undefined })
  return { config, store, gate, queue, http, runner, notices, changed, call, running }
}

const event = (eventId, threadTs) => ({ eventId, channel: 'C1', threadTs, messageTs: threadTs, user: { id: 'U1', name: 'tester' }, text: 'the button does nothing' })
const at = '2026-11-12T02:00:00Z'

test('the shipped registry and flow definitions pass their own startup checks', () => {
  assert.deepEqual(validateRegistry(), [])
  assert.deepEqual(validateFlow(allBotDefs()), [])
})

test('one task goes from the @ event through all seven steps to done', async (t) => {
  const r = await rig()
  t.after(() => r.http.close())

  const posted = await r.call('POST', '/events', event('E1', '1.1'))
  assert.equal(posted.status, 202)
  const id = posted.body.taskId
  let task = await r.running(id)
  assert.equal(task.step, 'fetch')
  assert.deepEqual(r.runner.started, [id])

  // Step 1: only the fetch step's write tool is allowed, and the step cannot advance without evidence.
  assert.equal((await r.gate.allow(id, 'slack_reply', 'ack')).ok, true)
  assert.equal((await r.gate.allow(id, 'mr_open_draft')).ok, false)
  const early = await r.gate.advance(id, 'issue')
  assert.equal(early.ok, false)
  assert.deepEqual(early.missing.sort(), ['slack.readAt', 'slack.sent.ack', 'stepResults.fetch'])
  await r.store.patchTask(id, { slack: { readAt: at, sent: { ack: true } }, stepResults: { fetch: { slack: { text: 'summary', at } } } })
  assert.equal((await r.gate.advance(id, 'issue')).ok, true)

  // Step 2 and 3.
  await r.store.patchTask(id, { jira: { key: 'DEMO-1', url: 'fake://jira/DEMO-1' } })
  assert.equal((await r.gate.advance(id, 'prepare')).ok, true)
  await r.store.patchTask(id, { repo: { dir: '/tmp/wt/T-1', branch: 'ai/DEMO-1', base: 'abc123' } })
  assert.equal((await r.gate.advance(id, 'code')).ok, true)

  // Step 4: needs a change and a passed review; skipping a step is refused.
  assert.equal((await r.gate.advance(id, 'writeback')).ok, false)
  assert.equal((await r.gate.advance(id, 'mr')).ok, false)
  r.changed.files = [{ path: 'src/button.js', added: 2, removed: 1 }]
  assert.equal((await r.gate.allow(id, 'review_report')).ok, true)
  await r.store.patchTask(id, { review: { verdict: 'pass', comments: 'fine', rounds: 1, at } })
  assert.equal((await r.gate.advance(id, 'mr')).ok, true)

  // Step 5 and 6.
  assert.equal((await r.gate.allow(id, 'mr_open_draft')).ok, true)
  await r.store.patchTask(id, { mr: { url: 'fake://gitlab/group/project/mr/1' } })
  assert.equal((await r.gate.advance(id, 'writeback')).ok, true)
  assert.equal((await r.gate.allow(id, 'slack_reply', 'result')).ok, true)
  await r.store.patchTask(id, { jira: { commentedMr: true }, slack: { sent: { result: true } } })
  assert.equal((await r.gate.advance(id, 'close')).ok, true)

  // Step 7.
  assert.equal((await r.gate.close(id, 'done')).ok, true)
  task = await r.store.getTask(id)
  assert.equal(task.state, 'done')
  assert.equal(task.endReason, 'completed')
  assert.equal(task.jira.key, 'DEMO-1')
  assert.equal(task.slack.sent.ack, true)
  assert.ok(task.runs[0].endedAt)

  const health = await r.call('GET', '/health')
  assert.equal(health.body.queued, 0)
  const shown = await r.call('GET', `/tasks/${id}?records=1`)
  assert.equal(shown.body.state ?? shown.body.task?.state, 'done')
  const records = await r.store.readRecords(id)
  assert.equal(records.filter(entry => entry.type === 'advance').length, 6)
  assert.ok(records.some(entry => entry.type === 'refused'))

  // The same event again creates nothing.
  const again = await r.call('POST', '/events', event('E1', '1.1'))
  assert.equal(again.body.duplicate, true)
  assert.equal(again.body.taskId, id)
})

test('needs information: both confirmations are required, and a new @ reruns the same task', async (t) => {
  const r = await rig()
  t.after(() => r.http.close())

  const posted = await r.call('POST', '/events', event('E2', '2.1'))
  const id = posted.body.taskId
  await r.running(id)
  await r.store.patchTask(id, { slack: { readAt: at, sent: { ack: true } }, stepResults: { fetch: { slack: { text: 'summary', at } } }, jira: { key: 'DEMO-2', url: 'fake://jira/DEMO-2' } })

  await r.gate.confirmNeedsInfo(id, 'coding', 'which page?')
  assert.equal((await r.gate.allow(id, 'slack_reply', 'question')).ok, false)
  assert.equal((await r.gate.close(id, 'needs_info')).ok, false)
  await r.gate.confirmNeedsInfo(id, 'main', 'which page is it?')
  assert.equal((await r.gate.allow(id, 'slack_reply', 'question')).ok, true)
  await r.store.patchTask(id, { slack: { sent: { question: true } } })
  assert.equal((await r.gate.close(id, 'needs_info')).ok, true)
  assert.equal((await r.store.getTask(id)).state, 'needs_info')

  // While the task waits for information, the same thread reruns it instead of creating a new task.
  const rerun = await r.call('POST', '/events', event('E3', '2.1'))
  assert.equal(rerun.status, 202)
  assert.equal(rerun.body.taskId, id)
  assert.equal(rerun.body.rerun, true)
  const task = await r.running(id)
  assert.equal(task.runs.length, 2)
  assert.equal(task.step, 'fetch')
  assert.equal(task.needsInfo.main, null)
  assert.equal(task.needsInfo.coding, null)
  assert.equal(task.jira.key, 'DEMO-2')
  assert.equal(task.slack.sent.ack, true)
})

test('with one slot the second task waits until the first ends', async (t) => {
  const r = await rig()
  t.after(() => r.http.close())

  const first = (await r.call('POST', '/events', event('E4', '4.1'))).body.taskId
  const second = (await r.call('POST', '/events', event('E5', '5.1'))).body.taskId
  await r.running(first)
  assert.equal((await r.store.getTask(second)).state, 'queued')

  const stopped = await r.call('POST', `/tasks/${first}/stop`)
  assert.equal(stopped.status, 200)
  assert.equal((await r.store.getTask(first)).state, 'stopped')
  await r.running(second)
  assert.deepEqual(r.runner.started, [first, second])
})
