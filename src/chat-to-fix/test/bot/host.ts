// A DS Bot fake DSH context with the chat-to-fix bot-layer entry installed on it, in the style of
// bot/test/group-work.test.js. Shared by the tests under test/bot/.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../core/config.ts'
import { createApp } from '../../core/app.ts'
import { connectTaskLayer, createRuntime, defineTool, runtimeOf } from '../../core/bot/index.ts'
import { fakeContext } from '../../bot/test/fake-ctx.ts'

export async function start(t, config: any = {}) {
  const home = mkdtempSync(join(tmpdir(), 'chat-to-fix-botlayer-'))
  // `config.presets` (a list of agent preset ids) makes the fake DSH serve those agent presets.
  const services: any = {
    permissionPresets: { resolve: name => name, set() {}, catalog: () => ({ options: [], defaultPreset: 'standard' }) },
    ...(config.presets ? { agentPresets: { list: async () => config.presets.map(id => ({ id })), serviceFor: () => undefined } } : {}),
  }
  const ctx = fakeContext({ services })
  const agents = new Map()
  const selected = []
  const prompts = []
  // Every request the bot layer made to create a session (cwd, workspaceId, agentPreset).
  const creates = []
  // What the projections of a session report (see sessionController.projections below).
  const totals = new Map()
  let sessions = 0
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const held = []
      const nextStep = []
      const inbox = {
        nextStep,
        nextTurn: held,
        remove(id) {
          for (const list of [nextStep, held]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      }
      const keep = list => message => { calls.push(message); list.push(message) }
      // As in bot/test/scoped-tools-creation.test.js: the Agent's own tool scope. `registrations`
      // keeps every tool registered into it; the disposer marks one removed.
      const registrations = []
      const register = (def) => {
        const entry = { name: def.name, def, active: true }
        registrations.push(entry)
        return () => { entry.active = false }
      }
      agents.set(sessionId, { session: { id: sessionId }, ctx: { tools: { register } }, registrations, calls, inbox, followup: keep(held), steer: keep(nextStep), cancel() {} })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4-flash', name: 'v4-flash', inputModalities: ['text'] }],
      // `config.efforts` (a list of thinking levels) makes every model serve them, as a reasoning model does.
      resolveModelInfo: async () => (config.efforts ? { reasoning: { efforts: config.efforts.map(id => ({ id })) } } : {}),
    },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      // DSH's per-session projections (tokenUsage, sessionStats); only when `config.projections` is set, so the
      // other tests keep the plain synchronous round end. A test sets what a session reports: host.totals.set(id, { tokens, stats }).
      ...(config.projections ? { projections: async ({ sessionId }) => {
        const got = totals.get(sessionId)
        return got === undefined ? null : { kind: 'sequenced', asOfSeq: 1, values: { tokenUsage: got.tokens, sessionStats: got.stats } }
      } } : {}),
      create: async (request) => { creates.push(request); return { sessionId: `s${++sessions}` } },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async (request) => { selected.push(request) },
      prompt: async (request) => { prompts.push(request) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  // `config.build(ctx, home)` lets a test install something else on the context (the plugin
  // entry); it returns the facade or an object with a `botlayer`.
  const { build, presets, projections, efforts, ...rest } = config
  const built = build ? build(ctx, home) : createRuntime(ctx, { home, ...rest })
  const botlayer = built.botlayer ?? built
  const rt = runtimeOf(botlayer)
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data, time?) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data, ...(time === undefined ? {} : { time }) })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  // DSH announces an Agent for a session: DS Bot then prepares the tools of its own scope.
  const agentCreated = async (sessionId) => {
    for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent: agentOf(sessionId) })
  }
  const begin = (sessionId) => {
    const message = agentOf(sessionId).calls.at(-1)
    agentOf(sessionId).inbox.nextTurn.length = 0
    agentOf(sessionId).inbox.nextStep.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  return { home, ctx, rt, botlayer, built, agentOf, agentCreated, agents, selected, prompts, creates, totals, emit, tool, begin, finish, services }
}

export const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}

// The task layer (core/app.ts) on a host, as in role-tools.test.js. `runtime` is extra host configuration
// (presets, efforts, ...). Every bot is on the fake DSH's deepseek route. Returns the host and the app;
// `post(text)` starts a task and resolves with the running task and its bots.
export async function startApp(t, { runtime = {}, config: extra = {} }: { runtime?: any, config?: any } = {}) {
  const host = await start(t, { ...runtime })
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-app-'))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify({
    dataDir: join(dir, 'data'),
    worktreesDir: join(dir, 'worktrees'),
    httpPort: 0,
    apiModel: 'deepseek/v4-flash',
    codingModel: 'deepseek/v4-flash',
    bindings: [{ channel: 'C1', repo: 'group/project', jiraProject: 'DEMO' }],
    ...extra,
  }))
  const config = loadConfig({ path: configPath, env: { ANTHROPIC_API_KEY: 'test-key' } })
  const warnings = []
  const app = createApp({ config, botlayer: host.botlayer, token: 'tok', defineTool, warn: (...args) => warnings.push(args.join(' ')) })
  connectTaskLayer(host.botlayer, app.taskLayer)
  const port = await app.start()
  t.after(() => app.stop())
  let events = 0
  const post = async (text = 'the save button does nothing') => {
    const n = ++events
    const posted = await (await fetch(`http://127.0.0.1:${port}/events`, {
      method: 'POST', headers: { 'x-chat-to-fix-token': 'tok', 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: `E${n}`, channel: 'C1', threadTs: `${n}.1`, messageTs: `${n}.1`, user: { id: 'U1', name: 'tester' }, text }),
    })).json()
    for (let i = 0; i < 300; i++) {
      const task = await app.store.getTask(posted.taskId)
      if (task?.state === 'running') return { task, bots: task.runs.at(-1).bots }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`task ${posted.taskId} did not start; warnings: ${warnings.join(' | ')}`)
  }
  return { host, app, post, warnings, config }
}
