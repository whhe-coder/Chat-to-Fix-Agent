// How one Claude Code process is started (bot/src/host/local-agents/launch.ts), tested on its own
// with a small fake runtime: the test commands of the task's binding, and the engineAuth key path.
// No process is started and no model is called; the key is a fake value.
import test from 'node:test'
import assert from 'node:assert/strict'
import { launchFor, withTestCommands } from '../bot/src/host/local-agents/launch.ts'

const FAKE_KEY = 'sk-ant-api03-FAKE-KEY-FOR-TESTS-0123456789'
const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1]
const open = { cwd: '/w', mcp: { url: 'http://127.0.0.1:1/mcp', token: 'tok' }, resumeId: undefined, preset: 'workspace-write', model: 'default', system: 'sys', toolNames: [] }

// roles: sessionId -> { role, taskId }; options: taskId -> { testCommands, setupCommands }
function rt(config, { roles = {}, options = {} }: any = {}) {
  return {
    config,
    teamTools: [],
    botlayer: { botOfSession: (id) => (roles[id] === undefined ? undefined : { botId: id, ...roles[id] }) },
    taskLayer: { bridgedToolNames: () => ['review_report'], codingOptions: (taskId) => options[taskId] },
  }
}
const allowedOf = (launch) => valueOf(launch.args, '--allowedTools').split(',')
const CODING = { coding: { role: 'coding', taskId: 'T-1' }, main: { role: 'main', taskId: 'T-1' }, other: { role: 'coding', taskId: 'T-2' } }

test('the Coding bot gets the test commands of its task\'s binding, not the plugin-level list', () => {
  const host = rt({ testCommands: ['plugin cmd'] }, { roles: CODING, options: { 'T-1': { testCommands: ['sh test.sh'], setupCommands: ['pnpm install'] }, 'T-2': { testCommands: ['make check'] } } })
  const first = allowedOf(launchFor(host, 'coding', open))
  assert.ok(first.includes('Bash(sh test.sh)'))
  assert.ok(first.includes('Bash(sh test.sh:*)'))
  assert.equal(first.includes('Bash(plugin cmd)'), false)
  const second = allowedOf(launchFor(host, 'other', open))
  assert.ok(second.includes('Bash(make check)'))
  assert.equal(second.includes('Bash(sh test.sh)'), false)
  // setup commands are run by the system, never allowed to the CLI
  assert.equal(first.some((rule) => /pnpm install/.test(rule)), false)
})

test('the Coding bot is told the test commands and to run them exactly as written', () => {
  const host = rt({}, { roles: CODING, options: { 'T-1': { testCommands: ['sh test.sh', 'make lint'] }, 'T-2': { testCommands: [] } } })
  const system = valueOf(launchFor(host, 'coding', open).args, '--append-system-prompt')
  assert.ok(system.startsWith('sys\n\n'), 'the bot instructions stay first')
  assert.match(system, /test commands: `sh test\.sh`, `make lint`\. Run a test command exactly as written, from your working folder: no cd, no pipe, no redirection/)
  // no test commands: the system text is left as it is
  assert.equal(valueOf(launchFor(host, 'other', open).args, '--append-system-prompt'), 'sys')
  assert.equal(withTestCommands(undefined, ['x']).startsWith('The shell commands you may run'), true)
})

test('without commands on the binding, the plugin-level list is the fallback; without both, only git status and diff', () => {
  const fallback = rt({ testCommands: ['plugin cmd'] }, { roles: CODING, options: { 'T-1': { testCommands: undefined } } })
  assert.ok(allowedOf(launchFor(fallback, 'coding', open)).includes('Bash(plugin cmd)'))
  const unknownTask = rt({ testCommands: ['plugin cmd'] }, { roles: CODING })
  assert.ok(allowedOf(launchFor(unknownTask, 'coding', open)).includes('Bash(plugin cmd)'))
  const none = rt({}, { roles: CODING, options: { 'T-1': {} } })
  assert.deepEqual(allowedOf(launchFor(none, 'coding', open)).filter((rule) => rule.startsWith('Bash(')), ['Bash(git status:*)', 'Bash(git diff:*)'])
  // an empty list on the binding means "no tests", it does not fall back
  const empty = rt({ testCommands: ['plugin cmd'] }, { roles: CODING, options: { 'T-1': { testCommands: [] } } })
  assert.equal(allowedOf(launchFor(empty, 'coding', open)).includes('Bash(plugin cmd)'), false)
  // a runtime without the hook (an older task layer) still works
  const hookless: any = rt({ testCommands: ['plugin cmd'] }, { roles: CODING })
  delete hookless.taskLayer.codingOptions
  assert.ok(allowedOf(launchFor(hookless, 'coding', open)).includes('Bash(plugin cmd)'))
})

test('a bot of another role gets no allow-list at all', () => {
  const host = rt({ testCommands: ['plugin cmd'] }, { roles: CODING, options: { 'T-1': { testCommands: ['sh test.sh'] } } })
  assert.equal(launchFor(host, 'main', open).args.includes('--allowedTools'), false)
})

test('engineAuth apiKey: the key reaches the CLI as ANTHROPIC_API_KEY and nowhere else', () => {
  const host = rt({ engineAuth: 'apiKey', engineApiKey: FAKE_KEY }, { roles: CODING })
  for (const session of ['coding', 'main', 'unbound']) {
    const launch: any = launchFor(host, session, open)
    assert.equal(launch.env.ANTHROPIC_API_KEY, FAKE_KEY, session)
    assert.equal(launch.args.some((arg) => String(arg).includes(FAKE_KEY)), false, `${session}: the key must not be on the command line`)
    assert.equal(Object.entries(launch.env).filter(([, v]) => v === FAKE_KEY).length, 1, `${session}: exactly one variable carries the key`)
    assert.equal(JSON.stringify({ ...launch, env: undefined }).includes(FAKE_KEY), false)
  }
})

test('engineAuth apiKey without a key fails without printing anything secret', () => {
  const host = rt({ engineAuth: 'apiKey' }, { roles: CODING })
  assert.throws(() => launchFor(host, 'coding', open), (e: any) => /needs an apiKey/.test(e.message))
})

test('engineAuth login: no key reaches the CLI, even when the process has one in its environment', () => {
  const saved = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = FAKE_KEY
  try {
    const host = rt({ engineAuth: 'login' }, { roles: CODING })
    for (const session of ['coding', 'main']) {
      const launch = launchFor(host, session, open)
      assert.equal('ANTHROPIC_API_KEY' in launch.env, false, session)
      assert.equal(Object.values(launch.env).includes(FAKE_KEY), false)
    }
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  }
})
