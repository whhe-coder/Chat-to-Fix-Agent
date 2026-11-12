// A DS Bot fake DSH context with the chat-to-fix bot-layer entry installed on it, in the style of
// bot/test/group-work.test.js. Shared by the tests under test/bot/.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/config.ts'
import { createApp } from '../../src/app.ts'
import { connectTaskLayer, createRuntime, defineTool, runtimeOf } from '../../src/bot/index.ts'
import { fakeContext } from '../../bot/test/fake-ctx.ts'

export async function start(t, config: any = {}) {
  const home = mkdtempSync(join(tmpdir(), 'chat-to-fix-botlayer-'))
  const services = {
    permissionPresets: { resolve: name => name, set() {}, catalog: () => ({ options: [], defaultPreset: 'standard' }) },
  }
  const ctx = fakeContext({ services })
  const agents = new Map()
  const selected = []
  const prompts = []
  // What the local agents module registers on the llm service (a route list and the adapter).
  const adapters = []
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
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'claude-code', name: 'Claude Code' }],
      listModels: async provider => (provider === 'claude-code'
        ? [{ id: 'default', name: 'CLI default', inputModalities: ['text'] }, { id: 'sonnet', name: 'sonnet', inputModalities: ['text'] }]
        : [{ id: 'v4-flash', name: 'v4-flash', inputModalities: ['text'] }]),
      resolveModelInfo: async () => ({}),
      registerAdapter(routes, adapter) {
        const entry = { routes, adapter }
        adapters.push(entry)
        return Object.assign(() => {}, { replace(next) { entry.routes = next } })
      },
    },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async (request) => { selected.push(request) },
      prompt: async (request) => { prompts.push(request) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  // `config.build(ctx, home)` lets a test install something else on the context (the plugin
  // entry); it returns the facade or an object with a `botlayer`.
  const { build, ...rest } = config
  const built = build ? build(ctx, home) : createRuntime(ctx, { home, ...rest })
  const botlayer = built.botlayer ?? built
  const rt = runtimeOf(botlayer)
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
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
  // The local-agents adapter once the CLI is found (the scan runs in the background).
  const localAdapter = async () => {
    const until = Date.now() + 20_000
    while (adapters.length === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(adapters.length > 0, 'the local agent adapter was not registered')
    return adapters[0].adapter
  }
  return { home, ctx, rt, botlayer, built, agentOf, agentCreated, agents, selected, prompts, emit, tool, begin, finish, adapters, localAdapter }
}

export const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}

// The task layer (src/app.ts) on a host, as in role-tools.test.js, with the Claude Code driver
// pointed at `cli` ({ command, args }: the fake CLI, or a wrapper of the real one). `runtime` is
// extra runtime configuration (testCommands, permissionTimeoutMs, ...). Returns the host and
// the app; `post(text)` starts a task and resolves with the running task and its bots.
export async function startApp(t, { cli, runtime = {}, config: extra = {} }: { cli?: any, runtime?: any, config?: any } = {}) {
  const host = await start(t, { claudeCommand: cli.command, claudeCommandArgs: cli.args, ...runtime })
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-app-'))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify({
    dataDir: join(dir, 'data'),
    worktreesDir: join(dir, 'worktrees'),
    httpPort: 0,
    apiModel: 'deepseek/v4-flash',
    codingModel: 'claude-code/default',
    bindings: [{ channel: 'C1', repo: 'group/project', jiraProject: 'DEMO' }],
    ...extra,
  }))
  const config = loadConfig({ path: configPath, env: {} })
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
