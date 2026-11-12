import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allBotDefs, botDef, toolsOfRole, validateRegistry } from '../src/registry/bots.ts'
import { STEPS, stepDef, nextStep, stepOfWriteTool, validateFlow } from '../src/flow/steps.ts'
import { ROLES, STEP_IDS } from '../src/task/contracts.ts'

test('five bots with the spec fields', () => {
  const defs = allBotDefs()
  assert.deepEqual(defs.map((d) => d.role), [...ROLES])
  assert.deepEqual(defs.map((d) => d.name), ['Main', 'Slack', 'Jira', 'Pipeline', 'Coding'])
  assert.deepEqual(defs.map((d) => d.label), ['Flow', 'Slack', 'Jira', 'GitLab', 'Claude Code'])
  assert.equal(botDef('coding').model, 'codingModel')
  assert.equal(botDef('coding').permission, 'codingPermission')
  for (const role of ['main', 'slack', 'jira', 'pipeline']) {
    assert.equal(botDef(role).model, 'apiModel')
    assert.equal(botDef(role).permission, 'read-only')
  }
  assert.deepEqual(toolsOfRole('main'), ['task_records', 'task_advance', 'task_close', 'needs_info_confirm'])
  assert.deepEqual(toolsOfRole('coding'), ['request_code', 'review_report', 'needs_info_confirm'])
  assert.deepEqual(toolsOfRole('nobody'), [])
  assert.equal(botDef('nobody'), undefined)
})

test('coding carries the reviewer, others do not', () => {
  const reviewer = botDef('coding').reviewer
  assert.equal(reviewer.name, 'reviewer')
  assert.ok(reviewer.instructions)
  assert.deepEqual(reviewer.tools, ['Read', 'Grep', 'Glob'])
  for (const role of ['main', 'slack', 'jira', 'pipeline']) assert.equal(botDef(role).reviewer, undefined)
})

test('seven steps in order, with the spec data', () => {
  assert.deepEqual(STEPS.map((s) => s.id), [...STEP_IDS])
  assert.deepEqual(STEPS.map((s) => s.no), [1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(stepDef('writeback').roles, ['jira', 'slack'])
  assert.deepEqual(stepDef('code').evidence, ['diff', 'review.verdict == pass'])
  assert.equal(nextStep('fetch').id, 'issue')
  assert.equal(nextStep('close'), undefined)
  assert.equal(stepDef('nope'), undefined)
})

test('stepOfWriteTool: bound, purpose-keyed, unbound, unknown', () => {
  assert.equal(stepOfWriteTool('mr_open_draft'), 'mr')
  assert.equal(stepOfWriteTool('slack_reply', 'ack'), 'fetch')
  assert.equal(stepOfWriteTool('slack_reply', 'result'), 'writeback')
  assert.equal(stepOfWriteTool('slack_reply', 'question'), null)
  assert.equal(stepOfWriteTool('needs_info_confirm'), null)
  assert.equal(stepOfWriteTool('task_close'), null)
  assert.equal(stepOfWriteTool('slack_reply'), undefined)
  assert.equal(stepOfWriteTool('rm_rf'), undefined)
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
    role: 'notify', name: 'Notify', label: 'Notify', instructions: 'notify.md', model: 'apiModel', permission: 'read-only', tools: ['notify_send'],
  }]
  assert.deepEqual(validateRegistry(defs), [])
  assert.deepEqual(toolsOfRole('notify', defs), ['notify_send'])
  assert.equal(botDef('notify', defs).name, 'Notify')
  assert.deepEqual(validateFlow(defs), [])
})
