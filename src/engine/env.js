// Environment for an agent CLI child process.
// Adapted from bot/src/host/local-agents/discover.js (cleanEnv, DS Bot 0.3.1).
// Difference: the reference DROPS a named list of variables and lets everything
// else through; this module only PASSES a named list (an allow-list), so a
// token we hold (SLACK_TOKEN, GITLAB_TOKEN, ANTHROPIC_API_KEY, ...) can never
// reach the child by accident. Anything extra must be given explicitly.

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
export function authEnv({ engineAuth = 'login', apiKey } = {}) {
  if (engineAuth === 'login') return {}
  if (engineAuth === 'apiKey') {
    if (typeof apiKey !== 'string' || apiKey === '') throw new Error("engineAuth 'apiKey' needs an apiKey")
    return { ANTHROPIC_API_KEY: apiKey }
  }
  throw new Error(`unknown engineAuth: ${engineAuth}`)
}
