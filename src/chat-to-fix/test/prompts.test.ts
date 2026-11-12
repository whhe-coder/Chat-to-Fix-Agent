import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allBotDefs, toolsOfRole } from '../core/registry/bots.ts'
import { STEPS } from '../core/flow/steps.ts'
import { loadPrompt, groupNotice, PROMPT_NAMES } from '../core/prompts/index.ts'
import { CI_STOP_REASONS, REVIEW_VERDICTS } from '../core/task/contracts.ts'

// Tools every bot has besides its own: task_read and the DS Bot team tools the bot keeps.
const SHARED = ['task_read', 'list_bots', 'message_bot', 'post_to_group', 'stop_bot']
const STEP_NAMES = ['Fetch the discussion', 'Create the issue', 'Prepare the code', 'Code', 'Open the MR', 'Check CI', 'Write back', 'Close']

const backticked = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
// Values of tool arguments (the ci_stop reasons, the review verdicts) are snake_case too but are not tools.
const NOT_TOOLS = new Set([...CI_STOP_REASONS, ...REVIEW_VERDICTS])
const looksLikeTool = (word) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(word) && !NOT_TOOLS.has(word)

test('every prompt the registry names loads and is non-empty', () => {
  const files = []
  for (const def of allBotDefs()) {
    files.push(def.instructions)
    if (def.reviewer) files.push(def.reviewer.instructions)
  }
  assert.equal(files.length, 6)
  for (const file of files) assert.ok(loadPrompt(file).length > 200, file)
  assert.ok(groupNotice().length > 200)
  for (const name of PROMPT_NAMES) assert.ok(loadPrompt(name).length > 0, name)
})

test('loadPrompt caches and rejects unknown names', () => {
  assert.equal(loadPrompt('main'), loadPrompt('main.md'))
  assert.throws(() => loadPrompt('nobody'), /unknown prompt "nobody"/)
  assert.throws(() => loadPrompt('constructor'), /unknown prompt/)
})

for (const def of allBotDefs()) {
  test(`${def.role}: tools named in the prompt are its own, and all its own are named`, () => {
    const text = loadPrompt(def.instructions)
    const mentioned = new Set(backticked(text).filter(looksLikeTool))
    const allowed = new Set([...toolsOfRole(def.role), ...SHARED])
    for (const tool of mentioned) assert.ok(allowed.has(tool), `${def.role} prompt names ${tool}, which is not its tool`)
    for (const tool of toolsOfRole(def.role)) assert.ok(mentioned.has(tool), `${def.role} prompt never names its tool ${tool}`)
    assert.ok(mentioned.has('task_read'), `${def.role} prompt never names task_read`)
  })
}

test('main names stop_bot; reviewer names only its read-only tools', () => {
  assert.ok(backticked(loadPrompt('main')).includes('stop_bot'))
  const reviewer = loadPrompt('reviewer')
  assert.deepEqual(backticked(reviewer).filter(looksLikeTool), [])
  for (const tool of allBotDefs().find((d) => d.role === 'coding').reviewer.tools) {
    assert.ok(backticked(reviewer).includes(tool), tool)
  }
})

test('group notice names the eight steps in order', () => {
  const notice = groupNotice()
  assert.equal(STEPS.length, STEP_NAMES.length)
  let at = -1
  STEP_NAMES.forEach((name, index) => {
    const found = notice.indexOf(`${index + 1}. ${name}`)
    assert.ok(found > at, `step ${index + 1} ${name} missing or out of order`)
    at = found
  })
  for (const word of ['Slack bot', 'Jira bot', 'Pipeline bot', 'Coding bot', 'Main bot', 'task_read']) {
    assert.ok(notice.includes(word), word)
  }
})

test('the group notice fits the 2000 characters a DS Bot group notice can hold', () => {
  assert.ok(groupNotice().length <= 2000, `${groupNotice().length} characters`)
})

test('tool names in the group notice are real tools', () => {
  const known = new Set([...allBotDefs().flatMap((d) => d.tools), ...SHARED])
  for (const tool of backticked(groupNotice()).filter(looksLikeTool)) assert.ok(known.has(tool), tool)
})

test('prompts have no capital-letter shouting', () => {
  for (const name of PROMPT_NAMES) {
    assert.doesNotMatch(loadPrompt(name), /\b(CRITICAL|MUST|NEVER|ALWAYS|IMPORTANT)\b/, name)
  }
})

// Spec 7, 4.10 (with the design change of 2026-11-12: the Pipeline bot owns the CI step alone).
test('CI step: the main bot hands the step to the Pipeline bot, then waits for the system and advances', () => {
  const main = loadPrompt('main')
  assert.ok(!backticked(main).includes('ci_stop'), 'ci_stop is the Pipeline bot\'s tool now')
  assert.match(main, /belongs to the Pipeline bot alone/)
  assert.match(main, /do nothing else in that step/)
  assert.match(main, /do not call the Coding bot/i)
  assert.match(main, /system tells you that the CI step is settled/i)
  assert.match(main, /advance to Write back/i)
  assert.match(main, /whether the CI passed/)
})

test('CI step: the pipeline bot leads the round: log, summary, ask Coding, push or stop', () => {
  const text = loadPrompt('pipeline')
  const tools = backticked(text)
  for (const tool of ['ci_read_log', 'mr_push_fix', 'ci_stop', 'message_bot']) assert.ok(tools.includes(tool), tool)
  for (const reason of CI_STOP_REASONS) assert.ok(tools.includes(reason), `pipeline never names the ci_stop reason ${reason}`)
  assert.match(text, /own step 6, Check CI, alone/)
  assert.match(text, /write the failure summary/i)
  assert.match(text, /Do not paste the whole log/i)
  assert.match(text, /ask the Coding bot to fix it/i)
  assert.match(text, /cannot_fix/)
  assert.match(text, /Conventional Commit/)
  assert.match(text, /woken by a \[system\] message/)
  assert.match(text, /loosened/)
})

test('CI step: the coding bot fixes from the summary, keeps scope and never weakens CI', () => {
  const text = loadPrompt('coding')
  assert.match(text, /task_read/)
  assert.match(text, /failure summary/i)
  assert.match(text, /scope of the Jira issue/i)
  assert.match(text, /Pipeline bot calls you/)
  assert.match(text, /loosen the CI configuration, a threshold/i)
  assert.match(text, /skip, disable or delete a test/i)
  assert.match(text, /A lint or type fix needs no new test/i)
  assert.match(text, /cannot_fix/)
  for (const verdict of REVIEW_VERDICTS) assert.ok(text.includes(verdict), verdict)
})

test('CI step: write-back says the CI outcome plainly and Jira is not moved when CI did not pass', () => {
  for (const name of ['slack', 'jira']) {
    const text = loadPrompt(name)
    assert.match(text, /CI outcome|CI passed/, name)
    assert.match(text, /Draft MR 已开，修复在里面；CI 第 \d+ 轮仍有这些 job 失败/, name)
    assert.match(text, /step 7/i, name)
  }
  const jira = loadPrompt('jira')
  assert.match(jira, /Do not call `jira_transition`/)
  assert.match(jira, /stays in its current status/)
})

test('the group notice tells the CI loop, its three roles and the round limit', () => {
  const notice = groupNotice()
  assert.match(notice, /6\. Check CI: the system waits for the pipeline/)
  assert.match(notice, /Pipeline reads the log, asks Coding to fix it and pushes the fix/)
  assert.match(notice, /only in step 6 the Pipeline bot calls the Coding bot/)
  assert.match(notice, /3 rounds/)
  assert.match(notice, /Never loosen CI/)
})

test('main: the close note is shown to the requester, so it is written in the discussion language without jargon', () => {
  const main = loadPrompt('main')
  assert.match(main, /requester reads that note/)
  assert.match(main, /language of the discussion/)
  assert.match(main, /no internal jargon/)
})
