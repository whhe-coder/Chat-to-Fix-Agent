// One Claude Code process per session, line-delimited JSON both ways.
// Adapted from bot/src/host/local-agents/claude.js (ClaudeSession, DS Bot 0.3.1).
// Differences from the reference:
//  - standalone: no ClaudeEngine/adapter/discover; start({ bin, cwd, args, env })
//    takes the executable, the full argument list (see args.js) and the full
//    child environment (see env.js; the reference read the wrong object,
//    this.engine.env, so extra env never arrived).
//  - events can be read with next() or `for await (const e of session)`; the
//    stream ends (undefined / loop exit) once the process is gone.
// Behaviour of the real CLI 2.1.321 (verified against the signed-in CLI) that this
// driver relies on:
//  - no `system/init` until the first user message (and one per turn), so start()
//    is ready when the CLI answers a `initialize` control request, not on init;
//    the first init emits an 'init' event, later ones a 'turn' event.
//  - a `can_use_tool` control request is answered with a control_response:
//    allow = {behavior:'allow', updatedInput:{...}}, deny = {behavior:'deny',
//    message:<string>}. A deny WITHOUT a string message is rejected by the CLI
//    ("The canUseTool callback returned an invalid permission result") and the
//    tool fails. Only `true` allows. An unanswered request hangs the turn for
//    ever, hence the permissionTimeoutMs option (auto-deny). The CLI may
//    withdraw a pending request with `control_cancel_request` (it does so on
//    interrupt); that becomes a 'permission_cancelled' event.
//  - with `--permission-prompts none` no can_use_tool is ever sent: a refused
//    action is `system/permission_denied` plus an is_error tool_result.
//  - a failed turn is `result` with is_error true (its subtype may still say
//    'success' for a login failure) and NO `result` field when it is an
//    error_* subtype; the text is in errors[]. terminal_reason tells why:
//    aborted_tools / aborted_streaming (interrupt), max_turns, api_error, ...
//  - `usage` is per turn; `total_cost_usd` and `modelUsage` are cumulative over
//    the process; `model_usage_since_last_result` is the per-turn part.
//  - denials and tool failures show up only as a user tool_result with is_error.
//  - a subagent (Agent tool) runs between system/task_started and
//    system/task_notification; its own messages carry parent_tool_use_id; its
//    final text arrives only inside the Agent tool_result (and in
//    task_notification.summary), never as an assistant message.
//  - system/thinking_tokens lines are noise and are ignored.
//  - interrupt() sends a request_id and resolves on the matching response.
//  - a child that exits before `initialize` is answered rejects start() at once
//    (the reference waited for its 60 s timer; the timeout stays,
//    startTimeoutMs); kill() ends the stream quietly instead of emitting an
//    'exited' error.
//  - cancel() is named interrupt() and returns a promise.
//
// Events (all plain objects with a `type`):
//  init {sessionId, model, tools, mcpServers, permissionMode, agents, skills}
//  turn {sessionId}
//  text {text, parentToolUseId}            thought {text, parentToolUseId} (never empty)
//  activity {text:'▸ Tool', tool, toolUseId, input, parentToolUseId}
//  permission {id, toolUseId, toolName, input, description, action, detail, options, reply(allow, reason?)}
//  permission_cancelled {id}               permission_timeout {id, toolName, toolUseId, input}
//  permission_denied {toolName, toolUseId, input, message, reasonType, reason}   input = what the model attempted
//                                          (the tool_use input, remembered until its tool_result; system/permission_denied
//                                          carries no input of its own)
//  tool_error {toolUseId, toolName, input, text, parentToolUseId}
//  subagent {phase:'started'|'progress'|'updated'|'notification', taskId, toolUseId, ...}
//  subagent_result {toolUseId, text, isError}
//  done {reason:'stop', result, sessionId, usage, turnCostUsd, subtype, numTurns, durationMs, totalCostUsd, permissionDenials, terminalReason}
//  error {error, result, reason?, subtype, terminalReason, numTurns, durationMs, totalCostUsd, permissionDenials, ...}
import { spawn } from 'node:child_process'
import { childEnv } from './env.ts'

const START_TIMEOUT_MS = 60_000
const DEFAULT_DENY = 'Denied: this action is not allowed for this bot.'
const ABORTED = new Set(['aborted_tools', 'aborted_streaming'])

export class ClaudeSession {
  declare name: any
  declare events: any
  declare waiters: any
  declare dead: any
  declare killed: any
  declare pending: any
  declare permissions: any
  declare toolNames: any
  declare toolInputs: any
  declare nextId: any
  declare permissionTimeoutMs: any
  declare child: any
  declare started: any
  declare onEarlyExit: any
  declare startTimer: any
  declare initialized: any
  declare exitCode: any
  declare cliSessionId: any
  constructor({ name = 'Claude Code' } = {}) {
    this.name = name
    this.events = []
    this.waiters = []
    this.dead = false
    this.killed = false
    this.pending = new Map()
    this.permissions = new Map() // request_id -> { timer } for can_use_tool requests not yet answered
    this.toolNames = new Map() // tool_use id -> tool name
    this.toolInputs = new Map() // tool_use id -> the input the model gave it (so a refusal can say what was attempted)
    this.nextId = 1
    this.permissionTimeoutMs = 0
  }

  emit(event) {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(event)
    else this.events.push(event)
  }

  // The next event, or undefined once the process is gone and the queue is empty.
  next() {
    if (this.events.length > 0) return Promise.resolve(this.events.shift())
    if (this.dead) return Promise.resolve(undefined)
    return new Promise(resolve => this.waiters.push(resolve))
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      const event = await this.next()
      if (event === undefined) return
      yield event
    }
  }

  write(message) {
    try { this.child?.stdin.write(`${JSON.stringify(message)}\n`) } catch { this.dead = true }
  }

  close() {
    this.dead = true
    for (const { reject } of this.pending.values()) reject(new Error(`${this.name} is gone`))
    this.pending.clear()
    for (const { timer } of this.permissions.values()) clearTimeout(timer)
    this.permissions.clear()
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }

  // permissionTimeoutMs: when > 0, a can_use_tool request nobody answered within
  // that time is denied (message: nobody answered) and a 'permission_timeout' event follows.
  async start({ bin, cwd, args = [], env, startTimeoutMs = START_TIMEOUT_MS, permissionTimeoutMs = 0 }) {
    if (this.child !== undefined) return this
    this.permissionTimeoutMs = permissionTimeoutMs
    if (bin === undefined) throw Object.assign(new Error(`${this.name} is not installed`), { code: 'NO_ADAPTER' })
    const child = this.child = spawn(bin, args, {
      env: env ?? childEnv(),
      cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    })
    child.stdin.on('error', () => {})
    let rest = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      rest += chunk
      let at
      while ((at = rest.indexOf('\n')) !== -1) {
        const line = rest.slice(0, at).trim()
        rest = rest.slice(at + 1)
        if (line !== '') this.onLine(line)
      }
    })
    this.started = new Promise((resolve, reject) => {
      this.onEarlyExit = reject
      this.startTimer = setTimeout(() => reject(new Error('the agent did not start')), startTimeoutMs)
      this.startTimer.unref?.()
    })
    this.started.catch(() => {})
    // The CLI prints nothing until the first user message; the answer to this
    // request is the ready signal.
    this.initialized = this.request({ subtype: 'initialize' }).then(() => clearTimeout(this.startTimer))
    this.initialized.catch(() => {})
    child.on('error', (error) => {
      this.finish(error)
    })
    child.on('exit', (code, signal) => {
      this.exitCode = code
      this.finish(this.killed ? undefined : new Error(`${this.name} exited (${signal ?? code})`))
    })
    return Promise.race([this.started, this.initialized]).then(() => this)
  }

  finish(error) {
    clearTimeout(this.startTimer)
    if (error !== undefined && !this.dead) {
      this.emit({ type: 'error', error })
      this.onEarlyExit?.(error)
    } else this.onEarlyExit?.(new Error('the session was killed'))
    this.close()
  }

  onLine(line) {
    let event
    try { event = JSON.parse(line) } catch { return }
    switch (event?.type) {
      case 'system': this.onSystem(event); break
      case 'assistant': this.onAssistant(event); break
      case 'user': this.onUser(event); break
      case 'control_request': {
        const request = event.request ?? {}
        if (request.subtype === 'can_use_tool') this.onPermission(event.request_id, request)
        break
      }
      case 'control_cancel_request':
        // The CLI withdraws a pending can_use_tool request (it does so on interrupt).
        if (this.permissions.has(event.request_id)) {
          clearTimeout(this.permissions.get(event.request_id).timer)
          this.permissions.delete(event.request_id)
          this.emit({ type: 'permission_cancelled', id: event.request_id })
        }
        break
      case 'control_response': {
        const response = event.response ?? {}
        const waiting = this.pending.get(response.request_id)
        if (waiting === undefined) break
        this.pending.delete(response.request_id)
        if (response.subtype === 'error') waiting.reject(new Error(response.error ?? 'the request failed'))
        else waiting.resolve(response.response ?? {})
        break
      }
      case 'result': this.onResult(event); break
      default: break
    }
  }

  onSystem(event) {
    switch (event.subtype) {
      case 'init':
        if (this.cliSessionId === undefined) {
          this.cliSessionId = event.session_id
          this.emit({
            type: 'init', sessionId: event.session_id, model: event.model, tools: event.tools, mcpServers: event.mcp_servers,
            permissionMode: event.permissionMode, agents: event.agents, skills: event.skills,
          })
        } else this.emit({ type: 'turn', sessionId: event.session_id })
        break
      case 'permission_denied':
        this.emit({
          type: 'permission_denied', toolName: event.tool_name, toolUseId: event.tool_use_id, input: this.toolInputs.get(event.tool_use_id), message: event.message,
          reasonType: event.decision_reason_type, reason: event.decision_reason,
        })
        break
      case 'task_started':
        this.emit({ type: 'subagent', phase: 'started', taskId: event.task_id, toolUseId: event.tool_use_id, description: event.description, subagentType: event.subagent_type, prompt: event.prompt })
        break
      case 'task_progress':
        this.emit({ type: 'subagent', phase: 'progress', taskId: event.task_id, toolUseId: event.tool_use_id, description: event.description, subagentType: event.subagent_type, lastToolName: event.last_tool_name, usage: event.usage })
        break
      case 'task_updated':
        this.emit({ type: 'subagent', phase: 'updated', taskId: event.task_id, toolUseId: event.tool_use_id, patch: event.patch })
        break
      case 'task_notification':
        this.emit({ type: 'subagent', phase: 'notification', taskId: event.task_id, toolUseId: event.tool_use_id, status: event.status, summary: event.summary, usage: event.usage })
        break
      case 'thinking_tokens': break // a running estimate; not interesting
      default: break
    }
  }

  onAssistant(event) {
    const parentToolUseId = event.parent_tool_use_id ?? null
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text') this.emit({ type: 'text', text: block.text ?? '', parentToolUseId })
      else if (block.type === 'thinking') {
        if ((block.thinking ?? '') !== '') this.emit({ type: 'thought', text: block.thinking, parentToolUseId })
      } else if (block.type === 'tool_use') {
        if (block.id !== undefined) { this.toolNames.set(block.id, block.name); this.toolInputs.set(block.id, block.input) }
        this.emit({ type: 'activity', text: `▸ ${block.name ?? 'tool'}`, tool: block.name, toolUseId: block.id, input: block.input, parentToolUseId })
      }
    }
  }

  onUser(event) {
    const parentToolUseId = event.parent_tool_use_id ?? null
    const content = event.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const toolName = this.toolNames.get(block.tool_use_id)
      const text = textOf(block.content)
      const isError = block.is_error === true
      if (isError) this.emit({ type: 'tool_error', toolUseId: block.tool_use_id, toolName, input: this.toolInputs.get(block.tool_use_id), text, parentToolUseId })
      // The reviewer's final text arrives only here (and in task_notification.summary).
      if (toolName === 'Agent' || toolName === 'Task') this.emit({ type: 'subagent_result', toolUseId: block.tool_use_id, text, isError })
      // The call is over: forget it, so a long-lived process does not keep every input it ever ran.
      this.toolNames.delete(block.tool_use_id)
      this.toolInputs.delete(block.tool_use_id)
    }
  }

  onPermission(requestId, request) {
    const tool = request.tool_name ?? 'tool'
    const reply = (allow, reason) => {
      if (!this.permissions.has(requestId)) return // answered, cancelled, timed out or gone
      clearTimeout(this.permissions.get(requestId).timer)
      this.permissions.delete(requestId)
      const body = allow === true
        ? { behavior: 'allow', updatedInput: request.input ?? {} }
        : { behavior: 'deny', message: typeof reason === 'string' && reason !== '' ? reason : DEFAULT_DENY }
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: body } })
    }
    let timer
    if (this.permissionTimeoutMs > 0) {
      timer = setTimeout(() => {
        if (!this.permissions.has(requestId)) return
        reply(false, 'Denied: nobody answered the permission request in time.')
        this.emit({ type: 'permission_timeout', id: requestId, toolName: tool, toolUseId: request.tool_use_id, input: request.input })
      }, this.permissionTimeoutMs)
      timer.unref?.()
    }
    this.permissions.set(requestId, { timer })
    this.emit({
      type: 'permission', id: requestId, toolUseId: request.tool_use_id, toolName: tool, input: request.input, description: request.description,
      reply,
      action: `Run ${tool}`,
      detail: JSON.stringify(request.input ?? {}).slice(0, 4_000),
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
    })
  }

  onResult(event) {
    // The failure flag is is_error alone: a failed turn can still say subtype 'success'.
    const turnCostUsd = Object.values(event.model_usage_since_last_result ?? {}).reduce((sum: number, model: any) => sum + (model?.costUSD ?? 0), 0)
    const common = {
      subtype: event.subtype, terminalReason: event.terminal_reason, numTurns: event.num_turns, durationMs: event.duration_ms,
      totalCostUsd: event.total_cost_usd, permissionDenials: event.permission_denials ?? [],
    }
    if (event.is_error !== true) {
      this.emit({
        type: 'done', reason: 'stop', result: event.result, sessionId: event.session_id, usage: usageOf(event.usage),
        ...(event.model_usage_since_last_result === undefined ? {} : { turnCostUsd }), ...common,
      })
      return
    }
    const text = event.result ?? (event.errors?.length > 0 ? event.errors.join('; ') : undefined) ?? event.subtype ?? 'the agent failed'
    const reason = ABORTED.has(event.terminal_reason) ? 'aborted'
      : (event.terminal_reason === 'max_turns' || event.subtype === 'error_max_turns') ? 'max_turns' : undefined
    this.emit({
      type: 'error', error: new Error(text), result: event.result, errors: event.errors, sessionId: event.session_id, usage: usageOf(event.usage),
      ...(event.model_usage_since_last_result === undefined ? {} : { turnCostUsd }),
      ...(reason === undefined ? {} : { reason }), ...common,
    })
  }

  prompt(blocks) {
    const content = typeof blocks === 'string' ? [{ type: 'text', text: blocks }] : blocks
    this.write({ type: 'user', message: { role: 'user', content } })
    return Promise.resolve()
  }

  // A control request with an id; resolves with the response body.
  request(request) {
    const id = `req-${this.nextId++}`
    return new Promise((resolve, reject) => {
      if (this.dead) { reject(new Error(`${this.name} is gone`)); return }
      this.pending.set(id, { resolve, reject })
      this.write({ type: 'control_request', request_id: id, request })
    })
  }

  // Asks the turn to stop cleanly; resolves on the CLI's answer. The aborted
  // turn then ends with an 'error' event (reason 'aborted'); a pending
  // permission request is withdrawn first ('permission_cancelled').
  interrupt() {
    return this.request({ subtype: 'interrupt' })
  }

  kill() {
    this.killed = true
    const child = this.child
    child?.kill('SIGTERM')
    setTimeout(() => { try { child?.kill('SIGKILL') } catch {} }, 5_000).unref?.()
    this.child = undefined
    this.close()
  }
}

const usageOf = usage => (usage === undefined ? undefined : {
  inputTokens: usage.input_tokens ?? 0,
  outputTokens: usage.output_tokens ?? 0,
  ...(usage.cache_read_input_tokens ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
  ...(usage.cache_creation_input_tokens ? { cacheCreationTokens: usage.cache_creation_input_tokens } : {}),
})

// A tool_result's content is a string or a list of blocks; keep the text parts.
const textOf = content => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n') : '')
