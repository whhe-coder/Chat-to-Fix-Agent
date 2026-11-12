// Two settings of the Claude Code driver, checked through the whole path on the real bot layer
// (the CLI is the fake of test/fixtures/fake-claude.ts, `[echo]` answers with its argv and env):
//  - a binding's testCommands reach the Coding bot's allow-list (the plugin-level list is the fallback);
//  - engineAuth "apiKey": configuration -> src/plugin.ts engineSettings -> launch.ts -> the CLI's
//    environment as ANTHROPIC_API_KEY. The key is a fake value; no real CLI or model runs.
//
// Run: node --import ./bot/test/harness-resolve.ts --test --test-force-exit test/bot/engine-binding.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { loadConfig } from '../../src/config.ts'
import { engineSettings } from '../../src/plugin.ts'
import { startApp } from './host.ts'

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url))
const CLI = { command: process.execPath, args: [FAKE] }
const FAKE_KEY = 'sk-ant-api03-FAKE-KEY-FOR-TESTS-0123456789'

const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1]
async function textOf(stream) {
  let text = ''
  for await (const chunk of stream) if (chunk.type === 'text-delta') text += chunk.text
  return text
}
const streamOptions = (sessionId) => ({
  provider: 'claude-code', model: 'default', sessionId, tools: [], signal: AbortSignal.timeout(30_000),
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '[echo]' }], source: { kind: 'user' } }],
})
// The argv and env the coding bot's CLI was started with.
async function echo(t, { runtime = {}, config = {} }: any = {}) {
  const app = await startApp(t, { cli: CLI, runtime, config })
  const { bots } = await app.post()
  const adapter = await app.host.localAdapter()
  const reply = await textOf(adapter.stream(streamOptions(bots.coding)))
  return JSON.parse(reply.slice('echo:'.length))
}
const configFile = (obj) => {
  const path = join(mkdtempSync(join(tmpdir(), 'chat-to-fix-engine-')), 'c.json')
  writeFileSync(path, JSON.stringify({ dataDir: '/d', worktreesDir: '/d/w', httpPort: 0, apiModel: 'anthropic/x', bindings: [{ channel: 'C1', repo: 'g/p', jiraProject: 'D' }], ...obj }))
  return path
}

test('the binding\'s testCommands are allowed to the Coding bot; the plugin-level list is not used then', async (t) => {
  const { argv } = await echo(t, {
    runtime: { testCommands: ['plugin cmd'] },
    config: { bindings: [{ channel: 'C1', repo: 'group/project', jiraProject: 'DEMO', testCommands: ['sh test.sh', 'make lint'] }] },
  })
  const allowed = valueOf(argv, '--allowedTools').split(',')
  assert.ok(allowed.includes('Bash(sh test.sh)') && allowed.includes('Bash(make lint)'))
  assert.equal(allowed.includes('Bash(plugin cmd)'), false)
  assert.ok(allowed.includes('Bash(git status:*)') && allowed.includes('Bash(git diff:*)'))
})

test('a binding without testCommands falls back to the plugin-level list', async (t) => {
  const { argv } = await echo(t, { runtime: { testCommands: ['plugin cmd'] } })
  assert.ok(valueOf(argv, '--allowedTools').split(',').includes('Bash(plugin cmd)'))
})

test('engineAuth apiKey end to end: the key from the environment reaches the CLI as ANTHROPIC_API_KEY, not the argument list', async (t) => {
  const config: any = loadConfig({ path: configFile({ engineAuth: 'apiKey' }), env: { ANTHROPIC_API_KEY: FAKE_KEY } })
  assert.equal(JSON.stringify(config).includes(FAKE_KEY), false, 'the loaded configuration never holds the key')
  const settings: any = engineSettings(config, { ANTHROPIC_API_KEY: FAKE_KEY })
  assert.deepEqual(Object.keys(settings).sort(), ['engineApiKey', 'engineAuth', 'engineMaxTurns'])
  const { argv, env } = await echo(t, { runtime: settings })
  assert.equal(env.ANTHROPIC_API_KEY, FAKE_KEY)
  assert.equal(argv.some((arg) => String(arg).includes(FAKE_KEY)), false)
  assert.equal(valueOf(argv, '--max-turns'), String(config.limits.engineMaxTurns))
})

test('engineAuth login end to end: engineSettings carries no key and the CLI gets none', async (t) => {
  const config: any = loadConfig({ path: configFile({}), env: {} })
  const settings: any = engineSettings(config, { ANTHROPIC_API_KEY: FAKE_KEY })
  assert.equal('engineApiKey' in settings, false)
  const saved = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = FAKE_KEY
  t.after(() => { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved })
  const { env } = await echo(t, { runtime: settings })
  assert.equal('ANTHROPIC_API_KEY' in env, false)
})
