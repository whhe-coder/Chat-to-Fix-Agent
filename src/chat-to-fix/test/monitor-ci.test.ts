// The CI wait inside the monitor (spec 7, 4.4: the eighth check) and its notices (4.7).
// A real createMonitor with an in-memory store and a stub repo adapter; the clock is injected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMonitor, ciNoticeText, CI_NOTICE_KINDS } from '../core/task/monitor.ts'
import { newCi } from '../core/task/contracts.ts'

const MIN = 60_000
const T0 = Date.parse('2026-11-12T02:00:00Z')
const LIMITS = {
  taskMinutes: 80,
  stepMinutes: { fetch: 5, issue: 5, prepare: 10, code: 40, mr: 5, ci: 30, writeback: 5 },
  quietMinutes: 3, quietNudges: 2, engineSilentMinutes: 10,
  ciPollSeconds: 15, ciWaitMinutes: 30, ciTotalMinutes: 90, ciMaxRounds: 3,
}
const job = (name, id = 1) => ({ id, name, url: `https://gl/job/${id}`, pipelineId: 7, projectId: 3 })
const PIPE = 'https://gl/pipelines/7'
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const merge = (a, b) => {
  if (!isObj(b)) return structuredClone(b)
  const out = isObj(a) ? { ...a } : {}
  for (const [k, v] of Object.entries(b)) if (v !== undefined) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : structuredClone(v)
  return out
}

function setup({ ci = undefined as any, stepAgoMin = 0, runAgoMin = 0, language = 'zh', limits = {}, review = { verdict: 'pass' } as any, quiet = false } = {}) {
  const clock = { t: T0 }
  const iso = (agoMin) => new Date(T0 - agoMin * MIN).toISOString()
  const tasks = new Map([['T-1', {
    id: 'T-1', no: 7, state: 'running', step: 'ci', stepAt: iso(stepAgoMin), origin: { channel: 'C1', threadTs: '1.1' },
    jira: { key: 'DEMO-7' }, repo: { branch: 'ai/DEMO-7' }, binding: { channel: 'C1', repo: 'g/p' },
    mr: { url: 'https://gl/mr/5', iid: 5, sha: 'sha1' }, review, ci: ci === undefined ? null : ci,
    runs: [{ no: 1, groupId: 'g1', bots: { main: 'bm', coding: 'bc' }, startedAt: iso(runAgoMin), endedAt: null }],
  } as any]])
  const records = []
  const store = {
    async getTask(id) { return structuredClone(tasks.get(id)) },
    async patchTask(id, patch) { tasks.set(id, merge(tasks.get(id), patch)); return tasks.get(id) },
    async appendRecord(id, entry) { records.push({ id, ...entry }) },
  }
  const calls: any = { post: [], sent: [], ended: [], checks: 0, retried: [] }
  const reply: any = { value: { status: 'pending', sha: 'sha1', pipelineUrl: null, failedJobs: [] }, error: null, onCall: null }
  const repo = {
    async getChecks(binding, iid) {
      calls.checks += 1
      calls.lastArgs = { binding, iid }
      if (reply.onCall) await reply.onCall()
      if (reply.error) throw reply.error
      return reply.value
    },
    async retryJobs(binding, jobs) {
      if (reply.retryError) throw reply.retryError
      calls.retried.push(jobs.map((j) => j.id)); return { retried: jobs.map((j) => j.id) }
    },
  }
  const state = { quiet }
  const botlayer = {
    async postTask(g, text, rid) { calls.post.push({ g, text, rid }) },
    async stopBot() {},
    isQuiet: () => state.quiet,
    answerApproval() {}, onSessionEvent: () => () => {}, onRoundEnd: () => () => {}, onGroupLine: () => () => {}, onApproval: () => () => {},
    botOfSession: () => undefined,
  }
  const warnings = []
  const monitor = createMonitor({
    store, botlayer, repo, language, limits: { ...LIMITS, ...limits }, now: () => clock.t, warn: (...a) => warnings.push(a),
    end: async (id, st, reason) => { calls.ended.push([id, st, reason]); (tasks.get(id) as any).state = st },
    send: async (origin, text) => { calls.sent.push({ origin, text }) },
  })
  const settle = () => new Promise((r) => setImmediate(r))
  const advance = (min) => { clock.t += min * MIN }
  const task = () => tasks.get('T-1') as any
  const ciIso = (agoMin) => iso(agoMin)
  return { monitor, tasks, task, records, calls, reply, state, clock, advance, settle, warnings, ciIso }
}
const ciRecords = (s) => s.records.filter((r) => r.type === 'ci')
const pendingCi = (s, agoMin = 0, extra = {}) => ({ ...newCi('sha1', s.ciIso(agoMin)), ...extra })
const start = async (s) => { s.monitor.watch('T-1'); await s.settle() }

test('first check in step ci writes task.ci for the commit of task.mr and polls with the binding and iid', async () => {
  const s = setup()
  await start(s); await s.monitor.tick()
  assert.equal(s.task().ci.status, 'pending')
  assert.equal(s.task().ci.sha, 'sha1')
  assert.equal(s.task().ci.round, 0)
  assert.equal(s.task().ci.waitedMs, 0)
  assert.equal(s.task().ci.since, new Date(T0).toISOString())
  assert.equal(s.calls.checks, 1)
  assert.deepEqual(s.calls.lastArgs, { binding: { channel: 'C1', repo: 'g/p' }, iid: 5 })
  assert.equal(s.calls.sent.length, 0)
})

test('polls once per ciPollSeconds although the monitor ticks every few seconds', async () => {
  const s = setup()
  await start(s); await s.monitor.tick()
  s.advance(5 / 60); await s.monitor.tick()
  s.advance(5 / 60); await s.monitor.tick()
  assert.equal(s.calls.checks, 1)
  s.advance(5 / 60 + 0.001); await s.monitor.tick() // 15 s have passed
  assert.equal(s.calls.checks, 2)
})

test('waiting: no step timeout, no quiet nudge, no end by total time', async () => {
  // entered the step 100 minutes ago, run started 200 minutes ago; the pipeline keeps running
  const s = setup({ stepAgoMin: 100, runAgoMin: 200, quiet: true, ci: undefined, limits: { ciWaitMinutes: 500, ciTotalMinutes: 500 } })
  s.tasks.get('T-1').ci = pendingCi(s, 150, { waitedMs: 0 })
  s.tasks.get('T-1').runs[0].startedAt = s.ciIso(155) // 155 min in, 150 of them waiting
  await start(s)
  for (let i = 0; i < 4; i++) { await s.monitor.tick(); s.advance(4) }
  assert.deepEqual(s.calls.ended, [])
  assert.equal(s.calls.post.length, 0)
  assert.equal(s.records.filter((r) => r.type === 'limit').length, 0)
})

test('the time spent waiting is not task time; the rest still is', async () => {
  // run 100 min old, 10 of them waiting for earlier rounds: 90 > 80
  const s = setup({ stepAgoMin: 1, runAgoMin: 100, ci: undefined })
  s.tasks.get('T-1').ci = { ...pendingCi(s, 1, { waitedMs: 10 * MIN }), status: 'failed', phaseAt: s.ciIso(1) }
  await start(s); await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [['T-1', 'timed_out', 'task_timeout']])
  // the same run with 30 min of waiting is within the limit
  const ok = setup({ stepAgoMin: 1, runAgoMin: 100, ci: undefined })
  ok.tasks.get('T-1').ci = { ...pendingCi(ok, 1, { waitedMs: 30 * MIN }), status: 'failed', phaseAt: ok.ciIso(1) }
  await start(ok); await ok.monitor.tick()
  assert.deepEqual(ok.calls.ended, [])
})

test('a pass settles the task, writes a ci record, tells Slack (zh) and the Main bot', async () => {
  const s = setup({ ci: undefined })
  s.tasks.get('T-1').ci = pendingCi(s, 4, { round: 1, waitedMs: 2 * MIN })
  s.reply.value = { status: 'passed', sha: 'sha1', pipelineUrl: PIPE, failedJobs: [] }
  await start(s); await s.monitor.tick()
  const ci = s.task().ci
  assert.equal(ci.status, 'passed')
  assert.equal(ci.settled, true)
  assert.equal(ci.outcome, 'passed')
  assert.equal(ci.pipelineUrl, PIPE)
  assert.equal(ci.waitedMs, 6 * MIN) // 2 earlier + 4 now
  assert.equal(ciRecords(s).length, 3) // the pipeline link, the pass, and the message to the Main bot
  assert.ok(ciRecords(s).some((r) => /^CI passed after 1 fix round/.test(r.text)))
  assert.equal(s.calls.sent.length, 1)
  assert.match(s.calls.sent[0].text, /CI 通过（修复 1 轮后）/)
  assert.ok(s.calls.sent[0].text.includes(PIPE))
  assert.deepEqual(s.calls.sent[0].origin, { channel: 'C1', threadTs: '1.1' })
  // the Main bot is told once, without a mention, to advance to writeback
  assert.equal(s.calls.post.length, 1)
  assert.equal(s.calls.post[0].g, 'g1')
  assert.match(s.calls.post[0].text, /^\[system\] The CI outcome is in \(passed\): the pipeline passed after 1 fix round\(s\)\. Advance to writeback/)
  assert.doesNotMatch(s.calls.post[0].text, /@Pipeline/)
  assert.equal(s.task().ci.mainNotified, true)
  // settled: no more polling, no second notice, no second message
  s.advance(1); await s.monitor.tick()
  await s.monitor.tick()
  assert.equal(s.calls.checks, 1)
  assert.equal(s.calls.sent.length, 1)
  assert.equal(s.calls.post.length, 1)
})

test('English notices when the language is not zh', async () => {
  const s = setup({ language: 'en' })
  s.reply.value = { status: 'passed', sha: 'sha1', pipelineUrl: PIPE, failedJobs: [] }
  await start(s); await s.monitor.tick()
  assert.match(s.calls.sent[0].text, /CI passed/)
  assert.doesNotMatch(s.calls.sent[0].text, /[一-龥]/)
})

test('first failure: the failed jobs are re-run once, no round, no notice, no message to the Main bot', async () => {
  const s = setup()
  s.reply.value = { status: 'failed', sha: 'sha1', pipelineUrl: PIPE, failedJobs: [job('lint', 11), job('test', 12)] }
  await start(s); await s.monitor.tick()
  assert.deepEqual(s.calls.retried, [[11, 12]])
  assert.equal(s.task().ci.retried, true)
  assert.equal(s.task().ci.status, 'pending')
  assert.equal(s.task().ci.round, 0)
  assert.equal(s.calls.sent.length, 0)
  assert.equal(s.calls.post.length, 0)
  assert.ok(ciRecords(s).some((r) => /re-running 2 failed job/.test(r.text)))
  // the re-run passes: settled passed, still round 0
  s.reply.value = { status: 'passed', sha: 'sha1', pipelineUrl: PIPE, failedJobs: [] }
  s.advance(0.5); await s.monitor.tick()
  assert.equal(s.task().ci.outcome, 'passed')
  assert.equal(s.task().ci.round, 0)
  assert.equal(s.calls.retried.length, 1)
})

test('failure after the re-run: failed jobs recorded, review cleared, Slack notice and Main bot message, waitedMs summed', async () => {
  const s = setup({ ci: undefined })
  s.tasks.get('T-1').ci = pendingCi(s, 3, { retried: true, waitedMs: 5 * MIN })
  s.reply.value = { status: 'failed', sha: 'sha1', pipelineUrl: PIPE, failedJobs: [job('lint', 11)] }
  await start(s); await s.monitor.tick()
  const ci = s.task().ci
  assert.equal(ci.status, 'failed')
  assert.equal(ci.settled, false)
  assert.deepEqual(ci.failedJobs, [job('lint', 11)])
  assert.equal(ci.logRead, false)
  assert.equal(ci.waitedMs, 8 * MIN)
  assert.equal(s.task().review, null)
  assert.equal(s.calls.retried.length, 0) // retried only once per commit
  assert.equal(s.calls.sent.length, 1)
  assert.match(s.calls.sent[0].text, /CI 第 1 轮失败：lint \(https:\/\/gl\/job\/11\)/)
  assert.ok(s.calls.sent[0].text.includes(PIPE))
  // the failed round goes to the Pipeline bot, which leads it; the Main bot is not told
  assert.equal(s.calls.post.length, 1)
  assert.match(s.calls.post[0].text, /^\[system\] @Pipeline-7 CI failed \(round 1 of 3\) in: lint/)
  assert.match(s.calls.post[0].text, /ci_read_log.*message_bot.*mr_push_fix.*ci_stop/)
})

test('failure in round N: the notice names round N+1; after ciMaxRounds fix commits the step settles as rounds_exhausted', async () => {
  const s = setup({ ci: undefined })
  s.tasks.get('T-1').ci = pendingCi(s, 1, { retried: true, round: 2 })
  s.reply.value = { status: 'failed', sha: 'sha1', pipelineUrl: PIPE, failedJobs: [job('test', 12)] }
  await start(s); await s.monitor.tick()
  assert.match(s.calls.sent[0].text, /第 3 轮失败/)
  assert.equal(s.task().ci.settled, false)

  const e = setup({ ci: undefined })
  e.tasks.get('T-1').ci = pendingCi(e, 1, { retried: true, round: 3 })
  e.reply.value = { status: 'failed', sha: 'sha1', pipelineUrl: PIPE, failedJobs: [job('test', 12)] }
  await start(e); await e.monitor.tick()
  assert.equal(e.task().ci.settled, true)
  assert.equal(e.task().ci.outcome, 'rounds_exhausted')
  assert.equal(e.task().ci.status, 'failed')
  assert.match(e.calls.sent[0].text, /修了 3 轮后仍未通过.*test/)
  assert.equal(e.calls.post.length, 1) // only the Main bot, not the Pipeline bot
  assert.match(e.calls.post[0].text, /^\[system\] The CI outcome is in \(rounds_exhausted\): CI still fails after 3 fix round\(s\) \(test\)\. Advance to writeback/)
  assert.doesNotMatch(e.calls.post[0].text, /@Pipeline/)
})

test('a rejected or failing re-run is not repeated and does not stop the wait', async () => {
  const s = setup()
  s.reply.retryError = new Error('403')
  s.reply.value = { status: 'failed', sha: 'sha1', pipelineUrl: PIPE, failedJobs: [job('lint', 11)] }
  await start(s); await s.monitor.tick()
  assert.equal(s.task().ci.retried, true)
  assert.ok(s.warnings.length > 0)
  s.advance(0.5); await s.monitor.tick() // still failing: the round is lost, no second re-run
  assert.equal(s.task().ci.status, 'failed')
  assert.equal(s.calls.retried.length, 0)
})

test('a result for another commit is ignored', async () => {
  const s = setup()
  s.reply.value = { status: 'passed', sha: 'old', pipelineUrl: PIPE, failedJobs: [] }
  await start(s); await s.monitor.tick()
  assert.equal(s.task().ci.status, 'pending')
  assert.equal(s.task().ci.pipelineUrl, null)
  assert.equal(s.calls.sent.length, 0)
})

test('a tool that changed task.ci during the request wins over the stale result', async () => {
  const s = setup({ ci: undefined })
  s.tasks.get('T-1').ci = pendingCi(s, 1)
  s.reply.value = { status: 'passed', sha: 'sha1', pipelineUrl: PIPE, failedJobs: [] }
  s.reply.onCall = async () => { s.task().ci = { ...s.task().ci, sha: 'sha2', round: 1 } } // mr_push_fix pushed meanwhile
  await start(s); await s.monitor.tick()
  assert.equal(s.task().ci.settled, false)
  assert.equal(s.task().ci.sha, 'sha2')
  assert.equal(s.calls.sent.length, 0)
})

test('getChecks errors only warn; the wait goes on and a later poll succeeds', async () => {
  const s = setup()
  s.reply.error = new Error('network')
  await start(s); await s.monitor.tick()
  assert.ok(s.warnings.length > 0)
  assert.equal(s.task().ci.status, 'pending')
  s.reply.error = null
  s.reply.value = { status: 'passed', sha: 'sha1', pipelineUrl: PIPE, failedJobs: [] }
  s.advance(0.3); await s.monitor.tick()
  assert.equal(s.task().ci.outcome, 'passed')
})

test('no pipeline within ciWaitMinutes: settled no_pipeline, notice, Main bot message', async () => {
  const s = setup()
  await start(s); await s.monitor.tick()
  s.advance(29); await s.monitor.tick()
  assert.equal(s.task().ci.settled, false)
  s.advance(1.1); await s.monitor.tick()
  const ci = s.task().ci
  assert.equal(ci.settled, true)
  assert.equal(ci.outcome, 'no_pipeline')
  assert.match(ci.note, /no pipeline was triggered within 30 minutes/)
  assert.match(s.calls.sent[0].text, /没有触发 pipeline/)
  assert.match(s.calls.post[0].text, /^\[system\] The CI outcome is in \(no_pipeline\): there is no CI result \(no pipeline was triggered within 30 minutes\)\. Advance to writeback/)
  assert.deepEqual(s.calls.ended, []) // the task goes on to writeback; the wait is not a limit failure
})

test('a pipeline that never finishes within ciWaitMinutes: no_pipeline with "wait timed out"', async () => {
  const s = setup()
  s.reply.value = { status: 'pending', sha: 'sha1', pipelineUrl: PIPE, failedJobs: [] }
  await start(s); await s.monitor.tick()
  assert.equal(s.task().ci.pipelineUrl, PIPE)
  s.advance(31); await s.monitor.tick()
  assert.equal(s.task().ci.outcome, 'no_pipeline')
  assert.equal(s.task().ci.note, 'wait timed out')
  assert.match(s.calls.sent[0].text, /等待超时/)
})

test('ciTotalMinutes over all rounds ends the wait even when this commit has waited little', async () => {
  const s = setup({ ci: undefined })
  s.tasks.get('T-1').ci = pendingCi(s, 5, { round: 2, waitedMs: 86 * MIN })
  s.tasks.get('T-1').runs[0].startedAt = s.ciIso(10)
  s.reply.value = { status: 'pending', sha: 'sha1', pipelineUrl: PIPE, failedJobs: [] }
  await start(s); await s.monitor.tick()
  assert.equal(s.task().ci.settled, true)
  assert.equal(s.task().ci.outcome, 'no_pipeline')
  assert.equal(s.task().ci.note, 'wait timed out')
  assert.equal(s.task().ci.waitedMs, 91 * MIN)
})

test('while the bots fix a failed round the step timer counts from that failure, not from entering the step', async () => {
  // entered the step 60 minutes ago; failed 2 minutes ago; stepMinutes.ci = 30
  const s = setup({ stepAgoMin: 60, runAgoMin: 61, ci: undefined })
  s.tasks.get('T-1').ci = { ...pendingCi(s, 58, { retried: true, waitedMs: 56 * MIN }), status: 'failed', phaseAt: s.ciIso(2), failedJobs: [job('lint')] }
  await start(s); await s.monitor.tick()
  assert.equal(s.calls.post.length, 0)
  assert.deepEqual(s.calls.ended, [])
  assert.equal(s.calls.checks, 0) // failed: no polling
  s.advance(28.5); await s.monitor.tick() // 30.5 minutes after the failure: nudge
  assert.equal(s.calls.post.length, 1)
  assert.match(s.calls.post[0].text, /^\[system\] @Pipeline-7 Step "ci" has taken more than 30 minutes/)
  s.advance(31); await s.monitor.tick()
  assert.deepEqual(s.calls.ended, [['T-1', 'failed', 'step_timeout']])
})

test('a new failed round resets the nudge flag and the quiet nudges', async () => {
  const s = setup({ stepAgoMin: 1, runAgoMin: 2, ci: undefined, limits: { ciWaitMinutes: 500, ciTotalMinutes: 500 } })
  s.tasks.get('T-1').ci = { ...pendingCi(s, 1, { retried: true }), status: 'failed', phaseAt: s.ciIso(1), failedJobs: [job('lint')] }
  s.state.quiet = true
  await start(s); await s.monitor.tick()
  s.advance(3.1); await s.monitor.tick() // quiet nudge 1
  s.advance(3.1); await s.monitor.tick() // quiet nudge 2
  assert.equal(s.calls.post.length, 2)
  // the fix is pushed, the next pipeline fails again: a new round starts with fresh nudges
  s.task().ci = { ...s.task().ci, status: 'pending', since: new Date(s.clock.t).toISOString(), failedJobs: [] }
  s.state.quiet = false
  await s.monitor.tick()
  s.state.quiet = true
  s.task().ci = { ...s.task().ci, status: 'failed', phaseAt: new Date(s.clock.t).toISOString(), failedJobs: [job('test')] }
  s.advance(0.1); await s.monitor.tick()
  s.advance(3.1); await s.monitor.tick()
  assert.equal(s.calls.post.length, 3)
  assert.deepEqual(s.calls.ended, [])
})

test('quiet counting is cleared while waiting, then applies again once the round failed', async () => {
  const s = setup({ stepAgoMin: 1, runAgoMin: 2, quiet: true })
  await start(s); await s.monitor.tick() // waiting
  s.advance(10); await s.monitor.tick()
  assert.equal(s.calls.post.length, 0)
  s.task().ci = { ...s.task().ci, status: 'failed', phaseAt: new Date(s.clock.t).toISOString(), failedJobs: [job('lint')], retried: true }
  await s.monitor.tick() // starts counting now
  s.advance(3.1); await s.monitor.tick()
  assert.equal(s.calls.post.length, 1)
  assert.match(s.calls.post[0].text, /^\[system\] @Pipeline-7 Nobody in the group.*CI round.*ci_stop/)
})

test('a settle written by a tool (ci_stop, branch_changed) is noticed once and told to the Main bot', async () => {
  for (const outcome of ['not_fixable', 'branch_changed']) {
    const s = setup({ stepAgoMin: 5, runAgoMin: 6, ci: undefined })
    s.tasks.get('T-1').ci = { ...pendingCi(s, 5, { retried: true }), status: 'failed', phaseAt: s.ciIso(3), failedJobs: [job('lint')] }
    await start(s); await s.monitor.tick()
    assert.equal(s.calls.post.length, 0) // not settled yet
    s.task().ci = { ...s.task().ci, settled: true, outcome, note: 'why' }
    await s.monitor.tick()
    await s.monitor.tick()
    assert.equal(s.calls.post.length, 1, outcome)
    assert.match(s.calls.post[0].text, new RegExp(`^\\[system\\] The CI outcome is in \\(${outcome}\\).*\\(why\\)\\. Advance to writeback`), outcome)
    assert.doesNotMatch(s.calls.post[0].text, /@Pipeline/)
    assert.equal(s.task().ci.mainNotified, true)
    assert.equal(s.calls.sent.length, 0) // Slack progress notices are only for what the system itself settles
  }
})

test('after the settle the Main bot leads: its step timer starts at the message, nudges go to it', async () => {
  const s = setup({ stepAgoMin: 80, runAgoMin: 85, ci: undefined, limits: { taskMinutes: 500 } })
  s.tasks.get('T-1').ci = { ...pendingCi(s, 80, { retried: true }), status: 'failed', phaseAt: s.ciIso(60), failedJobs: [job('lint')], settled: true, outcome: 'out_of_scope', note: 'n' }
  await start(s); await s.monitor.tick() // tells the Main bot now
  assert.equal(s.calls.post.length, 1)
  s.advance(31); await s.monitor.tick() // step limit 30 from the message
  assert.equal(s.calls.post.length, 2)
  assert.match(s.calls.post[1].text, /^\[system\] Step "ci"/)
  assert.doesNotMatch(s.calls.post[1].text, /@Pipeline/)
})

test('restart: the wait continues from task.ci, since is not reset', async () => {
  const s = setup({ stepAgoMin: 20, runAgoMin: 25, ci: undefined })
  s.tasks.get('T-1').ci = pendingCi(s, 20, { waitedMs: 0 })
  s.monitor.watch('T-1', { restarted: true }); await s.settle()
  await s.monitor.tick()
  assert.equal(s.task().ci.since, s.ciIso(20))
  assert.equal(s.calls.checks, 1)
  // still waiting: the 30 minute limit counts from `since`, not from the restart
  s.advance(10.5); await s.monitor.tick()
  assert.equal(s.task().ci.outcome, 'no_pipeline')
})

test('restart while the bots fix a round: the step timer starts at the restart, the failure is kept', async () => {
  const s = setup({ stepAgoMin: 50, runAgoMin: 51, ci: undefined })
  s.tasks.get('T-1').ci = { ...pendingCi(s, 40, { retried: true }), status: 'failed', phaseAt: s.ciIso(20), failedJobs: [job('lint')] }
  s.monitor.watch('T-1', { restarted: true }); await s.settle()
  await s.monitor.tick()
  assert.equal(s.calls.post.length, 0) // 20 minutes after the failure, but the limits count from the restart
  assert.equal(s.task().ci.status, 'failed')
})

test('other steps are untouched: no CI poll and no task.ci outside step ci', async () => {
  const s = setup({ ci: undefined })
  s.task().step = 'mr'
  await start(s); await s.monitor.tick()
  assert.equal(s.calls.checks, 0)
  assert.equal(s.task().ci, null)
})

test('without a repo adapter the poll only warns and the wait limit still ends the step', async () => {
  const s = setup()
  const m = createMonitor({
    store: { getTask: async () => structuredClone(s.task()), patchTask: async (id, p) => { s.tasks.set(id, merge(s.task(), p)) }, appendRecord: async () => {} },
    botlayer: { isQuiet: () => false, postTask: async (g, text) => { s.calls.post.push({ g, text }) }, stopBot: async () => {}, answerApproval() {}, onSessionEvent: () => () => {}, onRoundEnd: () => () => {}, onGroupLine: () => () => {}, onApproval: () => () => {} },
    limits: LIMITS, now: () => s.clock.t, warn: (...a) => s.warnings.push(a), end: async () => {}, send: async (o, text) => { s.calls.sent.push({ origin: o, text }) },
  } as any)
  m.watch('T-1'); await s.settle(); await m.tick()
  assert.ok(s.warnings.length > 0)
  s.advance(31); await m.tick()
  assert.equal(s.task().ci.outcome, 'no_pipeline')
})

test('notice texts: every kind exists in both languages, links and names only', () => {
  const ci = { round: 1, pipelineUrl: PIPE, failedJobs: [job('lint', 11)], waitTimedOut: false }
  for (const kind of CI_NOTICE_KINDS) {
    for (const lang of ['zh', 'en']) {
      const text = ciNoticeText(lang, kind, { id: 'T-1' }, ci)
      assert.ok(text.length > 0, `${kind} ${lang}`)
      assert.ok(text.includes(PIPE), `${kind} ${lang}`)
    }
  }
  assert.deepEqual([...CI_NOTICE_KINDS].sort(), ['ci_failed', 'ci_no_pipeline', 'ci_passed', 'ci_rounds_exhausted'])
  assert.match(ciNoticeText('zh', 'ci_failed', { id: 'T-1' }, ci), /^任务 T-1：CI 第 2 轮失败/)
  assert.match(ciNoticeText('en', 'ci_failed', { id: 'T-1' }, ci), /^Task T-1: CI failed in round 2/)
})
