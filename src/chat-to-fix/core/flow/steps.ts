// Flow definition (I7, spec 1 section 2.3). Everything about the order of the steps, who is in
// charge, what counts as done, and which write tools are allowed lives in this file as data.
// Changing the role in charge of a step, or swapping two steps, is an edit here only: the gate
// (core/task/gate.ts) reads the table and evaluates the evidence with one evaluator.
//
// Evidence strings (evaluated by gate.js against the task):
//   "<path>"            the field at <path> (dotted, on the task) has a value / is true
//   "<path> == <text>"  the field equals the text
//   "diff"              the code directory has changes relative to repo.base (adapter diff)
//   "diff.withinLimits" the change is within diffMaxFiles / diffMaxLines
//   "ended"             the task has ended (its state is no longer queued or running)
// In a close rule, "note" is the note given to close().
//
// writeTools: "tool" or "tool:purpose" (slack_reply is keyed by purpose).

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

export const STEPS = deepFreeze([
  { no: 1, id: 'fetch', roles: ['slack'], evidence: ['slack.readAt', 'slack.sent.ack', 'stepResults.fetch'], writeTools: ['slack_reply:ack'] },
  { no: 2, id: 'issue', roles: ['jira'], evidence: ['jira.key'], writeTools: ['jira_assess_request', 'jira_create_issue'] },
  { no: 3, id: 'prepare', roles: ['pipeline'], evidence: ['repo.dir', 'repo.branch', 'repo.base'], writeTools: ['repo_prepare'] },
  { no: 4, id: 'code', roles: ['coding'], evidence: ['diff', 'review.verdict == pass'], writeTools: ['request_review'] },
  { no: 5, id: 'mr', roles: ['pipeline'], evidence: ['mr.url'], writeTools: ['mr_open_draft'] },
  // Step ci (spec 7, 4.2): the system waits for the MR pipeline and counts rounds (monitor.ts); the fix loop runs
  // inside this step. request_review is also a write tool of step code, so a tool may belong to several steps.
  { no: 6, id: 'ci', roles: ['pipeline', 'coding'], evidence: ['ci.settled'], writeTools: ['mr_push_fix', 'request_review', 'review_report', 'ci_stop'] },
  { no: 7, id: 'writeback', roles: ['jira', 'slack'], evidence: ['jira.commentedMr', 'slack.sent.result'], writeTools: ['jira_add_comment', 'jira_transition', 'slack_reply:result'] },
  { no: 8, id: 'close', roles: ['main'], evidence: ['ended'], writeTools: [] },
])

/**
 * Write tools not bound to a step. `requires` is evidence that must hold; `reason` is what a
 * refusal says when it does not. task_advance and task_close are gated by their own rules
 * (advance / close in gate.js), not by allow().
 */
export const UNBOUND_WRITE_TOOLS = deepFreeze([
  { tool: 'needs_info_confirm', requires: [] },
  { tool: 'slack_reply:question', requires: ['needsInfo.main', 'needsInfoPeer'], reason: 'the main bot and the bot responsible for this step must confirm that information is missing first' },
  { tool: 'task_advance', requires: [] },
  { tool: 'task_close', requires: [] },
])

/**
 * Extra evidence a tool needs on top of being in its step. Each item carries the reason given
 * when it fails.
 */
export const TOOL_EXTRA_EVIDENCE = deepFreeze({
  mr_open_draft: [
    { evidence: 'review.verdict == pass', reason: 'the review has not passed' },
    { evidence: 'diff.withinLimits', reason: 'the change exceeds the size limit' },
  ],
  // Spec 7, 4.2: the monitor clears task.review whenever a CI round fails, so a pass here is this round's.
  mr_push_fix: [
    { evidence: 'review.verdict == pass', reason: 'the review has not passed' },
    { evidence: 'diff.withinLimits', reason: 'the change exceeds the size limit' },
  ],
})

/** Spec 7, 4.8: the end reason of outcome `done` by task.ci.outcome. `passed` and no ci at all give `completed`. */
export const CI_END_REASONS = deepFreeze({
  passed: 'completed',
  rounds_exhausted: 'completed_ci_failed',
  not_locatable: 'completed_ci_stopped',
  out_of_scope: 'completed_ci_stopped',
  not_fixable: 'completed_ci_stopped',
  branch_changed: 'completed_ci_stopped',
  no_pipeline: 'completed_no_ci',
})

/**
 * What close(outcome) needs and what it writes. `requires` is evidence; `endReason` is a
 * literal, or "$note" for the note text.
 */
export const OUTCOME_RULES = deepFreeze({
  // endReason is the default; `endReasonBy` (spec 7, 4.8) picks the reason from a task field. Use closeEndReason().
  done: { requires: ['step == close'], state: 'done', endReason: 'completed', endReasonBy: { path: 'ci.outcome', map: CI_END_REASONS }, reason: 'the task is not in step close' },
  needs_info: { requires: ['needsInfo.main', 'needsInfoPeer', 'slack.sent.question'], state: 'needs_info', endReason: 'needs_info', reason: 'both confirmations and the question to Slack are required first' },
  failed: { requires: ['note'], state: 'failed', endReason: '$note', reason: 'a note is required' },
  needs_person: { requires: ['note'], state: 'failed', endReason: 'needs_person', reason: 'a note is required' },
})

/** The end reason close(outcome) writes for a task: the rule's literal, "$note", or (done) the one chosen by ci.outcome. */
export function closeEndReason(outcome, task, note = '', rules = OUTCOME_RULES) {
  const rule = Object.hasOwn(rules, outcome) ? rules[outcome] : undefined
  if (!rule) return undefined
  if (rule.endReason === '$note') return String(note ?? '').trim()
  const by = rule.endReasonBy
  if (by) {
    let value = task
    for (const key of by.path.split('.')) value = value?.[key]
    if (typeof value === 'string' && Object.hasOwn(by.map, value)) return by.map[value]
  }
  return rule.endReason
}

const baseTool = (entry) => String(entry).split(':')[0]

/** Build lookup helpers over a set of step definitions (the default flow, or a modified copy). */
export function createFlow(steps = STEPS, unbound = UNBOUND_WRITE_TOOLS) {
  const stepDef = (id) => steps.find((step) => step.id === id)
  const nextStep = (id) => {
    const index = steps.findIndex((step) => step.id === id)
    return index < 0 ? undefined : steps[index + 1]
  }
  // Spec 7, 4.2 (D2): a write tool may be listed by several steps. Returns every step id that lists
  // the tool; [] when it is not bound to any step. A tool with a purpose is looked up as
  // "tool:purpose" first, then as plain "tool"; the first key that any step lists decides.
  const stepsOfWriteTool = (toolName: string, purpose?: string) => {
    const keys = purpose ? [`${toolName}:${purpose}`, toolName] : [toolName]
    for (const key of keys) {
      const hits = steps.filter((candidate) => candidate.writeTools.includes(key))
      if (hits.length > 0) return hits.map((step) => step.id)
    }
    return []
  }
  // Single-step view, the old contract: the first step that lists the tool; null when it is not
  // bound to a step (any step); undefined when it is no known write tool. A tool that belongs to
  // several steps must be checked with stepsOfWriteTool (gate.allow does, after spec 7 3b).
  const stepOfWriteTool = (toolName: string, purpose?: string) => {
    const [first] = stepsOfWriteTool(toolName, purpose)
    if (first !== undefined) return first
    const keys = purpose ? [`${toolName}:${purpose}`, toolName] : [toolName]
    for (const key of keys) if (unbound.some((entry) => entry.tool === key)) return null
    return undefined
  }
  const unboundEntry = (toolName, purpose) => {
    const keys = purpose ? [`${toolName}:${purpose}`, toolName] : [toolName]
    for (const key of keys) {
      const hit = unbound.find((entry) => entry.tool === key)
      if (hit) return hit
    }
    return undefined
  }
  return { steps, unbound, stepDef, nextStep, stepOfWriteTool, stepsOfWriteTool, unboundEntry }
}

const defaultFlow = createFlow()
export const stepDef = defaultFlow.stepDef
export const nextStep = defaultFlow.nextStep
export const stepOfWriteTool = defaultFlow.stepOfWriteTool
export const stepsOfWriteTool = defaultFlow.stepsOfWriteTool

/**
 * Startup checks on a flow (default: the real one) against a registry (list of bot
 * definitions). Returns a list of problems; empty means valid.
 */
export function validateFlow(registry, steps = STEPS, unbound = UNBOUND_WRITE_TOOLS) {
  const problems = []
  const defs = Array.isArray(registry) ? registry : Object.values(registry ?? {})
  const roles = new Set(defs.map((def) => def.role))
  const registered = new Set(defs.flatMap((def) => def.tools ?? []))
  const ids = new Set()
  steps.forEach((step, index) => {
    if (step.no !== index + 1) problems.push(`step ${step.id}: number ${step.no} is not ${index + 1}; numbers must be consecutive from 1`)
    if (ids.has(step.id)) problems.push(`step ${step.id}: duplicate step id`)
    ids.add(step.id)
    if (!Array.isArray(step.roles) || step.roles.length === 0) problems.push(`step ${step.id}: no role in charge`)
    for (const role of step.roles ?? []) if (!roles.has(role)) problems.push(`step ${step.id}: role ${role} is not in the registry`)
    if (!Array.isArray(step.evidence) || step.evidence.length === 0) problems.push(`step ${step.id}: no evidence`)
    for (const entry of step.writeTools ?? []) {
      if (!registered.has(baseTool(entry))) problems.push(`step ${step.id}: write tool ${baseTool(entry)} is not in any bot's tools`)
    }
  })
  for (const entry of unbound) {
    if (!registered.has(baseTool(entry.tool))) problems.push(`unbound write tool ${baseTool(entry.tool)} is not in any bot's tools`)
  }
  return problems
}
