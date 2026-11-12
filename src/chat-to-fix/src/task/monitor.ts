// The monitor (work package B7, spec 3 sections 4.5, 4.6 and 4.8).
// Enforces the time limits, nudges a quiet group, rejects approvals and sends system notices.
// It never reads a DS Bot or DSH object directly: only the I1 facade events and the I2 store.

import { newCi } from './contracts.ts'

// ---------------------------------------------------------------------------------------------
// Templates. Nudges go to the Main bot as the user; notices go to the original Slack discussion.
// ---------------------------------------------------------------------------------------------

export const NUDGE = Object.freeze({
  stepTimeout: (step, minutes) =>
    `[system] Step "${step}" has taken more than ${minutes} minutes. Finish it now, or tell me what is blocking it. If it is not finished after another ${minutes} minutes the task is ended.`,
  quiet: (minutes) =>
    `[system] Nobody in the group has done anything for ${minutes} minutes. Continue with the current step by calling the right bot, or close the task if it cannot go on.`,
  ciQuiet: (minutes) =>
    `[system] Nobody in the group has done anything for ${minutes} minutes. Continue this CI round: read the log, ask the Coding bot to fix it, push the fix with mr_push_fix, or stop the loop with ci_stop.`,
  ciEngineSilent: (minutes) =>
    `[system] The Coding bot (Claude Code) produced no output for ${minutes} minutes and its turn was stopped. Ask the Coding bot again (message_bot) with the same request.`,
  engineSilent: (minutes) =>
    `[system] The Coding bot (Claude Code) produced no output for ${minutes} minutes and its turn was stopped. Call the Coding bot again with the same request.`,
})

const where = (task) => {
  const extra = []
  if (task?.jira?.key) extra.push(`Jira: ${task.jira.key}`)
  if (task?.repo?.branch) extra.push(`Branch: ${task.repo.branch}`)
  return extra.length > 0 ? ` ${extra.join(', ')}.` : ''
}
const shortSha = (sha) => String(sha ?? '').slice(0, 7)
const ref = (task, zh = false) => (zh ? (task?.id ? `任务 ${task.id}：` : '') : (task?.id ? `Task ${task.id}` : 'This request'))

export const NOTICE = Object.freeze({
  in_progress: (task) => `${ref(task)} is already in progress for this discussion.${where(task)}`,
  queue_full: () => 'The fix queue is full, so this request was not accepted. Please try again later.',
  channel_not_bound: () => 'This channel is not set up for Chat-to-Fix, so this request was not accepted.',
  timed_out: (task) => `${ref(task)} timed out${task?.endReason ? ` (${task.endReason})` : ''} and was ended.${where(task)}`,
  failed: (task) => `${ref(task)} could not be completed${task?.endReason ? ` (${task.endReason})` : ''}.${where(task)}`,
  expired: (task) => `${ref(task)} waited too long in the queue and expired. Mention the bot again to retry.${where(task)}`,
  stopped: (task) => `${ref(task)} was stopped.${where(task)}`,
  resumed: (task) => `Got the extra information; ${task?.id ? `task ${task.id}` : 'this request'} is queued again.`,
  no_open_task: () => 'There is no open task in this discussion; please submit a new problem with /fix.',
  // Progress facts, sent by the system right when they are written (src/tools: jira_create_issue, mr_open_draft, mr_push_fix).
  jira_created: (task) => `${ref(task)}: Jira issue ${task?.jira?.key ?? ''} created${task?.jira?.url ? ` (${task.jira.url})` : ''}.`,
  mr_opened: (task) => `${ref(task)}: Draft MR opened: ${task?.mr?.url ?? ''}.`,
  ci_fix_pushed: (task) => `${ref(task)}: CI fix round ${task?.ci?.round ?? ''} pushed: commit ${shortSha(task?.mr?.sha)}${task?.commitUrl ? ` (${task.commitUrl})` : ''}.`,
  // Only with slack.mentions false: the requester cannot answer in the thread.
  needs_info_resubmit: (task) => `${ref(task)} needs more information; please submit it again with /fix, with the original description and the missing details together.`,
})

export const NOTICE_KINDS = Object.freeze(Object.keys(NOTICE))

// Chinese notices (chosen when `language` is 'zh'). The reason of failed / needs_person is the Main bot's note
// (task.closeNote), written for the requester; end reasons without a note fall back to endReason.
const zhRef = (task) => (task?.id ? `任务 ${task.id}` : '这个请求')
const zhWhere = (task) => {
  const extra = []
  if (task?.jira?.key) extra.push(`Jira：${task.jira.key}${task.jira.url ? `（${task.jira.url}）` : ''}`)
  if (task?.repo?.branch) extra.push(`分支：${task.repo.branch}`)
  if (task?.mr?.url) extra.push(`Draft MR：${task.mr.url}`)
  return extra.length > 0 ? `${extra.join('，')}。` : ''
}
const ZH_END_REASON = { task_timeout: '任务总时长超限', coding_timeout: '编码步骤超时', step_timeout: '某一步超时' }
const zhReason = (task) => {
  const raw = (task?.closeNote ?? task?.endReason ?? '').toString().trim()
  return raw.replace(/[。.]+$/, '')
}
const zhReasonOf = (task) => { const r = zhReason(task); return ZH_END_REASON[r] ?? r }

export const NOTICE_ZH = Object.freeze({
  in_progress: (task) => `${zhRef(task)} 已经在处理这个讨论了。${zhWhere(task)}`,
  queue_full: () => '修复队列已满，这次请求没有接收，请稍后再试。',
  channel_not_bound: () => '这个频道还没有接入 Chat-to-Fix，这次请求没有接收。',
  timed_out: (task) => `${zhRef(task)} 超时了${zhReasonOf(task) ? `（${zhReasonOf(task)}）` : ''}，已结束。${zhWhere(task)}`,
  failed: (task) => {
    if (task?.endReason === 'needs_person') {
      const why = zhReason(task) === 'needs_person' ? '' : zhReason(task)
      return `${zhRef(task)} 需要人来处理${why ? `：${why}` : ''}。${zhWhere(task)}`
    }
    const why = zhReasonOf(task)
    return `${zhRef(task)} 没能自动修好${why ? `：${why}` : ''}。${zhWhere(task)}补充信息后可以用 /fix 重新提交。`
  },
  expired: (task) => `${zhRef(task)} 在队列里等太久，已过期。想继续的话，请用 /fix 重新提交。${zhWhere(task)}`,
  stopped: (task) => `${zhRef(task)} 已停止。${zhWhere(task)}`,
  resumed: (task) => `收到补充信息，${zhRef(task)} 重新开始处理。`,
  no_open_task: () => '这个讨论串里没有在处理的任务，新问题请用 /fix 提交。',
  jira_created: (task) => `${zhRef(task)}：Jira 单已建好：${task?.jira?.key ?? ''}${task?.jira?.url ? `（${task.jira.url}）` : ''}。`,
  mr_opened: (task) => `${zhRef(task)}：Draft MR 已开：${task?.mr?.url ?? ''}。`,
  ci_fix_pushed: (task) => `${zhRef(task)}：CI 第 ${task?.ci?.round ?? ''} 轮修复已推送：提交 ${shortSha(task?.mr?.sha)}${task?.commitUrl ? `（${task.commitUrl}）` : ''}。`,
  needs_info_resubmit: (task) => `${zhRef(task)} 缺的信息补全后，请用 /fix 重新提交（把原来的描述和补充一起写上）。`,
})

/** The notice text of `kind` for `task` in `language` ('zh' Chinese, anything else English). */
export const noticeText = (language, kind, task) => {
  const table = language === 'zh' ? NOTICE_ZH : NOTICE
  const template = table[kind]
  return template ? template(task).trim() : undefined
}

// ---------------------------------------------------------------------------------------------
// CI wait (spec 7, 4.4 and 4.7). Messages to the Main bot are English like the nudges. The Slack
// progress notices follow the configuration `language` (zh: Chinese, anything else: English); they
// hold links and job names only, never a log. They are separate from NOTICE so that NOTICE_KINDS
// stays the list of the discussion-level notices.
// ---------------------------------------------------------------------------------------------

const jobNames = (ci) => (ci?.failedJobs ?? []).map((j) => j.name).join(', ') || '-'
const jobLinks = (ci, sep) => (ci?.failedJobs ?? []).map((j) => (j.url ? `${j.name} (${j.url})` : j.name)).join(sep) || '-'
const pipelineLink = (ci, zh) => (ci?.pipelineUrl ? `${zh ? 'Pipeline：' : 'Pipeline: '}${ci.pipelineUrl}` : '')

// The audience of `failed` is the Pipeline bot, which leads a fix round (it reads the log, asks the Coding bot
// through message_bot, pushes with mr_push_fix or stops with ci_stop). `settled` goes to the Main bot, which
// hands over at the start of step ci and advances at its end.
const SETTLED_WHY = {
  passed: (ci) => `the pipeline passed${ci.round > 0 ? ` after ${ci.round} fix round(s)` : ''}`,
  rounds_exhausted: (ci) => `CI still fails after ${ci.round} fix round(s) (${jobNames(ci)})`,
  no_pipeline: (ci) => `there is no CI result (${ci.note ?? 'no pipeline'})`,
  not_locatable: (ci) => `the Pipeline bot stopped the loop: the log does not show the cause${ci.note ? ` (${ci.note})` : ''}`,
  out_of_scope: (ci) => `the Pipeline bot stopped the loop: the fix is outside the ticket${ci.note ? ` (${ci.note})` : ''}`,
  not_fixable: (ci) => `the Pipeline bot stopped the loop: the Coding bot cannot fix it${ci.note ? ` (${ci.note})` : ''}`,
  branch_changed: (ci) => `someone else pushed to the task branch, so the fix was not pushed${ci.note ? ` (${ci.note})` : ''}`,
}

export const CI_NUDGE = Object.freeze({
  failed: (ci, max) =>
    `[system] CI failed (round ${ci.round + 1} of ${max}) in: ${jobNames(ci)}. The system already re-ran the failed jobs once. You lead this round: read the log with ci_read_log and summarise the failure, ask the Coding bot (message_bot) to fix it and have the fix reviewed, then push it with mr_push_fix once the review passed. If the log does not show the cause, the fix is outside the ticket, or the Coding bot says it cannot fix it, stop the loop with ci_stop. The system waits for the next pipeline after the push.`,
  settled: (ci) =>
    `[system] The CI outcome is in (${ci.outcome}): ${(SETTLED_WHY[ci.outcome] ?? (() => 'the CI step is settled'))(ci)}. Advance to writeback and report it as it is.`,
})

const CI_NOTICE_TEXT = {
  zh: {
    ci_passed: (task, ci) => `${ref(task, true)}CI 通过${ci.round > 0 ? `（修复 ${ci.round} 轮后）` : ''}。${pipelineLink(ci, true)}`,
    ci_failed: (task, ci) => `${ref(task, true)}CI 第 ${ci.round + 1} 轮失败：${jobLinks(ci, '、')}。${pipelineLink(ci, true)}`,
    ci_rounds_exhausted: (task, ci) => `${ref(task, true)}CI 修了 ${ci.round} 轮后仍未通过，没过的 job：${jobLinks(ci, '、')}。Draft MR 已开，需要人看一下。${pipelineLink(ci, true)}`,
    ci_no_pipeline: (task, ci) => `${ref(task, true)}没有拿到 CI 结果（${ci.waitTimedOut ? '等待超时' : '没有触发 pipeline'}）。MR 已开，需要人看一下。${pipelineLink(ci, true)}`,
  },
  en: {
    ci_passed: (task, ci) => `${ref(task)}: CI passed${ci.round > 0 ? ` after ${ci.round} fix round(s)` : ''}. ${pipelineLink(ci, false)}`,
    ci_failed: (task, ci) => `${ref(task)}: CI failed in round ${ci.round + 1}: ${jobLinks(ci, ', ')}. ${pipelineLink(ci, false)}`,
    ci_rounds_exhausted: (task, ci) => `${ref(task)}: CI still fails after ${ci.round} fix round(s): ${jobLinks(ci, ', ')}. The draft MR is open; a person needs to look. ${pipelineLink(ci, false)}`,
    ci_no_pipeline: (task, ci) => `${ref(task)}: no CI result (${ci.waitTimedOut ? 'the wait timed out' : 'no pipeline was triggered'}). The MR is open; a person needs to look. ${pipelineLink(ci, false)}`,
  },
}

export const CI_NOTICE_KINDS = Object.freeze(Object.keys(CI_NOTICE_TEXT.en))

export const ciNoticeText = (language, kind, task, ci) => (CI_NOTICE_TEXT[language === 'zh' ? 'zh' : 'en'][kind])(task, ci).trim()

// The idle-relay pause as the group shows it. Source: DSB:src/host/groups.js:90 (noticeText for
// reason 'paused' with idle), emitted at groups.js:723. The ordinary relay-limit pause says
// "have called each other", so it does not match. If DS Bot changes the wording, change it here only.
export const IDLE_RELAY_NOTICE = /went back and forth \d+ times without progress/i

// Session events of the Coding bot. DSH emits 'turn/start' when a turn opens and 'turn/end' when it
// closes (DSB:src/host/turns.js:667 and :896). Only these two change whether a turn is running;
// every other session event (text, tool calls, results...) counts as output and refreshes the clock.
// A RoundEndEvent from the facade also closes the turn.
const TURN_START = 'turn/start'
const TURN_END = 'turn/end'

const MINUTE = 60_000

export function createMonitor({ store, botlayer, limits, end, send, repo, language = 'en', now = () => Date.now(), warn = (...a) => console.warn(...a), intervalMs = 5000 }: any) {
  /** @type {Map<string, object>} */
  const watched = new Map()
  let unsubscribers = []
  let timer = null
  let ticking = null

  const stepMinutes = (step) => limits.stepMinutes?.[step]

  // ---- subscriptions ------------------------------------------------------------------------

  function taskOfSession(sessionId, botId) {
    const bound = sessionId !== undefined ? botlayer.botOfSession?.(sessionId) : undefined
    if (bound?.taskId && watched.has(bound.taskId)) return watched.get(bound.taskId)
    for (const w of watched.values()) {
      const ids = [w.groupId, ...Object.values(w.bots)]
      if ((sessionId && ids.includes(sessionId)) || (botId && ids.includes(botId))) return w
    }
    return undefined
  }

  const isCoding = (w, sessionId, botId) => {
    const bound = sessionId !== undefined ? botlayer.botOfSession?.(sessionId) : undefined
    if (bound) return bound.taskId === w.taskId && bound.role === 'coding'
    const coding = w.bots.coding
    return coding !== undefined && (coding === botId || coding === sessionId)
  }

  function onSessionEvent(ev) {
    const w = taskOfSession(ev.sessionId, ev.botId)
    if (!w || !isCoding(w, ev.sessionId, ev.botId)) return
    w.lastCodingEventAt = now()
    if (ev.type === TURN_START) w.turnRunning = true
    else if (ev.type === TURN_END) w.turnRunning = false
  }

  function onRoundEnd(ev) {
    const w = taskOfSession(ev.sessionId, ev.botId)
    if (!w || !isCoding(w, ev.sessionId, ev.botId)) return
    w.lastCodingEventAt = now()
    w.turnRunning = false
  }

  function onGroupLine(ev) {
    if (ev.kind !== 'notice' || !IDLE_RELAY_NOTICE.test(ev.text ?? '')) return
    for (const w of watched.values()) if (w.groupId === ev.groupId) w.idleRelay = true
  }

  function onApproval(ev) {
    const w = taskOfSession(ev.sessionId, ev.botId)
    if (!w) return
    try { botlayer.answerApproval(ev.id, 'reject') } catch (error) { warn('chat-to-fix: monitor cannot reject approval %s: %s', ev.id, error?.message ?? error) }
    void store.appendRecord(w.taskId, {
      type: 'approval', run: w.runNo, step: w.step, tool: ev.tool, text: `${ev.tool}: ${ev.text ?? ''} -> reject`,
    }).catch((error) => warn('chat-to-fix: monitor cannot record approval: %s', error?.message ?? error))
  }

  function subscribe() {
    if (unsubscribers.length > 0) return
    const subs: [string, any][] = [
      ['onSessionEvent', onSessionEvent], ['onRoundEnd', onRoundEnd],
      ['onGroupLine', onGroupLine], ['onApproval', onApproval],
    ]
    for (const [name, fn] of subs) {
      const off = botlayer[name]?.(fn)
      if (typeof off === 'function') unsubscribers.push(off)
    }
    if (unsubscribers.length === 0) unsubscribers.push(() => {})
  }

  function unsubscribe() {
    for (const off of unsubscribers) { try { off() } catch { /* already gone */ } }
    unsubscribers = []
  }

  // ---- bookkeeping per watched task ---------------------------------------------------------

  function adopt(w, task) {
    const run = task.runs?.findLast?.((r) => r.endedAt === null) ?? task.runs?.at?.(-1)
    w.runNo = run?.no ?? null
    w.taskNo = task.no ?? null
    w.groupId = run?.groupId ?? w.groupId
    w.bots = run?.bots ?? w.bots
    w.step = task.step ?? null
    w.runStart = run?.startedAt ? Date.parse(run.startedAt) : w.watchedAt
    if (w.stepKey !== w.step) { // a new step starts every step-level count afresh
      w.stepKey = w.step
      w.stepNudgedAt = null
    }
    const entered = task.stepAt ? Date.parse(task.stepAt) : w.watchedAt
    // After a restart every limit is counted from the restart; the total time is not (spec 4.8).
    w.stepStart = Math.max(Number.isFinite(entered) ? entered : w.watchedAt, w.baseAt)
  }

  function watch(taskId, opts: any = {}) {
    const t = now()
    const w: any = {
      taskId, watchedAt: t, baseAt: opts.restarted ? t : 0, restarted: !!opts.restarted,
      groupId: null, bots: {}, runNo: null, taskNo: null, lead: 'main', step: null, stepKey: undefined, stepStart: t, runStart: t,
      stepNudgedAt: null, quietSince: null, quietNudges: 0,
      lastCodingEventAt: t, turnRunning: false, engineSilentCount: 0, idleRelay: false, ended: false,
      ciPolledAt: 0, ciPhaseKey: null,
    }
    watched.set(taskId, w)
    subscribe()
    // Learn the group and bot ids at once so events that arrive before the first tick can be matched.
    Promise.resolve(store.getTask(taskId)).then((task) => { if (task && watched.get(taskId) === w) adopt(w, task) })
      .catch((error) => warn('chat-to-fix: monitor cannot load %s: %s', taskId, error?.message ?? error))
  }

  function unwatch(taskId) {
    watched.delete(taskId)
  }

  // ---- triggers -----------------------------------------------------------------------------

  async function record(w, check, action) {
    await store.appendRecord(w.taskId, { type: 'limit', run: w.runNo, step: w.step, check, action, text: `${check} at step ${w.step ?? '-'}: ${action}` })
  }

  // `to` is the bot that leads the step. Without a mention the group's opener (the Main bot) answers; for the
  // Pipeline bot the text carries its "@Name" (the bots are named `<Name>-<task no>`, runner.ts).
  async function nudge(w, text, kind, to = 'main') {
    const requestId = `${w.taskId}:${kind}:${now()}`
    const body = to === 'pipeline' && w.taskNo !== null && w.taskNo !== undefined ? text.replace(/^\[system\] /, `[system] @Pipeline-${w.taskNo} `) : text
    await botlayer.postTask(w.groupId, body, requestId)
  }

  // Ends the task at most once: the flag is set before anything is awaited.
  async function endTask(w, state, endReason, check, action) {
    if (w.ended) return
    w.ended = true
    try { await record(w, check, action) } catch (error) { warn('chat-to-fix: monitor cannot record %s: %s', check, error?.message ?? error) }
    try { await end(w.taskId, state, endReason) } catch (error) { warn('chat-to-fix: monitor cannot end %s: %s', w.taskId, error?.message ?? error) }
    watched.delete(w.taskId)
  }

  // ---- CI wait (spec 7, 4.4): the eighth check ------------------------------------------------

  const iso = (ms) => new Date(ms).toISOString()
  const ms = (iso) => { const v = Date.parse(iso); return Number.isFinite(v) ? v : null }

  // Writes a change of task.ci (and optionally clears the review) and one `ci` record. Returns the new ci.
  async function commitCi(w, ci, patch, text, { clearReview = false } = {}) {
    const next = { ...ci, ...patch }
    await store.patchTask(w.taskId, { ci: patch, ...(clearReview ? { review: null } : {}) })
    try { await store.appendRecord(w.taskId, { type: 'ci', run: w.runNo, step: 'ci', text }) } catch (error) { warn('chat-to-fix: monitor cannot record a ci change: %s', error?.message ?? error) }
    return next
  }

  // The Slack notice (and, for a failed round, the message to the Pipeline bot that leads it); a failure of
  // either only warns (the state is already written). The Main bot is told when task.ci becomes settled, see
  // ciSettledNotice.
  async function ciAnnounce(w, task, ci, kind, pipelineText = '', extra = {}) {
    try { await deliver({ ...task, ci }, `ci_${kind}`, ciNoticeText(language, `ci_${kind}`, task, { ...ci, ...extra })) } catch (error) { warn('chat-to-fix: monitor cannot send the CI notice: %s', error?.message ?? error) }
    if (pipelineText) {
      try { await nudge(w, pipelineText, 'ci', 'pipeline') } catch (error) { warn('chat-to-fix: monitor cannot tell the Pipeline bot about the CI: %s', error?.message ?? error) }
    }
  }

  async function ciPassed(w, task, ci, t) {
    const waitedMs = ci.waitedMs + Math.max(0, t - (ms(ci.since) ?? t))
    const next = await commitCi(w, ci, { status: 'passed', failedJobs: [], settled: true, outcome: 'passed', waitedMs, phaseAt: iso(t) }, `CI passed${ci.round > 0 ? ` after ${ci.round} fix round(s)` : ''}`)
    await ciAnnounce(w, task, next, 'passed')
    return next
  }

  async function ciFailed(w, task, ci, checks, t) {
    const waitedMs = ci.waitedMs + Math.max(0, t - (ms(ci.since) ?? t))
    const exhausted = ci.round >= limits.ciMaxRounds
    const patch = {
      status: 'failed', failedJobs: checks.failedJobs ?? [], logRead: false, waitedMs, phaseAt: iso(t),
      ...(exhausted ? { settled: true, outcome: 'rounds_exhausted' } : {}),
    }
    // The review verdict is cleared: what mr_push_fix and ci_stop need can only come from this round.
    const next = await commitCi(w, ci, patch, `CI failed in round ${ci.round + 1}: ${jobNames({ failedJobs: patch.failedJobs })}${exhausted ? ' (rounds exhausted)' : ''}`, { clearReview: true })
    if (exhausted) await ciAnnounce(w, task, next, 'rounds_exhausted')
    else await ciAnnounce(w, task, next, 'failed', CI_NUDGE.failed(next, limits.ciMaxRounds))
    return next
  }

  async function ciNoPipeline(w, task, ci, t, waitTimedOut, note) {
    const waitedMs = ci.waitedMs + Math.max(0, t - (ms(ci.since) ?? t))
    const next = await commitCi(w, ci, { settled: true, outcome: 'no_pipeline', note, waitedMs, phaseAt: iso(t) }, `no CI result: ${note}`)
    await ciAnnounce(w, task, next, 'no_pipeline', undefined, { waitTimedOut })
    return next
  }

  // The first failure of a commit: re-run the failed jobs once. No round, no model call, no message to the Main bot.
  // `retried` is written before the call, so a restart in between never sends the write twice.
  async function ciRetry(w, task, ci, checks) {
    const jobs = checks.failedJobs ?? []
    const next = await commitCi(w, ci, { retried: true }, `CI failed: re-running ${jobs.length} failed job(s) once: ${jobNames({ failedJobs: jobs })}`)
    if (jobs.length > 0) {
      try { await repo.retryJobs(task.binding, jobs) } catch (error) {
        warn('chat-to-fix: monitor cannot re-run the failed CI jobs of %s: %s', w.taskId, error?.message ?? error)
        try { await store.appendRecord(w.taskId, { type: 'ci', run: w.runNo, step: 'ci', text: `re-running the failed jobs failed: ${error?.message ?? error}` }) } catch { /* the warning above is enough */ }
      }
    }
    return next
  }

  // Once task.ci is settled, for any reason (the monitor's own pass, rounds or timeout, or a tool: ci_stop,
  // mr_push_fix branch_changed), the Main bot is told once to advance to writeback. `mainNotified` is written first
  // (with `phaseAt`, the start of the Main bot's turn), so a restart in between never posts it twice.
  async function ciSettledNotice(w, ci) {
    if (!ci?.settled || ci.mainNotified) return ci
    const phaseAt = iso(now())
    await store.patchTask(w.taskId, { ci: { mainNotified: true, phaseAt } })
    const next = { ...ci, mainNotified: true, phaseAt }
    try { await store.appendRecord(w.taskId, { type: 'ci', run: w.runNo, step: 'ci', text: `CI settled (${ci.outcome}); told the Main bot to advance to writeback` }) } catch (error) { warn('chat-to-fix: monitor cannot record a ci change: %s', error?.message ?? error) }
    try { await nudge(w, CI_NUDGE.settled(next), 'ci-settled', 'main') } catch (error) { warn('chat-to-fix: monitor cannot tell the Main bot about the CI: %s', error?.message ?? error) }
    return next
  }

  /**
   * Called by check() while the task is in step ci. Initialises task.ci, polls getChecks every
   * ciPollSeconds while the status is pending, and settles on pass, round failure, or a wait that is too long.
   * Returns the current task.ci.
   */
  async function ciCheck(w, task) {
    let ci = task.ci
    const t = now()
    if (!ci) ci = await commitCi(w, {}, newCi(task.mr?.sha, iso(t)), 'waiting for the pipeline of the merge request')
    if (ci.settled || ci.status !== 'pending') return ci

    const since = ms(ci.since) ?? t
    if (t - w.ciPolledAt >= limits.ciPollSeconds * 1000) {
      w.ciPolledAt = t
      let checks
      try {
        if (typeof repo?.getChecks !== 'function') throw new Error('the repository adapter has no getChecks')
        if (!task.binding) throw new Error('the task has no channel binding')
        checks = await repo.getChecks(task.binding, task.mr?.iid)
      } catch (error) { warn('chat-to-fix: monitor cannot read the CI checks of %s: %s', w.taskId, error?.message ?? error) }
      if (checks) {
        // A tool may have changed task.ci while the request was out (mr_push_fix, ci_stop): act only on what is still true.
        const fresh = await store.getTask(w.taskId)
        if (!fresh || fresh.state !== 'running' || !fresh.ci || fresh.ci.settled || fresh.ci.status !== 'pending' || fresh.ci.sha !== ci.sha) return fresh?.ci ?? ci
        ci = fresh.ci
        // Only the pipeline of the commit being waited for counts; an older one is ignored.
        if (!ci.sha || checks.sha === ci.sha) {
          const patch: any = {}
          if (!ci.sha && checks.sha) patch.sha = checks.sha
          if (checks.pipelineUrl && checks.pipelineUrl !== ci.pipelineUrl) patch.pipelineUrl = checks.pipelineUrl
          if (Object.keys(patch).length > 0) ci = await commitCi(w, ci, patch, `pipeline: ${checks.pipelineUrl ?? '-'}`)
          if (checks.status === 'passed') return ciPassed(w, task, ci, now())
          if (checks.status === 'failed') {
            if (!ci.retried) return ciRetry(w, task, ci, checks)
            return ciFailed(w, task, ci, checks, now())
          }
        }
      }
    }

    // Waiting too long: for this commit (ciWaitMinutes) or over all rounds (ciTotalMinutes).
    const t2 = now()
    const waited = ci.waitedMs + Math.max(0, t2 - since)
    if (t2 - since > limits.ciWaitMinutes * MINUTE || waited > limits.ciTotalMinutes * MINUTE) {
      const timedOut = !!ci.pipelineUrl || waited > limits.ciTotalMinutes * MINUTE
      const note = timedOut ? 'wait timed out' : `no pipeline was triggered within ${limits.ciWaitMinutes} minutes`
      return ciNoPipeline(w, task, ci, t2, timedOut, note)
    }
    return ci
  }

  // One pass of the eight checks over one task. Returns after the first check that ends the task.
  // (The seventh check, approvals, is event driven: see onApproval.)
  async function check(w) {
    const task = await store.getTask(w.taskId)
    if (!task || task.state !== 'running') { watched.delete(w.taskId); return }
    adopt(w, task)
    let t = now()

    // 5. Idle-relay pause.
    if (w.idleRelay) return endTask(w, 'failed', 'idle_relay', 'idle_relay', 'ended the task (failed)')

    // 8. CI wait (spec 7, 4.4). While the status is pending the system is waiting for a pipeline, not a bot:
    // the step limit and the quiet-group check are skipped and the waiting time is not task time. While the bots
    // fix a failed round the usual limits apply, counted from that failure.
    let waiting = false
    let waited = 0
    w.lead = 'main'
    if (w.step === 'ci') {
      let ci = await ciCheck(w, task)
      ci = await ciSettledNotice(w, ci)
      t = now()
      waiting = !!ci && !ci.settled && ci.status === 'pending'
      waited = (ci?.waitedMs ?? 0) + (waiting ? Math.max(0, t - (ms(ci.since) ?? t)) : 0)
      // The Pipeline bot leads a fix round; once settled it is the Main bot's turn to advance.
      if (ci && !ci.settled) w.lead = 'pipeline'
      // The phase starts at the failure; once settled, at the message to the Main bot (phaseAt is rewritten then).
      const phaseAtText = ci?.phaseAt
      const phaseKey = waiting ? `wait:${ci.since}` : (phaseAtText ?? null)
      if (phaseKey !== w.ciPhaseKey) { // a new phase: the step timer, the nudge flag and the quiet nudges start afresh
        w.ciPhaseKey = phaseKey
        w.stepNudgedAt = null
        w.quietNudges = 0
      }
      const phaseAt = waiting ? null : ms(phaseAtText)
      if (phaseAt !== null) w.stepStart = Math.max(w.stepStart, phaseAt)
      if (waiting) w.quietSince = null
    } else w.ciPhaseKey = null

    // 1. Total task time, counted from the start of this run (the time spent waiting for CI is not counted).
    if (t - w.runStart - waited > limits.taskMinutes * MINUTE) {
      return endTask(w, 'timed_out', 'task_timeout', 'task_timeout', 'ended the task (timed_out)')
    }

    // 3. Coding time limit.
    if (w.step === 'code') {
      const minutes = stepMinutes('code')
      if (minutes !== undefined && t - w.stepStart > minutes * MINUTE) {
        try { if (w.bots.coding) await botlayer.stopBot(w.bots.coding) } catch (error) { warn('chat-to-fix: monitor cannot stop the Coding bot: %s', error?.message ?? error) }
        return endTask(w, 'timed_out', 'coding_timeout', 'coding_timeout', 'stopped the Coding bot and ended the task (timed_out)')
      }
    }

    // 2. Step time limit (other than coding): nudge once, then end after one more limit.
    const minutes = w.step && w.step !== 'code' && !waiting ? stepMinutes(w.step) : undefined
    if (minutes !== undefined) {
      if (w.stepNudgedAt === null) {
        if (t - w.stepStart > minutes * MINUTE) {
          w.stepNudgedAt = t
          await record(w, 'step_timeout', `posted a message to the ${w.lead === 'pipeline' ? 'Pipeline' : 'Main'} bot about step ${w.step}`)
          await nudge(w, NUDGE.stepTimeout(w.step, minutes), 'step', w.lead)
        }
      } else if (t - w.stepNudgedAt > minutes * MINUTE) {
        return endTask(w, 'failed', 'step_timeout', 'step_timeout', 'ended the task (failed) after the nudge')
      }
    }

    // 6. Claude Code produces no output while its turn is running.
    if (w.turnRunning && t - w.lastCodingEventAt > limits.engineSilentMinutes * MINUTE) {
      w.engineSilentCount += 1
      if (w.engineSilentCount >= 2) {
        return endTask(w, 'failed', 'engine_silent', 'engine_silent', 'ended the task (failed), second silence')
      }
      w.turnRunning = false
      w.lastCodingEventAt = t
      await record(w, 'engine_silent', `stopped the Coding bot and asked the ${w.lead === 'pipeline' ? 'Pipeline' : 'Main'} bot to call it again`)
      try { if (w.bots.coding) await botlayer.stopBot(w.bots.coding) } catch (error) { warn('chat-to-fix: monitor cannot stop the Coding bot: %s', error?.message ?? error) }
      await nudge(w, w.lead === 'pipeline' ? NUDGE.ciEngineSilent(limits.engineSilentMinutes) : NUDGE.engineSilent(limits.engineSilentMinutes), 'engine', w.lead)
    }

    // 4. Group quiet (not while waiting for CI).
    if (!waiting && w.groupId && botlayer.isQuiet(w.groupId)) {
      if (w.quietSince === null) w.quietSince = t
      else if (t - w.quietSince > limits.quietMinutes * MINUTE) {
        if (w.quietNudges < limits.quietNudges) {
          w.quietNudges += 1
          w.quietSince = t
          await record(w, 'stalled', `posted nudge ${w.quietNudges} of ${limits.quietNudges} to the ${w.lead === 'pipeline' ? 'Pipeline' : 'Main'} bot`)
          await nudge(w, w.lead === 'pipeline' ? NUDGE.ciQuiet(limits.quietMinutes) : NUDGE.quiet(limits.quietMinutes), 'quiet', w.lead)
        } else {
          return endTask(w, 'failed', 'stalled', 'stalled', 'ended the task (failed) after the nudges')
        }
      }
    } else {
      w.quietSince = null
    }
  }

  async function runTick() {
    for (const w of [...watched.values()]) {
      if (w.ended) continue
      try { await check(w) } catch (error) { warn('chat-to-fix: monitor check failed for %s: %s', w.taskId, error?.message ?? error) }
    }
  }

  // Passes never overlap: a tick that is still running is shared.
  function tick() {
    if (!ticking) ticking = runTick().finally(() => { ticking = null })
    return ticking
  }

  // ---- system notices (spec 4.6) -------------------------------------------------------------

  // Writes the `system` record and sends the text to the original discussion; a failure only warns.
  async function deliver(full, kind, text) {
    if (full?.id) {
      try { await store.appendRecord(full.id, { type: 'system', run: null, text: `notice ${kind}: ${text}` }) } catch (error) { warn('chat-to-fix: monitor cannot record a notice: %s', error?.message ?? error) }
    }
    if (typeof send !== 'function') return
    try { await send(full?.origin, text, kind) } catch (error) { warn('chat-to-fix: system notice %s not sent: %s', kind, error?.message ?? error) }
  }

  async function notify(task, kind) {
    if (!NOTICE[kind]) { warn('chat-to-fix: monitor has no notice for kind %s', kind); return }
    let full = task
    if (task?.id && task.jira === undefined && task.repo === undefined) {
      try { full = { ...(await store.getTask(task.id)), ...task } } catch { /* the notice goes without them */ }
    }
    // A task ended as "needs a person" is state failed; the Slack side gets it as its own kind (docs/slack/slackbot.md 4.2(2)).
    const sentKind = kind === 'failed' && full?.endReason === 'needs_person' ? 'needs_person' : kind
    await deliver(full, sentKind, noticeText(language, kind, full))
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  function start() {
    if (timer) return
    subscribe()
    timer = setInterval(() => { tick().catch((error) => warn('chat-to-fix: monitor tick failed: %s', error?.message ?? error)) }, intervalMs)
    timer.unref?.()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    unsubscribe()
  }

  return { watch, unwatch, notify, tick, start, stop }
}
