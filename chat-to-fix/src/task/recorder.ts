// The recorder (work package B6, spec 2 sections 2.4, 3.2 and 4.2).
// It turns the bot layer's events into execution-record entries and, when a bot that is in
// charge of the current step ends a round, keeps that round's answer as the step result.
// Origins in DS Bot: appendRoom/onRoomLine (DSB:src/host/groups.js:238-256), session events
// (DSB:src/host/turns.js:627), tool results (DSB:src/host/turns.js:1096).
//
// Approval events are not recorded here: the monitor rejects the approval and writes the one
// `approval` entry itself (spec 3, 4.5), so subscribing would write it twice.
import { stepDef } from '../flow/steps.ts'
import { costOf, priceTable } from './pricing.ts'
import { fmtTokens, fmtTps, fmtUsd } from './usage.ts'

const argsText = (value) => {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? {}) } catch { return String(value) }
}

/**
 * @param {{ store: import('./contracts.ts').TaskStore, botlayer: import('./contracts.ts').BotLayer, pricing?: object, warn?: (...args: any[]) => void }} deps
 *   `pricing`: the configuration's `pricing` rows over the default price table (src/task/pricing.ts).
 * @returns {{ start: () => void, stop: () => void, flush: () => Promise<void> }}
 *   `flush()` resolves when every event received so far has been written (used by tests).
 */
export function createRecorder({ store, botlayer, pricing = undefined, warn = (...args) => console.warn(...args) }) {
  const prices = priceTable(pricing)
  let off = []
  // Events are handled one after the other, so the entries of one task keep the order of the events.
  let chain = Promise.resolve()
  const groupTask = new Map() // groupId -> taskId; a group belongs to one task for good

  const later = (job) => {
    chain = chain.then(job).catch((error) => warn('chat-to-fix: recorder failed: %s', error?.message ?? error))
  }

  // The task a group belongs to, through the current run of the running tasks.
  async function taskOfGroup(groupId) {
    if (typeof groupId !== 'string') return undefined
    if (!groupTask.has(groupId)) {
      for (const task of await store.listTasks({ state: 'running' })) {
        const run = task.runs?.at(-1)
        if (run?.groupId) groupTask.set(run.groupId, task.id)
      }
    }
    const id = groupTask.get(groupId)
    return id === undefined ? undefined : store.getTask(id)
  }

  const runOf = (task, groupId?) => {
    const index = groupId === undefined ? -1 : task.runs?.findIndex((run) => run.groupId === groupId)
    return index >= 0 ? index + 1 : (task.runs?.length ?? null)
  }

  async function append(task, run, role, botId, entry) {
    await store.appendRecord(task.id, { run, step: task.step ?? null, role: role ?? null, botId: botId ?? null, ...entry })
  }

  async function onGroupLine(e) {
    const task = await taskOfGroup(e.groupId)
    if (task === undefined) return
    const run = runOf(task, e.groupId)
    const roles = task.runs?.[run - 1]?.bots ?? {}
    const role = Object.keys(roles).find((name) => roles[name] === e.botId)
    await append(task, run, role, e.botId, { at: e.at, type: e.kind === 'notice' ? 'notice' : 'line', text: e.text })
  }

  // Finds task and role of a session; undefined when the session belongs to no task.
  async function ofSession(sessionId) {
    const bot = botlayer.botOfSession(sessionId)
    if (bot === undefined) return undefined
    const task = await store.getTask(bot.taskId)
    return task === undefined ? undefined : { task, bot }
  }

  // The Coding bot's own tool uses happen inside Claude Code, not as DSH tool calls. The adapter
  // (bot/src/host/local-agents/adapter.ts) writes a refused or failed one as a reasoning line
  // starting with "▸ denied:", "▸ permission request for … timed out" or "▸ tool error:"; those
  // lines become entries so a refused test command is visible in the records.
  const ENGINE_LINE = /^\s*▸ (denied:|permission request for .* timed out|tool error:)/
  async function onEngineLines(e) {
    const blocks = e.event?.data?.message?.content
    if (!Array.isArray(blocks)) return
    const lines = []
    for (const block of blocks) {
      if (block === null || typeof block !== 'object' || block.type === 'text') continue
      const text = [block.text, block.thinking, block.reasoning].find((v) => typeof v === 'string')
      if (text === undefined) continue
      for (const line of text.split('\n')) if (ENGINE_LINE.test(line)) lines.push(line.trim())
    }
    if (lines.length === 0) return
    const found = await ofSession(e.sessionId)
    if (found === undefined) return
    const { task, bot } = found
    for (const line of lines) {
      await append(task, runOf(task), bot.role, bot.botId, { at: e.at, type: line.startsWith('▸ tool error:') ? 'tool_error' : 'refusal', text: line })
    }
  }

  async function onSessionEvent(e) {
    if (e.type === 'assistant/message') return onEngineLines(e)
    if (e.type !== 'tool/call') return // only tool calls become entries
    const found = await ofSession(e.sessionId)
    if (found === undefined) return
    const { task, bot } = found
    const data = e.event?.data ?? e.event ?? {}
    await append(task, runOf(task), bot.role, bot.botId, { at: e.at, type: 'tool_call', tool: String(data.name ?? ''), text: `${data.name ?? ''} ${argsText(data.arguments ?? data.args)}`.trim() })
  }

  async function onToolResult(e) {
    const found = await ofSession(e.sessionId)
    if (found === undefined) return
    const { task, bot } = found
    await append(task, runOf(task), bot.role, bot.botId, { at: e.at, type: 'tool_result', tool: e.tool, ok: e.ok, ms: e.ms, text: e.text })
  }

  async function onRoundEnd(e) {
    const found = await ofSession(e.sessionId)
    if (found === undefined) return
    const { task, bot } = found
    await append(task, runOf(task, e.groupId ?? undefined), bot.role, bot.botId, { at: e.at, type: 'round_end', text: e.text, ...(e.failed ? { failed: true } : {}) })
    // spec 2, 4.2: only a role in charge of the current step keeps its answer as the step result.
    // A failed or empty round is not a result: it would pass the step's evidence without one.
    const step = stepDef(task.step)
    if (!step?.roles.includes(bot.role) || e.failed || typeof e.text !== 'string' || e.text.trim() === '') return
    await store.patchTask(task.id, { stepResults: { [task.step]: { [bot.role]: { text: e.text, at: e.at } } } })
  }

  // One usage record per model call (API bots) or per model of a CLI turn (Coding bot), and the same record
  // added to the task's running summary. The cost of an API call is computed from the price table; the CLI's
  // own cost wins for the Coding bot. A model with no price gets costUsd null and unpriced true (never a guess).
  // Fields: see src/task/usage.ts.
  async function onUsage(e) {
    const found = await ofSession(e.sessionId)
    if (found === undefined) return
    const { task, bot } = found
    const tokens = { input: e.input ?? 0, output: e.output ?? 0, cacheRead: e.cacheRead ?? 0, cacheWrite: e.cacheWrite ?? 0 }
    const cli = typeof e.costUsd === 'number' && Number.isFinite(e.costUsd)
    const costUsd = cli ? e.costUsd : costOf(e.model, tokens, prices)
    const record = {
      at: e.at, type: 'usage', model: e.model ?? 'unknown', ...(e.effort === undefined ? {} : { effort: e.effort }), ...tokens,
      costUsd, costSource: cli ? 'cli' : costUsd === null ? null : 'table', unpriced: costUsd === null,
      source: e.source, durationMs: e.durationMs ?? 0, ...(e.tpsTokens === undefined ? {} : { tpsTokens: e.tpsTokens }), ...(e.ttftMs === undefined ? {} : { ttftMs: e.ttftMs }),
      outputTps: e.outputTps ?? null, tpsBasis: e.tpsBasis ?? null, ...(e.failed ? { failed: true } : {}),
      text: `usage ${e.model ?? 'unknown'}: in ${fmtTokens(tokens.input)}, out ${fmtTokens(tokens.output)}, cache read ${fmtTokens(tokens.cacheRead)}, cache write ${fmtTokens(tokens.cacheWrite)}, ${costUsd === null ? 'unpriced' : fmtUsd(costUsd)}${e.outputTps ? `, ${fmtTps(e.outputTps)}` : ''}${e.failed ? ' (failed call)' : ''}`,
    }
    const run = runOf(task, undefined)
    await append(task, run, bot.role, bot.botId, record)
    await store.addUsage(task.id, { ...record, role: bot.role, botId: bot.botId, run })
  }

  const handlers = { onGroupLine, onSessionEvent, onToolResult, onRoundEnd, onUsage }

  function start() {
    if (off.length > 0) return
    for (const [name, handler] of Object.entries(handlers)) {
      if (typeof botlayer[name] === 'function') off.push(botlayer[name]((e) => later(() => handler(e))))
    }
  }

  function stop() {
    for (const unsubscribe of off) unsubscribe()
    off = []
  }

  return { start, stop, flush: () => chain }
}
