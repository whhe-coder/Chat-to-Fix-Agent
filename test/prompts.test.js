import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allBotDefs, toolsOfRole } from '../src/registry/bots.ts'
import { STEPS } from '../src/flow/steps.ts'
import { loadPrompt, groupNotice, PROMPT_NAMES } from '../src/prompts/index.ts'

// Tools every bot has besides its own: task_read and the DS Bot team tools the bot keeps.
const SHARED = ['task_read', 'list_bots', 'message_bot', 'post_to_group', 'stop_bot']
const STEP_NAMES = ['Fetch the discussion', 'Create the issue', 'Prepare the code', 'Code', 'Open the MR', 'Write back', 'Close']

const backticked = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
const looksLikeTool = (word) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(word)

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

test('group notice names the seven steps in order', () => {
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

test('tool names in the group notice are real tools', () => {
  const known = new Set([...allBotDefs().flatMap((d) => d.tools), ...SHARED])
  for (const tool of backticked(groupNotice()).filter(looksLikeTool)) assert.ok(known.has(tool), tool)
})

test('prompts have no capital-letter shouting', () => {
  for (const name of PROMPT_NAMES) {
    assert.doesNotMatch(loadPrompt(name), /\b(CRITICAL|MUST|NEVER|ALWAYS|IMPORTANT)\b/, name)
  }
})
