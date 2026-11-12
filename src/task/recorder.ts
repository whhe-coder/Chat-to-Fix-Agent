// The recorder (work package B6, spec 2 sections 2.4, 3.2 and 4.2).
// It turns the bot layer's events into execution-record entries and, when a bot that is in
// charge of the current step ends a round, keeps that round's answer as the step result.
// Origins in DS Bot: appendRoom/onRoomLine (DSB:src/host/groups.js:238-256), session events
// (DSB:src/host/turns.js:627), tool results (DSB:src/host/turns.js:1096).
//
// Approval events are not recorded here: the monitor rejects the approval and writes the one
// `approval` entry itself (spec 3, 4.5), so subscribing would write it twice.
import { stepDef } from '../flow/steps.ts'

const argsText = (value) => {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? {}) } catch { return String(value) }
}

/**
 * @param {{ store: import('./contracts.ts').TaskStore, botlayer: import('./contracts.ts').BotLayer, warn?: (...args: any[]) => void }} deps
 * @returns {{ start: () => void, stop: () => void, flush: () => Promise<void> }}
 *   `flush()` resolves when every event received so far has been written (used by tests).
 */
export function createRecorder({ store, botlayer, warn = (...args) => console.warn(...args) }) {
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

  async function onSessionEvent(e) {
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

  const handlers = { onGroupLine, onSessionEvent, onToolResult, onRoundEnd }

  function start() {
    if (off.length > 0) return
    for (const [name, handler] of Object.entries(handlers)) off.push(botlayer[name]((e) => later(() => handler(e))))
  }

  function stop() {
    for (const unsubscribe of off) unsubscribe()
    off = []
  }

  return { start, stop, flush: () => chain }
}
