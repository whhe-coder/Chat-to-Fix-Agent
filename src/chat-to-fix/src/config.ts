// Configuration (work package D1, spec 6 sections 2.1 and 4.1).
// Credentials come only from environment variables. They are never copied into the returned
// configuration and never appear in an error message (only the variable NAME may be mentioned).
import { readFileSync } from 'node:fs'
import { EFFORT_LEVELS } from './engine/args.ts'
import { pricingProblems } from './task/pricing.ts'

// The slash command that opens a task (design 2026-11-12); slack.slashCommand overrides it.
export const DEFAULT_SLASH_COMMAND = '/fix'

export const DEFAULT_LIMITS = Object.freeze({
  taskMinutes: 80,
  stepMinutes: Object.freeze({ fetch: 5, issue: 5, prepare: 10, code: 40, mr: 5, ci: 30, writeback: 5 }),
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
  // CI loop (spec 7, 4.9): poll interval, longest wait for one commit and over all rounds, fix commits, log length.
  ciPollSeconds: 15,
  ciWaitMinutes: 30,
  ciTotalMinutes: 90,
  ciMaxRounds: 3,
  ciLogMaxChars: 12000,
})

// Limits that count things: a whole number, not just a positive one.
const INTEGER_LIMITS = Object.freeze(['ciMaxRounds', 'ciLogMaxChars'])

const DEFAULTS = {
  language: 'zh',
  codingModel: 'claude-code/default',
  codingEffort: 'high',
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
  // slack.slashCommand: optional name of the slash command that opens a task (default /fix); read by the forwarder.
  if (name === 'slack' && given.slashCommand !== undefined && !(typeof given.slashCommand === 'string' && /^\/[a-z0-9_-]{1,32}$/.test(given.slashCommand))) {
    problems.push('slack.slashCommand must look like /fix (a slash, then lowercase letters, digits, - or _)')
  }
  if (email && given.email !== undefined && !isText(given.email)) problems.push(`${name}.email must be a non-empty string`)
  if (fields && given.fields !== undefined && !isObject(given.fields)) problems.push(`${name}.fields must be an object`)
  if (name === 'jira') {
    if (given.apiVersion !== undefined && given.apiVersion !== '2' && given.apiVersion !== '3') problems.push('jira.apiVersion must be "2" or "3"')
    if (given.browseUrl !== undefined && (!isHttpUrl(given.browseUrl) || hasCredentialsInUrl(given.browseUrl))) problems.push('jira.browseUrl must be an http(s) URL without credentials')
  }
  // slack.mentions: whether the requester can answer in the thread (default true); false until the Slack app has app_mentions:read.
  if (name === 'slack' && given.mentions !== undefined && typeof given.mentions !== 'boolean') problems.push('slack.mentions must be true or false')
  if (name === 'slack' && given.inputMode !== undefined && !['thread', 'command'].includes(given.inputMode)) problems.push('slack.inputMode must be "thread" or "command"')
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

/**
 * ciJobs and ciNone of a binding (spec 7, 4.9): they only describe the simulated GitLab pipeline.
 * ciJobs: [{ name, command, delaySeconds?, allowFailure?, flaky?, downstream? }]; ciNone: true = a push makes no pipeline.
 */
function ciBindingProblems(b, label, problems) {
  if (b.ciNone !== undefined && typeof b.ciNone !== 'boolean') problems.push(`${label}.ciNone must be true or false`)
  if (b.ciJobs === undefined) return
  if (!Array.isArray(b.ciJobs)) { problems.push(`${label}.ciJobs must be an array of jobs`); return }
  b.ciJobs.forEach((job, j) => {
    const at = `${label}.ciJobs[${j}]`
    if (!isObject(job)) { problems.push(`${at} must be an object`); return }
    if (!isText(job.name)) problems.push(`${at}.name must be a non-empty string`)
    if (!isText(job.command)) problems.push(`${at}.command must be a non-empty string`)
    if (job.delaySeconds !== undefined && !(typeof job.delaySeconds === 'number' && Number.isFinite(job.delaySeconds) && job.delaySeconds >= 0)) problems.push(`${at}.delaySeconds must be a number of 0 or more`)
    for (const flag of ['allowFailure', 'flaky']) {
      if (job[flag] !== undefined && typeof job[flag] !== 'boolean') problems.push(`${at}.${flag} must be true or false`)
    }
    if (job.downstream !== undefined && typeof job.downstream !== 'boolean' && !isObject(job.downstream)) problems.push(`${at}.downstream must be true, false or an object`)
  })
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
    // slack alone also takes "outbox": the company Slack Bot is connected to Slack, this service keeps no token (spec slackbot.md 4.3).
    if (kind !== 'fake' && kind !== 'real' && !(name === 'slack' && kind === 'outbox')) problems.push(`adapters.${name} must be "fake" or "real"${name === 'slack' ? ' or "outbox"' : ''}`)
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

  // codingEffort: --effort of the Coding bot and its reviewer (low, medium, high, xhigh, max).
  const codingEffort = raw.codingEffort ?? DEFAULTS.codingEffort
  if (!EFFORT_LEVELS.includes(codingEffort)) problems.push(`codingEffort must be one of ${EFFORT_LEVELS.join(', ')}`)
  // pricing: rows of the price table (USD per million tokens) that replace or add to src/task/pricing.ts.
  problems.push(...pricingProblems(raw.pricing))

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
      ciBindingProblems(b, `bindings[${i}]`, problems)
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
    else if (INTEGER_LIMITS.includes(key) && !Number.isInteger(value)) problems.push(`limits.${key} must be a whole number`)
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
    codingEffort,
    ...(raw.pricing === undefined ? {} : { pricing: raw.pricing }),
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
