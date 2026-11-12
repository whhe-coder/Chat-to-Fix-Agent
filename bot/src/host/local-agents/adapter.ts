// The LlmAdapter that serves every local-agent route. A DS Bot Bot whose model
// is one of these routes answers through a local agent CLI instead of a model
// API: the loop, Sessions, tools and approvals are the ordinary ones; this
// adapter turns each request into a prompt for the CLI session the Session is
// mapped to, and the CLI's output back into stream chunks.
import { createHash } from 'node:crypto'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { textOf } from '../text.ts'
import { engineOf } from './engines.ts'
import { LoopbackMcp } from './mcp.ts'

export const DEFAULT_CONTEXT_WINDOW = 200_000
// The replay window when a CLI session is new or its resume failed.
const REPLAY_MESSAGES = 12
const REPLAY_BYTES = 24 * 1024
const IDLE_CLOSE_MS = 10 * 60_000
// Injectable: deps.idleCloseMs, else the runtime configuration's idleCloseMs (tests close after a few ms).
const idleCloseOf = (deps: any) => {
  const ms = deps?.idleCloseMs ?? deps?.rt?.config?.idleCloseMs
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : IDLE_CLOSE_MS
}
const APPROVE_TOOL = 'approve_agent_action'

// A title request never reaches the CLI.
function titleChunk(text: any) {
  const title = text.slice(0, 60)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: title },
    { type: 'block-end', index: 0, block: { type: 'text', text: title } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

// A compaction request neither: a deterministic digest of the messages.
function digestChunks(messages: any) {
  const lines = []
  let used = 0
  for (const message of messages ?? []) {
    const text = textOf(message.content).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const line = `${message.role}: ${text.slice(0, 300)}`
    if (used + line.length > 8 * 1024) break
    lines.push(line)
    used += line.length
  }
  const text = `[Earlier conversation, condensed]\n${lines.join('\n')}`
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

// DSH's usage chunk names the cache-write count cacheWriteTokens; the CLI driver calls it cacheCreationTokens.
const dshUsage = (usage) => {
  const { cacheCreationTokens, ...rest } = usage ?? {}
  return cacheCreationTokens === undefined ? rest : { ...rest, cacheWriteTokens: cacheCreationTokens }
}

export class LocalAgentAdapter extends LlmAdapter {
  // deps: {rt, findExecutable, spawnEngine(kind,route,engine), record(sessionId),
  //        saveRecord, presetFor(sessionId), cwdFor, probeCwd, toolsFor(options)}
  declare deps: any
  declare engines: Map<any, any>
  declare live: Map<any, any>
  declare modelCache: Map<any, any>
  declare disposed: boolean
  constructor(deps: any) {
    super()
    this.deps = deps
    this.engines = new Map()   // route -> engine driver
    this.live = new Map()      // sessionId -> live session
    this.modelCache = new Map()
    this.disposed = false
  }

  // The engine entry of a route; the host may override how the CLI starts (deps.engineOf).
  specOf(route) { return this.deps.engineOf?.(route) ?? engineOf(route) }

  providerInfo(route) {
    const engine = this.specOf(route)
    return { id: route, name: engine?.name ?? route }
  }
  providerRetryPolicy() { return undefined }
  imageRequestPricing() { return undefined }

  engine(route) {
    let driver = this.engines.get(route)
    if (driver === undefined) {
      const spec = this.specOf(route)
      if (spec === undefined) throw new LlmError(`Unknown local agent ${route}`, 'NO_ADAPTER')
      driver = this.deps.spawnEngine(spec.kind, route, spec)
      this.engines.set(route, driver)
    }
    return driver
  }

  async listModels(route) {
    const cached = this.modelCache.get(route)
    if (cached !== undefined) return cached
    const spec = this.specOf(route)
    if (spec === undefined) return []
    const fallback = [{ provider: route, id: 'default', name: 'CLI default' }]
    let models
    try {
      models = await this.engine(route).listModels({ cwd: this.deps.probeCwd(), mcp: undefined })
    } catch {
      models = []
    }
    const value = [...fallback, ...(models ?? []).filter(model => model.id !== 'default')
      .map(model => ({ provider: route, id: model.id, name: model.name ?? model.id }))]
    this.modelCache.set(route, value)
    return value
  }

  dropModelCache(route?: any) {
    if (route === undefined) this.modelCache.clear()
    else this.modelCache.delete(route)
  }

  async resolveModel(route, model) {
    const spec = this.specOf(route)
    const listed = (await this.listModels(route).catch(() => [])).find(entry => entry.id === model)
    return {
      provider: route,
      id: model,
      name: listed?.name ?? model,
      inputModalities: ['text', 'image'] as any,
      context: { contextWindow: spec?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    }
  }

  // ---------------------------------------------------------------------------
  // The live bridge for one DS Bot Session.
  async liveFor(options) {
    const sessionId = String(options.sessionId)
    let live = this.live.get(sessionId)
    const record = this.deps.record(sessionId)
    const route = options.provider
    if (live !== undefined && !live.dead && live.route === route) return live
    if (live !== undefined) await this.closeLive(live)
    const spec = this.specOf(route)
    if (spec === undefined) throw new LlmError(`Unknown local agent ${route}`, 'NO_ADAPTER')
    const engine = this.engine(route)
    live = {
      sessionId, route, spec, engine, dead: false,
      record,
      cliSessionId: record?.cliSessionId,
      handed: record?.handedId,
      promptHash: record?.promptHash,
      engineSession: undefined,
      mcp: undefined,
      events: [],
      waiters: [],
      pending: new Map(),   // dshCallId -> {name, mcpCallId?, reply?}
      started: false,
      // 'idle': no CLI turn. 'running': a prompt is in flight. 'suspended': the
      // turn waits on a bridged tool call or a permission answer.
      state: 'idle',
      idle: undefined,
      cwd: record?.cwd,
      model: options.model,
    }
    // The idle timer counts from the CLI's last output. A turn in flight is not idle: a prompt that
    // is running (a long silent test run) keeps its process, the timer just starts over. A turn that
    // waits on a bridged call or a permission answer may be closed: the next request replays it.
    const arm = () => {
      clearTimeout(live.idle)
      live.idle = setTimeout(() => {
        if (live.state === 'running' && !live.dead) arm()
        else void this.closeLive(live, { idle: true })
      }, idleCloseOf(this.deps))
      live.idle.unref?.()
    }
    live.push = (event) => {
      // After an abort the CLI still ends the stopped turn with its own done/error; what
      // the stopped turn left behind is dropped up to and including that event.
      if (live.skipStale) {
        if (event.type === 'done' || event.type === 'error') live.skipStale = false
        return
      }
      arm()
      const waiter = live.waiters.shift()
      if (waiter !== undefined) waiter(event)
      else live.events.push(event)
    }
    live.next = () => (live.events.length > 0 ? Promise.resolve(live.events.shift()) : new Promise(resolve => live.waiters.push(resolve)))
    this.live.set(sessionId, live)
    return live
  }

  async closeLive(live, { idle = false } = {}) {
    if (live.dead) return
    live.dead = true
    clearTimeout(live.idle)
    this.live.delete(live.sessionId)
    live.mcp?.close()
    // The process of this Session goes with it (the next prompt starts a new one).
    live.engine.release?.(live.sessionId)
    if (idle) {
      // The CLI session survives on the agent side; the process leaves and the
      // next prompt resumes it.
      live.engineSession = undefined
      live.started = false
    }
    for (const waiter of live.waiters.splice(0)) waiter({ type: 'done', reason: 'stop' })
    const stillUsed = [...this.live.values()].some(other => other.engine === live.engine && !other.dead)
    if (!stillUsed) await live.engine.close?.().catch(() => {})
  }

  // The loopback MCP server for one live session; tools/call lands in its event queue.
  // `live.tools` is the tool list of the latest request (set by stream()); tools/list reads it
  // when the CLI asks. (DS Bot 0.3.1 handed the server a function that returned the function
  // itself, so every tools/list answered 500 and the CLI saw a connected server with no tools.)
  async ensureMcp(live) {
    if (live.mcp !== undefined) return live.mcp
    const mcp = new LoopbackMcp(() => live.tools ?? [], ({ name, arguments: args, callId }) => {
      const dshCallId = `dsbot-${callId}`
      return new Promise((resolve) => {
        live.pending.set(dshCallId, { name, mcpCallId: callId, resolve })
        live.push({ type: 'call', name, args, dshCallId })
      })
    })
    await mcp.listen()
    live.mcp = mcp
    return mcp
  }

  // ---------------------------------------------------------------------------
  async *stream(options) {
    if (this.disposed) throw new LlmError('the local agents adapter is disposed', 'NO_ADAPTER')
    if (options.purpose === 'session-title') {
      const first = (options.messages ?? []).find(message => message.role === 'user')
      const title = (textOf(first?.content).split('\n').find(line => line.trim() !== '') ?? 'Chat').trim()
      yield* titleChunk(title === '' ? 'Chat' : title)
      return
    }
    if (options.purpose === 'compaction') {
      yield* digestChunks(options.messages)
      return
    }
    const sessionId = options.sessionId
    if (sessionId === undefined) throw new LlmError('a local agent request needs a session', 'INVALID_REQUEST')
    const live = await this.liveFor(options)

    // What the request carries past the last handed message. When the marker is
    // gone the CLI session is stale or new: it gets a replay instead of a delta.
    const messages = options.messages ?? []
    const at = live.handed === undefined ? -1 : messages.findIndex(message => message.id === live.handed)
    const fresh = live.handed === undefined || at === -1
    const delta = fresh ? [] : messages.slice(at + 1)

    // Results of the calls the last step emitted answer the suspended CLI calls.
    // A user message never resolves an approve_agent_action pending: only that
    // tool's own result may. User text may answer a pending bridged MCP call
    // whose DSH tool concluded the turn (a question-type card).
    for (const message of delta) {
      if (message.role !== 'tool') continue
      const pending = live.pending.get(message.toolCallId)
      if (pending === undefined) continue
      live.pending.delete(message.toolCallId)
      pending.resolve({ text: textOf(message.content) || (message.isError ? 'the call failed' : ''), isError: message.isError === true })
    }
    // The loop's runtime-context user messages are context, not input: they
    // fold into the next prompt or steer, never start a prompt on their own.
    const contextText = delta
      .filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
      .map(message => textOf(message.content)).filter(text => text !== '').join('\n')
    const users = delta.filter(message => message.role === 'user' && message.source?.kind !== 'runtime-context')
    // The first open bridged call that is not an approval may take the user's
    // next message as its answer; the rest of the input is new.
    const openCall = [...live.pending.entries()].find(([, entry]) => entry.name !== APPROVE_TOOL)
    const remaining = []
    let answered = openCall === undefined
    for (const message of users) {
      if (!answered && openCall !== undefined) {
        const [id, pending] = openCall
        live.pending.delete(id)
        pending.resolve({ text: textOf(message.content) })
        answered = true
      } else {
        remaining.push(message)
      }
    }

    const system = messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n').trim()
    const promptHash = system === '' ? undefined : createHash('sha256').update(system).digest('hex')
    live.tools = this.deps.toolsFor(options)
    const toolNames = live.tools.map(tool => tool.name)
    const mcp = await this.ensureMcp(live)
    const cwd = live.cwd ?? await this.deps.cwdFor(sessionId)
    live.cwd = cwd

    const preset = this.deps.presetFor(sessionId)
    let instructions = system === '' ? undefined : system

    // A process that died (or was killed) is started again; the pump of the old one ends with it.
    if (live.engineSession?.dead) { live.engineSession = undefined; live.started = false }
    let freshCli = live.cliSessionId === undefined
    let replay = fresh
    if (live.engineSession === undefined) {
      const openArgs = {
        cwd,
        mcp,
        resumeId: live.cliSessionId,
        preset,
        model: options.model,
        toolNames,
        system: instructions,
      }
      live.engineSession = await live.engine.open(sessionId, openArgs)
        .catch(error => { throw toLlmError(error, live) })
      // The CLI session was not saved (the unattended coding setup): the new process has no
      // memory of the old one, so it gets a replay instead of a delta.
      if (openArgs.resumeId !== undefined && live.engineSession.resumed !== true) {
        freshCli = true
        replay = true
        live.handed = undefined
      }
      live.cliSessionId = live.engineSession.cliSessionId ?? live.cliSessionId
      live.started = true
      // The session's events feed this Session's queue: they reach drain() through live.next().
      const session = live.engineSession
      const token = live.pumpToken = {}
      void (async () => {
        while (live.pumpToken === token && !live.dead) {
          const event = await session.next()
          if (event === undefined) return
          if (live.pumpToken === token && !live.dead) live.push(event)
        }
      })()
      if (instructions !== undefined) live.promptHash = promptHash
      this.deps.saveRecord(sessionId, { route: live.route, cliSessionId: live.cliSessionId, cwd, handedId: live.handed, promptHash: live.promptHash ?? promptHash, model: options.model })
    }

    // The system text rides in the spawn arguments (--append-system-prompt); a fresh process
    // also gets the replay, which opens with it.
    let promptText = replay ? renderReplay(messages, system)
      : [contextText, ...remaining.map(message => textOf(message.content))].filter(text => text !== '').join('\n\n')
    let sentInstructions = freshCli && instructions !== undefined
    // A new CLI session gets its instructions in the spawn arguments or the replay;
    // the "updated" line is only for a session that saw older ones.
    if (instructions !== undefined && !freshCli && live.promptHash !== promptHash) {
      promptText = `Updated team instructions (replace earlier ones):\n\n${instructions}\n\n${promptText}`
      sentInstructions = true
    }
    if (promptText !== '') {
      this.sendInput(live, promptText, options.signal)
      if (sentInstructions) live.promptHash = promptHash
    }

    // The last DSH message is handed now; a later call sends only what follows.
    const last = messages.at(-1)
    if (last !== undefined) {
      live.handed = last.id
      this.deps.saveRecord(sessionId, { route: live.route, cliSessionId: live.cliSessionId, cwd, handedId: live.handed, promptHash: live.promptHash ?? promptHash, model: options.model })
    }

    yield* this.drain(live, options)
  }

  // Input for the CLI: a fresh prompt while it is idle; while a turn runs or waits on a
  // bridged call, a further user message (the CLI queues it). The prompt is sent but not
  // awaited; a send failure lands in the queue as an error.
  sendInput(live, text, signal) {
    const run = live.state === 'idle'
      ? () => live.engine.prompt(live.engineSession, [{ type: 'text', text }], { signal })
      : () => live.engine.steer?.(live.engineSession, text)
    if (live.state === 'idle') live.state = 'running'
    try {
      Promise.resolve(run()).catch(error => live.push({ type: 'error', error }))
    } catch (error) {
      live.push({ type: 'error', error })
    }
  }

  // Consume the CLI's events until the turn ends or a bridged call suspends it.
  async *drain(live, options) {
    let index = 0
    let textBuf = ''
    let textIndex = -1
    let thinkBuf = ''
    let thinkIndex = -1
    // Open text and reasoning stay open in parallel; each closes when it has to.
    const closeBlocks = function* () {
      if (textIndex !== -1) { yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuf } }; textIndex = -1; textBuf = '' }
      if (thinkIndex !== -1) { yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkBuf } }; thinkIndex = -1; thinkBuf = '' }
    }
    // Reasoning text, and a line of its own in it.
    const think = function* (text) {
      if (thinkIndex === -1) {
        if (textIndex !== -1) { yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuf } }; textIndex = -1; textBuf = '' }
        yield { type: 'block-start', index: index++, blockType: 'reasoning' }
        thinkIndex = index - 1
      }
      thinkBuf += text
      yield { type: 'reasoning-delta', index: thinkIndex, text }
    }
    const note = function* (text) {
      yield* think(`${thinkBuf === '' || thinkBuf.endsWith('\n') ? '' : '\n'}${text}\n`)
    }
    const emitCalls = (calls) => {
      const chunks = []
      calls.forEach((call, offset) => {
        const at = index + offset
        chunks.push(
          { type: 'block-start', index: at, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: at, id: call.dshCallId, name: call.name, argumentsDelta: JSON.stringify(call.args ?? {}) },
          { type: 'block-end', index: at, block: { type: 'tool-call', id: call.dshCallId, name: call.name, arguments: JSON.stringify(call.args ?? {}) } },
        )
      })
      index += calls.length
      return chunks
    }
    // One abort promise for the whole drain: the earlier version added a
    // listener per event and never removed it.
    let abortReject
    const abortPromise = new Promise((_, reject) => { abortReject = reject })
    const onAbort = () => abortReject(options.signal?.reason ?? new Error('aborted'))
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort)
    try {
    for (;;) {
      const event = await Promise.race([live.next(), abortPromise]).catch(error => ({ type: 'abort', error }))
      if (event.type === 'abort') {
        live.state = 'idle'
        // The stopped turn still ends with a done/error of its own; drop it with whatever
        // the turn left queued, so it cannot answer the next turn.
        const ended = live.events.findIndex(queued => queued.type === 'done' || queued.type === 'error')
        if (ended !== -1) live.events.splice(0, ended + 1)
        else live.skipStale = true
        live.engine.cancel?.(live.engineSession)
        live.mcp?.failAll(new Error('the turn was stopped'))
        for (const pending of live.pending.values()) pending.resolve({ text: 'the turn was stopped', isError: true })
        live.pending.clear()
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'the turn was stopped' } } }
        return
      }
      switch (event.type) {
        case 'text': {
          // A subagent's own text is a line of the reasoning; only the main agent's text is the answer.
          if (event.parentToolUseId) { if (event.text.trim() !== '') yield* note(`  ${oneLine(event.text, 300)}`); break }
          if (textIndex === -1) {
            if (thinkIndex !== -1) { yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkBuf } }; thinkIndex = -1; thinkBuf = '' }
            yield { type: 'block-start', index: index++, blockType: 'text' }
            textIndex = index - 1
          }
          textBuf += event.text
          yield { type: 'text-delta', index: textIndex, text: event.text }
          break
        }
        case 'thought':
          yield* think(event.text)
          break
        case 'activity': {
          // An activity line stands on its own line of the reasoning, which is how the chat
          // tells it from the thought around it. A shell command shows what it runs.
          const line = event.tool === 'Bash' && event.input?.command ? `${event.text}: ${attempted(event.tool, event.input)}` : event.text
          yield* note(event.parentToolUseId ? `  ${line}` : line)
          break
        }
        // What the CLI refused or failed, and the subagent's work, are shown the way activity is.
        // The task layer's recorder and monitor read them from the session events. A refusal
        // names what was attempted (the command, the path), redacted: this line is the only trace
        // of it, the CLI's own session is not kept.
        // Line formats (a recorder can match the prefixes): `▸ denied: <tool> (<reason>) | attempted: <what>`,
        // `▸ tool error: <tool>: <text> | attempted: <what>`, `▸ permission request for <tool> timed out: denied | attempted: <what>`.
        case 'permission_denied':
          yield* note(`▸ denied: ${event.toolName ?? 'tool'}${event.message ? ` (${oneLine(redact(event.message), 200)})` : ''}${refusedWhat(event)}`)
          break
        case 'tool_error':
          yield* note(`▸ tool error: ${event.toolName ?? 'tool'}: ${oneLine(redact(event.text), 300)}${refusedWhat(event)}`)
          break
        case 'subagent':
          if (event.phase === 'started') yield* note(`▸ subagent${event.subagentType ? ` ${event.subagentType}` : ''} started: ${oneLine(event.description ?? '', 200)}`)
          else if (event.phase === 'notification') yield* note(`▸ subagent ${event.status ?? 'finished'}`)
          break
        case 'subagent_result':
          yield* note(`▸ subagent result${event.isError ? ' (error)' : ''}: ${oneLine(event.text, 4_000)}`)
          break
        case 'permission_cancelled':
          live.pending.delete(event.id)
          yield* note('▸ permission request withdrawn')
          break
        case 'permission_timeout':
          // The driver already denied it; the approval card (if any) answers nothing now.
          live.pending.delete(event.id)
          yield* note(`▸ permission request for ${event.toolName ?? 'tool'} timed out: denied${refusedWhat(event)}`)
          break
        case 'init':
          // The CLI names its session only once the first prompt is in; the record needs it to resume.
          live.cliSessionId = event.sessionId
          this.deps.saveRecord(live.sessionId, { route: live.route, cliSessionId: live.cliSessionId, cwd: live.cwd, handedId: live.handed, promptHash: live.promptHash, model: live.model })
          break
        case 'usage': yield { type: 'usage', usage: dshUsage(event.usage) }; break
        case 'call': {
          yield* closeBlocks()
          live.state = 'suspended'
          // A team tool the CLI invoked over the loopback MCP server.
          for (const chunk of emitCalls([{ name: event.name, args: event.args, dshCallId: event.dshCallId }])) yield chunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'permission': {
          yield* closeBlocks()
          live.state = 'suspended'
          // The CLI's own permission prompt, bridged as an approval tool call. The answer is the
          // structured decision of approve_agent_action; a deny carries a reason for the CLI.
          const call = { name: APPROVE_TOOL, args: { action: event.action, ...(event.detail ? { detail: event.detail } : {}) }, dshCallId: event.id }
          live.pending.set(event.id, { name: APPROVE_TOOL, resolve: result => replyPermission(event, result) })
          for (const chunk of emitCalls([call])) yield chunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'done': {
          yield* closeBlocks()
          this.reportUsage(live, event)
          if (event.usage !== undefined) yield { type: 'usage', usage: dshUsage(event.usage) }
          live.state = 'idle'
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        case 'error': {
          live.state = 'idle'
          // A failed turn (max turns, interrupted, API error) was billed all the same.
          this.reportUsage(live, event, { failed: true })
          throw toLlmError(event.error, live)
        }
        default: break
      }
    }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  // The CLI's own account of a finished turn (per model, with its cost), for the task layer's billing.
  // DSH only sees the summed usage chunk below, and nothing of a failed turn; the per-model rows and
  // costUSD exist only here. The host passes deps.reportUsage (bot/src/host/local-agents/index.ts).
  reportUsage(live, event, { failed = false } = {}) {
    try {
      this.deps.reportUsage?.({
        sessionId: live.sessionId, route: live.route, model: event.model ?? live.model, models: event.models ?? [], usage: event.usage,
        durationMs: event.durationMs, durationApiMs: event.durationApiMs, failed,
      })
    } catch {}
  }

  async dispose() {
    this.disposed = true
    for (const live of Array.from(this.live.values())) await this.closeLive(live)
    for (const engine of Array.from(this.engines.values())) await engine.close?.().catch(() => {})
    this.engines.clear()
  }
}

// The result DSH gives approve_agent_action decides the CLI's answer: only the structured
// {"decision":"allow"} the tool returns on approval allows; free text, a parse failure, an error
// or a denial denies, and a deny always carries a reason text (the CLI rejects one without).
function replyPermission(event, result) {
  let decision
  if (result.isError !== true) {
    try { decision = JSON.parse(result.text ?? '')?.decision } catch { decision = undefined }
  }
  if (decision === 'allow') event.reply(true)
  else event.reply(false, decision === 'deny' ? 'Denied: the user did not approve this action.' : 'Denied: the approval did not allow this action.')
}

// One line of text, cut to `max` characters.
const oneLine = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// What a tool call attempted, in one short redacted piece of text: the shell command, or the path,
// pattern or URL; the content of a write or an edit is left out (it can be long and is in the file).
function attempted(tool, input) {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return oneLine(redact(input), 300)
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.subagent_type
  if (pick !== undefined) return oneLine(redact(pick), 300)
  const names = Object.keys(input)
  return names.length === 0 ? '' : `{${names.join(', ')}}`
}

// ` | attempted: <what>` for the line of a refusal, or nothing when the input is not known.
const refusedWhat = (event) => {
  const what = attempted(event.toolName, event.input)
  return what === '' ? '' : ` | attempted: ${what}`
}

// Masks what looks like a credential before it goes into a line that is kept: bearer values,
// key=value pairs whose key names a secret, and the common token shapes.
function redact(text) {
  return String(text ?? '')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [redacted]')
    .replace(/((?:token|secret|passw(?:or)?d|api[_-]?key|authorization|credential)[A-Za-z0-9_]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|glpat-[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g, '[redacted]')
}

// The replay a fresh CLI session stands up on: the system prompt, then the
// recent messages rendered as text, newest first, always with the latest input.
function renderReplay(messages, system) {
  const picked = []
  let used = 0
  const body = (messages ?? []).filter(message => message.role !== 'system')
  const latest = body.at(-1)
  for (const message of [...body].reverse()) {
    const line = `${message.role === 'assistant' ? 'You' : message.role === 'tool' ? `Tool result (${message.toolCallId ?? 'call'})` : 'User'}: ${textOf(message.content).slice(0, 2_000)}`
    if (message === latest) { picked.unshift(line); used += line.length; continue }
    if (picked.length >= REPLAY_MESSAGES || used + line.length > REPLAY_BYTES) break
    picked.unshift(line)
    used += line.length
  }
  if (picked.length === 0) return ''
  const head = system === '' ? '' : `The team instructions for this conversation:\n${system}\n\n`
  return `${head}The conversation so far (oldest first):\n\n${picked.join('\n\n')}`
}

// Process exits, missing CLIs, quota and sign-in failures get typed codes so DS
// Bot's repair card can act on them.
function toLlmError(error, live) {
  if (error instanceof LlmError) return error
  const text = String(error?.message ?? error)
  const code = error?.code === 'NO_ADAPTER' ? 'LOCAL_AGENT_MISSING'
    : /not signed in|not logged in|login required|unauthorized|authentication/i.test(text) ? 'LOCAL_AGENT_SIGNIN'
      : /quota|rate.?limit|usage limit|exceeded/i.test(text) ? 'LOCAL_AGENT_QUOTA'
        : /exited|spawn|ENOENT/i.test(text) ? 'LOCAL_AGENT_EXIT'
          : error?.code ?? 'LOCAL_AGENT_ERROR'
  const hint = code === 'LOCAL_AGENT_SIGNIN' ? ` Sign in with: ${live?.spec?.signIn ?? `${live?.spec?.command ?? 'the CLI'} login`}.` : ''
  return new LlmError(`${text}${hint}`, code, error?.status === undefined ? {} : { status: error.status })
}
