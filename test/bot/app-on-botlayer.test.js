// The task layer (src/app.js) on the real bot layer (DS Bot's modules through src/bot/index.js),
// running on DS Bot's fake DSH context with a hand-driven model. This is the sample of the
// whole framework: a Slack @ arrives at the listener, the system creates five DS Bot bots and an
// admin-mode group, the task reaches only the Main bot, the Main bot uses a task tool, the
// recorder writes what happened, and a stop dissolves the group and deletes the bots.
//
// Run: node --import ./bot/test/harness-resolve.mjs --test --test-force-exit test/bot/app-on-botlayer.test.js
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../../src/config.js'
import { createApp } from '../../src/app.js'
import { ROLES } from '../../src/task/contracts.js'
import { start, settle } from './host.js'

async function rig(t) {
  const host = await start(t)
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-sample-'))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify({
    dataDir: join(dir, 'data'),
    worktreesDir: join(dir, 'worktrees'),
    httpPort: 0,
    // The fake context offers one model; the real routes are set in the configuration.
    apiModel: 'deepseek/v4-flash',
    codingModel: 'deepseek/v4-flash',
    bindings: [{ channel: 'C1', repo: 'group/project', jiraProject: 'DEMO' }],
  }))
  const config = loadConfig({ path: configPath, env: {} })
  const warnings = []
  const app = createApp({ config, botlayer: host.botlayer, token: 'tok', warn: (...args) => warnings.push(args.join(' ')) })
  const port = await app.start()
  t.after(() => app.stop())
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'x-chat-to-fix-token': 'tok', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  const inState = async (id, state) => {
    for (let i = 0; i < 300; i++) {
      const task = await app.store.getTask(id)
      if (task?.state === state) return task
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`task ${id} did not reach ${state}; warnings: ${warnings.join(' | ')}`)
  }
  return { host, app, call, inState, warnings }
}

test('sample: a Slack @ runs on real DS Bot bots — system-made group, the Main bot calls the Slack bot, tools, record, stop', async (t) => {
  const { host, app, call, inState, warnings } = await rig(t)
  const { rt, botlayer } = host

  const posted = await call('POST', '/events', {
    eventId: 'E1', channel: 'C1', threadTs: '1.1', messageTs: '1.1', user: { id: 'U1', name: 'tester' }, text: 'the save button does nothing',
  })
  assert.equal(posted.status, 202)
  const id = posted.body.taskId
  const task = await inState(id, 'running')
  const run = task.runs.at(-1)

  // The system created five DS Bot bots from the registry and one admin-mode group; no bot was greeted.
  assert.deepEqual(Object.keys(run.bots).sort(), [...ROLES].sort())
  for (const role of ROLES) {
    const bot = rt.botOf(run.bots[role])
    assert.ok(bot, `the ${role} bot exists in the bot layer`)
    assert.match(bot.name, new RegExp(`-${task.no}$`))
    assert.equal(bot.kickoff, undefined)
    assert.equal(host.agentOf(run.bots[role]).calls.length, 0, 'no greeting')
    assert.deepEqual(botlayer.botOfSession(run.bots[role]), { botId: run.bots[role], role, taskId: id })
  }
  const room = rt.roomOf(run.groupId)
  assert.equal(room.mode, 'admin')
  assert.equal(room.admin, run.bots.main)
  assert.equal(room.members.length, 5)

  // The task was posted into the group as the user, with the Slack text inside the material block.
  assert.equal(host.prompts.length, 1)
  const prompt = host.prompts[0]
  assert.equal(prompt.sessionId, run.groupId)
  assert.match(prompt.content[0].text, /BEGIN MATERIAL[\s\S]*the save button does nothing[\s\S]*END MATERIAL/)

  // The group's own session relays the message (as DSH would): only the Main bot is called.
  const stop = new AbortController()
  t.after(() => stop.abort())
  host.emit(run.groupId, 'user/message', { content: prompt.content, source: { kind: 'user' } })
  let relayed = false
  void host.tool('group_relay', {}, run.groupId, { callId: 'c1', signal: stop.signal }).then(() => { relayed = true }, () => { relayed = true })
  const mainSession = () => rt.roomOf(run.groupId)?.sessions?.[run.bots.main]
  await settle(() => mainSession() !== undefined && host.agentOf(mainSession()).calls.length === 1)
  for (const role of ROLES.filter(role => role !== 'main')) {
    assert.equal(host.agentOf(run.bots[role]).calls.length, 0, `${role} was not called`)
    assert.equal(rt.roomOf(run.groupId).sessions?.[run.bots[role]], undefined)
  }

  // The Main bot's turn: it reads the task with its task tool from its group session, tries to
  // advance without evidence (refused by the step checks), and ends its round.
  host.begin(mainSession())
  const read = JSON.parse(await app.tools.call('task_read', mainSession(), {}))
  assert.equal(read.id, id)
  assert.equal(read.step, 'fetch')
  assert.match(await app.tools.call('task_advance', mainSession(), { to: 'issue' }), /Cannot advance/)
  const slackName = rt.botOf(run.bots.slack).name
  host.finish(mainSession(), `@${slackName} please fetch the discussion.`)

  // The Main bot's @ calls the Slack bot, and only it. Its final answer becomes the result of the
  // fetch step on the task (hand-over through storage), and the round goes back to the Main bot.
  const slackSession = () => rt.roomOf(run.groupId)?.sessions?.[run.bots.slack]
  await settle(() => slackSession() !== undefined && host.agentOf(slackSession()).calls.length === 1)
  for (const role of ['jira', 'pipeline', 'coding']) assert.equal(rt.roomOf(run.groupId).sessions?.[run.bots[role]], undefined, `${role} was not called`)
  assert.deepEqual(botlayer.botOfSession(slackSession()), { botId: run.bots.slack, role: 'slack', taskId: id })
  assert.match(await app.tools.call('task_advance', slackSession(), { to: 'issue' }), /tool failed/, 'the Slack bot has no task_advance')
  host.begin(slackSession())
  // Using a tool of its own counts as work in DS Bot (groups.js:814), and only a member that
  // worked is handed back to its caller (groups.js:876). The role tools are outside DS Bot's
  // team tools list for exactly this reason.
  host.emit(slackSession(), 'tool/call', { callId: 'k2', name: 'slack_read_thread', arguments: '{}' })
  host.emit(slackSession(), 'tool/result', { callId: 'k2' })
  host.finish(slackSession(), 'Summary: the save button on the profile page does nothing.')
  await settle(() => host.agentOf(mainSession()).calls.length === 2)
  host.begin(mainSession())
  host.finish(mainSession(), 'The fetch step is waiting for its evidence.')
  await settle(() => relayed)
  await app.recorder.flush()
  assert.equal((await app.store.getTask(id)).stepResults.fetch.slack.text, 'Summary: the save button on the profile page does nothing.')

  // The recorder turned the bot layer's events into the execution record.
  let records = await app.store.readRecords(id)
  assert.ok(records.some(entry => entry.type === 'line' && /the save button does nothing/.test(entry.text)), 'the task line')
  assert.ok(records.some(entry => entry.type === 'round_end' && entry.role === 'main'), 'the Main bot round end')
  assert.ok(records.some(entry => entry.type === 'refused'), 'the refused advance')

  // A stop from the control interface ends the run: group dissolved, bots deleted, slot free.
  const stopped = await call('POST', `/tasks/${id}/stop`)
  assert.equal(stopped.status, 200)
  const ended = await inState(id, 'stopped')
  assert.equal(ended.endReason, 'stopped')
  assert.equal(botlayer.groupExists(run.groupId), false)
  for (const role of ROLES) {
    assert.equal(rt.botOf(run.bots[role]), undefined, `the ${role} bot is deleted`)
    assert.equal(botlayer.botOfSession(run.bots[role]), undefined)
  }
  const health = await call('GET', '/health')
  assert.deepEqual([health.body.queued, health.body.running], [0, 0])
  records = await app.store.readRecords(id)
  assert.ok(records.filter(entry => entry.type === 'system').length >= 2)
  assert.deepEqual(warnings, [])
})
