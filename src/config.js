// Configuration (work package D1, spec 6 sections 2.1 and 4.1).
// Credentials come only from environment variables. They are never copied into the returned
// configuration and never appear in an error message (only the variable NAME may be mentioned).
import { readFileSync } from 'node:fs'

export const DEFAULT_LIMITS = Object.freeze({
  taskMinutes: 80,
  stepMinutes: Object.freeze({ fetch: 5, issue: 5, prepare: 10, code: 40, mr: 5, writeback: 5 }),
  quietMinutes: 3,
  quietNudges: 2,
  engineSilentMinutes: 10,
  engineMaxTurns: 200,
  reviewMaxRounds: 3,
  maxConcurrent: 1,
  queueMax: 20,
  queueWaitHours: 4,
  worktreeKeepDays: 7,
  toolTimeoutSeconds: 30,
  toolRetries: 2,
  diffMaxFiles: 20,
  diffMaxLines: 500,
  replyMaxChars: 600,
})

const DEFAULTS = {
  language: 'zh',
  codingModel: 'claude-code/default',
  codingPermission: 'workspace-write',
  engineAuth: 'login',
  jiraTransitions: ['In Review'],
  commitAuthor: { name: 'chat-to-fix', email: 'chat-to-fix@example.com' },
}

const ADAPTER_NAMES = ['slack', 'jira', 'gitlab']
const ADAPTER_TOKEN = { slack: 'CHAT_TO_FIX_SLACK_TOKEN', jira: 'CHAT_TO_FIX_JIRA_TOKEN', gitlab: 'CHAT_TO_FIX_GITLAB_TOKEN' }
const isText = (v) => typeof v === 'string' && v.trim() !== ''
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0

/** Gets a credential from the environment variables; undefined when it is not set. */
export function secret(env, name) {
  const value = (env ?? process.env)[name]
  return isText(value) ? value : undefined
}

/** The binding of a channel, or undefined. */
export function bindingOf(config, channel) {
  return config.bindings.find((b) => b.channel === channel)
}

/** Reads, validates and completes the configuration. Throws one Error that lists every problem. */
export function loadConfig({ path, env = process.env } = {}) {
  const file = path ?? env.CHAT_TO_FIX_CONFIG
  if (!isText(file)) throw new Error('invalid configuration: the path is missing (set CHAT_TO_FIX_CONFIG)')
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    const why = error instanceof SyntaxError ? 'not valid JSON' : 'cannot be read'
    throw new Error(`invalid configuration: the file ${file} is ${why}`)
  }
  if (!isObject(raw)) throw new Error('invalid configuration: the file must hold a JSON object')

  const problems = []
  for (const key of ['dataDir', 'worktreesDir', 'apiModel']) {
    if (!isText(raw[key])) problems.push(`missing ${key}`)
  }
  if (raw.httpPort === undefined || raw.httpPort === null) problems.push('missing httpPort')
  else if (!Number.isInteger(raw.httpPort) || raw.httpPort < 0 || raw.httpPort > 65535) problems.push('httpPort must be an integer from 0 to 65535')

  // adapters
  const adapters = {}
  const given = isObject(raw.adapters) ? raw.adapters : {}
  for (const name of ADAPTER_NAMES) {
    const kind = given[name] ?? 'fake'
    if (kind !== 'fake' && kind !== 'real') problems.push(`adapters.${name} must be "fake" or "real"`)
    else if (kind === 'real' && secret(env, ADAPTER_TOKEN[name]) === undefined) problems.push(`adapters.${name} is "real" but ${ADAPTER_TOKEN[name]} is not set`)
    adapters[name] = kind
  }

  const engineAuth = raw.engineAuth ?? DEFAULTS.engineAuth
  if (engineAuth !== 'login' && engineAuth !== 'apiKey') problems.push('engineAuth must be "login" or "apiKey"')
  else if (engineAuth === 'apiKey' && secret(env, 'ANTHROPIC_API_KEY') === undefined) problems.push('engineAuth is "apiKey" but ANTHROPIC_API_KEY is not set')

  // bindings
  const bindings = []
  if (!Array.isArray(raw.bindings) || raw.bindings.length === 0) problems.push('missing bindings (at least one entry is required)')
  else {
    const seen = new Set()
    raw.bindings.forEach((b, i) => {
      if (!isObject(b)) { problems.push(`bindings[${i}] must be an object`); return }
      for (const key of ['channel', 'repo', 'jiraProject']) {
        if (!isText(b[key])) problems.push(`missing bindings[${i}].${key}`)
      }
      if (isText(b.channel)) {
        if (seen.has(b.channel)) problems.push(`channel ${b.channel} appears twice in bindings`)
        seen.add(b.channel)
      }
      bindings.push({ ...b, defaultBranch: b.defaultBranch ?? 'master', issueType: b.issueType ?? 'Bug', labels: b.labels ?? [] })
    })
  }

  // limits
  const rawLimits = isObject(raw.limits) ? raw.limits : {}
  const limits = { ...DEFAULT_LIMITS, stepMinutes: { ...DEFAULT_LIMITS.stepMinutes } }
  for (const [key, value] of Object.entries(rawLimits)) {
    if (key === 'stepMinutes') continue
    if (!(key in DEFAULT_LIMITS)) continue
    if (!isPositive(value)) problems.push(`limits.${key} must be a positive number`)
    else limits[key] = value
  }
  if (rawLimits.stepMinutes !== undefined) {
    if (!isObject(rawLimits.stepMinutes)) problems.push('limits.stepMinutes must be an object')
    else for (const [step, value] of Object.entries(rawLimits.stepMinutes)) {
      if (!(step in DEFAULT_LIMITS.stepMinutes)) continue
      if (!isPositive(value)) problems.push(`limits.stepMinutes.${step} must be a positive number`)
      else limits.stepMinutes[step] = value
    }
  }

  if (problems.length > 0) throw new Error(`invalid configuration: ${problems.join('; ')}`)

  return {
    dataDir: raw.dataDir,
    worktreesDir: raw.worktreesDir,
    httpPort: raw.httpPort,
    language: raw.language ?? DEFAULTS.language,
    apiModel: raw.apiModel,
    codingModel: raw.codingModel ?? DEFAULTS.codingModel,
    codingPermission: raw.codingPermission ?? DEFAULTS.codingPermission,
    engineAuth,
    adapters,
    bindings,
    jiraTransitions: raw.jiraTransitions ?? [...DEFAULTS.jiraTransitions],
    commitAuthor: { ...DEFAULTS.commitAuthor, ...(isObject(raw.commitAuthor) ? raw.commitAuthor : {}) },
    limits,
  }
}
