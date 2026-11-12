import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from './rt-kit.ts'
import { fakeContext } from './fake-ctx.ts'

// Some routes (OpenCode Go among them) turn down every model request that names no
// Session. DS Bot's own requests name the Session they serve, and the hooks that act
// on a Session's own rounds still leave them alone.

const TEAM: any = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writing', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Code', model: 'deepseek/v4', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: { id: 'r1', name: 'Launch', named: true, members: ['b2', 'b3'], admin: 'b3', mode: 'everyone', notice: '', sessions: { b3: 'g3' }, seq: 0, log: [] },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const MISSING = '400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session"}'
const userText = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

async function drain(stream) {
  const chunks: any = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

// `ctx.llm.stream` runs the plugin's `llm/stream` listeners in order, as DSH does,
// and then a route that turns down a request without a Session. `respond` gives the
// text of each answer the route lets through.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-session-identity-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const bench: any = { tokens: 0, compacted: 0, respond: () => '', requests: [] }
  const compaction: any = {
    summarize() {},
    async compactIfNeeded() {
      bench.compacted += 1
      bench.tokens = 100
      return {}
    },
    async compactNow() {},
    async compactRegion() {},
  }
  const ctx = fakeContext({ services: { compaction, tokenMeter: { measure: () => ({ totalTokens: bench.tokens }) } } })
  async function* route(options) {
    bench.requests.push(options)
    if (options.sessionId === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: MISSING } } }
      return
    }
    yield { type: 'text-delta', index: 0, text: bench.respond(options) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }, { id: 'vision', inputModalities: ['text', 'image'] }],
      resolveModelInfo: async (_provider, model) => ({
        inputModalities: model === 'vision' ? ['text', 'image'] : ['text'],
        context: { contextWindow: 100_000 },
        defaultMaxTokens: 8_000,
        reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] },
      }),
      stream(options) {
        const chain = ctx.listeners.get('llm/stream') ?? []
        const run = index => (index < chain.length ? chain[index](options, () => run(index + 1)) : route(options))
        return run(0)
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 2 }, ctx: { tools: { register: () => () => {} } } } }),
      selectModel: async () => {},
      page: async () => ({
        records: [
          { event: { seq: 0, time: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep working on the report' }] } } },
          { event: { seq: 1, time: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Working on it.' }] } } } },
        ],
        hasMore: false,
      }),
    },
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  const hook = pattern => ctx.listeners.get('llm/stream').find(listener => pattern.test(String(listener)))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, bench, hook, stop }
}

for (const sessionId of ['b2', 'g3']) {
  test(`the context steward names the Session it decides for (${sessionId}), and the part is condensed in place`, async (t) => {
    const { ctx, bench, stop } = start()
    t.after(stop)
    bench.tokens = 95_000
    bench.respond = () => '{"action":"compact"}'
    const session: any = { id: sessionId, seq: 2, requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }), deriveMessages: () => [], toolHistory: () => [] }
    const preStep = ctx.listeners.get('agent/pre-step').find(listener => /adoptCompaction/.test(String(listener)))
    const next: any = { kind: 'continue' }
    const result = await preStep({ agent: { id: sessionId, session }, messages: [], step: 2, signal: new AbortController().signal }, () => next)
    assert.equal(result, next)
    assert.equal(bench.compacted, 1)
    assert.deepEqual(bench.requests.map(request => [request.sessionId, request.purpose]), [[sessionId, 'compaction']])
  })
}

test('the Session hooks pass DS Bot\'s own requests through, and still act on a Session\'s own rounds', async (t) => {
  const { rt, hook, stop } = start()
  t.after(stop)
  await rt.load()
  const own = (sessionId, messages) => ({ provider: 'deepseek', model: 'v4', sessionId, messages: rt.tagUsage([...messages], { sessionId, kind: 'compaction' }) })
  const round = (sessionId, messages) => ({ provider: 'deepseek', model: 'v4', sessionId, messages })
  const passed = (async function* () {})()
  const pass = () => passed

  const relay = hook(/relayOrPass/)
  assert.equal(relay(own('r1', [userText('Read this')]), pass), passed)
  assert.ok((await drain(relay({ ...round('r1', [userText('Read this')]), tools: [{ name: 'group_relay' }] }, pass))).some(chunk => chunk.name === 'group_relay'))

  const handoff: any = [{ role: 'user', source: { kind: 'bot', handoff: true }, content: [{ type: 'text', text: 'Handoff note' }] }]
  const acknowledge = hook(/acknowledge/)
  assert.equal(acknowledge(own('b2', handoff), pass), passed)
  assert.ok((await drain(acknowledge(round('b2', handoff), pass))).some(chunk => chunk.type === 'text-delta'))
})
