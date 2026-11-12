// Local agents: ordinary Bots whose model route is a local agent CLI (Claude Code only).
// install() scans for the CLI, registers one DSH LLM adapter for the route it found, keeps
// the Session→CLI-session map in state, and serves the Settings page.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { splitRef } from '../text.ts'
import { output } from '../tools.ts'
import { LocalAgentAdapter } from './adapter.ts'
import { ClaudeEngine } from './claude-engine.ts'
import { bridgeNames, launchFor } from './launch.ts'
import { ENGINES, isLocalAgentRoute } from './engines.ts'
import { findExecutable, probeVersion, refreshSearchDirs } from './discover.ts'
import { childEnv } from '../../../../src/engine/env.ts'

const SIGN_IN = {
  'claude-code': 'claude',
}

export function install(rt) {
  const { ctx, state } = rt
  // state.localAgents is replaced by the state load after install; read it
  // each time instead of holding the pre-load object.
  const store = () => {
    const live = state.localAgents ??= { sessions: {} }
    live.sessions ??= {}
    return live
  }

  const allRoutes = () => Object.keys(ENGINES)

  // The CLI is found on PATH by its name; rt.config.claudeCommand (a path or a name) names it
  // when it lives elsewhere (the Claude desktop app keeps it inside its bundle), and
  // rt.config.claudeCommandArgs go ahead of the arguments launch.js builds (a wrapper script).
  const engineOf = (route) => {
    const spec = ENGINES[route]
    if (spec === undefined || rt.config?.claudeCommand === undefined) return spec
    return { ...spec, command: rt.config.claudeCommand, args: rt.config.claudeCommandArgs ?? spec.args }
  }

  // How a Claude Code process is started for a Session: launch.js (arguments and environment).
  const spawnEngine = (kind, route, spec) => new ClaudeEngine(route, spec, { findExecutable, launch: (sessionId, open) => launchFor(rt, sessionId, open) })

  // Only CLIs found on this machine get a route; the scan result feeds the page.
  const found = new Map()
  async function scan() {
    await refreshSearchDirs()
    for (const route of Object.keys(ENGINES)) {
      const spec = engineOf(route)
      const path = findExecutable(spec.command)
      if (path === undefined) found.delete(route)
      else found.set(route, { route, name: spec.name, path, version: undefined, signIn: SIGN_IN[route] })
    }
    applyRoutes()
    return [...found.values()]
  }
  async function probeVersions() {
    for (const entry of found.values()) {
      if (entry.version !== undefined) continue
      const spec = engineOf(entry.route)
      const result = await probeVersion(entry.path, spec.version ?? ['--version'], childEnv()).catch(() => undefined)
      entry.version = result?.version
    }
  }

  const adapter = new LocalAgentAdapter({
    rt,
    findExecutable,
    engineOf,
    spawnEngine,
    record: sessionId => store().sessions[sessionId],
    saveRecord: (sessionId, record) => {
      store().sessions[sessionId] = record
      void rt.save().catch(() => {})
    },
    presetFor: (sessionId) => {
      const bot = rt.botOf(rt.selfOf(sessionId))
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      return room?.permission ?? bot?.permission ?? 'workspace-write'
    },
    cwdFor: async (sessionId) => {
      try {
        const agent = await rt.resolveAgent(sessionId)
        return agent.session.header?.cwd ?? rt.workDirOf?.({ botId: rt.selfOf(sessionId), roomId: rt.groupOwners.get(sessionId)?.roomId }) ?? rt.teamFolder?.() ?? tmpdir()
      } catch {
        return rt.teamFolder?.() ?? tmpdir()
      }
    },
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    toolsFor: (options) => {
      // Only DS Bot's own team tools and the session's role tools (the task layer's
      // bridgedToolNames) cross the bridge; the CLI keeps its own.
      const names = new Set([...rt.teamTools.map(def => def.name), 'approve_agent_action', ...bridgeNames(rt, options.sessionId)])
      return (options.tools ?? []).filter(tool => names.has(tool.name))
    },
  })

  let registration
  const supported = () => typeof ctx.llm?.registerAdapter === 'function'
  function applyRoutes() {
    if (!supported()) return
    const routes = [...found.keys()]
    // The initial registration needs at least one provider; an empty replace
    // is legal and keeps the adapter registered with zero routes.
    if (registration === undefined) {
      if (routes.length === 0) return
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else registration.replace(routes)
  }
  applyRoutes()
  void scan()
  // The callback returns the disposer: running adapter.dispose() inside the
  // setup would leave the adapter disposed from the moment it installs.
  ctx.effect(() => () => {
    void adapter.dispose()
    registration?.()
  }, 'ds-bot: local agents')

  // ---------------------------------------------------------------------------
  // Helpers the rest of the host asks.

  const isLocalAgentRef = ref => isLocalAgentRoute(splitRef(ref)?.provider ?? '')
  const localAgentOf = (bot) => {
    const ref = bot?.appliedModel ?? bot?.model
    return ref !== undefined && isLocalAgentRef(ref) ? ref : undefined
  }
  const isLocalAgentSession = (sessionId) => {
    const bot = rt.botOf(rt.selfOf(sessionId))
    return bot !== undefined && localAgentOf(bot) !== undefined
  }

  // ---------------------------------------------------------------------------
  // approve_agent_action: served only to abot sessions; the CLI's permission
  // prompts arrive through it as an ordinary approval card. It stays off
  // rt.teamTools (the catalog every Bot gets) and joins the scope only for a
  // local-agent Bot.

  rt.localAgentTools = [defineTool({
    name: 'approve_agent_action',
    description: 'Ask the user to approve an action you want to take: running a command, changing files, or reaching the network. The agent runtime asks this on your behalf when its own permission system wants a decision.',
    parameters: {
      action: { type: 'string', required: true, description: 'What the action does, in one line' },
      detail: { type: 'string', description: 'The exact command, paths, or arguments, when it helps the decision' },
    },
    output,
    localAgentOnly: true,
    async execute(args, exec) {
      const approval = ctx.get?.('approval')
      if (approval === undefined || exec.agent?.session === undefined) return 'denied: approvals are not available here'
      const text = `${args.action}${args.detail ? `\n${args.detail}` : ''}`
      const outcome = await approval.request({
        agent: exec.agent,
        toolName: exec.name,
        ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
        reason: text.slice(0, 500),
        displayReason: { en: text.slice(0, 500) },
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      // The adapter decides the CLI's option from this structured result;
      // only an explicit {"decision":"allow"} counts.
      return JSON.stringify({ decision: outcome === 'allowed-once' ? 'allow' : 'deny' })
    },
  })]

  // ---------------------------------------------------------------------------
  // The Settings page's endpoints.

  const detected = () => [...found.values()].map(entry => ({ route: entry.route, name: entry.name, path: entry.path, version: entry.version ?? null, signIn: entry.signIn }))

  async function localAgentsEndpoint(endpoint, body) {
    switch (endpoint) {
      case 'local-agents': {
        await scan()
        await probeVersions()
        return { available: supported(), detected: detected(), custom: [] }
      }
      case 'local-agent-refresh': {
        adapter.dropModelCache()
        await scan()
        await probeVersions()
        return { available: supported(), detected: detected(), custom: [] }
      }
      default:
        throw new Error(`Unknown endpoint ${endpoint}`)
    }
  }

  Object.assign(rt, {
    isLocalAgentRoute, isLocalAgentRef, localAgentOf, isLocalAgentSession,
    localAgentRoutes: allRoutes, localAgentsEndpoint,
    localAgentBadge: (ref) => {
      const provider = splitRef(ref)?.provider
      return provider !== undefined && isLocalAgentRoute(provider) ? provider : undefined
    },
  })
}
