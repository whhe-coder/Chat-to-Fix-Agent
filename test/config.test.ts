import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, bindingOf, secret } from '../src/config.ts'

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

const EXAMPLE = new URL('../config.example.json', import.meta.url).pathname

test('the example file loads once the placeholder model is replaced, and applies the defaults of spec 6', () => {
  const example = JSON.parse(readFileSync(EXAMPLE, 'utf8'))
  assert.equal(example.apiModel, 'anthropic/CHANGE-ME')
  const c = load({ ...example, apiModel: 'anthropic/claude-sonnet-5-5' })
  assert.equal(c.httpPort, 3090)
  assert.deepEqual(c.adapters, { slack: 'fake', jira: 'fake', gitlab: 'fake' })
  assert.equal(c.limits.stepMinutes.code, 40)
  assert.equal(c.jira.baseUrl, 'https://your-company.atlassian.net')
  assert.equal(c.gitlab.baseUrl, 'https://gitlab.example.com')
  assert.deepEqual(c.slack, {})
  assert.equal(bindingOf(c, 'C0456').jiraProject, 'DEMO')
  assert.deepEqual(bindingOf(c, 'C0456').testCommands, ['sh test.sh'])
  assert.equal(bindingOf(c, 'nope'), undefined)
})

test('a configuration that still holds the CHANGE-ME placeholder in apiModel is refused', () => {
  assert.throws(() => loadConfig({ path: EXAMPLE, env: {} }), /apiModel still holds the placeholder CHANGE-ME/)
  assert.throws(() => load({ ...base(), apiModel: 'CHANGE-ME' }), /placeholder/)
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
  assert.throws(() => load({}), (e: any) => /dataDir/.test(e.message) && /httpPort/.test(e.message) && /bindings/.test(e.message))
})

test('a real adapter needs its token; the message names the variable only', () => {
  const cfg = { ...base(), gitlab: { baseUrl: 'https://g.example.com' }, adapters: { slack: 'real', jira: 'fake', gitlab: 'real' } }
  assert.throws(() => load(cfg, {}), (e: any) => /CHAT_TO_FIX_SLACK_TOKEN/.test(e.message) && /CHAT_TO_FIX_GITLAB_TOKEN/.test(e.message) && !/JIRA/.test(e.message))
  const c: any = load(cfg, { CHAT_TO_FIX_SLACK_TOKEN: 'xoxb-secret-1', CHAT_TO_FIX_GITLAB_TOKEN: 'glpat-secret-2' })
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
  const real = { jira: { baseUrl: 'https://j.example.com', email: 'bot@example.com' }, gitlab: { baseUrl: 'https://g.example.com' } }
  const c = load({ ...base(), ...real, engineAuth: 'apiKey', adapters: { slack: 'real', jira: 'real', gitlab: 'real' } }, env)
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

const realEnv = { CHAT_TO_FIX_JIRA_TOKEN: 'jira-secret', CHAT_TO_FIX_GITLAB_TOKEN: 'gl-secret', CHAT_TO_FIX_SLACK_TOKEN: 'xoxb-secret' }

test('jira, gitlab and slack are passed through; the fake adapters need no baseUrl', () => {
  const c: any = load({
    ...base(),
    jira: { baseUrl: 'https://j.example.com', email: 'bot@example.com', fields: { customfield_1: { value: 'Bug' } }, extra: 1 },
    gitlab: { baseUrl: 'https://g.example.com' },
    slack: { note: 'reserved' },
  })
  assert.deepEqual(c.jira, { baseUrl: 'https://j.example.com', email: 'bot@example.com', fields: { customfield_1: { value: 'Bug' } }, extra: 1 })
  assert.deepEqual(c.gitlab, { baseUrl: 'https://g.example.com' })
  assert.deepEqual(c.slack, { note: 'reserved' })
  const bare: any = load(base())
  assert.deepEqual([bare.jira, bare.gitlab, bare.slack], [{}, {}, {}])
})

test('baseUrl is required for a real Jira and a real GitLab; Jira email is optional', () => {
  const real = { ...base(), adapters: { slack: 'real', jira: 'real', gitlab: 'real' } }
  assert.throws(() => load(real, realEnv), (e: any) => /jira\.baseUrl is required/.test(e.message) && /gitlab\.baseUrl is required/.test(e.message) && !/slack\.baseUrl/.test(e.message))
  const c: any = load({ ...real, jira: { baseUrl: 'https://j.example.com' }, gitlab: { baseUrl: 'https://g.example.com' } }, realEnv)
  assert.equal(c.jira.email, undefined)
  assert.equal(c.adapters.jira, 'real')
})

test('adapter sections are validated and the messages never repeat a value', () => {
  const secretUrl = 'https://bot:hunter2@j.example.com'
  assert.throws(() => load({ ...base(), jira: { baseUrl: secretUrl } }), (e: any) => /jira\.baseUrl must not contain a user name/.test(e.message) && !/hunter2/.test(e.message))
  assert.throws(() => load({ ...base(), jira: { baseUrl: 'ftp://x' } }), /jira\.baseUrl must be an http\(s\) URL/)
  assert.throws(() => load({ ...base(), gitlab: { baseUrl: 'not a url' } }), /gitlab\.baseUrl must be an http\(s\) URL/)
  assert.throws(() => load({ ...base(), jira: [] }), /jira must be an object/)
  assert.throws(() => load({ ...base(), slack: 'x' }), /slack must be an object/)
  assert.throws(() => load({ ...base(), jira: { email: 5 } }), /jira\.email/)
  assert.throws(() => load({ ...base(), jira: { fields: [] } }), /jira\.fields must be an object/)
  // A credential in the file is refused by key name; the value is not echoed.
  assert.throws(() => load({ ...base(), jira: { token: 'glpat-in-file' } }), (e: any) => /jira\.token looks like a credential/.test(e.message) && /CHAT_TO_FIX_JIRA_TOKEN/.test(e.message) && !/glpat-in-file/.test(e.message))
  assert.throws(() => load({ ...base(), gitlab: { apiToken: 'x' } }), /gitlab\.apiToken looks like a credential/)
})

test('binding testCommands, setupCommands and jiraFields are validated and passed through', () => {
  const binding = { channel: 'C1', repo: 'g/p', jiraProject: 'D' }
  const c: any = load({ ...base(), bindings: [{ ...binding, testCommands: [' sh test.sh ', 'pnpm lint'], setupCommands: ['pnpm install'], jiraFields: { customfield_9: 'x' } }] })
  const b = c.bindings[0]
  assert.deepEqual(b.testCommands, ['sh test.sh', 'pnpm lint'])
  assert.deepEqual(b.setupCommands, ['pnpm install'])
  assert.deepEqual(b.jiraFields, { customfield_9: 'x' })
  // Absent stays absent (the plugin-level list is then used).
  assert.equal('testCommands' in load(base()).bindings[0], false)
  assert.throws(() => load({ ...base(), bindings: [{ ...binding, testCommands: 'sh test.sh' }] }), /bindings\[0\]\.testCommands must be an array/)
  assert.throws(() => load({ ...base(), bindings: [{ ...binding, testCommands: ['ok', ''] }] }), /bindings\[0\]\.testCommands\[1\] must be a non-empty string/)
  assert.throws(() => load({ ...base(), bindings: [{ ...binding, testCommands: [3] }] }), /testCommands\[0\]/)
  assert.throws(() => load({ ...base(), bindings: [{ ...binding, testCommands: ['a,b'] }] }), /testCommands\[0\] must not contain a comma/)
  assert.throws(() => load({ ...base(), bindings: [{ ...binding, testCommands: ['*'] }] }), /bare wildcard/)
  assert.throws(() => load({ ...base(), bindings: [{ ...binding, setupCommands: [' '] }] }), /setupCommands\[0\]/)
  assert.throws(() => load({ ...base(), bindings: [{ ...binding, jiraFields: [] }] }), /bindings\[0\]\.jiraFields must be an object/)
})

test('slack.apiBase is an optional http(s) URL without credentials and is passed through', () => {
  assert.equal((load({ ...base(), slack: { apiBase: 'http://127.0.0.1:9999/api' } }) as any).slack.apiBase, 'http://127.0.0.1:9999/api')
  assert.throws(() => load({ ...base(), slack: { apiBase: 'nope' } }), /slack\.apiBase must be an http\(s\) URL/)
  assert.throws(() => load({ ...base(), slack: { apiBase: 'https://u:hunter2@slack.example.com' } }), (e: any) => /slack\.apiBase must not contain/.test(e.message) && !/hunter2/.test(e.message))
})
