// Environment for an agent CLI child process.
// Adapted from bot/src/host/local-agents/discover.ts (cleanEnv, DS Bot 0.3.1).
// Difference: the reference DROPS a named list of variables and lets everything
// else through; this module only PASSES a named list (an allow-list), so a
// token we hold (SLACK_TOKEN, GITLAB_TOKEN, ANTHROPIC_API_KEY, ...) can never
// reach the child by accident. Anything extra must be given explicitly.

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'

const ALLOW_EXACT = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR'])
const ALLOW_PREFIX = ['LC_']

export const isAllowed = key => ALLOW_EXACT.has(key) || ALLOW_PREFIX.some(prefix => key.startsWith(prefix))

// `extra`: variables the caller chooses to give the child (wins over the
// allow-listed ones). `source`: where the allow-listed ones are read from
// (default process.env; tests pass their own object).
export function childEnv({ extra = {}, source = process.env } = {}) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && isAllowed(key)) env[key] = value
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined || value === null) continue
    env[key] = String(value)
  }
  return env
}

// engineAuth: 'login' -> the CLI uses the account signed in on this machine, no key.
// 'apiKey' -> the key is given explicitly and travels as extra env.
export function authEnv({ engineAuth = 'login', apiKey }: any = {}) {
  if (engineAuth === 'login') return {}
  if (engineAuth === 'apiKey') {
    if (typeof apiKey !== 'string' || apiKey === '') throw new Error("engineAuth 'apiKey' needs an apiKey")
    return { ANTHROPIC_API_KEY: apiKey }
  }
  throw new Error(`unknown engineAuth: ${engineAuth}`)
}

// ---------------------------------------------------------------------------------------------
// Isolation of the machine owner's personal instructions (found in the second real run, T-1).
//
// Evidence (Claude Code CLI 2.1.321, read from its bundled memory loader; no model was called):
//  - `--setting-sources project` does keep the user source out: the loader only reads
//    <config home>/CLAUDE.md and <config home>/rules/ when "userSettings" is enabled.
//  - But the loader also walks every ANCESTOR directory of the working directory and reads
//    CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md and .claude/rules/ of each one as "Project"
//    memory. The run's worktree lives under the owner's home (~/chat-to-fix-runs/...), so the
//    ancestor `~` made ~/.claude/CLAUDE.md and ~/.claude/rules/*.md load as project memory (the
//    ancestor path is a plain path, so neither CLAUDE_CONFIG_DIR nor HOME can hide it).
//  - The one precise switch is the setting `claudeMdExcludes` (picomatch globs on absolute paths,
//    applies to User, Project and Local files). CLAUDE_CODE_DISABLE_CLAUDE_MDS would also drop the
//    repository's own CLAUDE.md in the worktree, which the Coding bot is told to follow.
// So: exclude everything that sits ABOVE the working directory, plus the user's config home, and
// keep the working directory's own files. Pair it with a private CLAUDE_CONFIG_DIR where possible
// (engineAuth 'apiKey', see isolatedConfigDir in launch.ts).
// ---------------------------------------------------------------------------------------------

// A path as a picomatch pattern that matches only itself (the loader compares with "/" separators).
const escapeGlob = (path: string) => path.replaceAll('\\', '/').replace(/[*?[\]{}()!+@]/g, '[$&]')

// Every directory above `dir`, nearest first, without the filesystem root (the loader stops there).
export function ancestorDirs(dir: string) {
  const out = []
  let current = dirname(resolve(dir))
  while (current !== parse(current).root) {
    out.push(current)
    current = dirname(current)
  }
  return out
}

// Glob patterns for the `claudeMdExcludes` setting: the instruction files of every ancestor of
// `cwd` (and of its resolved real path when that differs, e.g. /tmp -> /private/tmp), and
// the CLAUDE.md and rules/ of each config home in `configHomes`. `cwd` itself is left alone.
export function memoryExcludes(cwd: string, { configHomes = [] }: { configHomes?: string[] } = {}) {
  const dirs = new Set(ancestorDirs(cwd))
  try {
    for (const dir of ancestorDirs(realpathSync(cwd))) dirs.add(dir)
  } catch {
    // the folder does not exist (yet): the plain path is all there is
  }
  const patterns = []
  for (const dir of dirs) {
    for (const file of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']) patterns.push(escapeGlob(join(dir, file)))
    patterns.push(`${escapeGlob(join(dir, '.claude', 'rules'))}/**`)
  }
  for (const home of configHomes) {
    patterns.push(escapeGlob(join(home, 'CLAUDE.md')), `${escapeGlob(join(home, 'rules'))}/**`)
  }
  return [...new Set(patterns)]
}

// The user's Claude Code config home as the child would see it: CLAUDE_CONFIG_DIR if the
// environment has one, else ~/.claude.
export function userConfigHome(source: any = process.env) {
  const given = source.CLAUDE_CONFIG_DIR
  if (typeof given === 'string' && given !== '') return resolve(given)
  return join(source.HOME || homedir(), '.claude')
}

// Settings (as the JSON of `--settings`) that keep personal instruction files out of the process.
export function isolationSettings(cwd: string, { configHomes = [] }: { configHomes?: string[] } = {}) {
  return { claudeMdExcludes: memoryExcludes(cwd, { configHomes }) }
}
