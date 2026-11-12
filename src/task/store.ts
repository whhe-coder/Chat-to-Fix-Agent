// Task store (I2): tasks, runs and the execution record on the file system.
// Spec: spec-2-state-and-storage.md, sections 2, 3.1, 4.1, 4.3, 4.5, 4.6.
//
// <dataDir>/index.json                 nextNo, events, threads
// <dataDir>/tasks/T-<n>/task.json      the task
// <dataDir>/tasks/T-<n>/records.jsonl  the execution record (append-only)
import { readFileSync } from 'node:fs'
import { appendFile, copyFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TASK_STATES } from './contracts.ts'
import { addUsage, blankUsage } from './usage.ts'

const TEXT_MAX = 2000
const ID_PATTERN = /^T-[1-9]\d*$/

// End reasons that fix the task state (spec 2, 2.5). Any other end reason is the Main bot's
// explanation text or a monitor/runner reason, and always ends in `failed`, except the
// timeout and queue reasons below.
const STATE_OF_REASON = Object.freeze({
  completed: 'done',
  needs_info: 'needs_info',
  needs_person: 'failed',
  step_timeout: 'failed',
  stalled: 'failed',
  idle_relay: 'failed',
  engine_silent: 'failed',
  start_failed: 'failed',
  restart: 'failed',
  task_timeout: 'timed_out',
  coding_timeout: 'timed_out',
  store_corrupt: 'failed',
  stopped: 'stopped',
  queue_expired: 'expired',
})
const ENDED_STATES = TASK_STATES.filter(state => state !== 'queued' && state !== 'running')

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

// Merge by field: plain objects merge deeply; arrays, scalars and null replace. `undefined`
// in a patch means "no change".
function merge(target, patch) {
  if (!isPlainObject(patch)) return clone(patch)
  const out = isPlainObject(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : clone(value)
  }
  return out
}

// A task with every field present; a field with no value is null, not omitted (spec 2, 2.3).
function blankTask(id, no, now) {
  return {
    id,
    no,
    state: 'queued',
    endReason: null,
    createdAt: now,
    updatedAt: now,
    origin: null,
    binding: null,
    queuedAt: now,
    step: null,
    stepAt: null,
    stepResults: {},
    slack: { readAt: null, sent: { ack: false, question: false, result: false } },
    jira: { key: null, url: null, commentedMr: false, status: null },
    repo: { dir: null, branch: null, base: null },
    review: null,
    mr: null,
    needsInfo: { main: null, coding: null },
    runs: [],
    usage: blankUsage(),
  }
}

const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * @param {{ dataDir: string, now?: () => string, warn?: (...args: any[]) => void }} options
 * @returns {import('./contracts.ts').TaskStore}
 */
export function createStore({ dataDir, now = stamp, warn = (...args) => console.warn(...args) }) {
  const indexPath = join(dataDir, 'index.json')
  const tasksDir = join(dataDir, 'tasks')
  const taskDir = id => join(tasksDir, id)
  const taskPath = id => join(tasksDir, id, 'task.json')
  const recordsPath = id => join(tasksDir, id, 'records.jsonl')

  // The index lives in memory so knownEvent can answer at once; it is read when the store
  // opens and nothing is written then (spec 2, 4.6).
  const index = loadIndex()
  function loadIndex() {
    let text
    try {
      text = readFileSync(indexPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { nextNo: 1, events: {}, threads: {} }
      throw error
    }
    const parsed = JSON.parse(text)
    return { nextNo: parsed.nextNo ?? 1, events: parsed.events ?? {}, threads: parsed.threads ?? {} }
  }

  // Based on the state save in bot/src/host/store.ts: write to a temporary file, then rename
  // it over the target, and queue writes so each one builds on the one before. Here the queue
  // is kept per task (key = task id) plus one for index.json.
  let tempCount = 0
  const queues = new Map()
  function enqueue(key, job) {
    const run = (queues.get(key) ?? Promise.resolve()).then(job)
    const tail = run.catch(() => {})
    queues.set(key, tail)
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
    return run
  }

  async function writeJson(path, value) {
    const temp = `${path}.${process.pid}.${tempCount++}.tmp`
    try {
      await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
      await rename(temp, path)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }

  const writeIndex = () => writeJson(indexPath, index)

  // A task.json that cannot be parsed: the bad file is kept as task.json.broken-<time>, and
  // only this task is replaced by a failed task with end reason `store_corrupt` (spec 2, 4.5).
  async function recoverCorrupt(id, error) {
    const at = now()
    const no = Number(id.slice(2))
    warn('chat-to-fix: task %s is unreadable (%s); marked failed', id, error?.message ?? error)
    await copyFile(taskPath(id), `${taskPath(id)}.broken-${Date.now()}`).catch(() => {})
    const task = { ...blankTask(id, no, at), state: 'failed', endReason: 'store_corrupt' }
    await writeJson(taskPath(id), task)
    return task
  }

  // Reads one task. Returns { task, recovered }; task is undefined when there is no such task.
  async function load(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { task: undefined, recovered: false }
    let text
    try {
      text = await readFile(taskPath(id), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { task: undefined, recovered: false }
      throw error
    }
    try {
      const task = JSON.parse(text)
      if (!isPlainObject(task)) throw new Error('task.json is not an object')
      return { task, recovered: false }
    } catch (error) {
      return { task: await recoverCorrupt(id, error), recovered: true }
    }
  }

  // Read, change, write, all inside the task's queue. `change` returns the new task. A task
  // that was just found corrupt is returned as the failed task and `change` is not applied.
  function update(id, change) {
    return enqueue(id, async () => {
      const { task, recovered } = await load(id)
      if (task === undefined) throw new Error(`No such task: ${id}`)
      if (recovered) return task
      const next = change(task)
      next.updatedAt = now()
      await writeJson(taskPath(id), next)
      return next
    })
  }

  const threadKey = (channel, threadTs) => `${channel}:${threadTs}`

  function knownEvent(eventId) {
    return Object.hasOwn(index.events, eventId) ? index.events[eventId] : undefined
  }

  // Assigns the number and writes the task and both mappings. The index queue makes two
  // creates get two numbers. A discussion that already has a task is simply pointed at the
  // new one; whether a new task may be made is the listener's decision (spec 2, 4.3).
  function createTask(origin, binding) {
    return enqueue('index', async () => {
      const no = index.nextNo
      const id = `T-${no}`
      const at = now()
      const task = { ...blankTask(id, no, at), origin: clone(origin ?? null), binding: clone(binding ?? null) }
      await mkdir(taskDir(id), { recursive: true })
      await writeJson(taskPath(id), task)
      const before = { nextNo: index.nextNo, events: { ...index.events }, threads: { ...index.threads } }
      index.nextNo = no + 1
      if (origin?.eventId) index.events[origin.eventId] = id
      const threadTs = origin?.threadTs ?? origin?.messageTs
      if (origin?.channel && threadTs) index.threads[threadKey(origin.channel, threadTs)] = id
      try {
        await writeIndex()
      } catch (error) {
        Object.assign(index, before)
        throw error
      }
      return clone(task)
    })
  }

  async function getTask(id) {
    // Wait for writes already queued, so a read after an awaited write is never older.
    await (queues.get(id) ?? Promise.resolve())
    return (await load(id)).task
  }

  async function findByThread(channel, threadTs) {
    const key = threadKey(channel, threadTs)
    if (!Object.hasOwn(index.threads, key)) return undefined
    return getTask(index.threads[key])
  }

  function patchTask(id, patch) {
    // `id` and `no` never change.
    const { id: _id, no: _no, ...rest } = patch ?? {}
    return update(id, task => merge(task, rest))
  }

  // A new run: step back to fetch; needsInfo, review and stepResults cleared; jira, repo, mr
  // and slack.sent.ack kept (spec 1, 4.5). slack.readAt and the question/result flags are
  // cleared too, since the discussion is read again and the new run asks and reports afresh.
  function startRun(id, { groupId, bots }) {
    return update(id, (task) => {
      const at = now()
      const run = { no: (task.runs?.length ?? 0) + 1, groupId: groupId ?? null, bots: clone(bots ?? {}), startedAt: at, endedAt: null, endReason: null }
      return {
        ...task,
        state: 'running',
        endReason: null,
        step: 'fetch',
        stepAt: at,
        stepResults: {},
        review: null,
        needsInfo: { main: null, coding: null },
        slack: { readAt: null, sent: { ack: task.slack?.sent?.ack ?? false, question: false, result: false } },
        runs: [...(task.runs ?? []), run],
      }
    })
  }

  // The state follows the end reason as in spec 2, 2.5. A reason with a fixed state must be
  // given with that state; any other text (the Main bot's explanation) is only for `failed`.
  async function endRun(id, state, endReason) {
    const fixed = Object.hasOwn(STATE_OF_REASON, endReason) ? STATE_OF_REASON[endReason] : undefined
    const finalState = state ?? fixed ?? 'failed'
    if (!ENDED_STATES.includes(finalState)) throw new Error(`Not an end state: ${finalState}`)
    if (fixed !== undefined && fixed !== finalState) throw new Error(`End reason ${endReason} belongs to state ${fixed}, not ${finalState}`)
    if (fixed === undefined && finalState !== 'failed') throw new Error(`End reason "${endReason}" is only for state failed, not ${finalState}`)
    return update(id, (task) => {
      const at = now()
      const runs = clone(task.runs ?? [])
      const open = runs.findLast(run => run.endedAt === null)
      if (open !== undefined) {
        open.endedAt = at
        open.endReason = endReason
      }
      return { ...task, state: finalState, endReason, runs }
    })
  }

  // Adds one usage record to the running summary of the task (task.usage, src/task/usage.ts). It runs
  // inside the task's queue, so two records arriving together both count. A task that is gone is
  // logged and skipped: billing must never stop a task.
  async function addUsageRecord(id, record) {
    try {
      return await update(id, task => ({ ...task, usage: addUsage(task.usage, record) }))
    } catch (error) {
      warn('chat-to-fix: cannot add usage to %s: %s', id, error?.message ?? error)
      return undefined
    }
  }

  // Appends one line. A failure is logged and swallowed: the task goes on (spec 2, 4.5).
  async function appendRecord(id, entry) {
    try {
      if (typeof id !== 'string' || !ID_PATTERN.test(id) || Number(id.slice(2)) >= index.nextNo) throw new Error(`No such task: ${id}`)
      const line = { at: now(), taskId: id, run: null, step: null, role: null, botId: null, ...entry }
      if (typeof line.text === 'string' && line.text.length > TEXT_MAX) line.text = line.text.slice(0, TEXT_MAX)
      await enqueue(id, async () => {
        await mkdir(taskDir(id), { recursive: true })
        await appendFile(recordsPath(id), `${JSON.stringify(line)}\n`, 'utf8')
      })
    } catch (error) {
      warn('chat-to-fix: cannot append a record to %s: %s', id, error?.message ?? error)
    }
  }

  async function readRecords(id, { step }: any = {}) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return []
    await (queues.get(id) ?? Promise.resolve())
    let text
    try {
      text = await readFile(recordsPath(id), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const entries = []
    for (const line of text.split('\n')) {
      if (line === '') continue
      try {
        entries.push(JSON.parse(line))
      } catch {
        warn('chat-to-fix: skipped an unreadable line in the record of %s', id)
      }
    }
    return step === undefined ? entries : entries.filter(entry => entry.step === step)
  }

  async function listTasks({ state }: any = {}) {
    let names
    try {
      names = await readdir(tasksDir)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const tasks = []
    for (const name of names.filter(entry => ID_PATTERN.test(entry))) {
      const task = await getTask(name)
      if (task !== undefined && (state === undefined || task.state === state)) tasks.push(task)
    }
    return tasks.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.no - b.no))
  }

  return { knownEvent, createTask, getTask, findByThread, patchTask, startRun, endRun, appendRecord, addUsage: addUsageRecord, readRecords, listTasks }
}
