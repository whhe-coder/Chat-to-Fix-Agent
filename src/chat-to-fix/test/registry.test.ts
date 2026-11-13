import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allBotDefs, botDef, toolsOfRole, validateRegistry } from '../core/registry/bots.ts'
import { STEPS, stepDef, nextStep, stepOfWriteTool, stepsOfWriteTool, validateFlow, createFlow, closeEndReason, CI_END_REASONS } from '../core/flow/steps.ts'
import { ROLES, STEP_IDS, RECORD_TYPES, CI_OUTCOMES, CI_STOP_REASONS, CI_TOOL_PARAMETERS, DONE_END_REASONS, newCi } from '../core/task/contracts.ts'
import { ciTools } from '../core/tools/ci.ts'

test('five bots with the spec fields', () => {
  const defs = allBotDefs()
  assert.deepEqual(defs.map((d) => d.role), [...ROLES])
  assert.deepEqual(defs.map((d) => d.name), ['Main', 'Slack', 'Jira', 'Pipeline', 'Coding'])
  assert.deepEqual(defs.map((d) => d.label), ['Flow', 'Slack', 'Jira', 'GitLab', 'Coding'])
  // Every bot is a DSH session on an API route; the entries differ only in data.
  assert.equal(botDef('coding').model, 'codingModel')
  assert.equal(botDef('coding').effort, 'codingEffort')
  assert.equal(botDef('coding').permission, 'workspace-write')
  assert.equal(botDef('coding').preset, 'coding')
  for (const role of ['main', 'slack', 'jira', 'pipeline']) {
    assert.equal(botDef(role).model, 'apiModel')
    assert.equal(botDef(role).permission, 'read-only')
    assert.equal(botDef(role).preset, 'readonly')
    assert.equal(botDef(role).effort, undefined)
  }
  const fields = new Set(['role', 'name', 'label', 'instructions', 'model', 'effort', 'permission', 'preset', 'tools', 'reviewer'])
  for (const def of defs) for (const key of Object.keys(def)) assert.ok(fields.has(key), `${def.role}: ${key}`)
  assert.deepEqual(toolsOfRole('main'), ['task_records', 'task_advance', 'task_close', 'needs_info_confirm'])
  assert.deepEqual(toolsOfRole('coding'), ['repo_diff', 'run_tests', 'request_review', 'request_code', 'review_report', 'needs_info_confirm'])
  assert.deepEqual(toolsOfRole('nobody'), [])
  assert.equal(botDef('nobody'), undefined)
})

test('coding carries the reviewer, others do not', () => {
  const reviewer = botDef('coding').reviewer
  assert.deepEqual(reviewer, { instructions: 'reviewer.md', preset: 'readonly' })
  for (const role of ['main', 'slack', 'jira', 'pipeline']) assert.equal(botDef(role).reviewer, undefined)
})

test('eight steps in order, with the spec data', () => {
  assert.deepEqual(STEPS.map((s) => s.id), [...STEP_IDS])
  assert.deepEqual(STEPS.map((s) => s.no), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(stepDef('writeback').roles, ['jira', 'slack'])
  // Spec 7, 4.2: the sixth step is ci.
  assert.deepEqual(STEPS.map((s) => s.id).slice(4, 7), ['mr', 'ci', 'writeback'])
  assert.deepEqual(stepDef('ci').roles, ['pipeline', 'coding'])
  assert.deepEqual(stepDef('ci').evidence, ['ci.settled'])
  assert.deepEqual(stepDef('ci').writeTools, ['mr_push_fix', 'request_review', 'review_report', 'ci_stop'])
  assert.deepEqual(stepDef('code').writeTools, ['request_review'])
  assert.equal(nextStep('mr').id, 'ci')
  assert.equal(nextStep('ci').id, 'writeback')
  assert.deepEqual(stepDef('code').evidence, ['diff', 'review.verdict == pass'])
  assert.equal(nextStep('fetch').id, 'issue')
  assert.equal(nextStep('close'), undefined)
  assert.equal(stepDef('nope'), undefined)
})

test('stepOfWriteTool: bound, purpose-keyed, unbound, unknown', () => {
  assert.equal((stepOfWriteTool as any)('mr_open_draft'), 'mr')
  assert.equal((stepOfWriteTool as any)('slack_reply', 'ack'), 'fetch')
  assert.equal((stepOfWriteTool as any)('slack_reply', 'result'), 'writeback')
  assert.equal((stepOfWriteTool as any)('slack_reply', 'question'), null)
  assert.equal((stepOfWriteTool as any)('needs_info_confirm'), null)
  assert.equal((stepOfWriteTool as any)('task_close'), null)
  assert.equal((stepOfWriteTool as any)('slack_reply'), undefined)
  assert.equal((stepOfWriteTool as any)('rm_rf'), undefined)
})

test('stepsOfWriteTool: one tool in several steps; the single-step view keeps its old answers', () => {
  assert.deepEqual(stepsOfWriteTool('request_review'), ['code', 'ci'])
  assert.deepEqual(stepsOfWriteTool('review_report'), ['ci'])
  assert.deepEqual(stepsOfWriteTool('mr_push_fix'), ['ci'])
  assert.deepEqual(stepsOfWriteTool('ci_stop'), ['ci'])
  assert.deepEqual(stepsOfWriteTool('mr_open_draft'), ['mr'])
  assert.deepEqual(stepsOfWriteTool('slack_reply', 'result'), ['writeback'])
  assert.deepEqual(stepsOfWriteTool('slack_reply', 'question'), [])
  assert.deepEqual(stepsOfWriteTool('rm_rf'), [])
  assert.equal((stepOfWriteTool as any)('request_review'), 'code')
  assert.equal((stepOfWriteTool as any)('ci_stop'), 'ci')
  // createFlow on a modified copy answers the same way.
  const flow = createFlow(STEPS.filter((s) => s.id !== 'code'))
  assert.deepEqual(flow.stepsOfWriteTool('request_review'), ['ci'])
})

test('closeEndReason: done follows task.ci.outcome (spec 7, 4.8); the other outcomes are unchanged', () => {
  const done = (ci) => closeEndReason('done', { ci })
  assert.equal(done(null), 'completed')
  assert.equal(done({ outcome: null }), 'completed')
  assert.equal(done({ outcome: 'passed' }), 'completed')
  assert.equal(done({ outcome: 'rounds_exhausted' }), 'completed_ci_failed')
  for (const outcome of ['not_locatable', 'out_of_scope', 'not_fixable', 'branch_changed']) assert.equal(done({ outcome }), 'completed_ci_stopped', outcome)
  assert.equal(done({ outcome: 'no_pipeline' }), 'completed_no_ci')
  assert.equal(closeEndReason('failed', {}, ' because '), 'because')
  assert.equal(closeEndReason('needs_info', {}), 'needs_info')
  assert.equal(closeEndReason('nope', {}), undefined)
  // every end reason of a done task is a known one, and every CI outcome has a reason
  for (const outcome of CI_OUTCOMES) assert.ok(DONE_END_REASONS.includes(CI_END_REASONS[outcome]), outcome)
})

test('the CI contracts: shapes, constants and tool definitions line up', () => {
  assert.deepEqual(STEP_IDS.slice(4, 7), ['mr', 'ci', 'writeback'])
  assert.ok(RECORD_TYPES.includes('ci'))
  assert.deepEqual([...CI_STOP_REASONS], ['not_locatable', 'out_of_scope', 'not_fixable'])
  for (const reason of CI_STOP_REASONS) assert.ok(CI_OUTCOMES.includes(reason))
  const ci = newCi('abc', '2026-11-12T00:00:00Z', { round: 1, waitedMs: 5 })
  assert.deepEqual(ci, { status: 'pending', sha: 'abc', round: 1, retried: false, since: '2026-11-12T00:00:00Z', waitedMs: 5, pipelineUrl: null, failedJobs: [], logRead: false, settled: false, outcome: null, note: null })
  assert.equal(newCi('abc', 'x').round, 0)
  // the tool definitions carry the contract's parameters and the registry/flow agree on who has them
  const defs: any = Object.fromEntries(ciTools().map((def) => [def.name, def]))
  assert.deepEqual(Object.keys(defs).sort(), Object.keys(CI_TOOL_PARAMETERS).sort())
  assert.deepEqual(defs.ci_stop.parameters.reason.enum, [...CI_STOP_REASONS])
  assert.deepEqual([defs.ci_read_log.write, defs.mr_push_fix.write, defs.ci_stop.write], [false, true, true])
  assert.ok(toolsOfRole('pipeline').includes('ci_read_log') && toolsOfRole('pipeline').includes('mr_push_fix'))
  assert.ok(toolsOfRole('pipeline').includes('ci_stop'))
  assert.ok(!toolsOfRole('main').includes('ci_stop'))
  assert.deepEqual(defs.ci_stop.roles, ['pipeline'])
})

test('the real registry and flow validate', () => {
  assert.deepEqual(validateRegistry(), [])
  assert.deepEqual(validateFlow(allBotDefs()), [])
})

test('validateRegistry finds duplicates and bad lengths', () => {
  const defs = structuredClone(allBotDefs())
  defs[1].role = 'main'
  defs[2].name = 'x'.repeat(41)
  defs[3].label = 'y'.repeat(25)
  const problems = validateRegistry(defs).join('\n')
  assert.match(problems, /duplicate role id/)
  assert.match(problems, /longer than 40/)
  assert.match(problems, /longer than 24/)
  const noReviewer = structuredClone(allBotDefs())
  delete noReviewer[4].reviewer
  assert.match(validateRegistry(noReviewer).join('\n'), /reviewer is missing/)
})

test('validateFlow finds non-consecutive numbers and unregistered tools', () => {
  const steps = structuredClone(STEPS)
  steps[2].no = 9
  steps[1].writeTools = ['jira_create_issue', 'ghost_tool']
  steps[0].roles = ['ghost']
  const problems = validateFlow(allBotDefs(), steps).join('\n')
  assert.match(problems, /not 3/)
  assert.match(problems, /ghost_tool/)
  assert.match(problems, /role ghost/)
})

test('adding a bot only touches bots.js: a new entry validates and is found', () => {
  const defs = [...structuredClone(allBotDefs()), {
    role: 'notify', name: 'Notify', label: 'Notify', instructions: 'notify.md', model: 'apiModel', permission: 'read-only', preset: 'readonly', tools: ['notify_send'],
  }]
  assert.deepEqual(validateRegistry(defs), [])
  assert.deepEqual(toolsOfRole('notify', defs), ['notify_send'])
  assert.equal(botDef('notify', defs).name, 'Notify')
  assert.deepEqual(validateFlow(defs), [])
})
