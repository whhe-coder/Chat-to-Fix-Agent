// How one Claude Code process is started for a DSH Session: the argument list and the child
// environment. A session of a bound coding bot gets the settled unattended list (codingArgs:
// the reviewer subagent, our tools only, no permission prompts); any other session gets
// claudeArgs with what DS Bot passed before (resume id, system text, permission mode, model,
// the loopback MCP server).
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authEnv, childEnv, isolationSettings, userConfigHome } from '../../../../src/engine/env.ts'
import { claudeArgs, codingArgs } from '../../../../src/engine/args.ts'
import { botDef } from '../../../../src/registry/bots.ts'
import { loadPrompt } from '../../../../src/prompts/index.ts'

// A reviewer needs a description; the registry holds only its name, prompt file and tools.
const REVIEWER_DESCRIPTION = 'Read-only reviewer of a code change. Call it once the change is made and the tests pass; give it the task summary and a description of the change. It answers pass or not pass.'

// The default for a permission request nobody answers (the driver then denies it).
export const PERMISSION_TIMEOUT_MS = 5 * 60_000

// The test commands, named in the system text so the Coding bot runs them as the allow-list has them
// (an exact rule and a prefix rule, see testRules in src/engine/args.ts). The first real run (T-1)
// had its test run refused with no trace of what the model had typed.
export function withTestCommands(system, testCommands) {
  const commands = testCommands.map(command => String(command).trim()).filter(command => command !== '')
  if (commands.length === 0) return system
  const list = commands.map(command => `\`${command}\``).join(', ')
  const note = `The shell commands you may run are git status, git diff and these test commands: ${list}. Run a test command exactly as written, from your working folder: no cd, no pipe, no redirection and no && or ; chain, no environment prefix and no other wrapper. Any other command is refused at once and nobody can approve it.`
  return system === undefined || system === '' ? note : `${system}\n\n${note}`
}

// Keeping the machine owner's personal instructions (~/.claude/CLAUDE.md, ~/.claude/rules/*.md)
// out of a bot. The second real run showed the Coding bot reading them although the arguments
// say `--setting-sources project`: the CLI also reads the instruction files of every ancestor
// directory of the working directory, and the worktree lives under the owner's home (the full
// finding is in src/engine/env.ts). Two layers, both per process:
//  1. `--settings` with `claudeMdExcludes`: every instruction file above the working directory and
//     the user's config home are excluded; the repository's own files in the working directory stay.
//  2. engineAuth 'apiKey': a private CLAUDE_CONFIG_DIR inside the data folder, so the CLI's own
//     state (global config, sessions, auto memory) never touches the user's ~/.claude, and nothing
//     of the user's config home can load. The directory starts empty and never gets a credential:
//     the key travels in ANTHROPIC_API_KEY only.
//     engineAuth 'login': the login (OAuth token in the macOS keychain, entry named after the config
//     dir) belongs to the user's config home, so a private CLAUDE_CONFIG_DIR would log the CLI out.
//     The trade-off: login mode keeps the user's config home as the CLI's state directory and relies
//     on layer 1 plus `--setting-sources project` (no user settings, hooks, plugins or MCP servers);
//     auto memory is switched off for it (CLAUDE_CODE_DISABLE_AUTO_MEMORY) so a bot never writes into
//     ~/.claude. Use 'apiKey' where full isolation matters.
// rt.config.engineConfigRoot (set by src/plugin.ts: <dataDir>/engine-config) is the parent of the
// private directories; without it (a bare test runtime) they go under the OS temp folder.
export function isolatedConfigDir(config, sessionId) {
  const root = typeof config.engineConfigRoot === 'string' && config.engineConfigRoot !== '' ? config.engineConfigRoot : undefined
  const name = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')
  if (root === undefined) return mkdtempSync(join(tmpdir(), `chat-to-fix-engine-${name}-`))
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

// -> { env: extra variables for the child, settings: the --settings object }. childEnv does not pass
// CLAUDE_CONFIG_DIR on, so in login mode the CLI's config home is always <HOME>/.claude.
export function engineIsolation(config, sessionId, cwd, sourceEnv = process.env) {
  if (config.engineAuth === 'apiKey') {
    const dir = isolatedConfigDir(config, sessionId)
    return { env: { CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, settings: isolationSettings(cwd, { configHomes: [dir] }) }
  }
  return { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, settings: isolationSettings(cwd, { configHomes: [userConfigHome({ HOME: sourceEnv.HOME })] }) }
}

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
// engineApiKey (only with 'apiKey'), engineConfigRoot (parent of the private config dirs, see isolatedConfigDir), engineMaxTurns, codingEffort (--effort of the Coding bot and its reviewer; unset: the CLI's own default), testCommands (the plugin-level list of shell
// commands the coding bot may run besides git status / git diff; the fallback), permissionTimeoutMs.
// The task's own list comes first: rt.taskLayer.codingOptions(taskId).testCommands is the
// `testCommands` of the task's binding (src/task/runner.ts), so each channel names its own.
export function launchFor(rt, sessionId, open) {
  const config = rt.config ?? {}
  const auth = authEnv({ engineAuth: config.engineAuth ?? 'login', apiKey: config.engineApiKey } as any)
  const isolation = engineIsolation(config, sessionId, open.cwd ?? process.cwd())
  const env = childEnv({ extra: { ...auth, ...isolation.env } })
  const permissionTimeoutMs = config.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS
  const model = open.model === 'default' ? undefined : open.model
  const bound = rt.botlayer?.botOfSession(sessionId)
  const def = bound === undefined ? undefined : botDef(bound.role)
  if (def?.reviewer !== undefined) {
    const own = rt.taskLayer?.codingOptions?.(bound.taskId)
    const roleToolNames = bridgeNames(rt, sessionId, open.toolNames).filter(name => name !== 'approve_agent_action')
    // No permission prompt is ever asked, so a session that is not saved cannot be resumed: a
    // process that comes back later starts fresh and the adapter replays the conversation.
    const testCommands = own?.testCommands ?? config.testCommands ?? []
    // The reviewer runs on the Coding bot's own model and effort, set explicitly in its definition.
    const effort = config.codingEffort
    const args = codingArgs({
      reviewer: { name: def.reviewer.name, description: REVIEWER_DESCRIPTION, prompt: loadPrompt(def.reviewer.instructions), tools: def.reviewer.tools, model, effort },
      roleToolNames,
      mcpServer: { name: 'chat-to-fix', config: { url: open.mcp.url, token: open.mcp.token } },
      testCommands,
      maxTurns: config.engineMaxTurns,
      model,
      effort,
      system: withTestCommands(open.system, testCommands),
      settings: isolation.settings,
    } as any)
    // The reviewer must run inside the turn: with background tasks on, the CLI (2.1.321) starts the
    // Agent tool's subagent in the background and ends the turn before the reviewer has answered.
    const codingEnv = childEnv({ extra: { ...auth, ...isolation.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } })
    return { args, env: codingEnv, permissionTimeoutMs, resumed: false }
  }
  const args = claudeArgs({
    resumeId: open.resumeId,
    system: open.system,
    permission: open.preset,
    model,
    settingSources: 'project',
    settings: isolation.settings,
    mcp: { name: 'dsbot', url: open.mcp.url, token: open.mcp.token },
  })
  return { args, env, permissionTimeoutMs, resumed: open.resumeId !== undefined }
}
