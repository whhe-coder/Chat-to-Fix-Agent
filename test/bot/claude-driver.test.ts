// The Claude Code driver on the real bot layer: the Coding bot's CLI is started with the
// settled arguments, and its turns reach the bot's reply and the session events. The CLI is
// the fake of test/fixtures/fake-claude.ts; the task layer is src/app.ts on the fake DSH
// context of host.js; the loop is DSH's own (test/bot/loop.ts).
//
// Run: node --import ./bot/test/harness-resolve.mjs --test --test-force-exit test/bot/claude-driver.test.ts
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { loadPrompt } from '../../src/prompts/index.ts'
import { CODING_TOOLS } from '../../src/engine/args.ts'
import { startApp } from './host.ts'
import { answerOf, endOf, mountLoop, reasoningOf, send, waitForIdle } from './loop.ts'

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url))
const CLI = { command: process.execPath, args: [FAKE] }

const rig = async (t, runtime = {}) => {
  const app = await startApp(t, { cli: CLI, runtime: { testCommands: ['sh test.sh'], engineMaxTurns: 40, ...runtime } })
  const { bots } = await app.post()
  const adapter = await app.host.localAdapter()
  return { ...app, bots, adapter }
}

const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1]
// A turn through the adapter (no loop): the text of the reply.
async function textOf(stream) {
  let text = ''
  for await (const chunk of stream) if (chunk.type === 'text-delta') text += chunk.text
  return text
}
const streamOptions = (sessionId, text, extra = {}) => ({
  provider: 'claude-code', model: 'default', sessionId, tools: [], signal: AbortSignal.timeout(30_000), ...extra,
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
})
const echoed = text => JSON.parse(text.slice('echo:'.length))

test('a bound coding bot\'s CLI is started with the settled arguments', async (t) => {
  const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CHAT_TO_FIX_SLACK_TOKEN: process.env.CHAT_TO_FIX_SLACK_TOKEN }
  process.env.ANTHROPIC_API_KEY = 'sk-not-a-real-key'
  process.env.CHAT_TO_FIX_SLACK_TOKEN = 'xoxb-not-a-real-token'
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const { adapter, bots } = await rig(t)
  const reply = await textOf(adapter.stream(streamOptions(bots.coding, '[echo]', { model: 'sonnet' })))
  const { argv, env } = echoed(reply)

  assert.equal(argv[0], '-p')
  assert.deepEqual(argv.slice(1, 8), ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'])
  assert.equal(valueOf(argv, '--permission-prompts'), 'none')
  assert.equal(valueOf(argv, '--setting-sources'), 'project')
  assert.equal(valueOf(argv, '--permission-mode'), 'acceptEdits')
  assert.equal(valueOf(argv, '--tools'), CODING_TOOLS.join(','))
  assert.equal(valueOf(argv, '--max-turns'), '40')
  assert.equal(valueOf(argv, '--model'), 'sonnet')
  assert.ok(argv.includes('--strict-mcp-config'))
  assert.ok(argv.includes('--no-session-persistence'))

  // The reviewer: the registry's name and tools, the prompt of reviewer.md.
  const agents = JSON.parse(valueOf(argv, '--agents'))
  assert.deepEqual(Object.keys(agents), ['reviewer'])
  assert.equal(agents.reviewer.prompt, loadPrompt('reviewer'))
  assert.deepEqual(agents.reviewer.tools, ['Read', 'Grep', 'Glob'])
  assert.ok(agents.reviewer.description.length > 0)

  // Only our MCP server (the loopback one of DS Bot), by http with the session's token.
  const mcp = JSON.parse(valueOf(argv, '--mcp-config')).mcpServers
  assert.deepEqual(Object.keys(mcp), ['chat-to-fix'])
  assert.equal(mcp['chat-to-fix'].type, 'http')
  assert.match(mcp['chat-to-fix'].url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.match(mcp['chat-to-fix'].headers.Authorization, /^Bearer [0-9a-f]{64}$/)

  // The allow-list: the role tools of the coding bot (prefixed by the server name), the team
  // tools DS Bot bridges, the read-only git commands and the test command; not the approval tool.
  const allowed = valueOf(argv, '--allowedTools').split(',')
  for (const name of ['review_report', 'needs_info_confirm', 'task_read']) assert.ok(allowed.includes(`mcp__chat-to-fix__${name}`), name)
  assert.ok(allowed.includes('Bash(git status:*)') && allowed.includes('Bash(git diff:*)') && allowed.includes('Bash(sh test.sh)'))
  assert.equal(allowed.some(name => /approve_agent_action/.test(name)), false)
  assert.equal(allowed.some(name => /^(Read|Edit|Write|Bash)$/.test(name)), false, 'no bare file or shell rule')
  assert.equal(allowed.some(name => /task_advance|slack_|jira_|mr_open/.test(name)), false, 'no tool of another role')

  // The environment: the named variables only; no key (engineAuth login), no Slack token.
  assert.ok(env.PATH && env.HOME)
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.CHAT_TO_FIX_SLACK_TOKEN, undefined)
  assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1', 'the reviewer runs inside the turn')
  assert.equal(Object.keys(env).filter(key => /TOKEN|KEY|SECRET/.test(key)).length, 0)
})

test('a session that is not a bound coding bot is started with claudeArgs and what DS Bot passed before', async (t) => {
  const { adapter, host, bots } = await rig(t)
  const loose = await host.botlayer.createBot({ name: 'Loose', label: 'Other', instructions: 'You are Loose.' })
  const own = await textOf(adapter.stream(streamOptions(loose, '[echo]')))
  const { argv } = echoed(own)
  assert.equal(argv[0], '-p')
  assert.equal(valueOf(argv, '--permission-mode'), 'acceptEdits')
  assert.deepEqual(Object.keys(JSON.parse(valueOf(argv, '--mcp-config')).mcpServers), ['dsbot'])
  for (const flag of ['--agents', '--permission-prompts', '--tools', '--allowedTools', '--max-turns', '--no-session-persistence']) assert.equal(argv.includes(flag), false, flag)
  // A bound bot of another role (no reviewer) takes the same path.
  const main = echoed(await textOf(adapter.stream(streamOptions(bots.main, '[echo]'))))
  assert.equal(main.argv.includes('--agents'), false)
})

test('the engineAuth apiKey passes the key as the engine\'s extra variable, login passes none', async (t) => {
  const key = await rig(t, { engineAuth: 'apiKey', engineApiKey: 'sk-from-config' })
  const withKey = echoed(await textOf(key.adapter.stream(streamOptions(key.bots.coding, '[echo]')))).env
  assert.equal(withKey.ANTHROPIC_API_KEY, 'sk-from-config')
})

test('a turn\'s text reaches the bot\'s reply, and a bridged role tool is called over the HTTP MCP server', async (t) => {
  const { host, app, bots, adapter } = await rig(t)
  const { ctx, agent, close } = await mountLoop(host, adapter, bots.coding)
  t.after(close)
  // The first turn of a new CLI session replays the conversation; the next sends the new input alone.
  send(agent, 'kick off')
  await waitForIdle(ctx, agent)
  send(agent, 'fix the bug')
  await waitForIdle(ctx, agent)
  assert.match(answerOf(agent), /ok: fix the bug/)
  assert.equal(endOf(agent), 'completed')

  // What the CLI sees when it lists the tools of the loopback server (HTTP): the role tools, with schemas.
  const mcp = adapter.live.get(bots.coding).mcp
  const listed = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
  assert.equal(listed.status, 200)
  const tools = (await listed.json()).result.tools
  const report = tools.find(tool => tool.name === 'review_report')
  assert.ok(report, `tools/list: ${tools.map(tool => tool.name)}`)
  assert.deepEqual(Object.keys(report.inputSchema.properties).sort(), ['comments', 'rounds', 'verdict'])
  assert.ok(tools.some(tool => tool.name === 'task_read'))

  // The CLI calls review_report over the loopback MCP server; the task is not in step code, so
  // the registry's step check answers, and that answer is the tool's text.
  send(agent, '[mcp:review_report {"verdict":"pass","comments":"fine","rounds":1}]')
  await waitForIdle(ctx, agent)
  const types = agent.session.snapshotEvents().map(event => event.type)
  assert.ok(types.includes('tool/call') && types.includes('tool/result'))
  assert.match(answerOf(agent), /tool said: .*step/i)
  const [task] = await app.store.listTasks()
  assert.equal((await app.store.getTask(task.id)).review ?? null, null)

  // In step code the same call records the verdict in the task.
  await app.store.patchTask(task.id, { step: 'code' })
  send(agent, '[mcp:review_report {"verdict":"pass","comments":"fine","rounds":1}]')
  await waitForIdle(ctx, agent)
  assert.match(answerOf(agent), /Recorded: review pass/)
  assert.equal((await app.store.getTask(task.id)).review.verdict, 'pass')
})

test('a subagent result and a tool error show up in the session events', async (t) => {
  const { host, bots, adapter } = await rig(t)
  const { ctx, agent, close } = await mountLoop(host, adapter, bots.coding)
  t.after(close)
  send(agent, '[subagent]')
  await waitForIdle(ctx, agent)
  const reasoning = reasoningOf(agent)
  assert.match(reasoning, /▸ subagent result: \[Subagent hand-back\] approve: the change is fine/)
  assert.match(reasoning, /▸ tool error: Write: No such tool available: Write/)
  assert.equal(answerOf(agent), 'the reviewer approved')
})

test('with the settled arguments a refused action is a denial in the session events, not a request', async (t) => {
  const { host, bots, adapter } = await rig(t)
  const { ctx, agent, close } = await mountLoop(host, adapter, bots.coding)
  t.after(close)
  send(agent, '[permission]')
  await waitForIdle(ctx, agent)
  const reasoning = reasoningOf(agent)
  assert.match(reasoning, /▸ denied: Bash/)
  assert.match(reasoning, /▸ tool error: Bash: Permission for this tool use was denied/)
  assert.equal(answerOf(agent), 'refused')
  const types = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
  assert.equal(types.length, 0, 'no approval call was made')
})

test('a permission request nobody answers is denied after the timeout and the turn ends', async (t) => {
  const { host, adapter } = await rig(t, { permissionTimeoutMs: 150 })
  // A session of a bot the task layer did not make takes the attended path (permission prompts on).
  const loose = await host.botlayer.createBot({ name: 'Loose', label: 'Other', instructions: 'You are Loose.' })
  const messages = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '[permission]' }], source: { kind: 'user' } }]
  const options = { ...streamOptions(loose, ''), messages }
  const collect = async () => {
    const out = { reasoning: '', text: '', finish: undefined, calls: [] }
    for await (const chunk of adapter.stream(options)) {
      if (chunk.type === 'reasoning-delta') out.reasoning += chunk.text
      else if (chunk.type === 'text-delta') out.text += chunk.text
      else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') out.calls.push(chunk.block.name)
      else if (chunk.type === 'finish') out.finish = chunk.reason.kind
    }
    return out
  }
  const asked = await collect()
  assert.deepEqual(asked.calls, ['approve_agent_action'])
  await new Promise(resolve => setTimeout(resolve, 500))
  const ended = await collect()
  assert.equal(ended.finish, 'stop')
  assert.match(ended.reasoning, /timed out: denied/)
  assert.match(ended.reasoning, /Denied: nobody answered/)
  assert.equal(ended.text, 'permission: deny')
})
