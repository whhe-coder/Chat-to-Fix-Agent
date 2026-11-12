// The role tools on the real bot layer: after connectTaskLayer, the tool preparation of DS Bot
// (bot/src/host/tools.ts shareBotTools) hands each Agent to the task layer's attachRoleTools.
// The task layer is src/app.ts on the fake DSH context of host.js; the tools come from the
// registry, defined with DSH's own defineTool.
//
// Run: node --import ./bot/test/harness-resolve.mjs --test --test-force-exit test/bot/role-tools.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../../src/config.ts'
import { createApp } from '../../src/app.ts'
import { ROLES } from '../../src/task/contracts.ts'
import { connectTaskLayer, defineTool } from '../../src/bot/index.ts'
import { start } from './host.ts'

async function rig(t) {
  const host = await start(t)
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-roletools-'))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify({
    dataDir: join(dir, 'data'),
    worktreesDir: join(dir, 'worktrees'),
    httpPort: 0,
    apiModel: 'deepseek/v4-flash',
    codingModel: 'deepseek/v4-flash',
    bindings: [{ channel: 'C1', repo: 'group/project', jiraProject: 'DEMO' }],
  }))
  const config = loadConfig({ path: configPath, env: {} })
  const warnings = []
  const app = createApp({ config, botlayer: host.botlayer, token: 'tok', defineTool, warn: (...args) => warnings.push(args.join(' ')) })
  connectTaskLayer(host.botlayer, app.taskLayer)
  const port = await app.start()
  t.after(() => app.stop())
  const post = async (body) => (await fetch(`http://127.0.0.1:${port}/events`, {
    method: 'POST', headers: { 'x-chat-to-fix-token': 'tok', 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json()
  const running = async (id) => {
    for (let i = 0; i < 300; i++) {
      const task = await app.store.getTask(id)
      if (task?.state === 'running') return task
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`task ${id} did not start; warnings: ${warnings.join(' | ')}`)
  }
  return { host, app, post, running, warnings }
}

// The names this session's own scope holds, and have not been removed.
const held = (host, sessionId) => host.agentOf(sessionId).registrations.filter(entry => entry.active).map(entry => entry.name)

test('role tools are registered in the own scope of a bound bot\'s session, by its role', async (t) => {
  const { host, app, post, running, warnings } = await rig(t)
  const posted = await post({ eventId: 'E1', channel: 'C1', threadTs: '1.1', messageTs: '1.1', user: { id: 'U1', name: 'tester' }, text: 'the save button does nothing' })
  const task = await running(posted.taskId)
  const bots = task.runs.at(-1).bots
  assert.deepEqual(Object.keys(bots).sort(), [...ROLES].sort())

  // A fresh Agent for each bound session (DSH announces one after a reload); DS Bot prepares its tools.
  for (const role of ROLES) {
    host.agents.delete(bots[role])
    await host.agentCreated(bots[role])
  }
  const expected = role => app.tools.bridgedToolNames(bots[role])
  for (const role of ROLES) {
    const names = held(host, bots[role])
    for (const name of expected(role)) assert.ok(names.includes(name), `${role} has ${name}`)
    // DS Bot's own team tools are there too.
    assert.ok(names.includes('list_bots'), `${role} has the team tools`)
  }
  assert.ok(held(host, bots.main).includes('task_advance'))
  assert.equal(held(host, bots.slack).includes('task_advance'), false)
  assert.ok(held(host, bots.slack).includes('task_read'))
  assert.equal(held(host, bots.slack).includes('review_report'), false)
  assert.equal(warnings.filter(text => /cannot register/.test(text)).length, 0, warnings.join(' | '))

  // A call of the registered tool goes through the registry's wrapper: the step checks refuse an
  // advance without evidence, and the refusal is the tool's text.
  const registered = host.agentOf(bots.main).registrations.find(entry => entry.name === 'task_advance' && entry.active)
  assert.match(await registered.def.execute({ to: 'issue' }, {}), /Cannot advance/)
  const read = host.agentOf(bots.main).registrations.find(entry => entry.name === 'task_read' && entry.active)
  assert.equal(JSON.parse(await read.def.execute({}, {})).id, posted.taskId)
})

test('an unbound session gets no role tools, and a new Agent starts the scope over', async (t) => {
  const { host, app, post, running } = await rig(t)
  assert.deepEqual(app.tools.bridgedToolNames('no-such-session'), [])
  // A bot the task layer did not make: not bound, so its session holds the team tools only.
  const loose = await host.botlayer.createBot({ name: 'Loose', label: 'Other', instructions: 'You are Loose.' })
  await host.agentCreated(loose)
  assert.ok(held(host, loose).includes('list_bots'))
  for (const name of ['task_read', 'task_advance', 'task_close', 'slack_read_thread']) assert.equal(held(host, loose).includes(name), false, name)

  // A bound session: the same Agent asked again registers nothing twice; a fresh Agent starts over.
  const posted = await post({ eventId: 'E2', channel: 'C1', threadTs: '2.1', messageTs: '2.1', user: { id: 'U1', name: 'tester' }, text: 'again' })
  const task = await running(posted.taskId)
  const main = task.runs.at(-1).bots.main
  host.agents.delete(main)
  await host.agentCreated(main)
  const count = () => host.agentOf(main).registrations.filter(entry => entry.name === 'task_advance').length
  assert.equal(count(), 1)
  await host.agentCreated(main)
  assert.equal(count(), 1)
  const first = host.agentOf(main)
  host.agents.delete(main)
  await host.agentCreated(main)
  assert.notEqual(host.agentOf(main), first)
  assert.equal(count(), 1)
})

test('binding a bot gives its own-chat session the role tools, although that session was scoped before the binding', async (t) => {
  const { host, post, running } = await rig(t)
  const posted = await post({ eventId: 'E9', channel: 'C1', threadTs: '9.1', messageTs: '9.1', user: { id: 'U1', name: 'tester' }, text: 'the list is empty' })
  const bots = (await running(posted.taskId)).runs.at(-1).bots
  assert.ok(held(host, bots.main).includes('task_advance'), 'the Main bot can advance from its own chat')
  assert.ok(held(host, bots.main).includes('task_read'))
  assert.ok(!held(host, bots.slack).includes('task_advance'), 'the Slack bot cannot')
  assert.ok(held(host, bots.slack).includes('task_read'))
  assert.ok(held(host, bots.coding).includes('review_report'))
})
