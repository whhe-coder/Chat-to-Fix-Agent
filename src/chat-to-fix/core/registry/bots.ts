// Bot registry (I7, spec 1 section 2.2). One entry per bot. Adding a bot means adding an entry
// here and nothing else. The first five fields are DS Bot's bot fields (createBot/buildBot in
// bot/src/host/roster.ts): name -> name, label -> role, instructions, model, permission.
// `tools` is the addition: the tools only this bot has. Tools every bot has (task_read and the
// DS Bot team tools) are not listed.

/**
 * `model` and `permission` hold either a literal value or the name of a configuration key.
 * The consumer (bot layer / config) resolves the keys listed in CONFIG_KEYS, using
 * CONFIG_DEFAULTS when the configuration does not set them.
 */
export const CONFIG_KEYS = Object.freeze(['apiModel', 'codingModel', 'codingPermission'])
export const CONFIG_DEFAULTS = Object.freeze({ codingModel: 'claude-code/default', codingPermission: 'workspace-write' })

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
    tools: ['task_records', 'task_advance', 'task_close', 'needs_info_confirm'],
  },
  {
    role: 'slack',
    name: 'Slack',
    label: 'Slack',
    instructions: 'slack.md',
    model: 'apiModel',
    permission: 'read-only',
    tools: ['slack_read_thread', 'slack_reply'],
  },
  {
    role: 'jira',
    name: 'Jira',
    label: 'Jira',
    instructions: 'jira.md',
    model: 'apiModel',
    permission: 'read-only',
    tools: ['jira_assess_request', 'jira_create_issue', 'jira_get_issue', 'jira_add_comment', 'jira_transition', 'needs_info_confirm'],
  },
  {
    role: 'pipeline',
    name: 'Pipeline',
    label: 'GitLab',
    instructions: 'pipeline.md',
    model: 'apiModel',
    permission: 'read-only',
    tools: ['repo_prepare', 'repo_diff', 'repo_read_file', 'repo_log', 'mr_open_draft', 'mr_get', 'ci_read_log', 'mr_push_fix', 'ci_stop'],
  },
  {
    role: 'coding',
    name: 'Coding',
    label: 'Claude Code',
    instructions: 'coding.md',
    model: 'codingModel',
    permission: 'codingPermission',
    tools: ['request_code', 'review_report', 'needs_info_confirm'],
    // The reviewer subagent: not a registered bot, read-only tools (read and search).
    reviewer: { name: 'reviewer', instructions: 'reviewer.md', tools: ['Read', 'Grep', 'Glob'] },
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
    for (const field of ['role', 'name', 'label', 'instructions', 'model', 'permission']) {
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
    if (def?.reviewer !== undefined) {
      const reviewer = def.reviewer
      if (!reviewer.name || !reviewer.instructions || !Array.isArray(reviewer.tools) || reviewer.tools.length === 0) {
        problems.push(`${at}: reviewer needs name, instructions and tools`)
      }
    }
  }
  const coding = defs.find((def) => def.role === 'coding')
  if (coding && !coding.reviewer) problems.push('bot "coding": reviewer is missing')
  return problems
}
