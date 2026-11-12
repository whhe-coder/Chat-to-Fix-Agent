// How one Claude Code process is started (bot/src/host/local-agents/launch.ts), tested on its own
// with a small fake runtime: the test commands of the task's binding, and the engineAuth key path.
// No process is started and no model is called; the key is a fake value.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

// ---- isolation of the owner's personal instruction files (second real run, T-1) ----
// The worktree sits under the owner's home, so ~/.claude/CLAUDE.md is an ancestor's project file to the CLI.
const WORKTREE = '/Users/owner/chat-to-fix-runs/r1/chat-to-fix/worktrees/T-1'
const inWorktree = { ...open, cwd: WORKTREE }
const excludesOf = (launch) => JSON.parse(valueOf(launch.args, '--settings')).claudeMdExcludes
const scratch = () => mkdtempSync(join(tmpdir(), 'chat-to-fix-launch-'))

test('isolation: the Coding bot excludes every instruction file above its worktree, but not the worktree\'s own', () => {
  for (const engineAuth of ['login', 'apiKey']) {
    const host = rt({ engineAuth, engineApiKey: FAKE_KEY, engineConfigRoot: scratch() }, { roles: CODING })
    const launch: any = launchFor(host, 'coding', inWorktree)
    assert.equal(valueOf(launch.args, '--setting-sources'), 'project', engineAuth)
    const excludes = excludesOf(launch)
    assert.ok(excludes.includes('/Users/owner/.claude/CLAUDE.md'), `${engineAuth}: the file that leaked`)
    assert.ok(excludes.includes('/Users/owner/.claude/rules/**'), engineAuth)
    assert.ok(excludes.includes('/Users/owner/chat-to-fix-runs/CLAUDE.md'), engineAuth)
    assert.equal(excludes.some(pattern => pattern.startsWith(`${WORKTREE}/`)), false, `${engineAuth}: the repository's own CLAUDE.md stays`)
    assert.equal(launch.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', engineAuth)
    // the reviewer subagent is defined by arguments, so it is unaffected
    assert.deepEqual(Object.keys(JSON.parse(valueOf(launch.args, '--agents'))), ['reviewer'], engineAuth)
    assert.equal(launch.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1', engineAuth)
  }
})

test('isolation, engineAuth apiKey: a private config dir inside the data folder, per session, owner-only, never the user\'s ~/.claude', () => {
  const root = join(scratch(), 'engine-config')
  const host = rt({ engineAuth: 'apiKey', engineApiKey: FAKE_KEY, engineConfigRoot: root }, { roles: { ...CODING, second: { role: 'coding', taskId: 'T-2' } } })
  const first: any = launchFor(host, 'coding', inWorktree)
  const second: any = launchFor(host, 'second', inWorktree)
  assert.equal(first.env.CLAUDE_CONFIG_DIR, join(root, 'coding'))
  assert.equal(second.env.CLAUDE_CONFIG_DIR, join(root, 'second'))
  assert.ok(existsSync(first.env.CLAUDE_CONFIG_DIR))
  assert.equal(statSync(first.env.CLAUDE_CONFIG_DIR).mode & 0o077, 0, 'owner only')
  assert.deepEqual(readdirSync(first.env.CLAUDE_CONFIG_DIR), [], 'starts empty: no credential and nothing copied from the user')
  assert.equal(first.env.CLAUDE_CONFIG_DIR.includes('/.claude'), false)
  // the same session launched again (a restart) gets the same directory
  assert.equal((launchFor(host, 'coding', inWorktree) as any).env.CLAUDE_CONFIG_DIR, first.env.CLAUDE_CONFIG_DIR)
  // the private dir is excluded as well, in case the CLI ever reads instruction files from it
  assert.ok(excludesOf(first).includes(`${first.env.CLAUDE_CONFIG_DIR}/CLAUDE.md`))
  // a session id with path characters cannot leave the root
  const odd: any = launchFor(rt({ engineAuth: 'apiKey', engineApiKey: FAKE_KEY, engineConfigRoot: root }), '../../etc', inWorktree)
  assert.equal(dirname(odd.env.CLAUDE_CONFIG_DIR), root)
  // the key still travels in the environment only; no secret in the arguments
  for (const launch of [first, second, odd]) {
    assert.equal(launch.env.ANTHROPIC_API_KEY, FAKE_KEY)
    assert.equal(JSON.stringify(launch.args).includes(FAKE_KEY), false)
  }
})

test('isolation, engineAuth apiKey without a configured root: still a private directory, under the OS temp folder', () => {
  const launch: any = launchFor(rt({ engineAuth: 'apiKey', engineApiKey: FAKE_KEY }, { roles: CODING }), 'coding', inWorktree)
  assert.ok(launch.env.CLAUDE_CONFIG_DIR.startsWith(tmpdir()) || launch.env.CLAUDE_CONFIG_DIR.startsWith('/private'), launch.env.CLAUDE_CONFIG_DIR)
  assert.deepEqual(readdirSync(launch.env.CLAUDE_CONFIG_DIR), [])
})

test('isolation, engineAuth login: the login lives in the user\'s config home, so no CLAUDE_CONFIG_DIR is set; the same flags apply', () => {
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  process.env.HOME = '/Users/owner'
  process.env.CLAUDE_CONFIG_DIR = '/somewhere/else'
  try {
    const host = rt({ engineAuth: 'login' }, { roles: CODING })
    for (const session of ['coding', 'unbound']) {
      const launch: any = launchFor(host, session, inWorktree)
      assert.equal('CLAUDE_CONFIG_DIR' in launch.env, false, `${session}: childEnv never passes the variable on`)
      assert.equal(launch.env.HOME, '/Users/owner')
      assert.equal('ANTHROPIC_API_KEY' in launch.env, false)
      assert.equal(valueOf(launch.args, '--setting-sources'), 'project')
      assert.ok(excludesOf(launch).includes('/Users/owner/.claude/CLAUDE.md'))
      assert.ok(excludesOf(launch).includes('/Users/owner/.claude/rules/**'))
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

test('isolation: a bot of another role or an unbound session is isolated the same way (setting sources, excludes, config dir)', () => {
  const host = rt({ engineAuth: 'apiKey', engineApiKey: FAKE_KEY, engineConfigRoot: scratch() }, { roles: CODING })
  for (const session of ['main', 'unbound']) {
    const launch: any = launchFor(host, session, inWorktree)
    assert.equal(valueOf(launch.args, '--setting-sources'), 'project', session)
    assert.ok(excludesOf(launch).includes('/Users/owner/.claude/CLAUDE.md'), session)
    assert.ok(launch.env.CLAUDE_CONFIG_DIR.endsWith(`/${session}`), session)
    assert.equal(launch.args.includes('--agents'), false, session)
  }
})

test('the Coding bot is started on its configured model and effort, and its reviewer runs on the same ones', () => {
  const host = rt({ codingEffort: 'high' }, { roles: CODING, options: { 'T-1': { testCommands: ['sh test.sh'] } } })
  const launch = launchFor(host, 'coding', { ...open, model: 'claude-sonnet-5-5' })
  assert.equal(valueOf(launch.args, '--model'), 'claude-sonnet-5-5')
  assert.equal(valueOf(launch.args, '--effort'), 'high')
  const reviewer = JSON.parse(valueOf(launch.args, '--agents')).reviewer
  assert.deepEqual([reviewer.model, reviewer.effort], ['claude-sonnet-5-5', 'high'])
  // no effort configured (a bare runtime): the CLI keeps its own default; model 'default' pins nothing
  const bare = launchFor(rt({}, { roles: CODING }), 'coding', open)
  assert.ok(!bare.args.includes('--effort') && !bare.args.includes('--model'))
  assert.equal(JSON.parse(valueOf(bare.args, '--agents')).reviewer.model, undefined)
  // a bot of another role gets neither
  assert.ok(!launchFor(host, 'main', { ...open, model: 'claude-sonnet-5-5' }).args.includes('--effort'))
})
