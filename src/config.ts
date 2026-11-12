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
// Placeholder text of config.example.json: a run must never start with it still in place.
const PLACEHOLDER = 'CHANGE-ME'
// A key that looks like it holds a credential; credentials are read from the environment only.
const CREDENTIAL_KEY = /token|secret|password|passwd|api[-_]?key/i
// What the Claude Code allow-list cannot take (src/engine/args.ts): a comma, or a rule for every command.
const unusableCommand = (v) => v.includes(',') || v === '*' || v === ':*'

const isHttpUrl = (v) => {
  if (!isText(v)) return false
  try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false }
}
const hasCredentialsInUrl = (v) => { try { const u = new URL(v); return u.username !== '' || u.password !== '' } catch { return false } }

/**
 * Validates the `jira`, `gitlab` or `slack` object of the configuration and returns it (a shallow
 * copy; other keys pass through). `baseUrl` is required when the adapter is "real". Problems are
 * added to `problems`; messages name keys only, never values.
 */
function adapterSection(raw, name, kind, problems, { email = false, fields = false } = {}) {
  const section = raw[name]
  if (section !== undefined && !isObject(section)) { problems.push(`${name} must be an object`); return {} }
  const given: any = section ?? {}
  for (const key of Object.keys(given)) {
    if (CREDENTIAL_KEY.test(key)) problems.push(`${name}.${key} looks like a credential; credentials come from the environment only (${ADAPTER_TOKEN[name]})`)
  }
  if (given.baseUrl === undefined) {
    if (kind === 'real' && name !== 'slack') problems.push(`${name}.baseUrl is required when adapters.${name} is "real"`)
  } else if (!isHttpUrl(given.baseUrl)) problems.push(`${name}.baseUrl must be an http(s) URL`)
  else if (hasCredentialsInUrl(given.baseUrl)) problems.push(`${name}.baseUrl must not contain a user name or password`)
  // slack.apiBase: optional override of the Web API base URL (default https://slack.com/api).
  if (name === 'slack' && given.apiBase !== undefined) {
    if (!isHttpUrl(given.apiBase)) problems.push('slack.apiBase must be an http(s) URL')
    else if (hasCredentialsInUrl(given.apiBase)) problems.push('slack.apiBase must not contain a user name or password')
  }
  if (email && given.email !== undefined && !isText(given.email)) problems.push(`${name}.email must be a non-empty string`)
  if (fields && given.fields !== undefined && !isObject(given.fields)) problems.push(`${name}.fields must be an object`)
  return { ...given }
}

/** A list of non-empty strings; the problem text names the key and the index only. */
function textList(value, label, problems, { allowed = (_v) => true, why = '' }: any = {}) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) { problems.push(`${label} must be an array of non-empty strings`); return undefined }
  const out = []
  value.forEach((item, i) => {
    if (!isText(item)) problems.push(`${label}[${i}] must be a non-empty string`)
    else if (!allowed(item.trim())) problems.push(`${label}[${i}] ${why}`)
    else out.push(item.trim())
  })
  return out
}

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
export function loadConfig({ path, env = process.env }: { path?: string, env?: any } = {}) {
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
  if (isText(raw.apiModel) && raw.apiModel.includes(PLACEHOLDER)) problems.push(`apiModel still holds the placeholder ${PLACEHOLDER}; set the model id (for example anthropic/claude-sonnet-5-5)`)
  if (raw.httpPort === undefined || raw.httpPort === null) problems.push('missing httpPort')
  else if (!Number.isInteger(raw.httpPort) || raw.httpPort < 0 || raw.httpPort > 65535) problems.push('httpPort must be an integer from 0 to 65535')

  // adapters
  const adapters: any = {}
  const given = isObject(raw.adapters) ? raw.adapters : {}
  for (const name of ADAPTER_NAMES) {
    const kind = given[name] ?? 'fake'
    if (kind !== 'fake' && kind !== 'real') problems.push(`adapters.${name} must be "fake" or "real"`)
    else if (kind === 'real' && secret(env, ADAPTER_TOKEN[name]) === undefined) problems.push(`adapters.${name} is "real" but ${ADAPTER_TOKEN[name]} is not set`)
    adapters[name] = kind
  }

  // Per-adapter settings (the shared contract: tokens only from the environment).
  const jira = adapterSection(raw, 'jira', adapters.jira, problems, { email: true, fields: true })
  const gitlab = adapterSection(raw, 'gitlab', adapters.gitlab, problems)
  const slack = adapterSection(raw, 'slack', adapters.slack, problems)

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
      // testCommands: the shell commands the Coding bot may run (each becomes a Bash(<command>) rule);
      // setupCommands: run once in a fresh worktree; jiraFields: extra fields for this channel's issues.
      const testCommands = textList(b.testCommands, `bindings[${i}].testCommands`, problems, { allowed: (v) => !unusableCommand(v), why: 'must not contain a comma and must not be a bare wildcard' })
      const setupCommands = textList(b.setupCommands, `bindings[${i}].setupCommands`, problems)
      if (b.jiraFields !== undefined && !isObject(b.jiraFields)) problems.push(`bindings[${i}].jiraFields must be an object`)
      bindings.push({
        ...b, defaultBranch: b.defaultBranch ?? 'master', issueType: b.issueType ?? 'Bug', labels: b.labels ?? [],
        ...(testCommands === undefined ? {} : { testCommands }),
        ...(setupCommands === undefined ? {} : { setupCommands }),
      })
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
    jira,
    gitlab,
    slack,
    bindings,
    jiraTransitions: raw.jiraTransitions ?? [...DEFAULTS.jiraTransitions],
    commitAuthor: { ...DEFAULTS.commitAuthor, ...(isObject(raw.commitAuthor) ? raw.commitAuthor : {}) },
    limits,
  }
}
