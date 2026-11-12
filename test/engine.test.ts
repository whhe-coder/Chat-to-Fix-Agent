import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { claudeArgs, cliMode, codingArgs, CODING_TOOLS, testRules } from '../src/engine/args.ts'
import { ancestorDirs, authEnv, childEnv, isolationSettings, memoryExcludes, userConfigHome } from '../src/engine/env.ts'
import { matchesGlob } from 'node:path'
import { ClaudeSession } from '../src/engine/claude.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.ts', import.meta.url))
const BASE = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio']
const reviewer = { description: 'Reviews a change', prompt: 'Review it.', tools: ['Read', 'Grep'] }

test('args: -p by default, off on request', () => {
  assert.deepEqual(claudeArgs(), ['-p', ...BASE])
  assert.deepEqual(claudeArgs({ print: false }), BASE)
})

test('args: coding role with everything', () => {
  const args = claudeArgs({
    settingSources: 'project', resumeId: 'abc', system: 'be careful', permission: 'workspace-write', model: 'sonnet',
    mcp: { url: 'http://127.0.0.1:9/mcp', token: 'tok' }, maxTurns: 25, reviewer,
  })
  assert.deepEqual(args.slice(0, 1 + BASE.length), ['-p', ...BASE])
  const at = flag => args[args.indexOf(flag) + 1]
  assert.equal(at('--setting-sources'), 'project')
  assert.equal(at('--resume'), 'abc')
  assert.equal(at('--append-system-prompt'), 'be careful')
  assert.equal(at('--permission-mode'), 'acceptEdits')
  assert.equal(at('--model'), 'sonnet')
  assert.deepEqual(JSON.parse(at('--mcp-config')), { mcpServers: { 'chat-to-fix': { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer tok' } } } })
  assert.ok(args.includes('--strict-mcp-config'))
  assert.equal(at('--max-turns'), '25')
  assert.deepEqual(JSON.parse(at('--agents')), { reviewer })
})

test('args: without reviewer / MCP / max-turns / -p', () => {
  const args = claudeArgs({ print: false, permission: 'read-only', model: 'default' })
  assert.deepEqual(args, [...BASE, '--permission-mode', 'plan'])
  for (const flag of ['-p', '--setting-sources', '--agents', '--mcp-config', '--strict-mcp-config', '--max-turns', '--model', '--resume']) assert.ok(!args.includes(flag), flag)
})

test('args: reviewer without tools has no tools key; bad input throws', () => {
  const { tools, ...bare } = reviewer
  const args = claudeArgs({ reviewer: { name: 'checker', ...bare } })
  assert.deepEqual(JSON.parse(args[args.indexOf('--agents') + 1]), { checker: bare })
  assert.throws(() => claudeArgs({ maxTurns: 0 }))
  assert.throws(() => claudeArgs({ permission: 'nope' }))
  assert.throws(() => claudeArgs({ reviewer: { description: 'x' } }))
})

test('args: unattended options', () => {
  const args = claudeArgs({
    permissionPrompts: 'none', tools: ['Read', 'Grep'], allowedTools: ['mcp__chat-to-fix__review_report', 'Bash(git diff:*)'],
    disallowedTools: ['WebFetch', 'WebSearch'], persist: false,
  })
  const at = flag => args[args.indexOf(flag) + 1]
  assert.equal(at('--permission-prompts'), 'none')
  assert.equal(at('--tools'), 'Read,Grep')
  assert.equal(at('--allowedTools'), 'mcp__chat-to-fix__review_report,Bash(git diff:*)')
  assert.equal(at('--disallowedTools'), 'WebFetch,WebSearch')
  assert.ok(args.includes('--no-session-persistence'))
  const plain = claudeArgs({ persist: true })
  for (const name of ['--permission-prompts', '--tools', '--allowedTools', '--disallowedTools', '--no-session-persistence']) assert.ok(!plain.includes(name), name)
  assert.throws(() => claudeArgs({ permissionPrompts: 'ask' }), /permissionPrompts/)
})

test('args: a bare Read, Edit, Write, Bash or web tool in the allow-list is refused; scoped rules and Bash(...) pass', () => {
  for (const bare of ['Read', 'Edit', 'Write', 'Bash', 'WebFetch']) {
    assert.throws(() => claudeArgs({ allowedTools: ['Bash(git status:*)', bare] }), new RegExp(`bare "${bare}"`))
    assert.throws(() => claudeArgs({ allowedTools: `Glob, ${bare}` }), /bare/)
  }
  assert.doesNotThrow(() => claudeArgs({ allowedTools: ['Read(./src/**)', 'Edit(./src/**)', 'Glob'] }))
  assert.doesNotThrow(() => claudeArgs({ disallowedTools: ['Write'] })) // a deny rule is fine
  assert.throws(() => claudeArgs({ allowedTools: ['Bash(a,b)'] }), /comma/)
})

test('args: a stdio MCP server entry, besides http', () => {
  const args = claudeArgs({ mcp: { name: 'chat-to-fix', type: 'stdio', command: '/bin/node', args: ['server.mjs', 'log'], env: { A: '1' } } })
  assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), { mcpServers: { 'chat-to-fix': { type: 'stdio', command: '/bin/node', args: ['server.mjs', 'log'], env: { A: '1' } } } })
  assert.ok(args.includes('--strict-mcp-config'))
  const noArgs = claudeArgs({ mcp: { command: 'srv' } })
  assert.deepEqual(JSON.parse(noArgs[noArgs.indexOf('--mcp-config') + 1]).mcpServers['chat-to-fix'], { type: 'stdio', command: 'srv', args: [] })
  assert.throws(() => claudeArgs({ mcp: { type: 'stdio' } }), /command/)
  assert.throws(() => claudeArgs({ mcp: { name: 'x' } }), /url/)
})

test('args: codingArgs builds the verified unattended argument list', () => {
  const args = codingArgs({
    reviewer, roleToolNames: ['review_report', 'mcp__chat-to-fix__other'], mcpServer: { name: 'chat-to-fix', config: { type: 'stdio', command: '/bin/node', args: ['s.mjs'] } },
    testCommands: ['sh test.sh', 'npm test'], maxTurns: 20, model: 'sonnet',
  })
  assert.deepEqual(args, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--permission-prompts', 'none',
    '--setting-sources', 'project', '--permission-mode', 'acceptEdits', '--model', 'sonnet',
    '--tools', 'Read,Edit,Write,Bash,Glob,Grep,Agent,ToolSearch',
    '--allowedTools', 'mcp__chat-to-fix__review_report,mcp__chat-to-fix__other,Bash(git status:*),Bash(git diff:*),Bash(sh test.sh),Bash(sh test.sh:*),Bash(npm test),Bash(npm test:*)',
    '--no-session-persistence',
    '--mcp-config', JSON.stringify({ mcpServers: { 'chat-to-fix': { type: 'stdio', command: '/bin/node', args: ['s.mjs'] } } }), '--strict-mcp-config',
    '--max-turns', '20', '--agents', JSON.stringify({ reviewer }),
  ])
  const http = codingArgs({ mcpServer: { name: 'chat-to-fix', config: { url: 'http://127.0.0.1:1/mcp', token: 't' } }, persist: true })
  assert.ok(!http.includes('--no-session-persistence'))
  assert.deepEqual(JSON.parse(http[http.indexOf('--mcp-config') + 1]).mcpServers['chat-to-fix'], { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t' } })
  for (const web of ['AskUserQuestion', 'WebFetch', 'WebSearch', 'CronCreate']) assert.ok(!CODING_TOOLS.includes(web), web)
  assert.throws(() => codingArgs({ testCommands: ['a,b'] }), /comma/)
})

test('cliMode mapping', () => {
  assert.equal(cliMode('read-only'), 'plan')
  assert.equal(cliMode('workspace-write'), 'acceptEdits')
  assert.equal(cliMode('danger-full-access'), 'bypassPermissions')
  assert.equal(cliMode('other'), undefined)
})

test('childEnv: allow-list plus extra, nothing else', () => {
  const source = {
    PATH: '/bin', HOME: '/h', USER: 'u', LOGNAME: 'u', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TERM: 'xterm', TMPDIR: '/t',
    SLACK_TOKEN: 'xoxb', GITLAB_TOKEN: 'glpat', ANTHROPIC_API_KEY: 'sk-ant', ANTHROPIC_BASE_URL: 'http://x', NODE_OPTIONS: '--x', LCX: 'not LC_',
  }
  const env = childEnv({ source })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER'])
  const withExtra: any = childEnv({ source, extra: { ANTHROPIC_API_KEY: 'given', FOO: 1, GONE: undefined } })
  assert.equal(withExtra.ANTHROPIC_API_KEY, 'given')
  assert.equal(withExtra.FOO, '1')
  assert.ok(!('GONE' in withExtra) && !('SLACK_TOKEN' in withExtra) && !('GITLAB_TOKEN' in withExtra))
})

test('childEnv reads process.env by default and still drops secrets', () => {
  process.env.SLACK_TOKEN = 'leak'
  try { assert.ok(!('SLACK_TOKEN' in childEnv())) } finally { delete process.env.SLACK_TOKEN }
})

test('authEnv: login passes no key, apiKey passes ANTHROPIC_API_KEY', () => {
  assert.deepEqual(authEnv({ engineAuth: 'login', apiKey: 'sk' }), {})
  assert.deepEqual(authEnv({ engineAuth: 'apiKey', apiKey: 'sk' }), { ANTHROPIC_API_KEY: 'sk' })
  assert.throws(() => authEnv({ engineAuth: 'apiKey' }))
  assert.throws(() => authEnv({ engineAuth: 'x' }))
})

const SOURCE = { PATH: process.env.PATH, HOME: '/home/x', SLACK_TOKEN: 'leak', GITLAB_TOKEN: 'leak', ANTHROPIC_API_KEY: 'leak' }
async function open(extra = {}, options: any = {}, startOptions = {}) {
  const session = new ClaudeSession()
  await session.start({ bin: process.execPath, cwd: process.cwd(), args: [FAKE, ...(options.args ?? claudeArgs(options))], env: childEnv({ source: SOURCE, extra }), ...startOptions })
  return session
}
async function until(session, type) {
  for (;;) {
    const event = await session.next()
    assert.notEqual(event, undefined, `stream ended before ${type}`)
    if (event.type === type) return event
  }
}

test('session: start() resolves with no prompt sent and no init yet', async () => {
  const session = await open()
  try {
    assert.equal(session.cliSessionId, undefined)
    assert.equal(session.events.length, 0)
  } finally { session.kill() }
})

test('session: init once, text, done; later turns surface as turn', async () => {
  const session = await open()
  try {
    await session.prompt([{ type: 'text', text: 'fix it' }])
    const seen = []
    for (;;) {
      const event = await session.next()
      seen.push(event)
      if (event.type === 'done') break
    }
    assert.deepEqual(seen.map(e => e.type), ['init', 'thought', 'activity', 'text', 'done'])
    assert.match(session.cliSessionId, /^claude-/)
    assert.equal(seen[0].sessionId, session.cliSessionId)
    assert.equal(seen[2].text, '▸ Read')
    assert.equal(seen[3].text, 'ok: fix it')
    assert.deepEqual(seen[4].usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 7 })
    assert.equal(seen[4].result, 'ok: fix it')
    await session.prompt('again')
    const second = []
    for (;;) {
      const event = await session.next()
      second.push(event.type)
      if (event.type === 'done') break
    }
    assert.deepEqual(second, ['turn', 'thought', 'activity', 'text', 'done'])
  } finally { session.kill() }
})

test('session: a not-logged-in result (subtype success, is_error true) is an error event', async () => {
  const session = await open()
  try {
    await session.prompt('[login]')
    const event = await until(session, 'error')
    assert.equal(event.error.message, 'Not logged in · Please run /login')
    assert.equal(event.result, 'Not logged in · Please run /login')
    assert.equal(event.terminalReason, 'api_error')
    assert.equal(event.reason, undefined)
    assert.equal(event.subtype, 'success')
  } finally { session.kill() }
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('session: permission request answered with deny (default reason), via async iterator', async () => {
  const session = await open()
  try {
    await session.prompt('please [permission]')
    const types = []
    for await (const event of session) {
      types.push(event.type)
      if (event.type === 'permission') {
        assert.match(event.id, UUID)
        assert.equal(event.action, 'Run Bash')
        assert.equal(event.detail, '{"command":"ls"}')
        assert.equal(event.toolName, 'Bash')
        assert.deepEqual(event.input, { command: 'ls' })
        assert.match(event.toolUseId, /^toolu_/)
        assert.equal(event.description, 'List files')
        event.reply(false)
      }
      if (event.type === 'tool_error') {
        assert.equal(event.toolName, 'Bash')
        assert.match(event.text, /^Denied/) // a deny always carries a message
        assert.equal(event.parentToolUseId, null)
      }
      if (event.type === 'text' && event.parentToolUseId === null && event.text.startsWith('permission')) assert.equal(event.text, 'permission: deny')
      if (event.type === 'done') {
        assert.equal(event.result, 'permission: deny')
        assert.equal(event.permissionDenials.length, 1)
        assert.equal(event.permissionDenials[0].tool_name, 'Bash')
        break
      }
    }
    assert.deepEqual(types, ['init', 'activity', 'permission', 'tool_error', 'text', 'done'])
  } finally { session.kill() }
})

test('session: deny with a reason carries it to the tool_result; a second reply is ignored', async () => {
  const session = await open()
  try {
    await session.prompt('[permission]')
    const request = await until(session, 'permission')
    request.reply(false, 'Network access is not allowed for this bot.')
    request.reply(true)
    const error = await until(session, 'tool_error')
    assert.equal(error.text, 'Network access is not allowed for this bot.')
    assert.equal((await until(session, 'done')).result, 'permission: deny')
  } finally { session.kill() }
})

test('fake CLI: a deny without a string message is an invalid permission result and the turn goes on', async () => {
  const session = await open()
  try {
    await session.prompt('[permission]')
    const request = await until(session, 'permission')
    session.write({ type: 'control_response', response: { subtype: 'success', request_id: request.id, response: { behavior: 'deny' } } })
    const error = await until(session, 'tool_error')
    assert.match(error.text, /The canUseTool callback returned an invalid permission result/)
    assert.equal((await until(session, 'done')).result, 'permission: invalid')
  } finally { session.kill() }
})

test('session: allow only when reply(true); the input goes back as updatedInput', async () => {
  const session = await open()
  try {
    await session.prompt('[permission]')
    const request = await until(session, 'permission')
    request.reply(true)
    const types = []
    for (;;) {
      const event = await session.next()
      types.push(event.type)
      if (event.type === 'text') assert.equal(event.text, 'permission: allow')
      if (event.type === 'done') { assert.deepEqual(event.permissionDenials, []); break }
    }
    assert.deepEqual(types, ['text', 'done']) // an allowed tool_result is not an error: no tool_error
  } finally { session.kill() }
})

test('session: with permission prompts none a refused action is permission_denied plus tool_error, no permission event', async () => {
  const session = await open({}, { args: codingArgs({ testCommands: ['sh test.sh'] }) })
  try {
    await session.prompt('[permission]')
    const types = []
    let denied, error, done
    for (;;) {
      const event = await session.next()
      types.push(event.type)
      if (event.type === 'permission_denied') denied = event
      if (event.type === 'tool_error') error = event
      if (event.type === 'done') { done = event; break }
    }
    assert.ok(!types.includes('permission'))
    assert.equal(denied.toolName, 'Bash')
    assert.match(denied.toolUseId, /^toolu_/)
    assert.match(denied.message, /no approval surface/)
    assert.equal(denied.reasonType, 'asyncAgent')
    assert.equal(error.toolUseId, denied.toolUseId)
    assert.equal(error.text, denied.message)
    assert.equal(done.permissionDenials[0].tool_use_id, denied.toolUseId)
  } finally { session.kill() }
})

test('session: an unanswered permission request is denied after permissionTimeoutMs', async () => {
  const session = await open({}, {}, { permissionTimeoutMs: 40 })
  try {
    await session.prompt('[permission]')
    const request = await until(session, 'permission')
    const timeout = await until(session, 'permission_timeout')
    assert.equal(timeout.id, request.id)
    assert.equal(timeout.toolName, 'Bash')
    const error = await until(session, 'tool_error')
    assert.match(error.text, /nobody answered/i)
    assert.equal((await until(session, 'done')).result, 'permission: deny')
    assert.equal(session.permissions.size, 0)
    request.reply(true) // too late: ignored, nothing is written
  } finally { session.kill() }
})

test('session: no timeout when none is set, and an answer stops the timer', async () => {
  const session = await open({}, {}, { permissionTimeoutMs: 60 })
  try {
    await session.prompt('[permission]')
    const request = await until(session, 'permission')
    request.reply(true)
    await until(session, 'done')
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(session.events.length, 0) // no permission_timeout after the answer
  } finally { session.kill() }
})

test('session: interrupt while a permission is pending: cancel event, aborted error, tool_error', async () => {
  const session = await open()
  try {
    await session.prompt('[permission]')
    const request = await until(session, 'permission')
    const response = await session.interrupt()
    assert.deepEqual(response, { still_queued: [] })
    const types = []
    let cancelled, error
    for (;;) {
      const event = await session.next()
      types.push(event.type)
      if (event.type === 'permission_cancelled') cancelled = event
      if (event.type === 'tool_error') assert.match(event.text, /doesn't want to proceed/)
      if (event.type === 'error') { error = event; break }
    }
    assert.deepEqual(types, ['permission_cancelled', 'tool_error', 'error'])
    assert.equal(cancelled.id, request.id)
    assert.equal(session.permissions.size, 0)
    assert.equal(error.reason, 'aborted')
    assert.equal(error.terminalReason, 'aborted_tools')
    assert.equal(error.subtype, 'error_during_execution')
    assert.match(error.error.message, /ede_diagnostic/) // text from errors[]: there is no result field
    assert.equal(error.result, undefined)
    request.reply(false) // withdrawn: ignored
  } finally { session.kill() }
})

test('session: interrupt during a running tool aborts with aborted_tools', async () => {
  const session = await open()
  try {
    await session.prompt('[slowtool]')
    const activity = await until(session, 'activity')
    assert.equal(activity.tool, 'Bash')
    assert.deepEqual(activity.input, { command: 'sleep 40' })
    await session.interrupt()
    const error = await until(session, 'error')
    assert.equal(error.reason, 'aborted')
    assert.equal(error.terminalReason, 'aborted_tools')
  } finally { session.kill() }
})

test('session: max turns is an error with reason max_turns and the text from errors[]', async () => {
  const session = await open()
  try {
    await session.prompt('[maxturns]')
    const error = await until(session, 'error')
    assert.equal(error.error.message, 'Reached maximum number of turns (2)')
    assert.equal(error.reason, 'max_turns')
    assert.equal(error.subtype, 'error_max_turns')
    assert.equal(error.terminalReason, 'max_turns')
    assert.equal(error.numTurns, 3)
    assert.equal(error.result, undefined)
    assert.deepEqual(error.errors, ['Reached maximum number of turns (2)'])
    assert.equal(error.totalCostUsd, 0.01)
    assert.equal(error.turnCostUsd, 0.01)
  } finally { session.kill() }
})

test('session: done carries subtype, turns, duration, cost (cumulative and per turn), denials, terminal reason', async () => {
  const session = await open()
  try {
    await session.prompt('one')
    const first = await until(session, 'done')
    assert.equal(first.subtype, 'success')
    assert.equal(first.terminalReason, 'completed')
    assert.equal(first.numTurns, 1)
    assert.equal(first.durationMs, 5)
    assert.deepEqual(first.permissionDenials, [])
    assert.equal(first.totalCostUsd, 0.01)
    assert.equal(first.turnCostUsd, 0.01)
    await session.prompt('two')
    const second = await until(session, 'done')
    assert.equal(second.totalCostUsd, 0.02) // cumulative over the process
    assert.equal(second.turnCostUsd, 0.01) // this turn only
  } finally { session.kill() }
})

test('session: init carries model, tools, mcp servers, permission mode, agents', async () => {
  const session = await open({}, { args: codingArgs({ reviewer, roleToolNames: ['review_report'], mcpServer: { name: 'chat-to-fix', config: { command: 'node', args: ['s.js'] } }, model: 'sonnet' }) })
  try {
    await session.prompt('hello')
    const init = await until(session, 'init')
    assert.equal(init.model, 'sonnet')
    assert.deepEqual(init.tools, [...CODING_TOOLS])
    assert.deepEqual(init.mcpServers, [{ name: 'chat-to-fix', status: 'connected' }])
    assert.equal(init.permissionMode, 'acceptEdits')
    assert.deepEqual(init.agents, ['general-purpose', 'reviewer'])
    assert.deepEqual(init.skills, [])
  } finally { session.kill() }
})

test('session: thinking_tokens lines are ignored and an empty thinking block is skipped', async () => {
  const session = await open()
  try {
    await session.prompt('[think]')
    const types = []
    for (;;) {
      const event = await session.next()
      types.push(event.type)
      if (event.type === 'done') break
    }
    assert.deepEqual(types, ['init', 'text', 'done'])
  } finally { session.kill() }
})

test('session: subagent events, child activity with parentToolUseId, tool errors and the Agent result', async () => {
  const session = await open()
  try {
    await session.prompt('[subagent]')
    const seen = []
    for (;;) {
      const event = await session.next()
      seen.push(event)
      if (event.type === 'done') break
    }
    const agent = seen.find(e => e.type === 'activity' && e.tool === 'Agent')
    assert.equal(agent.parentToolUseId, null)
    assert.equal(agent.input.subagent_type, 'reviewer')
    const phases = seen.filter(e => e.type === 'subagent')
    assert.deepEqual(phases.map(e => e.phase), ['started', 'progress', 'updated', 'notification'])
    for (const event of phases.filter(e => e.phase !== 'updated')) assert.equal(event.toolUseId, agent.toolUseId)
    for (const event of phases) assert.equal(event.taskId, 'a6c9a19194b878dac')
    assert.equal(phases[0].subagentType, 'reviewer')
    assert.equal(phases[0].description, 'Review the change')
    assert.equal(phases[1].lastToolName, 'Read')
    assert.equal(phases[1].usage.tool_uses, 1)
    assert.deepEqual(phases[2].patch, { status: 'completed', end_time: 1 })
    assert.equal(phases[3].status, 'completed')
    assert.equal(phases[3].summary, 'approve: the change is fine')
    const children = seen.filter(e => ['activity', 'text'].includes(e.type) && e.parentToolUseId === agent.toolUseId)
    assert.deepEqual(children.map(e => e.text), ['▸ Read', '▸ Write', 'child musing'])
    const childError = seen.find(e => e.type === 'tool_error')
    assert.equal(childError.parentToolUseId, agent.toolUseId)
    assert.equal(childError.toolName, 'Write')
    const answer = seen.find(e => e.type === 'subagent_result')
    assert.equal(answer.toolUseId, agent.toolUseId)
    assert.equal(answer.text, '[Subagent hand-back] approve: the change is fine')
    assert.equal(answer.isError, false)
    assert.equal(seen.filter(e => e.type === 'tool_error').length, 1) // the Agent result itself is not an error
    const main = seen.find(e => e.type === 'text' && e.parentToolUseId === null)
    assert.equal(main.text, 'the reviewer approved')
    assert.equal(seen.at(-1).numTurns, 3)
  } finally { session.kill() }
})

test('session: interrupt resolves on its response; the aborted turn is an aborted error', async () => {
  const session = await open()
  try {
    await session.prompt('[slow]')
    await until(session, 'init')
    const response = await session.interrupt()
    assert.deepEqual(response, { still_queued: [] })
    const event = await until(session, 'error')
    assert.equal(event.reason, 'aborted')
    assert.equal(event.terminalReason, 'aborted_streaming')
  } finally { session.kill() }
})

test('session: kill ends the stream without an error event', async () => {
  const session = await open()
  const exited = new Promise(resolve => session.child.once('exit', resolve))
  session.kill()
  await exited
  const types = []
  for await (const event of session) types.push(event.type)
  assert.ok(!types.includes('error'))
  assert.equal(session.dead, true)
  assert.equal(await session.next(), undefined)
  await assert.rejects(session.interrupt(), /gone/)
})

test('session: child that exits before initialize rejects start and yields an error event', async () => {
  const session = new ClaudeSession()
  await assert.rejects(
    session.start({ bin: process.execPath, args: [FAKE], env: childEnv({ source: SOURCE, extra: { FAKE_EXIT_BEFORE_INIT: '1' } }) } as any),
    /exited/,
  )
  const event = await session.next()
  assert.equal(event.type, 'error')
  assert.match(event.error.message, /exited/)
  assert.equal(await session.next(), undefined)
})

test('session: child that dies mid-turn yields an error event', async () => {
  const session = await open()
  await session.prompt('[exit]')
  const event = await until(session, 'error')
  assert.match(event.error.message, /exited/)
  assert.equal(await session.next(), undefined)
})

test('echo: argv reaches the child, extra env reaches it, unlisted variables do not', async () => {
  const session = await open({ ANTHROPIC_API_KEY: 'sk-given', CHAT_TO_FIX_X: 'yes' }, { permission: 'workspace-write', maxTurns: 3, reviewer, settingSources: 'project' })
  try {
    await session.prompt('[echo]')
    const { text } = await until(session, 'text')
    const { argv, env } = JSON.parse(text.slice('echo:'.length))
    assert.deepEqual(argv, claudeArgs({ permission: 'workspace-write', maxTurns: 3, reviewer, settingSources: 'project' }))
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-given')
    assert.equal(env.CHAT_TO_FIX_X, 'yes')
    assert.equal(env.HOME, '/home/x')
    assert.ok(!('SLACK_TOKEN' in env) && !('GITLAB_TOKEN' in env))
    // macOS itself adds __CF_USER_TEXT_ENCODING to every exec'd process; it is not ours.
    for (const key of Object.keys(env).filter(key => key !== '__CF_USER_TEXT_ENCODING')) assert.ok(['PATH', 'HOME', 'ANTHROPIC_API_KEY', 'CHAT_TO_FIX_X'].includes(key), `unexpected ${key}`)
  } finally { session.kill() }
})

test('echo: without extra, the leaked API key is absent', async () => {
  const session = await open()
  try {
    await session.prompt('[echo]')
    const { text } = await until(session, 'text')
    const { env } = JSON.parse(text.slice('echo:'.length))
    assert.ok(!('ANTHROPIC_API_KEY' in env))
  } finally { session.kill() }
})

test('fake CLI: a non-JSON line kills it, closing stdin ends it with exit 0', async () => {
  const { spawn } = await import('node:child_process')
  const run = (feed) => new Promise((resolve) => {
    const child = spawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'ignore'] })
    child.on('exit', code => resolve(code))
    feed(child.stdin)
  })
  assert.equal(await run(stdin => stdin.write('not json\n')), 1)
  assert.equal(await run(stdin => stdin.end()), 0)
})

test('args: a test command is allowed as an exact rule and as a prefix rule for trailing arguments, nothing wider', () => {
  assert.deepEqual(testRules('sh test.sh'), ['Bash(sh test.sh)', 'Bash(sh test.sh:*)'])
  assert.deepEqual(testRules('  npm test  '), ['Bash(npm test)', 'Bash(npm test:*)'])
  // A command that is compound or has a wildcard keeps its exact rule only: a prefix rule on it would be wider than the command.
  for (const command of ['cd app && npm test', 'make a; make b', 'npm test | tee log', 'npm test > out', 'sh test.sh *', 'echo $(id)']) {
    assert.deepEqual(testRules(command), [`Bash(${command})`], command)
  }
  assert.deepEqual(testRules(''), [])
  const coding = codingArgs({ testCommands: ['sh test.sh'] })
  const allowed = coding[coding.indexOf('--allowedTools') + 1].split(',')
  assert.deepEqual(allowed, ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(sh test.sh)', 'Bash(sh test.sh:*)'])
  // Still refused as before: no bare Bash.
  assert.throws(() => claudeArgs({ allowedTools: ['Bash'] }), /bare "Bash"/)
  assert.throws(() => claudeArgs({ allowedTools: ['Bash(*)'] }), /bare "Bash\(\*\)"/)
})

test('session: a refused action names what the model attempted, taken from its tool_use', async () => {
  const session = await open({}, { args: codingArgs({ testCommands: ['sh test.sh'] }) })
  try {
    await session.prompt('[denied:cd /work && sh test.sh 2>&1 | tail -5]')
    let denied, error
    for (;;) {
      const event = await session.next()
      if (event.type === 'permission_denied') denied = event
      if (event.type === 'tool_error') error = event
      if (event.type === 'done') break
    }
    assert.deepEqual(denied.input, { command: 'cd /work && sh test.sh 2>&1 | tail -5' })
    assert.deepEqual(error.input, denied.input)
    assert.equal(session.toolInputs.size, 0, 'a finished call is forgotten')
    assert.equal(session.toolNames.size, 0)
  } finally { session.kill() }
})

test('args: settings becomes one --settings value (an object as JSON, a string as given); codingArgs passes it on', () => {
  const settings = { claudeMdExcludes: ['/a/CLAUDE.md'] }
  const args = claudeArgs({ settingSources: 'project', settings })
  assert.equal(args[args.indexOf('--settings') + 1], JSON.stringify(settings))
  assert.equal(claudeArgs({ settings: '{"x":1}' }).at(-1), '{"x":1}')
  assert.equal(claudeArgs().includes('--settings'), false)
  const coding = codingArgs({ reviewer, settings })
  assert.equal(coding[coding.indexOf('--settings') + 1], JSON.stringify(settings))
  assert.equal(coding[coding.indexOf('--setting-sources') + 1], 'project')
  assert.equal(codingArgs({ reviewer }).includes('--settings'), false)
})

test('memoryExcludes: every instruction file above the working directory, the user config home, never the directory itself', () => {
  const cwd = '/Users/me/runs/r1/worktrees/T-1'
  assert.deepEqual(ancestorDirs(cwd), ['/Users/me/runs/r1/worktrees', '/Users/me/runs/r1', '/Users/me/runs', '/Users/me', '/Users'])
  const patterns = memoryExcludes(cwd, { configHomes: ['/Users/me/.claude'] })
  // the home directory's .claude is the file the second real run leaked (it is an ancestor, so it is a project file to the CLI)
  assert.ok(patterns.includes('/Users/me/.claude/CLAUDE.md'))
  assert.ok(patterns.includes('/Users/me/.claude/rules/**'))
  for (const dir of ancestorDirs(cwd)) {
    for (const file of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']) assert.ok(patterns.includes(`${dir}/${file}`), `${dir}/${file}`)
    assert.ok(patterns.includes(`${dir}/.claude/rules/**`))
  }
  // the repository's own files in the working directory are not excluded
  assert.equal(patterns.some(pattern => pattern.startsWith(`${cwd}/`) || pattern === cwd), false)
  assert.equal(patterns.some(pattern => pattern.startsWith('/CLAUDE.md')), false, 'the filesystem root is never walked')
  // the patterns do match what they name, and only that
  const hits = file => patterns.some(pattern => matchesGlob(file, pattern))
  assert.ok(hits('/Users/me/.claude/CLAUDE.md'))
  assert.ok(hits('/Users/me/.claude/rules/neo4j-graph-first.md'))
  assert.ok(hits('/Users/me/runs/CLAUDE.md'))
  assert.equal(hits(`${cwd}/CLAUDE.md`), false)
  assert.equal(hits(`${cwd}/.claude/rules/x.md`), false)
  assert.equal(hits('/Users/me/other/CLAUDE.md'), false)
  assert.deepEqual(isolationSettings(cwd, { configHomes: ['/Users/me/.claude'] }), { claudeMdExcludes: patterns })
})

test('memoryExcludes: glob characters in a path are matched literally; a config home outside the ancestors is added', () => {
  const patterns = memoryExcludes('/a/b[1]/c*/w', { configHomes: ['/private/cfg {x}'] })
  assert.ok(patterns.includes('/a/b[[]1[]]/c[*]/CLAUDE.md'))
  assert.ok(patterns.includes('/private/cfg [{]x[}]/CLAUDE.md'))
  assert.ok(patterns.includes('/private/cfg [{]x[}]/rules/**'))
  assert.deepEqual(memoryExcludes('/'), [])
})

test('userConfigHome: CLAUDE_CONFIG_DIR when set, else ~/.claude', () => {
  assert.equal(userConfigHome({ HOME: '/Users/me' }), '/Users/me/.claude')
  assert.equal(userConfigHome({ HOME: '/Users/me', CLAUDE_CONFIG_DIR: '/x/cfg' }), '/x/cfg')
  assert.equal(userConfigHome({ HOME: '/Users/me', CLAUDE_CONFIG_DIR: '' }), '/Users/me/.claude')
})
