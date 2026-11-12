import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/task/store.ts'
import { createRecorder } from '../src/task/recorder.ts'
import { createFakeBotLayer } from './helpers/fake-botlayer.ts'

const ORIGIN = { eventId: 'E1', channel: 'C1', threadTs: '1.1', messageTs: '1.1', user: { id: 'U1', name: 'tester' }, text: 'broken' }
const BINDING = { repo: 'g/p', defaultBranch: 'master', jiraProject: 'DEMO', issueType: 'Bug', labels: [] }
const AT = '2026-11-12T02:00:00Z'

// A task with a running run: five bots bound in the fake layer, the group known to the store.
async function rig({ step = 'fetch' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-rec-'))
  const warnings = []
  const store = createStore({ dataDir: dir, warn: () => {} })
  const botlayer = createFakeBotLayer()
  const task = await store.createTask(ORIGIN, BINDING)
  const bots = {}
  for (const role of ['main', 'slack', 'jira', 'pipeline', 'coding']) {
    bots[role] = await botlayer.createBot({ name: role, label: role, instructions: 'i', model: 'm', permission: 'p' })
    botlayer.bindBot(bots[role], { taskId: task.id, role })
  }
  const groupId = await botlayer.createGroup({ name: 'g', memberIds: Object.values(bots), adminId: bots.main, notice: 'n' })
  await store.startRun(task.id, { groupId, bots })
  await store.patchTask(task.id, { step })
  const recorder = createRecorder({ store, botlayer, warn: (...a) => warnings.push(a) })
  recorder.start()
  return { store, botlayer, recorder, bots, groupId, id: task.id, warnings }
}

const entries = async (r) => { await r.recorder.flush(); return r.store.readRecords(r.id) }

test('a group line and a group notice become line and notice entries', async () => {
  const r = await rig()
  r.botlayer.emit.groupLine({ groupId: r.groupId, kind: 'line', botId: r.bots.main, name: 'Main', text: 'hello team', at: AT })
  r.botlayer.emit.groupLine({ groupId: r.groupId, kind: 'notice', botId: null, name: 'system', text: 'paused after repeated idle relays', at: AT })
  const [line, notice] = await entries(r)
  assert.deepEqual({ type: line.type, role: line.role, botId: line.botId, text: line.text, run: line.run, step: line.step, at: line.at },
    { type: 'line', role: 'main', botId: r.bots.main, text: 'hello team', run: 1, step: 'fetch', at: AT })
  assert.equal(notice.type, 'notice')
  assert.equal(notice.role, null)
  assert.equal(notice.text, 'paused after repeated idle relays')
})

test('a tool/call session event becomes a tool_call entry; other session events write nothing', async () => {
  const r = await rig()
  r.botlayer.emit.sessionEvent({ sessionId: r.bots.jira, botId: r.bots.jira, type: 'tool/call', event: { type: 'tool/call', data: { callId: 'c1', name: 'jira_create_issue', arguments: '{"summary":"x"}' } }, at: AT })
  r.botlayer.emit.sessionEvent({ sessionId: r.bots.jira, botId: r.bots.jira, type: 'turn/start', event: { type: 'turn/start', data: {} }, at: AT })
  const list = await entries(r)
  assert.equal(list.length, 1)
  assert.equal(list[0].type, 'tool_call')
  assert.equal(list[0].tool, 'jira_create_issue')
  assert.equal(list[0].role, 'jira')
  assert.match(list[0].text, /jira_create_issue .*summary/)
})

test('a tool result becomes a tool_result entry with ok and ms', async () => {
  const r = await rig()
  r.botlayer.emit.toolResult({ sessionId: r.bots.jira, botId: r.bots.jira, tool: 'jira_create_issue', args: {}, ok: true, text: 'DEMO-7', ms: 840, at: AT })
  r.botlayer.emit.toolResult({ sessionId: r.bots.slack, botId: r.bots.slack, tool: 'slack_reply', args: {}, ok: false, text: 'refused', ms: 3, at: AT })
  const [a, b] = await entries(r)
  assert.deepEqual({ type: a.type, tool: a.tool, ok: a.ok, ms: a.ms, text: a.text, role: a.role, botId: a.botId }, { type: 'tool_result', tool: 'jira_create_issue', ok: true, ms: 840, text: 'DEMO-7', role: 'jira', botId: r.bots.jira })
  assert.equal(b.ok, false)
  assert.equal(b.role, 'slack')
})

test('a round end of the role in charge writes round_end and stepResults; the last round counts', async () => {
  const r = await rig({ step: 'fetch' })
  r.botlayer.emit.roundEnd({ sessionId: r.bots.slack, botId: r.bots.slack, groupId: r.groupId, text: 'first answer', failed: false, at: AT })
  r.botlayer.emit.roundEnd({ sessionId: r.bots.slack, botId: r.bots.slack, groupId: r.groupId, text: 'Summary of the thread', failed: false, at: '2026-11-12T02:05:00Z' })
  const list = await entries(r)
  assert.deepEqual(list.map((e) => e.type), ['round_end', 'round_end'])
  assert.equal(list[1].text, 'Summary of the thread')
  const task = await r.store.getTask(r.id)
  assert.deepEqual(task.stepResults, { fetch: { slack: { text: 'Summary of the thread', at: '2026-11-12T02:05:00Z' } } })
})

test('a role that is not in charge of the step only gets a round_end entry', async () => {
  const r = await rig({ step: 'code' })
  // The Pipeline bot answering request_code in step `code`: spec 2, 4.2.
  r.botlayer.emit.roundEnd({ sessionId: r.bots.pipeline, botId: r.bots.pipeline, groupId: r.groupId, text: 'handed over', failed: false, at: AT })
  const list = await entries(r)
  assert.equal(list.length, 1)
  assert.equal(list[0].type, 'round_end')
  assert.equal(list[0].step, 'code')
  assert.deepEqual((await r.store.getTask(r.id)).stepResults, {})
  // The role in charge does write it.
  r.botlayer.emit.roundEnd({ sessionId: r.bots.coding, botId: r.bots.coding, groupId: null, text: 'changed 2 files', failed: false, at: AT })
  await r.recorder.flush()
  assert.deepEqual((await r.store.getTask(r.id)).stepResults, { code: { coding: { text: 'changed 2 files', at: AT } } })
})

test('a failed or empty round is recorded but is not a step result', async () => {
  const r = await rig({ step: 'fetch' })
  r.botlayer.emit.roundEnd({ sessionId: r.bots.slack, botId: r.bots.slack, groupId: r.groupId, text: 'timed out', failed: true, at: AT })
  r.botlayer.emit.roundEnd({ sessionId: r.bots.slack, botId: r.bots.slack, groupId: r.groupId, text: '  ', failed: false, at: AT })
  const list = await entries(r)
  assert.equal(list.length, 2)
  assert.equal(list[0].failed, true)
  assert.deepEqual((await r.store.getTask(r.id)).stepResults, {})
})

test('approval events are left to the monitor: the recorder writes nothing for them', async () => {
  const r = await rig()
  r.botlayer.emit.approval({ id: 'a1', sessionId: r.bots.coding, botId: r.bots.coding, tool: 'bash', text: 'rm -rf' })
  assert.deepEqual(await entries(r), [])
  assert.deepEqual(r.botlayer.callsOf('onApproval'), [])
})

test('events that belong to no task are ignored', async () => {
  const r = await rig()
  const stray = await r.botlayer.createBot({ name: 'stray', label: 's', instructions: 'i', model: 'm', permission: 'p' })
  r.botlayer.emit.groupLine({ groupId: 'group-unknown', kind: 'line', botId: null, name: 'u', text: 'hi', at: AT })
  r.botlayer.emit.sessionEvent({ sessionId: stray, botId: stray, type: 'tool/call', event: { data: { name: 'x' } }, at: AT })
  r.botlayer.emit.toolResult({ sessionId: 'nobody', botId: null, tool: 't', args: {}, ok: true, text: 'x', ms: 1, at: AT })
  r.botlayer.emit.roundEnd({ sessionId: stray, botId: stray, groupId: null, text: 'x', failed: false, at: AT })
  assert.deepEqual(await entries(r), [])
  assert.equal(r.warnings.length, 0)
})

test('entries keep the order of the events, and stop() unsubscribes', async () => {
  const r = await rig()
  for (let i = 0; i < 20; i++) r.botlayer.emit.groupLine({ groupId: r.groupId, kind: 'line', botId: null, name: 'u', text: `line ${i}`, at: AT })
  const list = await entries(r)
  assert.deepEqual(list.map((e) => e.text), Array.from({ length: 20 }, (_, i) => `line ${i}`))
  assert.equal(r.botlayer.subscriberCount(), 4)
  r.recorder.stop()
  assert.equal(r.botlayer.subscriberCount(), 0)
  r.botlayer.emit.groupLine({ groupId: r.groupId, kind: 'line', botId: null, name: 'u', text: 'late', at: AT })
  assert.equal((await entries(r)).length, 20)
})

test('a second run of the same task numbers its entries by run', async () => {
  const r = await rig()
  await r.store.endRun(r.id, 'needs_info', 'needs_info')
  const group2 = await r.botlayer.createGroup({ name: 'g2', memberIds: Object.values(r.bots), adminId: r.bots.main, notice: 'n' })
  await r.store.startRun(r.id, { groupId: group2, bots: r.bots })
  r.botlayer.emit.groupLine({ groupId: group2, kind: 'line', botId: r.bots.main, name: 'Main', text: 'again', at: AT })
  const [entry] = await entries(r)
  assert.equal(entry.run, 2)
})
