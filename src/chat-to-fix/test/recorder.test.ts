import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../core/task/store.ts'
import { createRecorder } from '../core/task/recorder.ts'
import { createFakeBotLayer } from './helpers/fake-botlayer.ts'

const ORIGIN = { eventId: 'E1', channel: 'C1', threadTs: '1.1', messageTs: '1.1', user: { id: 'U1', name: 'tester' }, text: 'broken' }
const BINDING = { repo: 'g/p', defaultBranch: 'master', jiraProject: 'DEMO', issueType: 'Bug', labels: [] }
const AT = '2026-11-12T02:00:00Z'

// A task with a running run: five bots bound in the fake layer, the group known to the store.
async function rig({ step = 'fetch' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-rec-'))
  const warnings = []
  const store = createStore({ dataDir: dir, warn: () => {} })
  const botlayer: any = createFakeBotLayer()
  const task = await store.createTask(ORIGIN, BINDING)
  const bots: any = {}
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

test('refused and failed engine tool uses in a reasoning block become refusal and tool_error entries', async () => {
  const r = await rig({ step: 'code' })
  const reasoning = [
    '▸ Bash: sh test.sh; echo $?',
    '▸ denied: Bash (Permission for this tool use was denied.) | attempted: sh test.sh; echo $?',
    '▸ tool error: Bash: exit code 1 | attempted: sh test.sh',
    '▸ permission request for Bash timed out: denied | attempted: npm i',
  ].join('\n')
  const message = { content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text: '▸ denied: in the answer text, not a record' }] }
  r.botlayer.emit.sessionEvent({ sessionId: r.bots.coding, botId: r.bots.coding, type: 'assistant/message', event: { type: 'assistant/message', data: { message } }, at: AT })
  r.botlayer.emit.sessionEvent({ sessionId: r.bots.main, botId: r.bots.main, type: 'assistant/message', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'plain answer' }] } } }, at: AT })
  const list = await entries(r)
  assert.deepEqual(list.map((e) => [e.type, e.role, e.step]), [['refusal', 'coding', 'code'], ['tool_error', 'coding', 'code'], ['refusal', 'coding', 'code']])
  assert.match(list[0].text, /^▸ denied: Bash .* attempted: sh test\.sh; echo \$\?$/)
  assert.match(list[2].text, /timed out/)
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
  assert.equal(r.botlayer.subscriberCount(), 5)
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

// ---- token billing: usage events become usage records and the task's running summary

const dshCall = (r, role, over = {}) => ({
  sessionId: r.bots[role], botId: r.bots[role], source: 'dsh', model: 'claude-sonnet-5-5', input: 4, output: 53, cacheRead: 0, cacheWrite: 9047,
  costUsd: null, durationMs: 1000, ttftMs: 700, outputTps: 53, tpsBasis: 'dsh-decode', at: AT, ...over,
})

test('an API bot call becomes a usage record priced from the table, and counts in task.usage', async () => {
  const r = await rig()
  r.botlayer.emit.usage(dshCall(r, 'jira'))
  r.botlayer.emit.usage(dshCall(r, 'jira', { output: 100, cacheRead: 9047, cacheWrite: 0, input: 2, durationMs: 2000, outputTps: 50 }))
  const [one, two] = await entries(r)
  assert.equal(one.type, 'usage')
  assert.deepEqual({ role: one.role, botId: one.botId, run: one.run, step: one.step, source: one.source, model: one.model }, { role: 'jira', botId: r.bots.jira, run: 1, step: 'fetch', source: 'dsh', model: 'claude-sonnet-5-5' })
  assert.deepEqual([one.input, one.output, one.cacheRead, one.cacheWrite], [4, 53, 0, 9047])
  assert.equal(one.costUsd, Number(((4 * 2 + 53 * 10 + 9047 * 2.5) / 1e6).toFixed(8)))
  assert.deepEqual([one.costSource, one.unpriced, one.durationMs, one.ttftMs, one.outputTps, one.tpsBasis], ['table', false, 1000, 700, 53, 'dsh-decode'])
  assert.match(one.text, /^usage claude-sonnet-5-5: in 4, out 53, cache read 0, cache write 9\.05k, \$0\.0/)
  const usage = (await r.store.getTask(r.id)).usage
  assert.equal(usage.calls, 2)
  assert.equal(usage.totalUsd, Number((one.costUsd + two.costUsd).toFixed(8)))
  assert.equal(usage.byRole.jira.output, 153)
  assert.equal(usage.byRole.jira.outputTps, 51, '153 tokens / 3 s')
  assert.equal(usage.byRun['1'].calls, 2)
  assert.deepEqual(Object.keys(usage.byRole), ['jira'])
})

test('a Coding bot turn: one record per model with the CLI cost, the reviewer model apart', async () => {
  const r = await rig({ step: 'code' })
  const turn = { sessionId: r.bots.coding, botId: r.bots.coding, source: 'cli', effort: 'high', at: AT, durationMs: 20_000, tpsBasis: 'cli-api' }
  r.botlayer.emit.usage({ ...turn, model: 'claude-sonnet-5-5', input: 28, output: 3915, cacheRead: 248_280, cacheWrite: 26_070, costUsd: 0.2143, outputTps: 195.75 })
  r.botlayer.emit.usage({ ...turn, model: 'claude-opus-5-5', input: 5, output: 700, cacheRead: 9000, cacheWrite: 0, costUsd: 0.05, durationMs: 4000, outputTps: 175 })
  const list = (await entries(r)).filter((e) => e.type === 'usage')
  assert.deepEqual(list.map((e) => [e.role, e.model, e.costUsd, e.costSource, e.effort, e.source]), [
    ['coding', 'claude-sonnet-5-5', 0.2143, 'cli', 'high', 'cli'],
    ['coding', 'claude-opus-5-5', 0.05, 'cli', 'high', 'cli'],
  ])
  const usage = (await r.store.getTask(r.id)).usage
  assert.equal(usage.byRole.coding.usd, 0.2643)
  assert.deepEqual(usage.byRole.coding.models, ['claude-sonnet-5-5', 'claude-opus-5-5'])
  assert.deepEqual(usage.byModel['claude-opus-5-5'].last, { model: 'claude-opus-5-5', outputTps: 175, tpsBasis: 'cli-api', effort: 'high' })
})

test('a CLI turn without a cost falls back to the table; an unknown model is unpriced', async () => {
  const r = await rig({ step: 'code' })
  r.botlayer.emit.usage({ sessionId: r.bots.coding, botId: r.bots.coding, source: 'cli', model: 'claude-sonnet-5-5', input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, durationMs: 0, outputTps: null, tpsBasis: null, at: AT })
  r.botlayer.emit.usage(dshCall(r, 'main', { model: 'mystery-1' }))
  const [a, b] = await entries(r)
  assert.deepEqual([a.costUsd, a.costSource, a.unpriced], [2, 'table', false])
  assert.deepEqual([b.costUsd, b.costSource, b.unpriced], [null, null, true])
  assert.match(b.text, /unpriced/)
  const usage = (await r.store.getTask(r.id)).usage
  assert.equal(usage.unpriced, true)
  assert.equal(usage.totalUsd, 2, 'the unpriced call adds no cost')
  assert.equal(usage.byModel['mystery-1'].unpriced, true)
})

test('configured pricing reaches the recorder; usage of a session in no task is ignored; a second run is booked under run 2', async () => {
  const r = await rig()
  const priced = createRecorder({ store: r.store, botlayer: r.botlayer, pricing: { 'claude-sonnet-5-5': { input: 100, output: 0, cacheRead: 0 } }, warn: () => {} })
  r.recorder.stop()
  priced.start()
  r.botlayer.emit.usage({ ...dshCall(r, 'main'), sessionId: 'nobody', botId: 'nobody' })
  r.botlayer.emit.usage(dshCall(r, 'main', { input: 1e6, output: 0, cacheWrite: 0 }))
  await priced.flush()
  assert.equal((await r.store.readRecords(r.id)).filter((e) => e.type === 'usage').length, 1)
  assert.equal((await r.store.readRecords(r.id))[0].costUsd, 100)
  await r.store.endRun(r.id, 'needs_info', 'needs_info')
  await r.store.startRun(r.id, { groupId: r.groupId, bots: r.bots })
  r.botlayer.emit.usage(dshCall(r, 'main', { input: 1e6, output: 0, cacheWrite: 0 }))
  await priced.flush()
  const usage = (await r.store.getTask(r.id)).usage
  assert.deepEqual(Object.keys(usage.byRun).sort(), ['1', '2'])
  assert.equal(usage.totalUsd, 200)
})
