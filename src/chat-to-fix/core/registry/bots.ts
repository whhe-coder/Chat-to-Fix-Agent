// Bot registry (I7, spec 1 section 2.2). One entry per bot. Adding a bot means adding an entry
// here and nothing else. Every bot is an ordinary DSH session on an API model route; the entries
// differ only in data. The fields are DS Bot's bot fields (createBot/buildBot in
// bot/src/host/roster.ts): name -> name, label -> role, instructions, model, effort, permission,
// preset (the DSH agent preset: which built-in tools the session has, config/cordis.patch.yml).
// `tools` is the addition: the tools only this bot has. Tools every bot has (task_read and the
// DS Bot team tools) are not listed.

/**
 * `model` and `effort` hold either a literal value or the name of a configuration key.
 * The consumer (runner) resolves the keys listed in CONFIG_KEYS, using CONFIG_DEFAULTS when the
 * configuration does not set them.
 */
export const CONFIG_KEYS = Object.freeze(['apiModel', 'codingModel', 'codingEffort'])
export const CONFIG_DEFAULTS = Object.freeze({ codingModel: 'anthropic/claude-sonnet-5-5', codingEffort: 'high' })

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

const BOTS = deepFreeze([
  {
    role: 'main',
    name: 'Main',
    label: 'Flow',
    instructions: 'main.md',
    model: 'apiModel',
    permission: 'read-only',
    preset: 'readonly',
    tools: ['task_records', 'task_advance', 'task_close', 'needs_info_confirm'],
  },
  {
    role: 'slack',
    name: 'Slack',
    label: 'Slack',
    instructions: 'slack.md',
    model: 'apiModel',
    permission: 'read-only',
    preset: 'readonly',
    tools: ['slack_read_thread', 'slack_reply'],
  },
  {
    role: 'jira',
    name: 'Jira',
    label: 'Jira',
    instructions: 'jira.md',
    model: 'apiModel',
    permission: 'read-only',
    preset: 'readonly',
    tools: ['jira_assess_request', 'jira_create_issue', 'jira_get_issue', 'jira_add_comment', 'jira_transition', 'needs_info_confirm'],
  },
  {
    role: 'pipeline',
    name: 'Pipeline',
    label: 'GitLab',
    instructions: 'pipeline.md',
    model: 'apiModel',
    permission: 'read-only',
    preset: 'readonly',
    tools: ['repo_prepare', 'repo_diff', 'repo_read_file', 'repo_log', 'mr_open_draft', 'mr_get', 'ci_read_log', 'mr_push_fix', 'ci_stop'],
  },
  {
    role: 'coding',
    name: 'Coding',
    label: 'Coding',
    instructions: 'coding.md',
    model: 'codingModel',
    effort: 'codingEffort',
    permission: 'workspace-write',
    preset: 'coding',
    tools: ['repo_diff', 'run_tests', 'request_review', 'request_code', 'review_report', 'needs_info_confirm'],
    // The reviewer: not a registered bot. request_review starts it as a DSH subagent of the Coding bot's
    // session, on this preset (read and search only), with these instructions.
    reviewer: { instructions: 'reviewer.md', preset: 'readonly' },
  },
])

/** All bot definitions, in registry order. */
export function allBotDefs() {
  return BOTS
}

/** The definition of one role, or undefined. */
export function botDef(role, defs = BOTS) {
  return defs.find((def) => def.role === role)
}

/** The tools only this role has ([] for an unknown role). */
export function toolsOfRole(role, defs = BOTS) {
  return botDef(role, defs)?.tools ?? []
}

/**
 * Startup checks on a registry (default: the real one). Returns a list of problems; an empty
 * list means valid. Roles are not checked against contracts.ROLES, so adding a bot needs no
 * other edit.
 */
export function validateRegistry(defs = BOTS) {
  const problems = []
  const roles = new Set()
  const names = new Set()
  for (const def of defs) {
    const at = `bot "${def?.role}"`
    for (const field of ['role', 'name', 'label', 'instructions', 'model', 'permission', 'preset']) {
      if (typeof def?.[field] !== 'string' || def[field].trim() === '') problems.push(`${at}: field ${field} is missing`)
    }
    if (roles.has(def?.role)) problems.push(`${at}: duplicate role id`)
    roles.add(def?.role)
    if (names.has(def?.name)) problems.push(`${at}: duplicate name ${def.name}`)
    names.add(def?.name)
    if (typeof def?.name === 'string' && def.name.length > 40) problems.push(`${at}: name is longer than 40 characters`)
    if (typeof def?.label === 'string' && def.label.length > 24) problems.push(`${at}: label is longer than 24 characters`)
    if (!Array.isArray(def?.tools)) problems.push(`${at}: tools is not a list`)
    else if (new Set(def.tools).size !== def.tools.length) problems.push(`${at}: duplicate tool in tools`)
    if (def?.effort !== undefined && (typeof def.effort !== 'string' || def.effort.trim() === '')) problems.push(`${at}: field effort is empty`)
    if (def?.reviewer !== undefined) {
      const reviewer = def.reviewer
      if (!reviewer?.instructions || !reviewer?.preset) problems.push(`${at}: reviewer needs instructions and a preset`)
    }
  }
  const coding = defs.find((def) => def.role === 'coding')
  if (coding && !coding.reviewer) problems.push('bot "coding": reviewer is missing')
  return problems
}
