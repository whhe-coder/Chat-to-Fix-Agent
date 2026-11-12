import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { start, settle } from './host.js'

// Drives the I1 facade on DS Bot's fake DSH context, in the style of bot/test/group-work.test.js.
const NAMES = ['Boss', 'Slacker', 'Jirer', 'Piper', 'Coder']


async function team(host) {
  const ids = []
  for (const name of NAMES) {
    ids.push(await host.botlayer.createBot({ name, label: 'Role', instructions: `You are ${name}.`, model: 'deepseek/v4-flash', permission: 'workspace-write', preset: 'standard' }))
  }
  const groupId = await host.botlayer.createGroup({ name: 'Task 1', memberIds: ids, adminId: ids[0], notice: 'Work on the task.' })
  return { ids, groupId }
}

test('createBot sends no greeting, sets model and permission, and returns the bot id', async (t) => {
  const host = await start(t)
  const { ids } = await team(host)
  await settle(() => true)
  assert.equal(new Set(ids).size, 5)
  for (const id of ids) {
    assert.equal(host.agentOf(id).calls.length, 0, 'no greeting message')
    const bot = host.rt.botOf(id)
    assert.equal(bot.kickoff, undefined)
    assert.equal(bot.model, 'deepseek/v4-flash')
    assert.equal(bot.permission, 'workspace-write')
    assert.equal(bot.id, id)
  }
  assert.equal(host.selected.length, 5)
  assert.equal(host.prompts.length, 0)
})

test('a posted task reaches only the admin bot; events arrive in the contract shapes', async (t) => {
  const host = await start(t)
  const { botlayer } = host
  const { ids, groupId } = await team(host)
  const [admin, ...others] = ids
  assert.equal(botlayer.groupExists(groupId), true)
  assert.equal(botlayer.groupExists('nope'), false)
  assert.equal(botlayer.isQuiet(groupId), true)

  const lines = []
  const sessionEvents = []
  const toolResults = []
  const rounds = []
  botlayer.onGroupLine(e => lines.push(e))
  botlayer.onSessionEvent(e => sessionEvents.push(e))
  botlayer.onToolResult(e => toolResults.push(e))
  botlayer.onRoundEnd(e => rounds.push(e))

  await botlayer.postTask(groupId, 'Fix the login bug', 'req-1')
  assert.equal(host.prompts.length, 1)
  const prompt = host.prompts[0]
  assert.deepEqual([prompt.requestId, prompt.sessionId, prompt.mode], ['req-1', groupId, 'queue'])
  assert.equal(prompt.content[0].text, 'Fix the login bug')

  // The group's own session takes the message up and relays it, as the DSH would.
  const stop = new AbortController()
  t.after(() => stop.abort())
  host.emit(groupId, 'user/message', { content: prompt.content, source: { kind: 'user' } })
  let relay
  void host.tool('group_relay', {}, groupId, { callId: 'c1', signal: stop.signal }).then((value) => { relay = JSON.parse(value) })
  const adminSession = () => host.rt.roomOf(groupId).sessions?.[admin]
  await settle(() => adminSession() !== undefined && host.agentOf(adminSession()).calls.length === 1)
  assert.equal(botlayer.isQuiet(groupId), false)
  host.begin(adminSession())
  // A tool call and its result, then the final answer.
  host.emit(adminSession(), 'tool/call', { callId: 'k1', name: 'list_bots', arguments: '{}' })
  for (const listener of host.ctx.listeners.get('tools/result') ?? []) {
    listener({ callId: 'k1', name: 'list_bots', arguments: { all: true }, agent: { id: adminSession() } }, { isError: false, content: [{ type: 'text', text: 'five bots' }] })
  }
  host.emit(adminSession(), 'tool/result', { callId: 'k1' })
  host.finish(adminSession(), 'On it, I will plan the work.')
  await settle(() => relay !== undefined)

  // Only the admin was called.
  for (const id of others) {
    assert.equal(host.agentOf(id).calls.length, 0)
    assert.equal(host.rt.roomOf(groupId).sessions?.[id], undefined)
  }
  await settle(() => botlayer.isQuiet(groupId))

  // Group lines: the user's task and the admin's answer.
  assert.deepEqual(lines.map(l => [l.groupId, l.kind, l.botId, l.name, l.text]), [
    [groupId, 'line', null, 'User', 'Fix the login bug'],
    [groupId, 'line', admin, 'Boss', 'On it, I will plan the work.'],
  ])
  assert.ok(lines.every(l => !Number.isNaN(Date.parse(l.at))))

  // Session events keep the DSH type; turn/start and turn/end are forwarded.
  const types = sessionEvents.filter(e => e.sessionId === adminSession()).map(e => e.type)
  assert.ok(types.includes('turn/start') && types.includes('turn/end'))
  const end = sessionEvents.find(e => e.type === 'turn/end')
  assert.deepEqual([end.sessionId, end.botId, end.event.type, end.event.data.reason.kind], [adminSession(), admin, 'turn/end', 'completed'])
  assert.ok(!Number.isNaN(Date.parse(end.at)))

  // Tool result.
  assert.equal(toolResults.length, 1)
  assert.deepEqual({ ...toolResults[0], ms: typeof toolResults[0].ms, at: typeof toolResults[0].at }, {
    sessionId: adminSession(), botId: admin, tool: 'list_bots', args: { all: true }, ok: true, text: 'five bots', ms: 'number', at: 'string',
  })

  // Round end carries the final answer.
  const ended = rounds.find(r => r.sessionId === adminSession())
  assert.deepEqual({ ...ended, at: typeof ended.at }, { sessionId: adminSession(), botId: admin, groupId, text: 'On it, I will plan the work.', failed: false, at: 'string' })
})

test('one id per bot: createBot, events, bindBot, botOfSession, stopBot and deleteBot agree', async (t) => {
  const host = await start(t)
  const { botlayer } = host
  const { ids, groupId } = await team(host)
  const [admin] = ids
  const events = []
  botlayer.onSessionEvent(e => events.push(e))
  const rounds = []
  botlayer.onRoundEnd(e => rounds.push(e))

  // The admin's own chat (session id = bot id) and its group session (another session id).
  host.emit(admin, 'turn/start', { turn: 1 })
  host.emit(admin, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  host.rt.roomOf(groupId).sessions = { [admin]: 'group-session-of-admin' }
  host.rt.groupOwners.set('group-session-of-admin', { botId: admin, roomId: groupId })
  host.emit('group-session-of-admin', 'turn/start', { turn: 1 })
  host.emit('group-session-of-admin', 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } })

  assert.deepEqual(events.map(e => [e.sessionId, e.botId, e.type]), [
    [admin, admin, 'turn/start'], [admin, admin, 'turn/end'],
    ['group-session-of-admin', admin, 'turn/start'], ['group-session-of-admin', admin, 'turn/end'],
  ])
  assert.deepEqual(rounds.map(r => [r.sessionId, r.botId, r.failed]), [[admin, admin, false], ['group-session-of-admin', admin, true]])

  // Binding table.
  assert.equal(botlayer.botOfSession(admin), undefined)
  botlayer.bindBot(admin, { taskId: 'T1', role: 'main' })
  assert.deepEqual(botlayer.botOfSession(admin), { botId: admin, role: 'main', taskId: 'T1' })
  assert.deepEqual(botlayer.botOfSession('group-session-of-admin'), { botId: admin, role: 'main', taskId: 'T1' })
  botlayer.unbindBot(admin)
  assert.equal(botlayer.botOfSession(admin), undefined)

  // The same id is accepted by stopBot and deleteBot.
  await botlayer.stopBot(admin)
  botlayer.bindBot(ids[1], { taskId: 'T1', role: 'slack' })
  await botlayer.deleteBot(ids[1])
  assert.equal(host.rt.botOf(ids[1]), undefined)
  assert.equal(botlayer.botOfSession(ids[1]), undefined)
})

test('askBot sends a request to another bot and the status shows the wait', async (t) => {
  const host = await start(t)
  const { ids } = await team(host)
  await host.botlayer.askBot({ fromSessionId: ids[1], toBotId: ids[2], text: 'Create the issue' })
  const call = host.agentOf(ids[2]).calls.at(-1)
  assert.equal(call.source.role, 'request')
  assert.equal(call.source.senderSessionId, ids[1])
  assert.match(call.content[0].text, /Create the issue/)
  const status = host.botlayer.status()
  assert.deepEqual(Object.keys(status).sort(), ['activity', 'rooms', 'waiting', 'work'])
})

test('stopGroup, deleteGroup and deleteBot leave nothing in the state file', async (t) => {
  const host = await start(t)
  const { botlayer } = host
  const { ids, groupId } = await team(host)
  await botlayer.stopGroup(groupId)
  await botlayer.deleteGroup(groupId)
  assert.equal(botlayer.groupExists(groupId), false)
  for (const id of ids) await botlayer.deleteBot(id)
  const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
  assert.deepEqual([saved.bots, saved.rooms, saved.mainBotIds], [{}, {}, []])
})

test('setGroupWorkDir sets the group folder', async (t) => {
  const host = await start(t)
  const { groupId } = await team(host)
  const dir = mkdtempSync(join(tmpdir(), 'chat-to-fix-wd-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await host.botlayer.setGroupWorkDir(groupId, dir)
  assert.ok(host.rt.roomOf(groupId).workDir)
})
