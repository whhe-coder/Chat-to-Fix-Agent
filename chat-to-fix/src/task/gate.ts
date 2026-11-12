// Step checks (I3, spec 1 sections 3 and 4). The gate holds no flow knowledge of its own: the
// order of steps, evidence, allowed tools and close rules all come from src/flow/steps.ts, and
// one evaluator (evaluate) turns an evidence string into met / not met.

import { closeEndReason, createFlow, OUTCOME_RULES, TOOL_EXTRA_EVIDENCE } from '../flow/steps.ts'

const OTHER = { main: 'coding', coding: 'main' }
const ENDED_STATES = new Set(['done', 'needs_info', 'failed', 'timed_out', 'stopped', 'expired'])

const hasValue = (value) => value !== undefined && value !== null && value !== '' && value !== false

const pathValue = (object, path) => {
  let value = object
  for (const key of path.split('.')) {
    if (value === null || value === undefined) return undefined
    value = value[key]
  }
  return value
}

/**
 * @param {{store: object, repo: {diff: Function}, limits: {diffMaxFiles: number, diffMaxLines: number},
 *          onClosed?: Function, flow?: ReturnType<typeof createFlow>, now?: () => string}} options
 * `flow` defaults to the real flow definition; tests pass a modified copy.
 */
export function createGate({ store, repo, limits, onClosed, flow = createFlow(), now = () => new Date().toISOString() }) {
  async function record(task, entry) {
    const run = task.runs?.at?.(-1)?.no ?? null
    await store.appendRecord(task.id, { at: now(), taskId: task.id, run, step: task.step ?? null, role: null, botId: null, ...entry })
  }

  async function refuse(task, text, extra = {}) {
    await record(task, { type: 'refused', ok: false, text, ...extra })
    return text
  }

  // The one evidence evaluator. `ctx` carries values that are not task fields (the close note).
  // `memo` caches the diff for the duration of one check.
  async function evaluate(evidence, task, ctx, memo) {
    const text = String(evidence).trim()
    if (text === 'ended') return ENDED_STATES.has(task.state)
    if (text === 'diff' || text === 'diff.withinLimits') {
      if (!memo.diff) {
        memo.diff = (async () => {
          if (!task.repo?.dir || !task.repo?.base) return undefined
          try { return await repo.diff(task.repo.dir, task.repo.base) } catch { return undefined }
        })()
      }
      const result = await memo.diff
      if (!result) return false
      if (text === 'diff') return (result.totalFiles ?? result.files?.length ?? 0) > 0
      return result.totalFiles <= limits.diffMaxFiles && result.totalLines <= limits.diffMaxLines
    }
    const eq = text.indexOf(' == ')
    const view = { ...task, ...ctx }
    if (eq >= 0) return String(pathValue(view, text.slice(0, eq).trim())) === text.slice(eq + 4).trim()
    const value = pathValue(view, text)
    return typeof value === 'string' ? value.trim() !== '' : hasValue(value)
  }

  async function missingOf(list, task, ctx = {}, memo = {}) {
    const missing = []
    for (const evidence of list) if (!(await evaluate(evidence, task, ctx, memo))) missing.push(evidence)
    return missing
  }

  async function load(taskId) {
    const task = await store.getTask(taskId)
    if (!task) throw new Error(`task ${taskId} not found`)
    return task
  }

  async function advance(taskId, toStep) {
    const task = await load(taskId)
    const current = flow.stepDef(task.step)
    if (!current) {
      const reason = `the current step ${task.step} is not a known step`
      await refuse(task, `advance to ${toStep} refused: ${reason}`)
      return { ok: false, missing: [], reason }
    }
    const next = flow.nextStep(current.id)
    if (!next || next.id !== toStep) {
      const reason = next ? `can only advance to the next step (${next.id}), not ${toStep}` : `${current.id} is the last step`
      await refuse(task, `advance to ${toStep} refused: ${reason}`)
      return { ok: false, missing: [], reason }
    }
    const missing = await missingOf(current.evidence, task)
    if (missing.length > 0) {
      await refuse(task, `advance to ${toStep} refused: missing ${missing.join(', ')}`)
      return { ok: false, missing }
    }
    await store.patchTask(taskId, { step: next.id, stepAt: now() })
    await record(task, { type: 'advance', text: `${current.id} -> ${next.id}` })
    return { ok: true }
  }

  async function allow(taskId, toolName, purpose) {
    const task = await load(taskId)
    const label = purpose ? `${toolName}(${purpose})` : toolName
    // A write tool may belong to several steps (spec 7, 4.2): it is allowed when the current step is one of them.
    const stepIds = flow.stepsOfWriteTool(toolName, purpose)
    // No step lists it: null = unbound (any step), undefined = no known write tool.
    const stepId = stepIds.length > 0 ? stepIds[0] : flow.stepOfWriteTool(toolName, purpose)
    if (stepId === undefined) {
      const reason = `${label} is not a known write tool`
      return { ok: false, reason: await refuse(task, reason, { tool: toolName }) }
    }
    const memo = {}
    if (stepId === null) {
      const entry = flow.unboundEntry(toolName, purpose)
      const missing = await missingOf(entry.requires, task, {}, memo)
      if (missing.length > 0) {
        const reason = `${label} refused: ${entry.reason ?? `missing ${missing.join(', ')}`}`
        return { ok: false, reason: await refuse(task, reason, { tool: toolName }) }
      }
      return { ok: true }
    }
    if (!stepIds.includes(task.step)) {
      const reason = `${label} belongs to step ${stepIds.join(' or ')}, the task is in step ${task.step}`
      return { ok: false, reason: await refuse(task, reason, { tool: toolName }) }
    }
    for (const extra of TOOL_EXTRA_EVIDENCE[toolName] ?? []) {
      if (!(await evaluate(extra.evidence, task, {}, memo))) {
        const reason = `${label} refused: ${extra.reason}`
        return { ok: false, reason: await refuse(task, reason, { tool: toolName }) }
      }
    }
    return { ok: true }
  }

  async function confirmNeedsInfo(taskId, role, text) {
    const task = await load(taskId)
    if (!(role in OTHER)) {
      const reason = `needs_info_confirm refused: role ${role} cannot confirm; only main and coding can`
      await refuse(task, reason, { tool: 'needs_info_confirm' })
      throw new Error(reason)
    }
    await store.patchTask(taskId, { needsInfo: { [role]: { text: String(text ?? ''), at: now() } } })
    await record(task, { type: 'system', role, tool: 'needs_info_confirm', text: `needs info confirmed by ${role}` })
    return { other: hasValue(task.needsInfo?.[OTHER[role]]) }
  }

  async function close(taskId, outcome, note) {
    const task = await load(taskId)
    const rule = Object.hasOwn(OUTCOME_RULES, outcome) ? OUTCOME_RULES[outcome] : undefined
    const refused = async (reason) => ({ ok: false, reason: await refuse(task, `close(${outcome}) refused: ${reason}`, { tool: 'task_close' }) })
    if (!rule) return refused(`unknown outcome ${outcome}`)
    if (ENDED_STATES.has(task.state)) return refused(`the task has already ended (${task.state})`)
    const trimmed = typeof note === 'string' ? note.trim() : ''
    const missing = await missingOf(rule.requires, task, { note: trimmed })
    if (missing.length > 0) return refused(`${rule.reason} (missing ${missing.join(', ')})`)
    // Spec 7, 4.8: outcome done takes its end reason from task.ci.outcome.
    const endReason = closeEndReason(outcome, task, trimmed)
    // The note is kept for the requester's end notice (needs_person has only a literal end reason).
    await store.patchTask(taskId, { state: rule.state, endReason, ...(trimmed ? { closeNote: trimmed } : {}) })
    await record(task, { type: 'system', tool: 'task_close', ok: true, text: `closed: ${outcome}, state ${rule.state}, end reason ${endReason}` })
    await onClosed?.(taskId, rule.state, endReason)
    return { ok: true }
  }

  return { advance, allow, confirmNeedsInfo, close }
}
