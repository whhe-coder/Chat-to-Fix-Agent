#!/usr/bin/env node
// A fake Claude Code for tests: stream-json both ways, behaving like the real
// CLI 2.1.321 as verified. Adapted from bot/test/fixtures/fake-claude.mjs
// (DS Bot 0.3.1). Behaviour:
//  - prints nothing at startup; `system/init` comes after each user message
//  - answers control requests `initialize` and `interrupt` by request_id
//  - a failed turn is `result` with is_error true; error subtypes carry errors[]
//    and no `result` field
//  - a permission reply is validated: deny needs a string `message`, otherwise the
//    tool fails with "The canUseTool callback returned an invalid permission result"
//  - a non-JSON line on stdin kills the process (exit 1); closing stdin exits 0
//  - the process stays alive between turns
// The text of a prompt picks a behaviour:
//      [echo]        answers with its argv and its whole environment as JSON
//      [permission]  Bash tool_use + can_use_tool; reports the reply it got. With
//                    `--permission-prompts none` the action is refused at once
//                    (system/permission_denied + is_error tool_result)
//      [denied:CMD]  a Bash tool_use of CMD, refused at once (permission_denied + is_error tool_result)
//      [slow]        does nothing until an interrupt arrives, then aborts (aborted_streaming)
//      [slowtool]    a Bash tool_use that never returns; interrupt -> aborted_tools
//      [maxturns]    ends with error_max_turns
//      [login]       fails the turn like the real CLI when not signed in
//      [think]       system/thinking_tokens lines and an empty thinking block
//      [subagent]    Agent tool_use, task_* system messages, child lines with
//                    parent_tool_use_id, the Agent tool_result, then text
//      [exit]        exits with code 3
//      [mcp:NAME {json}]  calls the tool NAME of the (first) MCP server of --mcp-config over HTTP
//                    with the JSON arguments (Streamable HTTP, the reply on an SSE stream, as DS Bot's loopback server
//                    answers); the tool_use is mcp__<server>__NAME. Then reports `tool said: <text>`
// A pending permission request interrupted: control_cancel_request, the interrupt
// response, the tool_result "doesn't want to proceed", the user text, the result.
// env FAKE_EXIT_BEFORE_INIT=1 exits before answering `initialize`.
import { randomUUID } from 'node:crypto'

if (process.env.FAKE_EXIT_BEFORE_INIT === '1') process.exit(2)

const sessionId = `claude-${Math.random().toString(36).slice(2)}`
const argv = process.argv.slice(2)
const flag = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const promptsNone = flag('--permission-prompts') === 'none'
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const answer = (request_id, response = {}) => send({ type: 'control_response', response: { subtype: 'success', request_id, response } })
const assistant = (content, parent = null) => send({ type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: parent, session_id: sessionId, uuid: randomUUID() })
const toolResult = (id, content, { isError = false, parent = null } = {}) => send({
  type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) }] },
  parent_tool_use_id: parent, session_id: sessionId, uuid: randomUUID(),
})
const toolId = () => `toolu_${randomUUID().replaceAll('-', '').slice(0, 20)}`

let resultIndex = 0
let totalCost = 0
let denials = []
let turnTools = 0
const turnCost = 0.01
const usage = () => ({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 3 })
const modelUsage = { 'fake-model': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 7, costUSD: turnCost } }
function result(extra = {}) {
  totalCost += turnCost
  const body = {
    type: 'result', subtype: 'success', is_error: false, session_id: sessionId, num_turns: 1 + turnTools, duration_ms: 5, duration_api_ms: 4,
    usage: usage(), total_cost_usd: Number(totalCost.toFixed(4)), modelUsage, model_usage_since_last_result: modelUsage,
    permission_denials: denials, terminal_reason: 'completed', result_index: resultIndex++, stop_reason: 'end_turn', ...extra,
  }
  denials = []
  turnTools = 0
  send(body)
}
const finish = (text, extra = {}) => result({ result: text, ...extra })
const fail = (subtype, terminal_reason, errors) => result({ subtype, is_error: true, terminal_reason, errors, stop_reason: 'tool_use' })

function init() {
  const mcp = flag('--mcp-config')
  const agents = flag('--agents')
  send({
    type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId,
    tools: (flag('--tools') ?? 'Bash,Read').split(','), mcp_servers: mcp === undefined ? [] : Object.keys(JSON.parse(mcp).mcpServers).map(name => ({ name, status: 'connected' })),
    model: flag('--model') ?? 'fake-model', permissionMode: flag('--permission-mode') ?? 'default',
    agents: ['general-purpose', ...(agents === undefined ? [] : Object.keys(JSON.parse(agents)))], skills: [], uuid: randomUUID(),
  })
}

const VALID_DENY_HELP = "The canUseTool callback returned an invalid permission result. Expected {behavior: 'allow', updatedInput?: object} or {behavior: 'deny', message: string}."
const DOESNT_WANT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

let slowTurn = false
let slowTool // tool_use id of a Bash call that never returns
let pendingPermission // { requestId, toolUseId, input }
let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('end', () => process.exit(0))
process.stdin.on('data', (chunk) => {
  rest += chunk
  let at
  while ((at = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, at).trim()
    rest = rest.slice(at + 1)
    if (line === '') continue
    let message
    try { message = JSON.parse(line) } catch { process.stderr.write('Error: invalid JSON input\n'); process.exit(1) }
    if (message.type === 'control_request') {
      const subtype = message.request?.subtype
      if (subtype === 'initialize') answer(message.request_id, { commands: [], models: [], agents: [] })
      else if (subtype === 'interrupt') onInterrupt(message.request_id)
      continue
    }
    if (message.type === 'control_response') {
      onPermissionReply(message)
      continue
    }
    if (message.type !== 'user') continue
    init()
    onPrompt((message.message?.content ?? []).map(block => block.text ?? '').join('\n'))
  }
})

function onInterrupt(requestId) {
  if (pendingPermission !== undefined) {
    const { requestId: permissionId, toolUseId } = pendingPermission
    pendingPermission = undefined
    send({ type: 'control_cancel_request', request_id: permissionId })
    answer(requestId, { still_queued: [] })
    toolResult(toolUseId, DOESNT_WANT, { isError: true })
    send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, parent_tool_use_id: null, session_id: sessionId })
    turnTools = 1
    fail('error_during_execution', 'aborted_tools', ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'])
    return
  }
  answer(requestId, { still_queued: [] })
  if (slowTool !== undefined) {
    const id = slowTool
    slowTool = undefined
    toolResult(id, DOESNT_WANT, { isError: true })
    send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, parent_tool_use_id: null, session_id: sessionId })
    turnTools = 1
    fail('error_during_execution', 'aborted_tools', ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'])
  } else if (slowTurn) {
    slowTurn = false
    fail('error_during_execution', 'aborted_streaming', ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'])
  }
}

// What the CLI does with the answer to a can_use_tool request.
function onPermissionReply(message) {
  const reply = message.response?.response ?? {}
  if (pendingPermission === undefined || message.response?.request_id !== pendingPermission.requestId) return
  const { toolUseId, input } = pendingPermission
  pendingPermission = undefined
  const behavior = reply.behavior
  turnTools = 1
  if (behavior === 'allow' && (reply.updatedInput === undefined || typeof reply.updatedInput === 'object')) {
    toolResult(toolUseId, `ran: ${JSON.stringify(reply.updatedInput ?? input)}`)
    assistant([{ type: 'text', text: 'permission: allow' }])
    finish('permission: allow')
  } else if (behavior === 'deny' && typeof reply.message === 'string') {
    denials = [{ tool_name: 'Bash', tool_use_id: toolUseId, tool_input: input }]
    toolResult(toolUseId, reply.message, { isError: true })
    assistant([{ type: 'text', text: 'permission: deny' }])
    finish('permission: deny')
  } else {
    // Invalid reply (a deny without a message, ...): the tool fails, the turn goes on.
    toolResult(toolUseId, VALID_DENY_HELP, { isError: true })
    assistant([{ type: 'text', text: 'permission: invalid' }])
    finish('permission: invalid')
  }
}

function onPrompt(text) {
  if (text.includes('[exit]')) process.exit(3)
  if (text.includes('[slow]')) { slowTurn = true; return }
  if (text.includes('[slowtool]')) {
    slowTool = toolId()
    assistant([{ type: 'tool_use', id: slowTool, name: 'Bash', input: { command: 'sleep 40' } }])
    return
  }
  if (text.includes('[maxturns]')) {
    assistant([{ type: 'text', text: 'working' }])
    turnTools = 2
    fail('error_max_turns', 'max_turns', ['Reached maximum number of turns (2)'])
    return
  }
  if (text.includes('[login]')) {
    assistant([{ type: 'text', text: 'Not logged in · Please run /login' }])
    finish('Not logged in · Please run /login', { is_error: true, terminal_reason: 'api_error' })
    return
  }
  // [denied:CMD] a Bash tool_use of CMD the allow-list does not cover: refused at once, as with
  // `--permission-prompts none` (the permission_denied event carries no input, only the tool_use does).
  const denied = /\[denied:([^\]]*)\]/.exec(text)
  if (denied !== null) {
    const id = toolId()
    const input = { command: denied[1] }
    assistant([{ type: 'tool_use', id, name: 'Bash', input }])
    const refusal = 'Permission for this tool use was denied. It requires approval, and this session has no approval surface.'
    send({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: id, decision_reason_type: 'asyncAgent', decision_reason: 'no approval surface in this session; permission request denied automatically', message: refusal, uuid: randomUUID(), session_id: sessionId })
    toolResult(id, refusal, { isError: true })
    denials = [{ tool_name: 'Bash', tool_use_id: id, tool_input: input }]
    turnTools = 1
    assistant([{ type: 'text', text: 'not run' }])
    finish('not run')
    return
  }
  if (text.includes('[permission]')) {
    const id = toolId()
    const input = { command: 'ls' }
    assistant([{ type: 'tool_use', id, name: 'Bash', input }])
    if (promptsNone) {
      const refusal = 'Permission for this tool use was denied. It requires approval, and this session has no approval surface.'
      send({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: id, decision_reason_type: 'asyncAgent', decision_reason: 'no approval surface in this session; permission request denied automatically', message: refusal, uuid: randomUUID(), session_id: sessionId })
      toolResult(id, refusal, { isError: true })
      denials = [{ tool_name: 'Bash', tool_use_id: id, tool_input: input }]
      turnTools = 1
      assistant([{ type: 'text', text: 'refused' }])
      finish('refused')
      return
    }
    pendingPermission = { requestId: randomUUID(), toolUseId: id, input }
    send({
      type: 'control_request', request_id: pendingPermission.requestId,
      request: {
        subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input, description: 'List files', tool_use_id: id,
        permission_suggestions: [{ type: 'addRules', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow' }],
      },
    })
    return
  }
  const mcp = /\[mcp:(\w+)(?: (\{[^\]]*\}))?\]/.exec(text)
  if (mcp !== null) {
    callMcp(mcp[1], mcp[2] === undefined ? {} : JSON.parse(mcp[2]))
    return
  }
  if (text.includes('[echo]')) {
    const echo = `echo:${JSON.stringify({ argv: process.argv.slice(2), env: process.env })}`
    assistant([{ type: 'text', text: echo }])
    finish(echo)
    return
  }
  if (text.includes('[think]')) {
    send({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 50, session_id: sessionId, uuid: randomUUID() })
    assistant([{ type: 'thinking', thinking: '', signature: 'sig' }])
    send({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 90, estimated_tokens_delta: 40, session_id: sessionId, uuid: randomUUID() })
    assistant([{ type: 'text', text: 'thought done' }])
    finish('thought done')
    return
  }
  if (text.includes('[subagent]')) {
    const agentId = toolId()
    const taskId = 'a6c9a19194b878dac'
    const base = { task_id: taskId, run_id: 'run-1', tool_use_id: agentId, session_id: sessionId }
    assistant([{ type: 'tool_use', id: agentId, name: 'Agent', input: { description: 'Review the change', subagent_type: 'reviewer', prompt: 'Please review.' } }])
    send({ type: 'system', subtype: 'task_started', ...base, description: 'Review the change', subagent_type: 'reviewer', prompt: 'Please review.', task_type: 'local_agent', uuid: randomUUID() })
    send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Please review.' }] }, parent_tool_use_id: agentId, session_id: sessionId })
    send({ type: 'system', subtype: 'task_progress', ...base, description: 'Reading calc.js', subagent_type: 'reviewer', usage: { total_tokens: 4287, tool_uses: 1, duration_ms: 4372 }, last_tool_name: 'Read', uuid: randomUUID() })
    const readId = toolId()
    assistant([{ type: 'tool_use', id: readId, name: 'Read', input: { file_path: 'calc.js' } }], agentId)
    toolResult(readId, '1\texport function add(a, b) {', { parent: agentId })
    const badId = toolId()
    assistant([{ type: 'tool_use', id: badId, name: 'Write', input: { file_path: 'x' } }], agentId)
    toolResult(badId, 'No such tool available: Write', { isError: true, parent: agentId })
    assistant([{ type: 'text', text: 'child musing' }], agentId)
    send({ type: 'system', subtype: 'task_updated', task_id: taskId, run_id: 'run-1', patch: { status: 'completed', end_time: 1 }, uuid: randomUUID(), session_id: sessionId })
    send({ type: 'system', subtype: 'task_notification', ...base, status: 'completed', summary: 'approve: the change is fine', usage: { total_tokens: 6980, tool_uses: 2, duration_ms: 24501 }, uuid: randomUUID() })
    toolResult(agentId, [{ type: 'text', text: '[Subagent hand-back] approve: the change is fine' }])
    turnTools = 2
    assistant([{ type: 'text', text: 'the reviewer approved' }])
    finish('the reviewer approved')
    return
  }
  const readId = toolId()
  assistant([{ type: 'thinking', thinking: `thought about: ${text.slice(0, 40)}` }, { type: 'tool_use', id: readId, name: 'Read', input: { file_path: 'a.js' } }, { type: 'text', text: `ok: ${text.slice(0, 60)}` }])
  finish(`ok: ${text.slice(0, 60)}`)
}

// A tools/call over the MCP http transport; the answer is read from the SSE stream.
async function callMcp(tool, args) {
  const [server, entry]: [string, any] = Object.entries(JSON.parse(flag('--mcp-config')).mcpServers)[0]
  const id = toolId()
  assistant([{ type: 'tool_use', id, name: `mcp__${server}__${tool}`, input: args }])
  let reply
  try {
    const response = await fetch(entry.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(entry.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    })
    const body = await response.text()
    const line = body.split('\n').find(row => row.startsWith('data: ') && row.includes('"result"'))
    reply = JSON.parse(line.slice(6)).result
  } catch (error) {
    reply = { content: [{ type: 'text', text: `mcp failed: ${error.message}` }], isError: true }
  }
  const out = (reply.content ?? []).map(block => block.text ?? '').join('\n')
  turnTools = 1
  toolResult(id, out, { isError: reply.isError === true })
  assistant([{ type: 'text', text: `tool said: ${out}` }])
  finish(`tool said: ${out}`)
}
