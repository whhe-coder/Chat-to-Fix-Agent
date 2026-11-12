// End to end through the whole task layer (src/app.ts) with the fake bot layer:
// listener -> queue -> runner (five bots, one group) -> tools -> step checks -> recorder -> monitor -> end.
// The Slack, Jira and GitLab tools are not built yet, so the test writes to the task what those
// tools will write; everything else is the real code.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { createApp } from '../src/app.ts'
import { ROLES } from '../src/task/contracts.ts'
import { createFakeBotLayer } from './helpers/fake-botlayer.ts'

async function rig({ binding = {} }: any = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-app-'))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify({
    dataDir: join(dir, 'data'),
    worktreesDir: join(dir, 'worktrees'),
    httpPort: 0,
    apiModel: 'anthropic/test',
    bindings: [{ channel: 'C1', repo: 'group/project', jiraProject: 'DEMO', ...binding }],
  }))
  const config = loadConfig({ path: configPath, env: {} })
  const botlayer = createFakeBotLayer()
  const clock = { ms: Date.now() }
  const changed = { files: [] }
  const notices = []
  const adapters = {
    slack: { reply: async (origin, purpose, text) => { notices.push({ origin, purpose, text }); return 'ts' } },
    repo: {
      diff: async () => ({ files: changed.files, totalFiles: changed.files.length, totalLines: changed.files.length * 3 }),
      cleanup: async () => {},
    },
  }
  const warnings = []
  const app = createApp({ config, botlayer, adapters, token: 'tok', now: () => clock.ms, warn: (...args) => warnings.push(args) })
  const port = await app.start()
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'x-chat-to-fix-token': 'tok', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  const until = async (check) => {
    for (let i = 0; i < 200; i++) {
      const value = await check()
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('condition was not reached')
  }
  const inState = (id, state) => until(async () => { const task = await app.store.getTask(id); return task?.state === state ? task : undefined })
  return { app, botlayer, clock, changed, notices, warnings, post, inState }
}

const event = (eventId, threadTs) => ({ eventId, channel: 'C1', threadTs, messageTs: threadTs, user: { id: 'U1', name: 'tester' }, text: 'the button does nothing' })
const at = '2026-11-12T02:00:00Z'

test('a Slack @ becomes a run with five bots and one group, and goes through the eight steps to done', async (t) => {
  const r = await rig()
  t.after(() => r.app.stop())
  const { app, botlayer } = r

  const posted = await r.post('/events', event('E1', '1.1'))
  assert.equal(posted.status, 202)
  const id = posted.body.taskId
  let task = await r.inState(id, 'running')
  const run = task.runs.at(-1)
  const bots = run.bots

  // The system created the bots and the group; no bot did.
  assert.deepEqual(Object.keys(bots).sort(), [...ROLES].sort())
  assert.equal(botlayer.bots.size, 5)
  assert.equal(botlayer.groups.size, 1)
  assert.equal(botlayer.groups.get(run.groupId).adminId, bots.main)
  assert.equal(botlayer.posts.length, 1)
  assert.match(botlayer.posts[0].text, /the button does nothing/)
  for (const role of ROLES) assert.deepEqual(botlayer.botOfSession(bots[role]), { botId: bots[role], role, taskId: id })

  const tool = (role, name, args = {}) => app.tools.call(name, bots[role], args)
  const roundEnd = async (role, text) => {
    botlayer.emit.roundEnd({ sessionId: bots[role], botId: bots[role], groupId: run.groupId, text, failed: false, at })
    await app.recorder.flush()
  }

  // A role has only its own tools: the Slack bot cannot advance the task.
  assert.match(await tool('slack', 'task_advance', { to: 'issue' }), /tool failed/)

  // Step 1: the Main bot cannot advance without the evidence; the Slack bot's final answer becomes the step result.
  assert.match(await tool('main', 'task_advance', { to: 'issue' }), /Cannot advance/)
  await app.store.patchTask(id, { slack: { readAt: at, sent: { ack: true } } })
  await roundEnd('slack', 'Summary: the save button on the profile page does nothing.')
  assert.equal((await app.store.getTask(id)).stepResults.fetch.slack.text, 'Summary: the save button on the profile page does nothing.')
  assert.match(await tool('main', 'task_advance', { to: 'issue' }), /Advanced/)

  // Steps 2 and 3.
  await app.store.patchTask(id, { jira: { key: 'DEMO-1', url: 'fake://jira/DEMO-1' } })
  assert.match(await tool('main', 'task_advance', { to: 'prepare' }), /Advanced/)
  await app.store.patchTask(id, { repo: { dir: '/tmp/wt/T-1', branch: 'ai/DEMO-1', base: 'abc123' } })
  assert.match(await tool('main', 'task_advance', { to: 'code' }), /Advanced/)

  // Step 4: the Coding bot records the review with its own tool; without a change and a pass the step stays.
  assert.match(await tool('main', 'task_advance', { to: 'mr' }), /Cannot advance/)
  r.changed.files = [{ path: 'src/button.js', added: 2, removed: 1 }]
  assert.match(await tool('main', 'review_report', { verdict: 'pass', comments: 'x', rounds: 1 }), /tool failed/)
  assert.doesNotMatch(await tool('coding', 'review_report', { verdict: 'pass', comments: 'fine', rounds: 1 }), /tool failed/)
  assert.match(await tool('main', 'task_advance', { to: 'mr' }), /Advanced/)

  // Steps 5 and 6. Step ci waits for ci.settled, which the monitor writes (spec 7); the test writes it by hand.
  await app.store.patchTask(id, { mr: { url: 'fake://gitlab/group/project/mr/1' } })
  assert.match(await tool('main', 'task_advance', { to: 'ci' }), /Advanced/)
  assert.match(await tool('main', 'task_advance', { to: 'writeback' }), /Cannot advance/)
  await app.store.patchTask(id, { ci: { status: 'passed', settled: true, outcome: 'passed' } })
  assert.match(await tool('main', 'task_advance', { to: 'writeback' }), /Advanced/)
  await app.store.patchTask(id, { jira: { commentedMr: true }, slack: { sent: { result: true } } })
  assert.match(await tool('main', 'task_advance', { to: 'close' }), /Advanced/)

  // Step 8: closing ends the run: the group is dissolved, the bots are deleted, the slot is free.
  assert.match(await tool('main', 'task_close', { outcome: 'done' }), /Task closed/)
  task = await r.inState(id, 'done')
  assert.equal(task.endReason, 'completed')
  assert.equal(botlayer.bots.size, 0)
  assert.equal(botlayer.groups.size, 0)
  assert.equal(botlayer.bindings.size, 0)
  assert.equal(r.notices.length, 0, 'a completed task sends no system notice')

  const records = await app.store.readRecords(id)
  assert.equal(records.filter(entry => entry.type === 'advance').length, 7)
  assert.ok(records.some(entry => entry.type === 'round_end' && entry.role === 'slack'))
  assert.ok(records.some(entry => entry.type === 'system'))
  assert.ok(records.some(entry => entry.type === 'refused'))

  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings))
})

test('the task layer hands the Claude Code launcher the test commands of the task\'s binding', async (t) => {
  const r = await rig({ binding: { testCommands: ['sh test.sh'], setupCommands: ['pnpm install'] } })
  t.after(() => r.app.stop())
  assert.equal(typeof r.app.taskLayer.codingOptions, 'function')
  const id = (await r.post('/events', event('E10', '10.1'))).body.taskId
  await r.inState(id, 'running')
  assert.deepEqual(r.app.taskLayer.codingOptions(id), { testCommands: ['sh test.sh'], setupCommands: ['pnpm install'] })
  assert.equal(r.app.taskLayer.codingOptions('T-999'), undefined)
  await r.post(`/tasks/${id}/stop`, undefined)
  await r.inState(id, 'stopped')
  assert.equal(r.app.taskLayer.codingOptions(id), undefined, 'gone with the run')
})

test('a task that runs past its total time is ended by the monitor, the person is told, and the next task starts', async (t) => {
  const r = await rig()
  t.after(() => r.app.stop())
  const { app, botlayer } = r

  const first = (await r.post('/events', event('E2', '2.1'))).body.taskId
  const second = (await r.post('/events', event('E3', '3.1'))).body.taskId
  await r.inState(first, 'running')
  assert.equal((await app.store.getTask(second)).state, 'queued')
  const firstGroup = (await app.store.getTask(first)).runs.at(-1).groupId
  botlayer.setQuiet(firstGroup, false)

  // The default total time limit is 80 minutes.
  r.clock.ms += 81 * 60 * 1000
  await app.monitor.tick()

  const ended = await r.inState(first, 'timed_out')
  assert.equal(ended.endReason, 'task_timeout')
  assert.equal(botlayer.groups.has(firstGroup), false)
  assert.equal(r.notices.length, 1)
  assert.equal(r.notices[0].purpose, 'system')
  assert.match(r.notices[0].text, new RegExp(first))
  const records = await app.store.readRecords(first)
  assert.ok(records.some(entry => entry.type === 'limit'))

  // The slot was released: the queued task gets its own fresh five bots and group.
  const next = await r.inState(second, 'running')
  assert.equal(botlayer.bots.size, 5)
  assert.equal(botlayer.groups.size, 1)
  assert.notEqual(next.runs.at(-1).groupId, firstGroup)
})

test('an approval request from a task bot is rejected and recorded', async (t) => {
  const r = await rig()
  t.after(() => r.app.stop())
  const { app, botlayer } = r

  const id = (await r.post('/events', event('E4', '4.1'))).body.taskId
  const task = await r.inState(id, 'running')
  const coding = task.runs.at(-1).bots.coding
  botlayer.emit.approval({ id: 'ap-1', sessionId: coding, botId: coding, tool: 'Bash', text: 'rm -rf build' })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(botlayer.answers, [{ id: 'ap-1', choice: 'reject' }])
  const records = await app.store.readRecords(id)
  assert.ok(records.some(entry => entry.type === 'approval'))
})
