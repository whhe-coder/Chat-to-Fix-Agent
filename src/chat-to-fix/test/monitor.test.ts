import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMonitor, NOTICE_KINDS } from '../core/task/monitor.ts'

const LIMITS = {
  taskMinutes: 80,
  stepMinutes: { fetch: 5, issue: 5, prepare: 10, code: 40, mr: 5, writeback: 5 },
  quietMinutes: 3, quietNudges: 2, engineSilentMinutes: 10, codingMaxSteps: 5,
}
const MIN = 60_000
const T0 = Date.parse('2026-11-12T02:00:00Z')

function setup({ step = 'issue', stepAgoMin = 0, runAgoMin = 0, withSend = true, sendFails = false, language = undefined } = {}) {
  const clock = { t: T0 }
  const iso = (agoMin) => new Date(T0 - agoMin * MIN).toISOString()
  const tasks = new Map([['T-1', {
    id: 'T-1', state: 'running', step, stepAt: iso(stepAgoMin), origin: { channel: 'C1', threadTs: '1.1' },
    jira: { key: 'DEMO-7' }, repo: { branch: 'ai/DEMO-7' },
    runs: [{ no: 1, groupId: 'g1', bots: { main: 'bm', coding: 'bc' }, startedAt: iso(runAgoMin), endedAt: null }],
  }]])
  const records = []
  const store = {
    async getTask(id) { return tasks.get(id) },
    async appendRecord(id, entry) { records.push({ id, ...entry }) },
  }
  const calls = { post: [], stop: [], approval: [], ended: [], sent: [] }
  const handlers = { session: [], round: [], line: [], approval: [], tool: [] }
  const state = { quiet: false }
  const sub = (list) => (fn) => { list.push(fn); return () => list.splice(list.indexOf(fn), 1) }
  const botlayer = {
    async postTask(g, text, rid) { calls.post.push({ g, text, rid }) },
    async stopBot(id) { calls.stop.push(id) },
    isQuiet: () => state.quiet,
    answerApproval(id, choice) { calls.approval.push([id, choice]) },
    onSessionEvent: sub(handlers.session),
    onToolResult: sub(handlers.tool),
    onRoundEnd: sub(handlers.round),
    onGroupLine: sub(handlers.line),
    onApproval: sub(handlers.approval),
    botOfSession: () => undefined,
  }
  const warnings = []
  const monitor = createMonitor({
    store, botlayer, limits: LIMITS, language, now: () => clock.t, warn: (...a) => warnings.push(a),
    end: async (id, st, reason) => { calls.ended.push([id, st, reason]); tasks.get(id).state = st },
    send: withSend ? async (origin, text, kind) => { if (sendFails) throw new Error('slack down'); calls.sent.push({ origin, text, kind }) } : undefined,
  })
  const settle = () => new Promise((r) => setImmediate(r))
  const advance = (min) => { clock.t += min * MIN }
  return { monitor, tasks, records, calls, handlers, state, clock, advance, settle, warnings }
}
const limitRecords = (s) => s.records.filter((r) => r.type === 'limit')
const sessionEvent = (s, type, id = 'bc', data = {}) => s.handlers.session[0]({ sessionId: id, botId: id, type, event: { type, data }, at: '' })
const toolCall = (s, name, id = 'bc') => sessionEvent(s, 'tool/call', id, { name })
const toolResult = (s, tool, id = 'bc') => s.handlers.tool[0]({ sessionId: id, botId: id, tool, ok: true, text: '', ms: 1, at: '' })

test('total task time ends the run as timed_out / task_timeout', async () => {
  const s = setup({ step: 'code', stepAgoMin: 1, runAgoMin: 81 })
  s.monitor.watch('T-1'); await s.settle(); await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [['T-1', 'timed_out', 'task_timeout']])
  assert.equal(limitRecords(s).length, 1)
  assert.equal(limitRecords(s)[0].step, 'code')
})

test('step limit: first a message to the Main bot, then failed / step_timeout after one more limit', async () => {
  const s = setup({ step: 'issue', stepAgoMin: 6 })
  s.monitor.watch('T-1'); await s.monitor.tick()
  assert.equal(s.calls.post.length, 1)
  assert.equal(s.calls.post[0].g, 'g1')
  assert.match(s.calls.post[0].text, /issue/)
  assert.deepEqual(s.calls.ended, [])
  await s.monitor.tick() // no second nudge, no end yet
  assert.equal(s.calls.post.length, 1)
  s.advance(5.1)
  await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [['T-1', 'failed', 'step_timeout']])
  assert.equal(limitRecords(s).length, 2)
})

test('step limit uses the limit of that step (prepare = 10)', async () => {
  const s = setup({ step: 'prepare', stepAgoMin: 6 })
  s.monitor.watch('T-1'); await s.monitor.tick()
  assert.equal(s.calls.post.length, 0)
  s.advance(5)
  await s.monitor.tick()
  assert.equal(s.calls.post.length, 1)
})

test('coding limit stops the Coding bot and ends timed_out / coding_timeout', async () => {
  const s = setup({ step: 'code', stepAgoMin: 41 })
  s.monitor.watch('T-1'); await s.monitor.tick()
  assert.deepEqual(s.calls.stop, ['bc'])
  assert.deepEqual(s.calls.ended, [['T-1', 'timed_out', 'coding_timeout']])
  assert.equal(s.calls.post.length, 0)
})

test('quiet group: two nudges, then failed / stalled', async () => {
  const s = setup({ step: 'code', stepAgoMin: 0 })
  s.state.quiet = true
  s.monitor.watch('T-1'); await s.monitor.tick() // starts counting
  s.advance(3.1); await s.monitor.tick()
  assert.equal(s.calls.post.length, 1)
  s.advance(3.1); await s.monitor.tick()
  assert.equal(s.calls.post.length, 2)
  assert.deepEqual(s.calls.ended, [])
  s.advance(3.1); await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [['T-1', 'failed', 'stalled']])
  assert.equal(s.calls.post.length, 2)
})

test('quiet counting restarts when the group shows activity', async () => {
  const s = setup({ step: 'code' })
  s.state.quiet = true
  s.monitor.watch('T-1'); await s.monitor.tick()
  s.advance(2); s.state.quiet = false; await s.monitor.tick()
  s.advance(2); s.state.quiet = true; await s.monitor.tick()
  s.advance(2); await s.monitor.tick()
  assert.equal(s.calls.post.length, 0)
})

test('idle-relay pause notice ends the task as failed / idle_relay', async () => {
  const s = setup({ step: 'code' })
  s.monitor.watch('T-1'); await s.settle()
  const other = 'Paused: Bots have called each other 6 times since the user last wrote here.'
  s.handlers.line[0]({ groupId: 'g1', kind: 'notice', botId: null, name: 'DS Bot', text: other, at: '' })
  await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [])
  s.handlers.line[0]({ groupId: 'g1', kind: 'notice', botId: null, name: 'DS Bot', text: 'Paused: A and B went back and forth 6 times without progress (no tool used).', at: '' })
  await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [['T-1', 'failed', 'idle_relay']])
})

test('the Coding bot silent: first stop and ask again, second silence ends failed / engine_silent', async () => {
  const s = setup({ step: 'code', stepAgoMin: 1 })
  s.monitor.watch('T-1'); await s.settle()
  sessionEvent(s, 'turn/start')
  s.advance(5)
  sessionEvent(s, 'tool/result') // output resets the clock
  s.advance(9); await s.monitor.tick()
  assert.equal(s.calls.stop.length, 0)
  s.advance(1.5); await s.monitor.tick()
  assert.deepEqual(s.calls.stop, ['bc'])
  assert.equal(s.calls.post.length, 1)
  assert.match(s.calls.post[0].text, /Coding bot/)
  assert.deepEqual(s.calls.ended, [])
  // the Main bot calls the Coding bot again, which goes silent once more
  sessionEvent(s, 'turn/start')
  s.advance(10.5); await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [['T-1', 'failed', 'engine_silent']])
})

test('a test run or a review in flight is not silence; once it returns, the silence counts again', async () => {
  const s = setup({ step: 'code', stepAgoMin: 1 })
  s.monitor.watch('T-1'); await s.settle()
  sessionEvent(s, 'turn/start')
  toolCall(s, 'request_review')
  s.advance(14); await s.monitor.tick()
  assert.equal(s.calls.stop.length, 0, 'the review runs for 14 minutes without an event of the Coding bot')
  toolResult(s, 'request_review')
  s.advance(10.5); await s.monitor.tick()
  assert.deepEqual(s.calls.stop, ['bc'], 'silent after the review returned')
  // another tool does not hold the check off
  sessionEvent(s, 'turn/start')
  toolCall(s, 'read')
  s.advance(10.5); await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [['T-1', 'failed', 'engine_silent']])
})

test('more tool calls in one turn than codingMaxSteps stop the Coding bot and end the task failed / coding_max_steps', async () => {
  const s = setup({ step: 'code', stepAgoMin: 1 })
  s.monitor.watch('T-1'); await s.settle()
  sessionEvent(s, 'turn/start')
  for (let i = 0; i < 5; i++) toolCall(s, 'read')
  await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [], 'five calls are within the limit')
  sessionEvent(s, 'turn/start') // a new turn counts afresh
  for (let i = 0; i < 5; i++) toolCall(s, 'edit')
  await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [])
  toolCall(s, 'edit')
  toolCall(s, 'read', 'bm') // another bot's calls do not count
  await s.monitor.tick()
  assert.deepEqual(s.calls.stop, ['bc'])
  assert.deepEqual(s.calls.ended, [['T-1', 'failed', 'coding_max_steps']])
  assert.match(limitRecords(s).at(-1).text, /coding_max_steps at step code: stopped the Coding bot after 6 tool calls in one turn/)
})

test('a finished turn is not counted as silence; other bots are ignored', async () => {
  const s = setup({ step: 'code', stepAgoMin: 1 })
  s.monitor.watch('T-1'); await s.settle()
  sessionEvent(s, 'turn/start')
  s.handlers.round[0]({ sessionId: 'bc', botId: 'bc', groupId: 'g1', text: 'done', failed: false, at: '' })
  s.advance(15); await s.monitor.tick()
  assert.equal(s.calls.stop.length, 0)
  sessionEvent(s, 'turn/start', 'bm') // the Main bot
  s.advance(15); await s.monitor.tick()
  assert.equal(s.calls.stop.length, 0)
})

test('approval is rejected and written as one approval entry', async () => {
  const s = setup()
  s.monitor.watch('T-1'); await s.settle()
  s.handlers.approval[0]({ id: 'ap1', sessionId: 'bc', botId: 'bc', tool: 'bash', text: 'rm -rf /' })
  await s.settle()
  assert.deepEqual(s.calls.approval, [['ap1', 'reject']])
  const rec = s.records.filter((r) => r.type === 'approval')
  assert.equal(rec.length, 1)
  assert.match(rec[0].text, /rm -rf/)
  // an approval from a bot that is not ours is left alone
  s.handlers.approval[0]({ id: 'ap2', sessionId: 'zz', botId: 'zz', tool: 'bash', text: 'x' })
  assert.equal(s.calls.approval.length, 1)
})

test('restart: step limits count from now', async () => {
  const s = setup({ step: 'issue', stepAgoMin: 30, runAgoMin: 40 })
  s.monitor.watch('T-1', { restarted: true }); await s.monitor.tick()
  assert.equal(s.calls.post.length, 0) // entered 30 min ago, but counts from the restart
  s.advance(5.1); await s.monitor.tick()
  assert.equal(s.calls.post.length, 1)
  assert.deepEqual(s.calls.ended, [])
})

test('restart: total time is still counted from the start of the run', async () => {
  const s = setup({ step: 'issue', stepAgoMin: 30, runAgoMin: 79 })
  s.monitor.watch('T-1', { restarted: true }); await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [])
  s.advance(1.5); await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [['T-1', 'timed_out', 'task_timeout']])
})

test('a task is ended only once, also when passes overlap or repeat', async () => {
  const s = setup({ step: 'code', stepAgoMin: 1, runAgoMin: 90 })
  s.monitor.watch('T-1'); await s.settle()
  await Promise.all([s.monitor.tick(), s.monitor.tick()])
  await s.monitor.tick()
  assert.equal(s.calls.ended.length, 1)
  assert.equal(limitRecords(s).length, 1)
})

test('a failing task does not stop the pass over the others', async () => {
  const s = setup({ step: 'code', stepAgoMin: 1, runAgoMin: 90 })
  s.tasks.set('T-2', { ...s.tasks.get('T-1'), id: 'T-2' })
  const ended = []
  const m = createMonitor({
    store: { getTask: async (id) => { if (id === 'T-1') throw new Error('disk'); return s.tasks.get(id) }, appendRecord: async () => {} },
    botlayer: { isQuiet: () => false, postTask: async () => {}, stopBot: async () => {}, answerApproval() {}, onSessionEvent: () => () => {}, onRoundEnd: () => () => {}, onGroupLine: () => () => {}, onApproval: () => () => {} } as any,
    limits: LIMITS, now: () => s.clock.t, warn: (...a) => s.warnings.push(a),
    end: async (id) => { ended.push(id) },
  } as any)
  m.watch('T-1'); m.watch('T-2'); await s.settle(); await m.tick()
  assert.deepEqual(ended, ['T-2'])
  assert.ok(s.warnings.length > 0)
})

test('notify: the notice kinds carry the task id, Jira key and branch', async () => {
  const s = setup()
  const task = { id: 'T-1', origin: { channel: 'C1' }, jira: { key: 'DEMO-7' }, repo: { branch: 'ai/DEMO-7' } }
  assert.deepEqual([...NOTICE_KINDS].sort(), ['channel_not_bound', 'ci_fix_pushed', 'expired', 'failed', 'in_progress', 'interrupted', 'jira_created', 'mr_opened', 'needs_info_resubmit', 'no_open_task', 'queue_full', 'resumed', 'stopped', 'timed_out'])
  for (const kind of ['in_progress', 'timed_out', 'failed', 'expired', 'stopped']) {
    s.calls.sent.length = 0
    await s.monitor.notify(task, kind)
    assert.equal(s.calls.sent.length, 1, kind)
    assert.equal(s.calls.sent[0].kind, kind) // the kind goes on to the adapter (the outbox keeps it)
    assert.match(s.calls.sent[0].text, /T-1/, kind)
    assert.match(s.calls.sent[0].text, /DEMO-7/, kind)
    assert.match(s.calls.sent[0].text, /ai\/DEMO-7/, kind)
    assert.deepEqual(s.calls.sent[0].origin, { channel: 'C1' })
  }
  for (const kind of ['queue_full', 'channel_not_bound']) {
    s.calls.sent.length = 0
    await s.monitor.notify({ id: null, origin: { channel: 'C9' } }, kind)
    assert.equal(s.calls.sent.length, 1)
    assert.deepEqual(s.calls.sent[0].origin, { channel: 'C9' })
  }
  assert.equal(s.records.filter((r) => r.type === 'system').length, 5)
})

test('notify in English: failed and resumed texts are the fixed templates', async () => {
  const s = setup({ language: 'en' })
  await s.monitor.notify({ id: 'T-1', origin: {}, jira: { key: 'DEMO-7' }, repo: null, state: 'failed', endReason: 'repo is gone', closeNote: 'repo is gone' }, 'failed')
  assert.equal(s.calls.sent[0].text, 'Task T-1 could not be completed (repo is gone). Jira: DEMO-7.')
  await s.monitor.notify({ id: 'T-1', origin: {}, jira: null, repo: null }, 'resumed')
  assert.equal(s.calls.sent[1].text, 'Got the extra information; task T-1 is queued again.')
})

test('notify in Chinese (language zh): failed with note, needs_person with note and MR, resumed, the rest', async () => {
  const s = setup({ language: 'zh' })
  const base = { id: 'T-1', origin: { channel: 'C1' }, jira: { key: 'DEMO-7' }, repo: { branch: 'ai/DEMO-7' } }
  const sent = async (task, kind) => { s.calls.sent.length = 0; await s.monitor.notify(task, kind); return s.calls.sent[0].text }
  assert.equal(
    await sent({ ...base, state: 'failed', endReason: '评审没通过', closeNote: '评审没通过' }, 'failed'),
    '任务 T-1 没能自动修好：评审没通过。Jira：DEMO-7，分支：ai/DEMO-7。补充信息后可以用 /fix 重新提交。',
  )
  const person = await sent({ ...base, state: 'failed', endReason: 'needs_person', closeNote: '改动太大，不适合自动提交。', mr: { url: 'https://gl/mr/1' } }, 'failed')
  assert.equal(person, '任务 T-1 需要人来处理：改动太大，不适合自动提交。Jira：DEMO-7，分支：ai/DEMO-7，Draft MR：https://gl/mr/1。')
  assert.doesNotMatch(person, /@ 我/)
  assert.equal(s.calls.sent[0].kind, 'needs_person', 'the Slack side gets "needs a person" as its own kind')
  assert.equal(await sent({ id: 'T-1', origin: {}, jira: null, repo: null, state: 'failed', endReason: 'needs_person' }, 'failed'), '任务 T-1 需要人来处理。')
  assert.equal(await sent({ id: 'T-1', origin: {}, jira: null, repo: null }, 'resumed'), '收到补充信息，任务 T-1 重新开始处理。')
  assert.equal(await sent({ ...base, endReason: 'task_timeout' }, 'timed_out'), '任务 T-1 超时了（任务总时长超限），已结束。Jira：DEMO-7，分支：ai/DEMO-7。')
  assert.equal(await sent({ id: 'T-1', origin: {}, jira: null, repo: null }, 'stopped'), '任务 T-1 已停止。')
  assert.match(await sent({ id: 'T-1', origin: {}, jira: null, repo: null }, 'expired'), /^任务 T-1 在队列里等太久，已过期。想继续的话，请用 \/fix 重新提交。/)
  assert.equal(await sent({ id: null, origin: {} }, 'no_open_task'), '这个讨论串里没有在处理的任务，新问题请用 /fix 提交。')
  assert.match(await sent({ id: 'T-1', origin: {}, jira: null, repo: null }, 'in_progress'), /^任务 T-1 已经在处理这个讨论了。/)
  assert.equal(await sent({ id: null, origin: {} }, 'queue_full'), '修复队列已满，这次请求没有接收，请稍后再试。')
  assert.equal(await sent({ id: null, origin: {} }, 'channel_not_bound'), '这个频道还没有接入 Chat-to-Fix，这次请求没有接收。')
})

test('notify without a Jira key leaves it out; without send only the record is written; a failing send does not throw', async () => {
  const s = setup({ withSend: false })
  await s.monitor.notify({ id: 'T-1', origin: {}, jira: null, repo: null }, 'stopped')
  assert.equal(s.records.length, 1)
  assert.doesNotMatch(s.records[0].text, /Jira/)
  const f = setup({ sendFails: true })
  await f.monitor.notify({ id: 'T-1', origin: {}, jira: null, repo: null }, 'failed')
  assert.ok(f.warnings.length > 0)
})

test('stop() drops the subscriptions', async () => {
  const s = setup()
  s.monitor.watch('T-1'); await s.settle()
  assert.equal(s.handlers.session.length, 1)
  s.monitor.stop()
  for (const list of Object.values(s.handlers)) assert.equal(list.length, 0)
})

test('notify: the progress and resubmit notices, texts in Chinese and English', async () => {
  const task = { id: 'T-1', origin: { channel: 'C1' }, jira: { key: 'DEMO-7', url: 'https://j.example.com/browse/DEMO-7' }, repo: { branch: 'ai/DEMO-7' }, mr: { url: 'https://g.example.com/p/-/merge_requests/3', sha: 'abc1234def5678' }, ci: { round: 2 } }
  const noUrl = { id: 'T-1', origin: {}, jira: { key: 'DEMO-7' }, repo: null, mr: null }
  const texts = async (language, t, extra = {}) => {
    const s = setup({ language })
    const out: any = {}
    for (const kind of ['jira_created', 'mr_opened', 'ci_fix_pushed', 'needs_info_resubmit']) {
      s.calls.sent.length = 0
      await s.monitor.notify({ ...t, ...extra }, kind)
      assert.equal(s.calls.sent[0].kind, kind)
      out[kind] = s.calls.sent[0].text
    }
    return out
  }
  const zh = await texts('zh', task, { commitUrl: 'https://g.example.com/p/-/commit/abc1234def5678' })
  assert.equal(zh.jira_created, '任务 T-1：Jira 单已建好：DEMO-7（https://j.example.com/browse/DEMO-7）。')
  assert.equal(zh.mr_opened, '任务 T-1：Draft MR 已开：https://g.example.com/p/-/merge_requests/3。')
  assert.equal(zh.ci_fix_pushed, '任务 T-1：CI 第 2 轮修复已推送：提交 abc1234（https://g.example.com/p/-/commit/abc1234def5678）。')
  assert.equal(zh.needs_info_resubmit, '任务 T-1 缺的信息补全后，请用 /fix 重新提交（把原来的描述和补充一起写上）。')
  const en = await texts('en', task, { commitUrl: 'https://g.example.com/p/-/commit/abc1234def5678' })
  assert.equal(en.jira_created, 'Task T-1: Jira issue DEMO-7 created (https://j.example.com/browse/DEMO-7).')
  assert.equal(en.mr_opened, 'Task T-1: Draft MR opened: https://g.example.com/p/-/merge_requests/3.')
  assert.equal(en.ci_fix_pushed, 'Task T-1: CI fix round 2 pushed: commit abc1234 (https://g.example.com/p/-/commit/abc1234def5678).')
  assert.equal(en.needs_info_resubmit, 'Task T-1 needs more information; please submit it again with /fix, with the original description and the missing details together.')
  // without url and without commit link the bracket part is left out
  assert.equal((await texts('zh', noUrl)).jira_created, '任务 T-1：Jira 单已建好：DEMO-7。')
  assert.equal((await texts('en', noUrl)).jira_created, 'Task T-1: Jira issue DEMO-7 created.')
  assert.equal((await texts('zh', task)).ci_fix_pushed, '任务 T-1：CI 第 2 轮修复已推送：提交 abc1234。')
  assert.equal((await texts('en', task)).ci_fix_pushed, 'Task T-1: CI fix round 2 pushed: commit abc1234.')
})
