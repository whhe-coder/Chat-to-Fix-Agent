import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, bindingOf, secret } from '../src/config.js'

const base = () => ({
  dataDir: '/d', worktreesDir: '/d/w', httpPort: 3090, apiModel: 'anthropic/x',
  bindings: [{ channel: 'C1', repo: 'g/p', jiraProject: 'DEMO' }],
})
function write(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-to-fix-cfg-'))
  const path = join(dir, 'c.json')
  writeFileSync(path, typeof obj === 'string' ? obj : JSON.stringify(obj))
  return path
}
const load = (obj, env = {}) => loadConfig({ path: write(obj), env })

test('the example file loads and applies the defaults of spec 6', () => {
  const c = loadConfig({ path: new URL('../config.example.json', import.meta.url).pathname, env: {} })
  assert.equal(c.httpPort, 3090)
  assert.equal(c.apiModel, 'anthropic/CHANGE-ME')
  assert.deepEqual(c.adapters, { slack: 'fake', jira: 'fake', gitlab: 'fake' })
  assert.equal(c.limits.stepMinutes.code, 40)
  assert.equal(bindingOf(c, 'C0456').jiraProject, 'DEMO')
  assert.equal(bindingOf(c, 'nope'), undefined)
  assert.match(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'), /"anthropic\/CHANGE-ME"/)
})

test('path may come from CHAT_TO_FIX_CONFIG', () => {
  const c = loadConfig({ env: { CHAT_TO_FIX_CONFIG: write(base()) } })
  assert.equal(c.dataDir, '/d')
  assert.throws(() => loadConfig({ env: {} }), /CHAT_TO_FIX_CONFIG/)
})

test('defaults are applied for missing optional keys and partial limits', () => {
  const c = load({ ...base(), limits: { queueMax: 5, stepMinutes: { code: 50 } } })
  assert.equal(c.language, 'zh')
  assert.equal(c.codingModel, 'claude-code/default')
  assert.equal(c.codingPermission, 'workspace-write')
  assert.equal(c.engineAuth, 'login')
  assert.deepEqual(c.adapters, { slack: 'fake', jira: 'fake', gitlab: 'fake' })
  assert.deepEqual(c.jiraTransitions, ['In Review'])
  assert.equal(c.limits.queueMax, 5)
  assert.equal(c.limits.stepMinutes.code, 50)
  assert.equal(c.limits.stepMinutes.fetch, 5)
  assert.equal(c.limits.maxConcurrent, 1)
  assert.equal(c.limits.queueWaitHours, 4)
  assert.equal(c.limits.replyMaxChars, 600)
  const b = c.bindings[0]
  assert.deepEqual([b.defaultBranch, b.issueType, b.labels], ['master', 'Bug', []])
})

for (const key of ['dataDir', 'worktreesDir', 'httpPort', 'apiModel']) {
  test(`missing ${key} names it`, () => {
    const c = base(); delete c[key]
    assert.throws(() => load(c), new RegExp(`missing ${key}`))
  })
}

test('missing or empty bindings', () => {
  const c = base(); delete c.bindings
  assert.throws(() => load(c), /missing bindings/)
  assert.throws(() => load({ ...base(), bindings: [] }), /missing bindings/)
})

test('binding without a required field names the field', () => {
  assert.throws(() => load({ ...base(), bindings: [{ channel: 'C1', repo: 'g/p' }] }), /missing bindings\[0\]\.jiraProject/)
})

test('duplicate channel is refused', () => {
  const b = { channel: 'C1', repo: 'g/p', jiraProject: 'D' }
  assert.throws(() => load({ ...base(), bindings: [b, b] }), /channel C1 appears twice/)
})

test('all problems are reported together', () => {
  assert.throws(() => load({}), (e) => /dataDir/.test(e.message) && /httpPort/.test(e.message) && /bindings/.test(e.message))
})

test('a real adapter needs its token; the message names the variable only', () => {
  const cfg = { ...base(), adapters: { slack: 'real', jira: 'fake', gitlab: 'real' } }
  assert.throws(() => load(cfg, {}), (e) => /CHAT_TO_FIX_SLACK_TOKEN/.test(e.message) && /CHAT_TO_FIX_GITLAB_TOKEN/.test(e.message) && !/JIRA/.test(e.message))
  const c = load(cfg, { CHAT_TO_FIX_SLACK_TOKEN: 'xoxb-secret-1', CHAT_TO_FIX_GITLAB_TOKEN: 'glpat-secret-2' })
  assert.equal(c.adapters.slack, 'real')
})

test('engineAuth apiKey needs ANTHROPIC_API_KEY', () => {
  const cfg = { ...base(), engineAuth: 'apiKey' }
  assert.throws(() => load(cfg, {}), /ANTHROPIC_API_KEY/)
  assert.equal(load(cfg, { ANTHROPIC_API_KEY: 'sk-ant-secret' }).engineAuth, 'apiKey')
})

test('invalid values are named', () => {
  assert.throws(() => load({ ...base(), adapters: { slack: 'bogus' } }), /adapters\.slack/)
  assert.throws(() => load({ ...base(), engineAuth: 'x' }), /engineAuth/)
  assert.throws(() => load({ ...base(), limits: { queueMax: 0 } }), /limits\.queueMax/)
  assert.throws(() => load({ ...base(), limits: { stepMinutes: { code: -1 } } }), /limits\.stepMinutes\.code/)
  assert.throws(() => load({ ...base(), httpPort: 'abc' }), /httpPort/)
  assert.throws(() => load('{not json'), /not valid JSON/)
  assert.throws(() => loadConfig({ path: '/nonexistent/x.json', env: {} }), /cannot be read/)
})

test('secrets never appear in the returned config or in errors', () => {
  const env = { CHAT_TO_FIX_SLACK_TOKEN: 'xoxb-secret-1', CHAT_TO_FIX_JIRA_TOKEN: 'jira-secret-2', CHAT_TO_FIX_GITLAB_TOKEN: 'gl-secret-3', ANTHROPIC_API_KEY: 'sk-secret-4', CHAT_TO_FIX_HTTP_TOKEN: 'http-secret-5' }
  const c = load({ ...base(), engineAuth: 'apiKey', adapters: { slack: 'real', jira: 'real', gitlab: 'real' } }, env)
  const text = JSON.stringify(c)
  for (const v of Object.values(env)) assert.ok(!text.includes(v), `config leaks ${v}`)
  try { load({ ...base(), httpPort: 'x', adapters: { slack: 'real' } }, env); assert.fail() } catch (e) {
    for (const v of Object.values(env)) assert.ok(!e.message.includes(v))
  }
})

test('secret() reads the environment', () => {
  assert.equal(secret({ A: 'v' }, 'A'), 'v')
  assert.equal(secret({ A: '' }, 'A'), undefined)
  assert.equal(secret({}, 'A'), undefined)
})
