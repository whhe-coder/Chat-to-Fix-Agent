// The Claude Code engine of the local agents: one ClaudeSession (src/engine/claude.js) per DSH
// Session. The driver itself lives in src/engine; this class only holds the sessions and builds
// each process's executable, arguments and environment through `launch`, which the host
// supplies (launch.js): launch(dshSessionId, openArgs) -> { args, env, permissionTimeoutMs }.
import { ClaudeSession } from '../../../../src/engine/claude.js'

export class ClaudeEngine {
  constructor(route, engine, { findExecutable, launch }) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.launch = launch
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

  async listModels() {
    return ['default', 'opus', 'sonnet', 'haiku'].map(id => ({ id, name: id === 'default' ? 'CLI default' : id }))
  }

  async close() {
    for (const session of this.sessions.values()) session.kill()
    this.sessions.clear()
  }
}
