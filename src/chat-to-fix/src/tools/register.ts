// Tool registration framework (C0, I4). Spec: spec-4-tools-and-adapters.md sections 2.1, 3, 4.1, 4.2.
//
// A role tool is defined once (defineRoleTool), attached to the sessions of the bots whose role
// has it (attachRoleTools), and always executed through one wrapper (call): fresh task, step
// check for write tools, retry and timeout, and a failure returned as text instead of thrown.
// Tools never write the execution record; the recorder builds it from the bot layer's tool events.
import { allBotDefs, toolsOfRole } from '../registry/bots.ts'

// DS Bot's team tools list, copied from bot/src/host/constants.ts:65 (TEAM_TOOLS). A role tool
// must not use one of these names. The copy is checked against the original in test/tools.test.ts.
export const TEAM_TOOL_NAMES = Object.freeze([
  'list_bots', 'message_bot', 'stop_bot', 'post_to_group',
  'request_secret', 'list_secrets', 'group_relay', 'read_own_chat',
  'read_group_chat', 'remember', 'forget', 'recall', 'read_browser',
  'group_goal', 'list_connectors', 'request_connector',
])

// The tool output shape DS Bot uses for every tool that returns plain text
// (bot/src/host/tools.ts:14).
const OUTPUT = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/
const PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean'])
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasText = (value) => typeof value === 'string' && value.trim() !== ''

/** Checks one tool definition. Returns a list of problems (empty = valid). */
function checkDefinition(def) {
  const problems = []
  if (!isObject(def)) return ['the definition is not an object']
  const at = `tool "${def.name}"`
  if (!hasText(def.name) || !NAME_PATTERN.test(def.name)) problems.push(`${at}: name must be lower-case letters, digits and underscores`)
  else if (TEAM_TOOL_NAMES.includes(def.name)) problems.push(`${at}: the name is in DS Bot's team tools list`)
  if (def.roles !== 'all') {
    if (!Array.isArray(def.roles) || def.roles.length === 0 || !def.roles.every(hasText)) problems.push(`${at}: roles must be "all" or a non-empty list of role ids`)
    else if (new Set(def.roles).size !== def.roles.length) problems.push(`${at}: duplicate role in roles`)
  }
  if (typeof def.write !== 'boolean') problems.push(`${at}: write must be true or false`)
  if (def.purpose !== undefined && typeof def.purpose !== 'function') problems.push(`${at}: purpose must be a function`)
  if (def.purpose !== undefined && def.write !== true) problems.push(`${at}: purpose only makes sense for a write tool`)
  if (!hasText(def.description)) problems.push(`${at}: description is missing`)
  if (!isObject(def.parameters)) problems.push(`${at}: parameters must be an object (use {} for none)`)
  else {
    for (const [key, spec] of Object.entries(def.parameters) as [string, any][]) {
      if (!isObject(spec) || !PARAM_TYPES.has(spec.type)) problems.push(`${at}: parameter ${key} needs a type (${[...PARAM_TYPES].join(', ')})`)
      else if (spec.enum !== undefined && (!Array.isArray(spec.enum) || spec.enum.length === 0)) problems.push(`${at}: parameter ${key} has an empty enum`)
    }
  }
  if (typeof def.run !== 'function') problems.push(`${at}: run must be a function`)
  return problems
}

/** Checks the arguments of a call against the parameter table. Returns a problem text or undefined. */
function checkArgs(def, args) {
  if (args !== undefined && args !== null && !isObject(args)) return 'the arguments must be an object'
  const given = args ?? {}
  for (const [key, spec] of Object.entries(def.parameters) as [string, any][]) {
    const value = given[key]
    if (value === undefined || value === null) {
      if (spec.required) return `missing required argument ${key}`
      continue
    }
    const ok = spec.type === 'integer' ? Number.isInteger(value) : spec.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === spec.type
    if (!ok) return `argument ${key} must be of type ${spec.type}`
    if (spec.enum && !spec.enum.includes(value)) return `argument ${key} must be one of ${spec.enum.join(', ')}`
  }
  return undefined
}

const messageOf = (error) => {
  const text = error?.message ?? String(error)
  return error?.code ? `${text} [${error.code}]` : text
}

/**
 * @param {{store: import('../task/contracts.ts').TaskStore, gate: import('../task/contracts.ts').Gate,
 *          adapters?: object, config?: object, botlayer: import('../task/contracts.ts').BotLayer,
 *          warn?: (...args: any[]) => void,
 *          defineTool?: (def: object) => object, retryDelayMs?: number}} options
 *   `defineTool` is DSH's `defineTool` from @deepseek-ai/dsh-tools (the bot layer passes it in); the
 *   default is identity, which is what the tests use. `retryDelayMs` is the pause before a retry.
 */
export function createToolRegistry({ store, gate, adapters, config = {} as any, botlayer, warn = (...args) => console.warn(...args), defineTool = (def) => def, retryDelayMs = 250 }) {
  /** @type {Map<string, import('../task/contracts.ts').RoleTool>} */
  const tools = new Map()
  // sessionId -> { agent, disposers } for the sessions that already hold their tools.
  const attached = new Map()

  const appliesTo = (def, role) => def.roles === 'all' || def.roles.includes(role)

  function defineRoleTool(def) {
    const problems = checkDefinition(def)
    if (problems.length === 0 && tools.has(def.name)) problems.push(`tool "${def.name}" is already defined`)
    if (problems.length > 0) throw new Error(`invalid tool definition: ${problems.join('; ')}`)
    tools.set(def.name, def)
    return def
  }

  /** The definitions a role has, in definition order. */
  function toolsFor(role) {
    return [...tools.values()].filter((def) => appliesTo(def, role))
  }

  function lookup(sessionId) {
    try {
      return botlayer.botOfSession(sessionId)
    } catch (error) {
      warn('chat-to-fix: botOfSession failed for %s: %s', sessionId, error?.message ?? error)
      return undefined
    }
  }

  /** Names of this session's role tools; [] for a session that is not bound to a bot. */
  function bridgedToolNames(sessionId) {
    const bound = lookup(sessionId)
    return bound ? toolsFor(bound.role).map((def) => def.name) : []
  }

  async function runOnce(def, ctx, args, timeoutMs) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${timeoutMs / 1000}s`), { code: 'timeout' })), timeoutMs)
    })
    try {
      return await Promise.race([(async () => def.run(ctx, args))(), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  // The common wrapper (spec 4 section 4.2). Always resolves to text; never throws.
  async function call(name, sessionId, args) {
    const def = tools.get(name)
    if (!def) return `tool failed: no such tool ${name}`
    try {
      const bound = lookup(sessionId)
      if (!bound) return `tool failed: session ${sessionId} does not belong to a task`
      if (!appliesTo(def, bound.role)) return `tool failed: ${name} is not available to the ${bound.role} bot`
      const problem = checkArgs(def, args)
      if (problem) return `tool failed: ${name}: ${problem}`

      // 1. The latest task and the context.
      const task = await store.getTask(bound.taskId)
      if (!task) return `tool failed: task ${bound.taskId} not found`
      const ctx = { task, role: bound.role, botId: bound.botId, sessionId, store, gate, adapters, config, botlayer }

      // 2. A write tool must pass the step checks; the refusal reason is the result.
      if (def.write) {
        const verdict = await gate.allow(task.id, name, def.purpose?.(args ?? {}))
        if (!verdict.ok) return verdict.reason
      }

      // 3. Run with retry (retryable errors only) and a time limit per attempt.
      const retries = config?.limits?.toolRetries ?? 2
      const timeoutMs = (config?.limits?.toolTimeoutSeconds ?? 30) * 1000
      for (let attempt = 0; ; attempt++) {
        try {
          // 4. Success: the tool's text.
          return String(await runOnce(def, ctx, args ?? {}, timeoutMs))
        } catch (error) {
          if (error?.retryable === true && attempt < retries) {
            if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
            continue
          }
          return `tool failed: ${messageOf(error)}`
        }
      }
    } catch (error) {
      return `tool failed: ${messageOf(error)}`
    }
  }

  /**
   * Registers this session's role tools into its own scope (spec 4 section 4.1). Shape copied from
   * DS Bot's shareBotTools (bot/src/host/tools.ts:793-826). Properties of `agent` relied on:
   *   agent.session.id                 the session id (tools.js:795)
   *   agent.ctx.tools.register(def)    registers one tool into this agent's own scope and returns a
   *                                    function that removes it again (tools.js:823-826)
   * The registered definition has DS Bot's tool shape: name, description, parameters, output,
   * execute(args, exec) (tools.js:75). The session id is fixed at attach time, so `exec` is not used.
   * Returns the names registered.
   */
  function attachRoleTools(agent) {
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return []
    const bound = lookup(sessionId)
    if (!bound) return []
    const defs = toolsFor(bound.role)
    if (defs.length === 0) return []
    const held = attached.get(sessionId)
    // The same agent asking again changes nothing; a fresh agent for the same session starts over.
    if (held?.agent === agent && held.role === bound.role) return held.names
    if (held) detachRoleTools(sessionId)
    if (typeof agent.ctx?.tools?.register !== 'function') {
      warn('chat-to-fix: %s needs its role tools but its Agent cannot register them yet', sessionId)
      return []
    }
    const retries = config?.limits?.toolRetries ?? 2
    const budgetMs = ((config?.limits?.toolTimeoutSeconds ?? 30) * (retries + 1) + 5) * 1000
    const disposers = []
    const names = []
    for (const def of defs) {
      try {
        const dispose = agent.ctx.tools.register(defineTool({
          name: def.name,
          description: def.description,
          parameters: def.parameters,
          output: OUTPUT,
          // Above the wrapper's own limits, so DSH never cuts a call the wrapper still waits for.
          timeoutMs: budgetMs,
          execute: async (args) => call(def.name, sessionId, args),
        }))
        if (typeof dispose === 'function') disposers.push(dispose)
        names.push(def.name)
      } catch (error) {
        warn('chat-to-fix: cannot register tool %s for %s: %s', def.name, sessionId, error?.message ?? error)
      }
    }
    attached.set(sessionId, { agent, role: bound.role, names, disposers })
    return names
  }

  /** Removes a session's role tools again (the session ended or moved to another agent). */
  function detachRoleTools(sessionId) {
    const held = attached.get(sessionId)
    attached.delete(sessionId)
    for (const dispose of held?.disposers ?? []) {
      try { dispose() } catch (error) { warn('chat-to-fix: cannot remove a tool of %s: %s', sessionId, error?.message ?? error) }
    }
  }

  /**
   * Startup check (spec 4 section 6, C0): every tool a registry entry lists has a definition, and
   * a definition's roles agree with the registry (a role has a tool exactly when the registry lists
   * it for that role; tools for `all` are not listed in the registry). Returns a list of problems.
   */
  function validate(defs = allBotDefs()) {
    const problems = []
    for (const bot of defs) {
      for (const name of toolsOfRole(bot.role, defs)) {
        const def = tools.get(name)
        if (!def) problems.push(`bot "${bot.role}": tool ${name} has no definition`)
        else if (!appliesTo(def, bot.role)) problems.push(`bot "${bot.role}": the registry lists ${name} but the tool's roles do not include it`)
      }
    }
    for (const def of tools.values()) {
      if (def.roles === 'all') continue
      for (const role of def.roles) {
        const bot = defs.find((candidate) => candidate.role === role)
        if (!bot) problems.push(`tool ${def.name}: unknown role ${role}`)
        else if (!bot.tools.includes(def.name)) problems.push(`tool ${def.name}: role ${role} does not list it in the registry`)
      }
    }
    return problems
  }

  return { defineRoleTool, attachRoleTools, detachRoleTools, bridgedToolNames, toolsFor, call, validate }
}
