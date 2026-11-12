#!/usr/bin/env node
// Demo: one Claude Code session, one prompt, one line per event.
//   node scripts/claude-demo.mjs --cwd <dir> --prompt "<text>" [--bin <path>] [--no-print] [--reviewer]
//   node scripts/claude-demo.mjs --unattended --cwd <dir> --prompt "<text>" [--test-command "sh test.sh"] [--max-turns 20] [--model <alias>] [--mcp-log <file>]
// The binary is --bin, else $CLAUDE_BIN. -p is on by default; --no-print drops it
// (--print is accepted, a no-op). Only project settings are loaded (--setting-sources project).
// Plain mode: permission requests are denied, the run is cut off after 30 s.
// --unattended: the Coding bot's argument list (codingArgs): no permission prompts, the reviewer
// subagent (prompt from src/prompts/reviewer.md), the stdio MCP server of the cc-verify folder as
// `chat-to-fix` offering review_report, 180 s limit; every driver event is printed on one line.
import { parseArgs } from 'node:util'
import { claudeArgs, codingArgs } from '../src/engine/args.js'
import { childEnv } from '../src/engine/env.js'
import { ClaudeSession } from '../src/engine/claude.js'
import { loadPrompt } from '../src/prompts/index.js'

const MCP_SERVER = '/private/tmp/claude-501/-Users-zihuifan-Documents-mywork-ba/956c7019-a4ec-45b8-8bd4-51e32f3c5fcb/scratchpad/cc-verify/mcp-server.mjs'

const { values } = parseArgs({
  options: {
    cwd: { type: 'string' }, prompt: { type: 'string' }, bin: { type: 'string' },
    print: { type: 'boolean', default: true }, 'no-print': { type: 'boolean', default: false }, reviewer: { type: 'boolean', default: false },
    unattended: { type: 'boolean', default: false }, 'test-command': { type: 'string', default: 'sh test.sh' },
    'max-turns': { type: 'string', default: '20' }, model: { type: 'string' }, 'mcp-log': { type: 'string' }, 'mcp-server': { type: 'string', default: MCP_SERVER },
  },
})
const bin = values.bin ?? process.env.CLAUDE_BIN
if (!values.cwd || !values.prompt || !bin) {
  console.error('usage: node scripts/claude-demo.mjs [--unattended] --cwd <dir> --prompt "<text>" [--bin <path>] [--no-print] [--reviewer]  (bin defaults to $CLAUDE_BIN)')
  process.exit(2)
}

const unattended = values.unattended
const limitMs = unattended ? 180_000 : 30_000
const args = unattended
  ? codingArgs({
    print: !values['no-print'],
    reviewer: { description: 'Reviews a code change for bugs. Read and search only.', prompt: loadPrompt('reviewer'), tools: ['Read', 'Grep', 'Glob'] },
    roleToolNames: ['review_report'],
    mcpServer: { name: 'chat-to-fix', config: { type: 'stdio', command: process.execPath, args: [values['mcp-server'], values['mcp-log'] ?? `${values.cwd}.mcp.jsonl`] } },
    testCommands: [values['test-command']],
    maxTurns: Number(values['max-turns']),
    model: values.model,
  })
  : claudeArgs({
    print: !values['no-print'],
    settingSources: 'project',
    permission: 'workspace-write',
    maxTurns: 10,
    ...(values.reviewer ? { reviewer: { description: 'Reviews a change for bugs', prompt: 'You review code changes. Read and search only.', tools: ['Read', 'Grep', 'Glob'] } } : {}),
  })
const session = new ClaudeSession()
const say = (type, text = '') => console.log(`${type.padEnd(14)} ${text}`)
const clip = (value, n = 400) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text.length > n ? `${text.slice(0, n)}...` : text }
const who = event => (event.parentToolUseId ? `[sub ${event.parentToolUseId.slice(-6)}] ` : '')
let code = 1
setTimeout(() => { say('error', `timeout after ${limitMs / 1000} s`); session.kill(); process.exit(1) }, limitMs).unref()
try {
  await session.start({ bin, cwd: values.cwd, args, env: childEnv(), ...(unattended ? { permissionTimeoutMs: 5_000 } : {}) })
  await session.prompt(values.prompt)
  for await (const event of session) {
    if (event.type === 'init') say('init', unattended ? `${event.sessionId} model=${event.model} mode=${event.permissionMode} tools=${(event.tools ?? []).join(',')} mcp=${clip(event.mcpServers)} agents=${(event.agents ?? []).join(',')}` : event.sessionId)
    else if (event.type === 'turn') say('turn', event.sessionId)
    else if (event.type === 'text' || event.type === 'thought') say(event.type, `${who(event)}${event.text}`)
    else if (event.type === 'activity') say('activity', unattended ? `${who(event)}${event.text} ${clip(event.input)}` : event.text)
    else if (event.type === 'permission') { say('permission', `${event.action} ${event.detail} -> deny`); event.reply(false, 'Denied by the demo.') }
    else if (event.type === 'permission_cancelled') say('perm-cancelled', event.id)
    else if (event.type === 'permission_timeout') say('perm-timeout', `${event.toolName} ${event.id}`)
    else if (event.type === 'permission_denied') say('perm-denied', `${event.toolName} ${event.toolUseId} (${event.reasonType}) ${clip(event.message, 200)}`)
    else if (event.type === 'tool_error') say('tool-error', `${who(event)}${event.toolName ?? '?'} ${clip(event.text, 300)}`)
    else if (event.type === 'subagent') say('subagent', `${event.phase} task=${event.taskId} tool_use=${event.toolUseId ?? '-'} ${clip({ description: event.description, type: event.subagentType, last: event.lastToolName, status: event.status ?? event.patch?.status, summary: event.summary, usage: event.usage }, 500)}`)
    else if (event.type === 'subagent_result') say('subagent-reply', `${event.toolUseId} ${event.isError ? '(error) ' : ''}${clip(event.text, 1500)}`)
    else if (event.type === 'done') {
      say('done', `${event.result ?? ''} usage=${JSON.stringify(event.usage)}`)
      if (unattended) say('summary', `turns=${event.numTurns} duration_ms=${event.durationMs} total_cost_usd=${event.totalCostUsd} turn_cost_usd=${event.turnCostUsd} denials=${clip(event.permissionDenials, 600)} terminal=${event.terminalReason}`)
      code = 0
      break
    } else if (event.type === 'error') {
      say('error', `${event.error.message}${event.terminalReason ? ` (${event.terminalReason})` : ''}${event.reason ? ` reason=${event.reason}` : ''}`)
      if (unattended) say('summary', `turns=${event.numTurns} total_cost_usd=${event.totalCostUsd} denials=${clip(event.permissionDenials ?? [], 600)}`)
      break
    }
  }
} catch (error) {
  say('error', error.message)
}
session.kill()
process.exit(code)
