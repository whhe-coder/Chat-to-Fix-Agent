// The Claude Code engine of the local agents: one ClaudeSession (src/engine/claude.ts) per DSH
// Session. The driver itself lives in src/engine; this class only holds the sessions and builds
// each process's executable, arguments and environment through `launch`, which the host
// supplies (launch.js): launch(dshSessionId, openArgs) -> { args, env, permissionTimeoutMs }.
import { ClaudeSession } from '../../../../src/engine/claude.ts'

export class ClaudeEngine {
  declare route: any
  declare engine: any
  declare findExecutable: any
  declare launch: any
  declare sessions: Map<any, any>
  declare extraModels: any
  constructor(route, engine, { findExecutable, launch, extraModels = () => [] }: any) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.launch = launch
    this.extraModels = extraModels
    this.sessions = new Map()
  }

  // A live process holds its own event queue; the adapter drains it.
  async open(dshSessionId, openArgs) {
    let session = this.sessions.get(dshSessionId)
    if (session !== undefined && session.dead) session = undefined
    if (session !== undefined) return session
    const bin = this.findExecutable(this.engine.command)
    if (bin === undefined) throw Object.assign(new Error(`${this.engine.name} is not installed`), { code: 'NO_ADAPTER' })
    const { args, env, permissionTimeoutMs, resumed } = this.launch(dshSessionId, openArgs)
    session = new ClaudeSession({ name: this.engine.name })
    this.sessions.set(dshSessionId, session)
    // Fixture scripts in tests ride in spec.args ahead of the real CLI flags.
    await session.start({ bin, cwd: openArgs.cwd, args: [...(this.engine.args ?? []), ...args], env, permissionTimeoutMs })
    session.resumed = resumed === true
    return session
  }

  prompt(session, blocks) {
    return session.prompt(blocks)
  }

  // Input while a turn runs: the CLI queues a further user message.
  steer(session, text) {
    return session.prompt(text)
  }

  cancel(session) {
    session.interrupt().catch(() => {})
  }

  // Ends the process of one Session.
  release(dshSessionId) {
    this.sessions.get(dshSessionId)?.kill()
    this.sessions.delete(dshSessionId)
  }

  // The aliases of the CLI, the full ids of the priced models (src/task/pricing.ts) and the configured Coding model.
  // A model the catalog does not list cannot be given to a bot (models.ts resolveModel refuses it, and a bot
  // whose model is not listed falls back to the default), so a pinned `claude-code/claude-sonnet-5-5` must be here.
  async listModels() {
    const ids = ['default', 'opus', 'sonnet', 'haiku', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', ...this.extraModels()]
    return [...new Set(ids)].map(id => ({ id, name: id === 'default' ? 'CLI default' : id }))
  }

  async close() {
    for (const session of this.sessions.values()) session.kill()
    this.sessions.clear()
  }
}
