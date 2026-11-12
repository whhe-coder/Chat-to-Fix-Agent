import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.ts'
import { ClaudeEngine } from '../src/host/local-agents/claude-engine.ts'
import { launchFor } from '../src/host/local-agents/launch.ts'
import { LoopbackMcp, flattenSchema } from '../src/host/local-agents/mcp.ts'
import { ENGINES, isLocalAgentRoute } from '../src/host/local-agents/engines.ts'
import { install as partsInstall } from '../src/host/parts.ts'
import { fakeContext } from './fake-ctx.js'

// The fake Claude Code CLI of the task layer (behaves like the real CLI 2.1.321).
const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-claude.mjs', import.meta.url))

const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const system = (id, text) => ({ id, role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } })
const toolResult = (id, callId, text, isError = false) => ({ id, role: 'tool', content: [{ type: 'text', text }], toolCallId: callId, isError, source: { kind: 'tool', callId } })

// An adapter wired to the fake CLI: the route spawns `node fake-claude.mjs` with the arguments
// launch.js builds for a session that is not a bound coding bot (claudeArgs).
function makeAdapter({ records = {}, preset = 'workspace-write', config = {} } = {}) {
  const rt = { warn: () => {}, config, teamTools: [{ name: 'message_bot' }] }
  const spawned = []
  const adapter = new LocalAgentAdapter({
    rt,
    findExecutable: path => path,
    spawnEngine: (kind, route, spec) => {
      const engine = new ClaudeEngine(route, { ...spec, command: process.execPath, args: [FAKE] }, { findExecutable: path => path, launch: (sessionId, open) => launchFor(rt, sessionId, open) })
      spawned.push(engine)
      return engine
    },
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    presetFor: () => preset,
    cwdFor: async () => mkdtempSync(join(tmpdir(), 'dsb-cwd-')),
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    toolsFor: () => [{ name: 'message_bot', description: 'Message another Bot', parameters: { type: 'object', properties: { bot: { type: 'string' }, text: { type: 'string' } } } }],
  })
  adapter._spawned = spawned
  return adapter
}

// Collect a stream into {text, thinking, calls, finish} for assertions.
async function collect(stream) {
  const out = { text: '', thinking: '', calls: [], finish: undefined, usage: undefined }
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') out.text += chunk.text
    else if (chunk.type === 'reasoning-delta') out.thinking += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') out.calls.push(chunk.block)
    else if (chunk.type === 'usage') out.usage = chunk.usage
    else if (chunk.type === 'finish') out.finish = chunk.reason
  }
  return out
}

const options = (sessionId, messages, extra = {}) => ({ provider: 'claude-code', model: 'default', sessionId, messages, tools: [{ name: 'message_bot' }], signal: AbortSignal.timeout(60_000), ...extra })

test('session-title and compaction stay deterministic, no CLI is started', async () => {
  const adapter = makeAdapter()
  const title = await collect(adapter.stream(options('s1', [user('m1', 'Please review the auth changes')], { purpose: 'session-title' })))
  assert.equal(title.text, 'Please review the auth changes')
  assert.equal(title.finish.kind, 'stop')
  const digest = await collect(adapter.stream(options('s1', [user('m1', 'hello')], { purpose: 'compaction' })))
  assert.match(digest.text, /condensed/)
  assert.equal(adapter.engines.size, 0)
  await adapter.dispose()
})

test('a first turn replays the conversation, a later one sends only the delta', async (t) => {
  const records = {}
  const adapter = makeAdapter({ records })
  t.after(() => adapter.dispose())
  const first = await collect(adapter.stream(options('s1', [system('sys', 'You are Kai, a coder.'), user('m1', 'hello')])))
  assert.match(first.text, /^ok: /)
  assert.match(first.thinking, /thought about/)
  assert.match(first.thinking, /▸ Read/)
  assert.equal(first.finish.kind, 'stop')
  assert.equal(first.usage.inputTokens, 10)
  // The record remembers the CLI session and how far it was handed.
  assert.ok(records.s1.cliSessionId?.startsWith('claude-'))
  assert.equal(records.s1.handedId, 'm1')
  const second = await collect(adapter.stream(options('s1', [system('sys', 'You are Kai, a coder.'), user('m1', 'hello'), user('m2', 'again')])))
  assert.match(second.text, /ok: again/)
  assert.equal(records.s1.handedId, 'm2')
})

test('each DS Bot Session maps to its own CLI session', async (t) => {
  const records = {}
  const adapter = makeAdapter({ records })
  t.after(() => adapter.dispose())
  await collect(adapter.stream(options('own', [user('m1', 'one')])))
  await collect(adapter.stream(options('group', [user('m1', 'two')])))
  assert.notEqual(records.own.cliSessionId, records.group.cliSessionId)
})

test('the MCP bridge suspends the turn and the next stream answers it', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const first = await collect(adapter.stream(options('s1', [user('m1', 'please [mcp:message_bot] now')])))
  assert.equal(first.finish.kind, 'tool-calls')
  assert.equal(first.calls.length, 1)
  assert.equal(first.calls[0].name, 'message_bot')
  const second = await collect(adapter.stream(options('s1', [user('m1', 'please [mcp:message_bot] now'), toolResult('m2', first.calls[0].id, 'Kai says hi back')])))
  assert.equal(second.finish.kind, 'stop')
  assert.match(second.text, /tool said: Kai says hi back/)
})

test('the loopback MCP server lists the tools of the latest request over HTTP', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  await collect(adapter.stream(options('s1', [user('m1', 'hello')])))
  const mcp = adapter.live.get('s1').mcp
  const list = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
  assert.equal(list.status, 200)
  const tools = (await list.json()).result.tools
  assert.deepEqual(tools.map(tool => tool.name), ['message_bot'])
  assert.equal(tools[0].inputSchema.type, 'object')
})

test('a permission prompt bridges to approve_agent_action and fails closed', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const ask = await collect(adapter.stream(options('s1', [user('m1', '[permission]')])))
  assert.equal(ask.finish.kind, 'tool-calls')
  assert.equal(ask.calls[0].name, 'approve_agent_action')
  // The request named the call only by id; the card still says what it runs.
  const asked = JSON.parse(ask.calls[0].arguments ?? JSON.stringify(ask.calls[0].args))
  assert.equal(asked.action, 'Run Bash')
  assert.equal(asked.detail, '{"command":"ls"}')
  // An allowed answer allows the action: only the structured {"decision":"allow"} counts.
  const allowed = await collect(adapter.stream(options('s1', [user('m1', '[permission]'), toolResult('m2', ask.calls[0].id, JSON.stringify({ decision: 'allow' }))])))
  assert.match(allowed.text, /permission: allow/)
})
test('a permission answer that is not the structured allow is denied, with a reason', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const ask = await collect(adapter.stream(options('s1', [user('m1', '[permission]')])))
  // Free text that reads like an approval is not an approval. The fake CLI accepts a deny only
  // with a message ("permission: invalid" otherwise), and shows the message as the tool's error.
  const loose = await collect(adapter.stream(options('s1', [user('m1', '[permission]'), toolResult('m2', ask.calls[0].id, 'yes, allow it')])))
  assert.match(loose.text, /permission: deny/)
  assert.match(loose.thinking, /tool error: Bash: Denied/)
})
test('a denied answer rejects the agent\'s action', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const ask = await collect(adapter.stream(options('s1', [user('m1', '[permission]')])))
  const denied = await collect(adapter.stream(options('s1', [user('m1', '[permission]'), toolResult('m2', ask.calls[0].id, JSON.stringify({ decision: 'deny' }))])))
  assert.match(denied.text, /permission: deny/)
  assert.match(denied.thinking, /tool error: Bash: Denied: the user did not approve/)
})

test('a permission request nobody answers is denied after the timeout and the turn ends', async (t) => {
  const adapter = makeAdapter({ config: { permissionTimeoutMs: 150 } })
  t.after(() => adapter.dispose())
  const messages = [user('m1', '[permission]')]
  const ask = await collect(adapter.stream(options('s1', messages)))
  assert.equal(ask.calls[0].name, 'approve_agent_action')
  await new Promise(resolve => setTimeout(resolve, 500))
  // Nobody answered: the driver denied it, the CLI went on and ended the turn.
  const ended = await collect(adapter.stream(options('s1', messages)))
  assert.equal(ended.finish.kind, 'stop')
  assert.match(ended.thinking, /timed out: denied/)
  assert.match(ended.thinking, /tool error: Bash: Denied: nobody answered/)
  assert.match(ended.text, /permission: deny/)
})

test('a subagent result, a denial and a tool error are shown with the turn', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const out = await collect(adapter.stream(options('s1', [user('m1', '[subagent]')])))
  assert.equal(out.finish.kind, 'stop')
  assert.match(out.thinking, /▸ subagent reviewer started: Review the change/)
  assert.match(out.thinking, /▸ subagent result: \[Subagent hand-back\] approve: the change is fine/)
  assert.match(out.thinking, /▸ subagent completed/)
  // The reviewer's own failed call is a tool error; its musings are not the answer.
  assert.match(out.thinking, /▸ tool error: Write: No such tool available: Write/)
  assert.match(out.thinking, /child musing/)
  assert.equal(out.text, 'the reviewer approved')
})

test('abort cancels the turn, and the stopped turn does not answer the next one', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const control = new AbortController()
  const stream = collect(adapter.stream(options('s1', [user('m1', '[slow]')], { signal: control.signal })))
  setTimeout(() => control.abort(), 300)
  const out = await stream
  assert.equal(out.finish.kind, 'aborted')
  const next = await collect(adapter.stream(options('s1', [user('m1', '[slow]'), user('m2', 'after the stop')])))
  assert.match(next.text, /ok: after the stop/)
  assert.equal(next.finish.kind, 'stop')
})

test('a CLI that exits ends the turn with a typed error and the next prompt starts a new one', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  await assert.rejects(collect(adapter.stream(options('s1', [user('m1', '[exit]')]))), error => error.code === 'LOCAL_AGENT_EXIT')
  const next = await collect(adapter.stream(options('s1', [user('m1', '[exit]'), user('m2', 'again')])))
  assert.match(next.text, /ok: /)
})

test('routes: only Claude Code is a local agent route', () => {
  assert.deepEqual(Object.keys(ENGINES), ['claude-code'])
  assert.equal(isLocalAgentRoute('claude-code'), true)
  assert.equal(isLocalAgentRoute('devin-cli'), false)
  assert.equal(isLocalAgentRoute('codex-cli'), false)
  assert.equal(isLocalAgentRoute('acp-custom'), false)
  assert.equal(isLocalAgentRoute('deepseek'), false)
})

test('listModels reports the CLI default plus the model aliases', async (t) => {
  const adapter = makeAdapter()
  t.after(() => adapter.dispose())
  const models = await adapter.listModels('claude-code')
  assert.deepEqual(models.map(model => model.id), ['default', 'opus', 'sonnet', 'haiku'])
  assert.equal(models[0].name, 'CLI default')
})

test('MCP: bad token gets 401, tools/list flattens schemas', async () => {
  const mcp = new LoopbackMcp(() => [{ name: 'message_bot', description: 'd', parameters: { type: 'object', properties: { x: { anyOf: [{ type: 'string' }, { type: 'number' }] } }, required: ['x'] } }], async () => ({ text: 'done' }))
  await mcp.listen()
  const url = mcp.url
  const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{}' })
  assert.equal(bad.status, 401)
  const good = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
  const list = (await good.json()).result
  assert.equal(list.tools[0].name, 'message_bot')
  assert.equal(list.tools[0].inputSchema.properties.x.type, 'string')
  mcp.close()
})

test('flattenSchema removes unions, refs and const', () => {
  const flat = flattenSchema({ type: 'object', $defs: { a: { type: 'string' } }, properties: { p: { $ref: '#/$defs/a' }, q: { const: 'x' }, r: { oneOf: [{ type: 'null' }, { type: 'number' }] } } })
  assert.equal(flat.$defs, undefined)
  assert.equal(flat.properties.p.$ref, undefined)
  assert.equal(flat.properties.q.const, undefined)
  assert.equal(flat.properties.r.type, 'number')
})

// The steward must never touch an abot's Session: the pre-step listener returns
// early for a local-agent Bot, and checkContext leaves too.
test('the steward leaves a local-agent Session alone', async () => {
  const ctx = fakeContext()
  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'acp-fake/default' }
  const rt = {
    ctx,
    config: {},
    state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [] },
    warnings: [],
    warn() {},
    async save() {},
    async load() {},
    readOnly: () => undefined,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    selfOf: () => 'b1',
    chatOf: () => 's1',
    isBotSession: id => id === 's1',
    isLocalAgentRef: ref => typeof ref === 'string' && ref.startsWith('acp-'),
    chatOwners: new Map([['s1', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map(),
    partsOf: () => [],
    resolveAgent: async id => ({ id, session: { id, deriveMessages: () => [] }, status: 'idle' }),
    teamTools: [],
  }
  partsInstall(rt)
  const listener = ctx.listeners.get('agent/pre-step')?.[0]
  assert.ok(listener !== undefined)
  const agent = { id: 's1', session: { id: 's1', deriveMessages: () => [] }, status: 'idle' }
  const next = async () => 'next-called'
  const result = await listener({ agent, messages: [] }, next)
  assert.equal(result, 'next-called')
})

// A manual new part gives the deterministic handoff: verbatim tail + anchors +
// the read_own_chat line, with no model call.
test('a fresh part carries the deterministic handoff', async () => {
  const ctx = fakeContext()
  ctx.workspaceRegistry = { archiveSession: async () => {}, unarchiveSession: async () => {} }
  ctx.sessions = { flush: async () => {} }
  const messages = Array.from({ length: 14 }, (_, i) => ({ seq: i + 1, who: i % 2 ? 'you' : 'user', text: `line ${i + 1}` }))
  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'acp-fake/default', segments: [] }
  const followed = []
  const delivered = []
  const rt = {
    ctx,
    config: {},
    state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
    warn: (...args) => rt.warnings.push(args.join(' ')),
    warnings: [],
    async save() {},
    async load() {},
    readOnly: () => undefined,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    selfOf: () => 'b1',
    isMain: () => false,
    chatOf: () => 's1',
    sessionOfRoom: () => undefined,
    isBotSession: id => ['s1', 's2'].includes(id),
    isLocalAgentRef: ref => typeof ref === 'string' && ref.startsWith('acp-'),
    chatOwners: new Map([['s1', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map(),
    teamTools: [],
    live: new Map(),
    groupSessionsOf: () => [],
    unreadOf: () => [],
    clock: () => 'now',
    partsOf: () => (bot.segments ?? []).map(segment => segment.sessionId),
    partLines: async function* () { for (const line of messages) yield line },
    eventsBackwards: async function* () {
      for (const line of [...messages].reverse()) {
        yield line.who === 'user'
          ? { type: 'user/message', time: line.seq, seq: line.seq, data: { content: [{ type: 'text', text: line.text }], source: { kind: 'user' } } }
          : { type: 'assistant/message', time: line.seq, seq: line.seq, data: { message: { content: [{ type: 'text', text: line.text }] } } }
      }
    },
    historyEntry: () => undefined,
    displayItems: async () => [],
    earlierPage: async () => ({}),
    chatPage: async () => ({}),
    noteText: () => '',
    followFolder: async () => {},
    heldBack: () => [],
    resolveAgent: async id => ({ id, session: { id, deriveMessages: () => messages.map(line => ({ role: line.who === 'user' ? 'user' : 'assistant', content: [{ type: 'text', text: line.text }] })) }, status: 'idle', followup: (message) => followed.push(message), whenIdle: async () => {}, runMaintenance: async fn => fn(AbortSignal.timeout(5_000)), inbox: { nextStep: [], nextTurn: [] }, send: async () => {} }),
    createSession: async () => 's2',
    desiredModel: async bot => bot.model,
    desiredEffort: async () => undefined,
    selectSessionModel: async () => {},
    applyModel: async () => {},
    applyPermission: async () => {},
    ensureCapabilities: async () => {},
    renewMemory: () => {},
    moveSchedules: async () => {},
    sessionTitle: { rename: async () => {} },
    deliver: async (message) => delivered.push(message),
    teamFolder: () => '/tmp/team',
    workDirOf: () => '/tmp/team',
    isFolder: async () => true,
    uiLanguage: () => 'en',
    roomProgress: new Map(),
    resolveModelInfo: async () => ({}),
    llmRequests: new Map(),
  }
  partsInstall(rt)
  assert.equal(typeof rt.newPart, 'function')
  await rt.newPart('s1')
  // The switch runs as a job; the Bot lands on s2 with s1 kept as an earlier part.
  for (let i = 0; i < 50 && bot.sessionId !== 's2'; i += 1) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(bot.sessionId, 's2', rt.warnings.join(' | '))
  assert.equal(bot.segments.length, 1)
  assert.equal(bot.segments[0].sessionId, 's1')
  const text = [...followed, ...delivered].map(message => message?.content?.map?.(block => block.text).join('') ?? message?.text ?? String(message)).join('\n')
  assert.match(text, /fresh conversation was started|previous part|read_own_chat/i)
})
