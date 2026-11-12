// Start arguments for one Claude Code process, built by one pure function.
// Adapted from ClaudeSession.start in bot/src/host/local-agents/claude.js and
// the MODES table in bot/src/host/local-agents/engines.ts (DS Bot 0.3.1).
// Differences: the arguments are built here, not inside the driver; `-p` is an
// option, default ON (the real CLI 2.1.321 needs it for stream-json on a TTY;
// the reference left it off); added --permission-prompt-tool stdio (so
// can_use_tool requests reach the driver), --setting-sources, --mcp-config with
// --strict-mcp-config (http or stdio server), --max-turns and --agents (reviewer
// subagent); an unattended mode (--permission-prompts none, --tools,
// --allowedTools, --disallowedTools, --no-session-persistence) and codingArgs().

// Same mapping as the reference MODES[...].claude.
const CLI_MODES = {
  'read-only': 'plan',
  'workspace-write': 'acceptEdits',
  'danger-full-access': 'bypassPermissions',
}

export const cliMode = permission => CLI_MODES[permission]

// Rules without a scope that open more than the working directory: a bare Write was shown to let a
// write outside the directory through, and a bare Bash (or Bash(*)) would let any command run, curl included.
const BARE_FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'Bash', 'Bash(*)', 'Bash(:*)', 'WebFetch', 'WebSearch'])

// A tool list for --tools / --allowedTools / --disallowedTools: an array (or one
// comma-separated string) becomes one comma-separated value.
function toolList(name, list) {
  const items = (Array.isArray(list) ? list : String(list).split(',')).map(item => String(item).trim()).filter(item => item !== '')
  for (const item of items) {
    if (item.includes(',')) throw new Error(`${name}: "${item}" contains a comma, which cannot be passed in a comma-separated list`)
  }
  return items
}

// options: {
//   print = true, settingSources, resumeId, system, permission, model,
//   mcp: { name = 'chat-to-fix', url, token }            an http server, or
//        { name = 'chat-to-fix', command, args, env? }   a stdio server,
//   maxTurns,
//   reviewer: { name = 'reviewer', description, prompt, tools? },
//   unattended mode (nobody can answer a permission prompt; a refused action is
//   denied by the CLI itself, see system/permission_denied):
//   permissionPrompts: 'none'   -> --permission-prompts none
//   tools: [...]                -> --tools (the only built-in tools that exist)
//   allowedTools: [...]         -> --allowedTools; a bare Read, Edit or Write is refused
//                                  (a bare Write rule lets a write outside the working
//                                  directory through; use acceptEdits for the cwd)
//   disallowedTools: [...]      -> --disallowedTools
//   persist: false              -> --no-session-persistence
//   settings: { ... } | 'json'  -> --settings (extra settings for this process only; used for the
//                                  claudeMdExcludes that keep personal instruction files out, see
//                                  src/engine/env.ts)
// }
export function claudeArgs(options: any = {}) {
  const {
    print = true, settingSources, resumeId, system, permission, model, mcp, maxTurns, reviewer,
    permissionPrompts, tools, allowedTools, disallowedTools, persist, settings,
  } = options
  const args = []
  if (print) args.push('-p')
  args.push('--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio')
  if (permissionPrompts !== undefined) {
    if (permissionPrompts !== 'none') throw new Error(`unknown permissionPrompts: ${permissionPrompts}`)
    args.push('--permission-prompts', 'none')
  }
  if (settingSources !== undefined) args.push('--setting-sources', settingSources)
  if (settings !== undefined) args.push('--settings', typeof settings === 'string' ? settings : JSON.stringify(settings))
  if (resumeId !== undefined) args.push('--resume', resumeId)
  if (system !== undefined) args.push('--append-system-prompt', system)
  if (permission !== undefined) {
    const mode = cliMode(permission)
    if (mode === undefined) throw new Error(`unknown permission preset: ${permission}`)
    args.push('--permission-mode', mode)
  }
  if (model !== undefined && model !== 'default') args.push('--model', model)
  if (tools !== undefined) args.push('--tools', toolList('tools', tools).join(','))
  if (allowedTools !== undefined) {
    const list = toolList('allowedTools', allowedTools)
    for (const item of list) {
      if (BARE_FILE_TOOLS.has(item)) throw new Error(`allowedTools: a bare "${item}" rule is refused (it is not limited to the working directory); use a permission mode or a scoped rule`)
    }
    args.push('--allowedTools', list.join(','))
  }
  if (disallowedTools !== undefined) args.push('--disallowedTools', toolList('disallowedTools', disallowedTools).join(','))
  if (persist === false) args.push('--no-session-persistence')
  if (mcp !== undefined) args.push('--mcp-config', JSON.stringify({ mcpServers: { [mcp.name ?? 'chat-to-fix']: mcpServerEntry(mcp) } }), '--strict-mcp-config')
  if (maxTurns !== undefined) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('maxTurns must be a positive integer')
    args.push('--max-turns', String(maxTurns))
  }
  if (reviewer !== undefined) {
    if (!reviewer.description || !reviewer.prompt) throw new Error('a reviewer needs a description and a prompt')
    const definition: any = { description: reviewer.description, prompt: reviewer.prompt }
    if (reviewer.tools !== undefined) definition.tools = reviewer.tools
    args.push('--agents', JSON.stringify({ [reviewer.name ?? 'reviewer']: definition }))
  }
  return args
}

function mcpServerEntry(mcp) {
  if (mcp.command !== undefined || mcp.type === 'stdio') {
    if (typeof mcp.command !== 'string' || mcp.command === '') throw new Error('a stdio MCP server needs a command')
    return { type: 'stdio', command: mcp.command, args: mcp.args ?? [], ...(mcp.env === undefined ? {} : { env: mcp.env }) }
  }
  if (typeof mcp.url !== 'string' || mcp.url === '') throw new Error('an http MCP server needs a url')
  const server: any = { type: 'http', url: mcp.url }
  if (mcp.token !== undefined) server.headers = { Authorization: `Bearer ${mcp.token}` }
  return server
}

// The verified argument list for the unattended Coding bot (one function for the bot layer).
//   reviewer: { name?, description, prompt, tools }   the review subagent
//   roleToolNames: ['review_report', ...]             tools of our MCP server this role may call
//   mcpServer: { name = 'chat-to-fix', config }            config is an http { url, token } or stdio { command, args, env? } entry
//   testCommands: ['sh test.sh', ...]                 shell commands allowed besides git status / git diff (each as an exact and a prefix rule, see testRules)
//   maxTurns, model, persist (default false: --no-session-persistence), settingSources (default 'project'),
//   system, resumeId, settings
// No permission request ever reaches the driver: edits inside the working directory
// are accepted by the mode, the allow-list holds the rest, everything else is
// refused by the CLI. AskUserQuestion, web and scheduling tools are not offered at all.
// What the CLI 2.1.321 does with a Bash allow rule (read from its bundled permission code; the
// run of T-1 on 2026-11-12 showed that an exact `Bash(sh test.sh)` alone refused what the model ran):
//  - An exact rule `Bash(cmd)` matches only that exact string. Redirections (`2>&1`, `> /dev/null`)
//    are stripped before matching, so `sh test.sh 2>&1` still matches; a further argument does not.
//  - A prefix rule `Bash(cmd:*)` matches `cmd` and `cmd <anything>` (a space after the prefix).
//  - A compound command (`a && b`, `a; b`, `a | b`) is split; each part must be allowed on its own,
//    and a prefix rule never matches a part that is itself compound. `cd`, `echo` and a few
//    read-only commands are allowed by the CLI itself, anything else in the chain is refused
//    (spec 5 section 4.9: "permission prompts none" refuses whatever would prompt; allow rules decide first).
// So each test command is allowed as an exact rule and as a prefix rule (trailing arguments), but a
// command that is itself compound or has a wildcard gets the exact rule only. The Coding bot is
// told to run the command exactly as given (src/prompts/coding.md and launch.ts), from its working folder.
const SHELL_OPERATOR = /&&|\|\||[;|&<>`\n]|\$\(/
const WILDCARD = /\*/
export function testRules(command) {
  const text = String(command).trim()
  if (text === '') return []
  const exact = `Bash(${text})`
  if (SHELL_OPERATOR.test(text) || WILDCARD.test(text)) return [exact]
  return [exact, `Bash(${text}:*)`]
}

export const CODING_TOOLS = Object.freeze(['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Agent', 'ToolSearch'])

export function codingArgs({ reviewer, roleToolNames = [], mcpServer, testCommands = [], maxTurns, model, persist = false, settingSources = 'project', system, resumeId, print, settings }: any = {}) {
  const serverName = mcpServer?.name ?? 'chat-to-fix'
  const prefix = `mcp__${serverName}__`
  const allowedTools = [
    ...roleToolNames.map(name => (name.startsWith('mcp__') ? name : `${prefix}${name}`)),
    'Bash(git status:*)', 'Bash(git diff:*)',
    ...testCommands.flatMap(testRules),
  ]
  return claudeArgs({
    ...(print === undefined ? {} : { print }),
    settingSources, permission: 'workspace-write', permissionPrompts: 'none',
    tools: CODING_TOOLS, allowedTools,
    ...(mcpServer === undefined ? {} : { mcp: { name: serverName, ...mcpServer.config } }),
    maxTurns, reviewer, model, persist, system, resumeId, settings,
  })
}
