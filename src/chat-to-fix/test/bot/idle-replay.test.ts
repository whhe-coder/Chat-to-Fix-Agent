// The Coding bot after its Claude Code process was closed for being idle (spec-7 section 4.11):
// the next request starts a new process (the Coding bot's session is not saved: launch.ts says
// resumed: false), the adapter replays the system text and the recent messages, the session stays
// the same bot of the same task, and the task layer (records, usage, step results, task_read)
// still connects. The CLI is the fake of test/fixtures/fake-claude.ts; the idle time is injected
// (runtime idleCloseMs), so a few milliseconds stand for the ten minutes.
//
// Run: node --import ./bot/test/harness-resolve.mjs --test --test-force-exit test/bot/idle-replay.test.ts
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { forwardLoopEvents, startApp } from './host.ts'
import { answerOf, endOf, mountLoop, send, waitForIdle } from './loop.ts'

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url))
const CLI = { command: process.execPath, args: [FAKE] }
const IDLE_MS = 120

const rig = async (t, runtime = {}) => {
  const app = await startApp(t, { cli: CLI, runtime: { testCommands: ['sh test.sh'], engineMaxTurns: 40, idleCloseMs: IDLE_MS, ...runtime } })
  const { bots, task } = await app.post()
  const adapter = await app.host.localAdapter()
  return { ...app, bots, task, adapter }
}

const until = async (check, what, ms = 5000) => {
  const limit = Date.now() + ms
  while (!(await check()) && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(await check(), what)
}
// The adapter drops the live session when the idle timer fires: the CLI process is gone with it.
const closed = (adapter, sessionId) => until(() => !adapter.live.has(sessionId), 'the idle close did not happen')
const seenOf = text => JSON.parse(text.slice(text.indexOf('seen:') + 'seen:'.length))
const lastAnswer = agent => answerOf(agent).split('\n').filter(line => line.startsWith('seen:')).at(-1)!
const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1]
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

test('after an idle close the next request starts a new process with the replay window, on the same bot', async (t) => {
  const { host, app, bots, task, adapter } = await rig(t)
  const { ctx, agent, close } = await mountLoop(host, adapter, bots.coding)
  t.after(forwardLoopEvents(host, ctx))
  t.after(close)

  send(agent, 'alpha: first request')
  await waitForIdle(ctx, agent)
  send(agent, '[prompt] beta: second request')
  await waitForIdle(ctx, agent)
  const before = seenOf(lastAnswer(agent))
  // Within one process only what is new is sent: no replay.
  assert.doesNotMatch(before.text, /The conversation so far/)
  assert.match(before.text, /beta: second request/)
  assert.doesNotMatch(before.text, /alpha/)
  const recordBefore = { ...host.rt.state.localAgents.sessions[bots.coding] }
  assert.ok(recordBefore.cliSessionId)

  // The idle timer closes the process; the record of the session stays.
  await closed(adapter, bots.coding)
  await until(() => !alive(before.pid), 'the CLI process was not closed')
  assert.equal(host.rt.state.localAgents.sessions[bots.coding].cliSessionId, recordBefore.cliSessionId)

  send(agent, '[prompt] gamma: after the pause')
  await waitForIdle(ctx, agent)
  assert.equal(endOf(agent), 'completed')
  const after = seenOf(lastAnswer(agent))
  assert.notEqual(after.pid, before.pid, 'a new process')
  assert.notEqual(after.sessionId, before.sessionId)
  // The new process has the same settled arguments (system text in the spawn arguments, our MCP
  // server, no resume: the Coding bot's session is not saved).
  assert.equal(after.argv.includes('--resume'), false)
  assert.ok(after.argv.includes('--no-session-persistence') && after.argv.includes('--agents'))
  assert.equal(valueOf(after.argv, '--tools'), valueOf(before.argv, '--tools'))
  assert.equal(valueOf(after.argv, '--append-system-prompt'), valueOf(before.argv, '--append-system-prompt'))
  assert.match(valueOf(after.argv, '--append-system-prompt'), /test commands: `sh test\.sh`/)
  assert.deepEqual(Object.keys(JSON.parse(valueOf(after.argv, '--mcp-config')).mcpServers), ['chat-to-fix'])
  // The replay: the team instructions, then the conversation oldest first, newest input last.
  assert.match(after.text, /^The team instructions for this conversation:/)
  assert.match(after.text, /The conversation so far \(oldest first\):/)
  const at = word => after.text.indexOf(word)
  assert.ok(at('alpha: first request') !== -1 && at('beta: second request') > at('alpha: first request') && at('gamma: after the pause') > at('beta: second request'), after.text)
  assert.match(after.text, /\n\nYou: ok: /, 'the earlier answers are in it')
  assert.match(after.text, /\n\nYou: seen:/, 'including the answer of the previous process')
  assert.equal(after.text.indexOf('gamma: after the pause'), after.text.lastIndexOf('gamma: after the pause'), 'the latest input once')

  // Still the Coding bot of the task: same session, same binding, the record carries on.
  assert.deepEqual(host.botlayer.botOfSession(bots.coding), { botId: bots.coding, role: 'coding', taskId: task.id })
  const record = host.rt.state.localAgents.sessions[bots.coding]
  assert.equal(record.cliSessionId, after.sessionId, 'the record names the new CLI session')
  assert.ok(record.handedId)
  // The delta after the replay is incremental again: the next request in the same process sends only itself.
  send(agent, '[prompt] delta: right after')
  await waitForIdle(ctx, agent)
  const next = seenOf(lastAnswer(agent))
  assert.equal(next.pid, after.pid)
  assert.doesNotMatch(next.text, /The conversation so far|alpha/)
  assert.match(next.text, /delta: right after/)

  // The task layer's records connect to the one Coding bot of the task over the restart.
  await until(async () => (await app.store.readRecords(task.id)).filter(entry => entry.type === 'round_end').length >= 4, 'round ends')
  const records = await app.store.readRecords(task.id)
  const rounds = records.filter(entry => entry.type === 'round_end')
  assert.ok(rounds.length >= 4, `round ends: ${rounds.length}`)
  assert.ok(rounds.every(entry => entry.role === 'coding' && entry.botId === bots.coding), 'every round end is the Coding bot\'s')
  // The rounds of the restarted process are in the record (the answers name the process that gave them).
  const pids = rounds.map(entry => /"pid":(\d+)/.exec(entry.text)?.[1]).filter(Boolean).map(Number)
  assert.deepEqual(pids, [before.pid, after.pid, after.pid])
  assert.ok(rounds.every(entry => entry.run === 1), 'one run')
})

test('the replay window is the system text, the latest input and at most REPLAY_MESSAGES recent messages within REPLAY_BYTES', async (t) => {
  const { bots, adapter } = await rig(t)
  const sessionId = bots.coding
  const message = (n, role, text, extra = {}) => ({ id: `m${n}`, role, content: [{ type: 'text', text }], source: { kind: 'user' }, ...extra })
  const system = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are the Coding bot.' }] }
  const options = (messages) => ({ provider: 'claude-code', model: 'default', sessionId, tools: [], signal: AbortSignal.timeout(30_000), messages })
  const run = async (messages) => {
    let text = ''
    for await (const chunk of adapter.stream(options(messages))) if (chunk.type === 'text-delta') text += chunk.text
    return seenOf(text)
  }
  // 30 short messages (ending in the marker): only the latest 12 reach the new process, with the system text.
  const history = [system]
  for (let n = 1; n <= 29; n++) history.push(message(n, n % 2 === 0 ? 'assistant' : 'user', `note-${n}`))
  history.push(message(30, 'user', '[prompt] note-30'))
  const first = await run(history)
  assert.match(first.text, /^The team instructions for this conversation:\nYou are the Coding bot\./)
  assert.equal([...first.text.matchAll(/note-\d+/g)].length, 12)
  assert.match(first.text, /note-19[\s\S]*note-30/)
  assert.doesNotMatch(first.text, /note-18/)

  await closed(adapter, sessionId)
  // After the idle close the same window applies (12 messages, the latest input kept).
  history.push(message(31, 'assistant', 'note-31'), message(32, 'user', '[prompt] note-32'))
  const second = await run(history)
  assert.notEqual(second.pid, first.pid)
  assert.equal([...second.text.matchAll(/note-\d+/g)].length, 12)
  assert.match(second.text, /note-21[\s\S]*note-32/)
  assert.doesNotMatch(second.text, /note-20/)
  assert.match(second.text, /You: note-31/)

  // The byte limit: long messages (each clipped to 2000 characters in the replay) fill the 24 KB before 12 do,
  // and the latest input is always kept.
  await closed(adapter, sessionId)
  const long = [system]
  for (let n = 1; n <= 20; n++) long.push(message(n, n % 2 === 0 ? 'assistant' : 'user', `big-${n} ${'x'.repeat(5000)}`))
  long.push(message(21, 'user', '[prompt] latest-input'))
  const third = await run(long)
  const bigs = [...third.text.matchAll(/big-(\d+) /g)].map(match => Number(match[1]))
  assert.ok(bigs.length >= 10 && bigs.length < 12, `big messages in the replay: ${bigs.length}`)
  assert.equal(bigs.at(-1), 20)
  assert.match(third.text, /latest-input/)
  assert.ok(third.text.length < 30 * 1024, `replay size ${third.text.length}`)
})

test('the CLI usage of the turn after an idle close is still reported and billed to the Coding bot of the task', async (t) => {
  const { host, app, bots, task, adapter } = await rig(t)
  const usage = []
  host.botlayer.onUsage(e => usage.push(e))
  const { ctx, agent, close } = await mountLoop(host, adapter, bots.coding)
  t.after(forwardLoopEvents(host, ctx))
  t.after(close)
  send(agent, 'one')
  await waitForIdle(ctx, agent)
  await closed(adapter, bots.coding)
  send(agent, 'two')
  await waitForIdle(ctx, agent)
  await closed(adapter, bots.coding)
  send(agent, 'three')
  await waitForIdle(ctx, agent)
  await until(() => usage.length >= 3, `usage events: ${usage.length}`)
  assert.equal(usage.length, 3)
  for (const event of usage) {
    assert.equal(event.sessionId, bots.coding)
    assert.equal(event.botId, bots.coding)
    assert.equal(event.source, 'cli')
    assert.equal(event.model, 'fake-model')
    assert.equal(event.costUsd, 0.01)
    assert.deepEqual([event.input, event.output, event.cacheRead, event.cacheWrite], [10, 5, 3, 7])
  }
  // And in the task: a usage record per turn, all by the Coding bot, summed in task.usage.
  await until(async () => (await app.store.readRecords(task.id)).filter(entry => entry.type === 'usage').length >= 3, 'usage records')
  const records = (await app.store.readRecords(task.id)).filter(entry => entry.type === 'usage')
  assert.equal(records.length, 3)
  assert.ok(records.every(entry => entry.role === 'coding' && entry.botId === bots.coding && entry.costSource === 'cli'))
  await until(async () => ((await app.store.getTask(task.id)).usage?.calls ?? 0) >= 3, 'task usage')
  const total = (await app.store.getTask(task.id)).usage
  assert.equal(total.byRole.coding.calls, 3)
  assert.equal(Object.keys(total.byRole).join(), 'coding')
  assert.ok(Math.abs(total.totalUsd - 0.03) < 1e-9 && total.cacheWrite === 21 && total.output === 15, JSON.stringify(total))
})

test('a bridged role tool called by the restarted process is attributed to the Coding bot, and task_read gives the whole task view', async (t) => {
  const { host, app, bots, task, adapter } = await rig(t)
  const { ctx, agent, close } = await mountLoop(host, adapter, bots.coding)
  t.after(forwardLoopEvents(host, ctx))
  t.after(close)
  send(agent, 'before the pause')
  await waitForIdle(ctx, agent)
  await closed(adapter, bots.coding)

  // While the process is away the task moves on: the view must come from the task, not from a replay.
  await app.store.patchTask(task.id, {
    step: 'code',
    stepResults: { issue: { jira: { text: 'DEMO-1 created', at: '2026-01-01T00:00:00Z' } } },
    jira: { key: 'DEMO-1', url: 'http://jira.test/browse/DEMO-1' },
    repo: { dir: '/work/demo', branch: 'fix/demo-1' },
  })
  send(agent, '[mcp:task_read]')
  await waitForIdle(ctx, agent)
  assert.equal(endOf(agent), 'completed')
  const view = JSON.parse(answerOf(agent).split('tool said: ').at(-1)!)
  assert.equal(view.id, task.id)
  assert.equal(view.step, 'code')
  assert.equal(view.state, 'running')
  assert.equal(view.jira.key, 'DEMO-1')
  assert.deepEqual(view.repo, { dir: '/work/demo', branch: 'fix/demo-1' })
  assert.equal(view.stepResults.issue.jira.text, 'DEMO-1 created')
  assert.ok(view.origin.text, 'the Slack message is there')
  assert.ok('review' in view && 'mr' in view && 'needsInfo' in view)

  // A write tool after a second pause: the registry's wrapper still knows the bot, the step and the task.
  await closed(adapter, bots.coding)
  send(agent, '[mcp:review_report {"verdict":"pass","comments":"fine","rounds":1}]')
  await waitForIdle(ctx, agent)
  assert.match(answerOf(agent), /Recorded: review pass/)
  assert.equal((await app.store.getTask(task.id)).review.verdict, 'pass')
  await until(async () => (await app.store.readRecords(task.id)).some(entry => entry.type === 'tool_result' && entry.tool === 'review_report'), 'tool result record')
  const records = await app.store.readRecords(task.id)
  const calls = records.filter(entry => entry.tool === 'task_read' || entry.tool === 'review_report')
  assert.deepEqual(calls.map(entry => `${entry.type}:${entry.tool}`), ['tool_call:task_read', 'tool_result:task_read', 'tool_call:review_report', 'tool_result:review_report'])
  assert.ok(calls.every(entry => entry.role === 'coding' && entry.botId === bots.coding))
})

// ---------------------------------------------------------------------------
// A turn in flight is not idle. The idle timer counts from the last output of the CLI; a turn that is
// silent for longer than the idle time (a long test run) or that waits on a bridged tool call must not lose its process.
const direct = (adapter, sessionId, messages, extra: any = {}) => adapter.stream({
  provider: 'claude-code', model: 'default', sessionId, signal: AbortSignal.timeout(30_000), tools: [], ...extra, messages,
})
const collect = async (stream) => {
  const out = { text: '', calls: [] as any[], finish: undefined as any }
  for await (const chunk of stream as any) {
    if (chunk.type === 'text-delta') out.text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') out.calls.push(chunk.block)
    else if (chunk.type === 'finish') out.finish = chunk.reason.kind
  }
  return out
}
const msg = (id, role, text, extra = {}) => ({ id, role, content: [{ type: 'text', text }], source: { kind: 'user' }, ...extra })

test('a turn that is silent for longer than the idle time is not closed under the running CLI', async (t) => {
  const { bots, adapter } = await rig(t)
  const controller = new AbortController()
  const turn = collect(direct(adapter, bots.coding, [msg('m1', 'user', '[slow]')], { signal: controller.signal }))
  await new Promise(resolve => setTimeout(resolve, IDLE_MS * 4))
  assert.ok(adapter.live.has(bots.coding), 'the live session is still there while the turn runs')
  controller.abort()
  const result = await turn
  assert.equal(result.finish, 'aborted')
})

test('a turn that waits on a bridged tool call longer than the idle time continues from the replay when the result arrives', async (t) => {
  const { bots, task, adapter } = await rig(t)
  const tools = [{ name: 'task_read', description: 'Read the task', parameters: { type: 'object', properties: {} } }]
  const first = await collect(direct(adapter, bots.coding, [msg('m1', 'user', '[mcp:task_read]')], { tools }))
  assert.equal(first.finish, 'tool-calls')
  assert.deepEqual(first.calls.map(call => call.name), ['task_read'])
  // The tool takes longer than the idle time (a bot-to-bot hand-over, say).
  await new Promise(resolve => setTimeout(resolve, IDLE_MS * 4))
  const toolMessage = { id: 'm3', role: 'tool', toolCallId: first.calls[0].id, content: [{ type: 'text', text: JSON.stringify({ id: task.id, step: 'code' }) }] }
  const assistantMessage = { id: 'm2', role: 'assistant', content: [{ type: 'tool-call', id: first.calls[0].id, name: 'task_read', arguments: '{}' }] }
  const second = await collect(direct(adapter, bots.coding, [msg('m1', 'user', '[mcp:task_read]'), assistantMessage, toolMessage, msg('m4', 'user', '[prompt] go on')], { tools }))
  assert.equal(second.finish, 'stop')
  const seen = seenOf(second.text)
  // Whatever happened to the first process, the one that answers has the tool result in front of it.
  assert.match(seen.text, new RegExp(`Tool result \\(${first.calls[0].id}\\): \\{"id":"${task.id}","step":"code"\\}`))
  assert.match(seen.text, /go on/)
})
