// The monitor (work package B7, spec 3 sections 4.5, 4.6 and 4.8).
// Enforces the time limits, nudges a quiet group, rejects approvals and sends system notices.
// It never reads a DS Bot or DSH object directly: only the I1 facade events and the I2 store.

// ---------------------------------------------------------------------------------------------
// Templates. Nudges go to the Main bot as the user; notices go to the original Slack discussion.
// ---------------------------------------------------------------------------------------------

export const NUDGE = Object.freeze({
  stepTimeout: (step, minutes) =>
    `[system] Step "${step}" has taken more than ${minutes} minutes. Finish it now, or tell me what is blocking it. If it is not finished after another ${minutes} minutes the task is ended.`,
  quiet: (minutes) =>
    `[system] Nobody in the group has done anything for ${minutes} minutes. Continue with the current step by calling the right bot, or close the task if it cannot go on.`,
  engineSilent: (minutes) =>
    `[system] The Coding bot (Claude Code) produced no output for ${minutes} minutes and its turn was stopped. Call the Coding bot again with the same request.`,
})

const where = (task) => {
  const extra = []
  if (task?.jira?.key) extra.push(`Jira: ${task.jira.key}`)
  if (task?.repo?.branch) extra.push(`Branch: ${task.repo.branch}`)
  return extra.length > 0 ? ` ${extra.join(', ')}.` : ''
}
const ref = (task) => (task?.id ? `Task ${task.id}` : 'This request')

export const NOTICE = Object.freeze({
  in_progress: (task) => `${ref(task)} is already in progress for this discussion.${where(task)}`,
  queue_full: () => 'The fix queue is full, so this request was not accepted. Please try again later.',
  channel_not_bound: () => 'This channel is not set up for Chat-to-Fix, so this request was not accepted.',
  timed_out: (task) => `${ref(task)} timed out${task?.endReason ? ` (${task.endReason})` : ''} and was ended.${where(task)}`,
  failed: (task) => `${ref(task)} could not be completed${task?.endReason ? ` (${task.endReason})` : ''}.${where(task)}`,
  expired: (task) => `${ref(task)} waited too long in the queue and expired. Mention the bot again to retry.${where(task)}`,
  stopped: (task) => `${ref(task)} was stopped.${where(task)}`,
})

export const NOTICE_KINDS = Object.freeze(Object.keys(NOTICE))

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

export function createMonitor({ store, botlayer, limits, end, send, now = () => Date.now(), warn = (...a) => console.warn(...a), intervalMs = 5000 }) {
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
    const subs = [
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

  function watch(taskId, opts = {}) {
    const t = now()
    const w = {
      taskId, watchedAt: t, baseAt: opts.restarted ? t : 0, restarted: !!opts.restarted,
      groupId: null, bots: {}, runNo: null, step: null, stepKey: undefined, stepStart: t, runStart: t,
      stepNudgedAt: null, quietSince: null, quietNudges: 0,
      lastCodingEventAt: t, turnRunning: false, engineSilentCount: 0, idleRelay: false, ended: false,
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

  async function nudge(w, text, kind) {
    const requestId = `${w.taskId}:${kind}:${now()}`
    await botlayer.postTask(w.groupId, text, requestId)
  }

  // Ends the task at most once: the flag is set before anything is awaited.
  async function endTask(w, state, endReason, check, action) {
    if (w.ended) return
    w.ended = true
    try { await record(w, check, action) } catch (error) { warn('chat-to-fix: monitor cannot record %s: %s', check, error?.message ?? error) }
    try { await end(w.taskId, state, endReason) } catch (error) { warn('chat-to-fix: monitor cannot end %s: %s', w.taskId, error?.message ?? error) }
    watched.delete(w.taskId)
  }

  // One pass of the seven checks over one task. Returns after the first check that ends the task.
  // (The seventh check, approvals, is event driven: see onApproval.)
  async function check(w) {
    const task = await store.getTask(w.taskId)
    if (!task || task.state !== 'running') { watched.delete(w.taskId); return }
    adopt(w, task)
    const t = now()

    // 5. Idle-relay pause.
    if (w.idleRelay) return endTask(w, 'failed', 'idle_relay', 'idle_relay', 'ended the task (failed)')

    // 1. Total task time, counted from the start of this run.
    if (t - w.runStart > limits.taskMinutes * MINUTE) {
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
    const minutes = w.step && w.step !== 'code' ? stepMinutes(w.step) : undefined
    if (minutes !== undefined) {
      if (w.stepNudgedAt === null) {
        if (t - w.stepStart > minutes * MINUTE) {
          w.stepNudgedAt = t
          await record(w, 'step_timeout', `posted a message to the Main bot about step ${w.step}`)
          await nudge(w, NUDGE.stepTimeout(w.step, minutes), 'step')
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
      await record(w, 'engine_silent', 'stopped the Coding bot and asked the Main bot to call it again')
      try { if (w.bots.coding) await botlayer.stopBot(w.bots.coding) } catch (error) { warn('chat-to-fix: monitor cannot stop the Coding bot: %s', error?.message ?? error) }
      await nudge(w, NUDGE.engineSilent(limits.engineSilentMinutes), 'engine')
    }

    // 4. Group quiet.
    if (w.groupId && botlayer.isQuiet(w.groupId)) {
      if (w.quietSince === null) w.quietSince = t
      else if (t - w.quietSince > limits.quietMinutes * MINUTE) {
        if (w.quietNudges < limits.quietNudges) {
          w.quietNudges += 1
          w.quietSince = t
          await record(w, 'stalled', `posted nudge ${w.quietNudges} of ${limits.quietNudges} to the Main bot`)
          await nudge(w, NUDGE.quiet(limits.quietMinutes), 'quiet')
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

  async function notify(task, kind) {
    const template = NOTICE[kind]
    if (!template) { warn('chat-to-fix: monitor has no notice for kind %s', kind); return }
    let full = task
    if (task?.id && task.jira === undefined && task.repo === undefined) {
      try { full = { ...(await store.getTask(task.id)), ...task } } catch { /* the notice goes without them */ }
    }
    const text = template(full)
    if (full?.id) {
      try { await store.appendRecord(full.id, { type: 'system', run: null, text: `notice ${kind}: ${text}` }) } catch (error) { warn('chat-to-fix: monitor cannot record a notice: %s', error?.message ?? error) }
    }
    if (typeof send !== 'function') return
    try { await send(full?.origin, text) } catch (error) { warn('chat-to-fix: system notice %s not sent: %s', kind, error?.message ?? error) }
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
