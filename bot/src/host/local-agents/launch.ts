// How one Claude Code process is started for a DSH Session: the argument list and the child
// environment. A session of a bound coding bot gets the settled unattended list (codingArgs:
// the reviewer subagent, our tools only, no permission prompts); any other session gets
// claudeArgs with what DS Bot passed before (resume id, system text, permission mode, model,
// the loopback MCP server).
import { authEnv, childEnv } from '../../../../src/engine/env.ts'
import { claudeArgs, codingArgs } from '../../../../src/engine/args.ts'
import { botDef } from '../../../../src/registry/bots.ts'
import { loadPrompt } from '../../../../src/prompts/index.ts'

// A reviewer needs a description; the registry holds only its name, prompt file and tools.
const REVIEWER_DESCRIPTION = 'Read-only reviewer of a code change. Call it once the change is made and the tests pass; give it the task summary and a description of the change. It answers pass or not pass.'

// The default for a permission request nobody answers (the driver then denies it).
export const PERMISSION_TIMEOUT_MS = 5 * 60_000

// The names of the tools this session's loopback MCP server may serve: DS Bot's team tools plus
// the role tools of the session's bot (the task layer's bridgedToolNames).
export function bridgeNames(rt, sessionId, requested = []) {
  const team = new Set(rt.teamTools.map(def => def.name))
  const names = new Set()
  for (const name of requested) if (team.has(name)) names.add(name)
  for (const name of rt.taskLayer?.bridgedToolNames?.(sessionId) ?? []) names.add(name)
  return [...names]
}

// open: { cwd, mcp (a LoopbackMcp), resumeId, preset, model, system, toolNames }
// -> { args, env, permissionTimeoutMs, resumed }
//
// rt.config (from the plugin config, see src/plugin.ts): engineAuth ('login' | 'apiKey'),
// engineApiKey (only with 'apiKey'), engineMaxTurns, testCommands (shell commands the coding
// bot may run besides git status / git diff), permissionTimeoutMs.
export function launchFor(rt, sessionId, open) {
  const config = rt.config ?? {}
  const auth = authEnv({ engineAuth: config.engineAuth ?? 'login', apiKey: config.engineApiKey })
  const env = childEnv({ extra: auth })
  const permissionTimeoutMs = config.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS
  const model = open.model === 'default' ? undefined : open.model
  const bound = rt.botlayer?.botOfSession(sessionId)
  const def = bound === undefined ? undefined : botDef(bound.role)
  if (def?.reviewer !== undefined) {
    const roleToolNames = bridgeNames(rt, sessionId, open.toolNames).filter(name => name !== 'approve_agent_action')
    // No permission prompt is ever asked, so a session that is not saved cannot be resumed: a
    // process that comes back later starts fresh and the adapter replays the conversation.
    const args = codingArgs({
      reviewer: { name: def.reviewer.name, description: REVIEWER_DESCRIPTION, prompt: loadPrompt(def.reviewer.instructions), tools: def.reviewer.tools },
      roleToolNames,
      mcpServer: { name: 'chat-to-fix', config: { url: open.mcp.url, token: open.mcp.token } },
      testCommands: config.testCommands ?? [],
      maxTurns: config.engineMaxTurns,
      model,
      system: open.system,
    })
    // The reviewer must run inside the turn: with background tasks on, the CLI (2.1.321) starts the
    // Agent tool's subagent in the background and ends the turn before the reviewer has answered.
    const codingEnv = childEnv({ extra: { ...auth, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } })
    return { args, env: codingEnv, permissionTimeoutMs, resumed: false }
  }
  const args = claudeArgs({
    resumeId: open.resumeId,
    system: open.system,
    permission: open.preset,
    model,
    mcp: { name: 'dsbot', url: open.mcp.url, token: open.mcp.token },
  })
  return { args, env, permissionTimeoutMs, resumed: open.resumeId !== undefined }
}
