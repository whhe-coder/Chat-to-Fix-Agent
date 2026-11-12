// A read-only full-screen terminal view of a running task, for watching the first real run.
//
//   node scripts/watch.ts [T-1] [--dir <first-run folder>] [--url <url> --token-file <path>] [--interval <seconds>]
//
// Where it connects: --dir (the folder scripts/first-run.ts prepared: http-token and chat-to-fix.json),
// or --url with --token-file (or CHAT_TO_FIX_URL and CHAT_TO_FIX_HTTP_TOKEN), as scripts/show-task.ts.
// It only sends GET requests to the control interface (GET /tasks, GET /tasks/:id?records=1) every 2 s.
// The token is read from the file, goes only into the request header, and is never printed.
//
// Screen: header (task, state, channel/repo, Jira, MR, elapsed), the seven steps, the five bots, then
// the newest execution records. Keys: q quit, up/down or k/j scroll, PageUp/PageDown, End or G back to
// the newest, Home or g oldest, t next task. Without a TTY it appends plain lines instead.
// Plain ANSI escape codes, Node built-ins only. The rendering is in exported pure functions.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connection } from './show-task.ts'
import { ROLES, STEP_IDS } from '../src/task/contracts.ts'
import { STEPS } from '../src/flow/steps.ts'

const END_STATES = ['done', 'failed', 'stopped', 'timed_out', 'needs_info', 'expired']
export const HEAD_ROWS = 7

export const STEP_LABELS = Object.freeze({ fetch: '取讨论', issue: '建工单', prepare: '准备代码', code: '写代码', mr: '开 MR', writeback: '回写', close: '结束' })
export const ROLE_LABELS = Object.freeze({ main: '主控', slack: 'Slack', jira: 'Jira', pipeline: '流水线', coding: '写代码' })
export const STATE_LABELS = Object.freeze({ queued: '排队中', running: '运行中', done: '已完成', needs_info: '需要补充信息', failed: '失败', timed_out: '超时', stopped: '已停止', expired: '已过期' })
const ROLE_STYLE = Object.freeze({ main: 'magenta', slack: 'cyan', jira: 'blue', pipeline: 'yellow', coding: 'green' })
const STATE_STYLE = Object.freeze({ queued: 'yellow', running: 'cyan', done: 'green', needs_info: 'yellow', failed: 'red', timed_out: 'red', stopped: 'yellow', expired: 'yellow' })

// ---------------------------------------------------------------- text helpers

const CODES = { bold: '1', dim: '2', inverse: '7', red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36', banner: '1;97;41' }
const paint = (style, text) => (CODES[style] === undefined ? text : `\x1b[${CODES[style]}m${text}\x1b[0m`)
export const stripAnsi = (text) => String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/** Display width of one code point: 2 for East Asian wide characters and emoji, 0 for combining marks. */
export function charWidth(cp) {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2
  return 1
}

export function textWidth(text) {
  let w = 0
  for (const ch of String(text)) w += charWidth(ch.codePointAt(0))
  return w
}

/** The text cut to at most `width` columns, ending in an ellipsis when something was cut. */
export function clipWidth(text, width) {
  text = String(text)
  if (width <= 0) return ''
  if (textWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0))
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

export const padWidth = (text, width) => text + ' '.repeat(Math.max(0, width - textWidth(text)))

/** Parts are [style, text] pairs; the result is one line of at most `width` columns. */
export function fitParts(parts, width, color = false) {
  let used = 0
  let out = ''
  for (const [style, text] of parts) {
    if (used >= width) break
    const piece = clipWidth(text, width - used)
    if (piece === '') continue
    used += textWidth(piece)
    out += color && style ? paint(style, piece) : piece
  }
  return out
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m${String(s % 60).padStart(2, '0')}s`
}

const pad2 = (n) => String(n).padStart(2, '0')
/** HH:MM:SS in local time; dashes when the value is not a time. */
export function clock(at) {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '--:--:--' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

// ---------------------------------------------------------------- task data

const idNumber = (id) => Number(String(id).replace(/^\D+/, '')) || 0

/** Tasks newest first. */
export const newestFirst = (tasks) => [...(tasks ?? [])].sort((a, b) => idNumber(b.id) - idNumber(a.id))

/** The wanted task when it exists, else the newest running one, else the newest. */
export function pickTask(tasks, wantedId) {
  const sorted = newestFirst(tasks)
  if (wantedId != null) return sorted.find((t) => t.id === wantedId)
  return sorted.find((t) => t.state === 'running') ?? sorted[0]
}

/** Elapsed time of a task: since the current run started (or since creation while it waits). */
export function elapsedMs(task, now = Date.now()) {
  if (task === undefined) return NaN
  const run = task.runs?.at(-1)
  const start = Date.parse(run?.startedAt ?? task.queuedAt ?? task.createdAt)
  if (task.state === 'queued') return now - Date.parse(task.queuedAt ?? task.createdAt)
  if (task.state === 'running') return now - start
  const end = Date.parse(run?.endedAt ?? task.updatedAt)
  return end - start
}

/** The seven steps with a mark: done, current, failed (the task ended on this step), pending. */
export function stepStates(task) {
  const current = STEP_IDS.indexOf(task?.step)
  return STEP_IDS.map((id, index) => {
    let mark = 'pending'
    if (task?.state === 'done') mark = 'done'
    else if (current >= 0 && index < current) mark = 'done'
    else if (current >= 0 && index === current) mark = task.state === 'running' || task.state === 'queued' ? 'current' : 'failed'
    return { id, label: STEP_LABELS[id] ?? id, mark }
  })
}

/** The five bots with working / idle. Only a running task has working bots. */
export function botStates(task, records = []) {
  const stepRoles = STEPS.find((s) => s.id === task?.step)?.roles ?? []
  const stepAt = Date.parse(task?.stepAt)
  const runNo = task?.runs?.length
  return ROLES.map((role) => {
    const label = ROLE_LABELS[role] ?? role
    if (task?.state !== 'running') return { role, label, state: 'off' }
    const last = records.findLast((r) => r?.role === role && (r.run == null || runNo == null || r.run === runNo))
    let working = last !== undefined && last.type !== 'round_end'
    // A role in charge of the step that began after its last answer is about to work.
    if (!working && stepRoles.includes(role)) working = last === undefined || !(Date.parse(last.at) >= stepAt)
    return { role, label, state: working ? 'working' : 'idle' }
  })
}

// ---------------------------------------------------------------- records

/** One record as styled parts: [style, text] pairs, a short tag first. Unknown types render generically. */
export function recordParts(record) {
  if (record === null || typeof record !== 'object') return [[null, oneLine(record)]]
  const text = oneLine(record.text)
  const type = String(record.type ?? 'unknown')
  const ms = typeof record.ms === 'number' ? ` ${record.ms}ms` : ''
  switch (type) {
    case 'line': return [[null, text]]
    case 'notice': return [['yellow', '[notice]'], [null, ` ${text}`]]
    case 'tool_call': {
      const name = oneLine(record.tool) || text.split(' ')[0]
      const args = text.startsWith(name) ? text.slice(name.length).trim() : text
      return [['cyan', '[call]'], ['bold', ` ${name}`], ['dim', args === '' ? '' : ` ${args}`]]
    }
    case 'tool_result': {
      const failed = record.ok === false
      return [[failed ? 'red' : 'green', failed ? `[FAILED${ms}]` : `[ok${ms}]`], ['bold', ` ${oneLine(record.tool)}`], ['dim', text === '' ? '' : ` ${text}`]]
    }
    case 'round_end': return record.failed ? [['red', '[round FAILED]'], [null, ` ${text}`]] : [['dim', '[round end]'], [null, ` ${text}`]]
    case 'advance': return [['green', '[advance]'], [null, ` ${text}`]]
    case 'refused': return [['yellow', '[refused]'], [null, ` ${text}`]]
    case 'limit': return [['red', '[limit]'], [null, ` ${text}`]]
    case 'approval': return [['yellow', '[approval]'], [null, ` ${text}`]]
    case 'system': return [['dim', '[system]'], [null, ` ${text}`]]
    default: {
      // Unknown type: the text when there is one, else the other fields as JSON.
      const { at, taskId, run, step, role, botId, type: _type, ...rest } = record
      const body = text !== '' ? text : (Object.keys(rest).length > 0 ? oneLine(safeJson(rest)) : '')
      return [['dim', `[${type}]`], [null, body === '' ? '' : ` ${body}`]]
    }
  }
}

const safeJson = (value) => { try { return JSON.stringify(value) } catch { return String(value) } }

export const recordPlain = (record) => recordParts(record).map(([, t]) => t).join('')

/** One record as one line of parts: time, role (coloured), then the content. */
export function recordLineParts(record) {
  const role = record?.role == null ? '-' : String(record.role)
  return [['dim', `${clock(record?.at)} `], [ROLE_STYLE[role] ?? 'dim', padWidth(role, 8)], [null, ' '], ...recordParts(record)]
}

/** One record as plain text for the non-TTY output. */
export const recordLinePlain = (record) => recordLineParts(record).map(([, t]) => t).join('')

// ---------------------------------------------------------------- layout

export const scrollLimit = (count, height, hasBanner = false) => Math.max(0, count - bodyHeight(height, hasBanner))
export const bodyHeight = (height, hasBanner = false) => Math.max(0, height - 1 - HEAD_ROWS - (hasBanner ? 1 : 0))

/**
 * The whole screen as exactly `height` lines of at most `width` columns.
 * data: { tasks, task, records, error }; view: { scroll, now, color }.
 */
export function layout({ width, height, tasks = [], task = undefined, records = [], error = null, scroll = 0, now = Date.now(), color = false }: any) {
  const fit = (parts) => fitParts(parts, width, color)
  const head = []
  if (error) head.push(fitParts([['banner', padWidth(` ! ${oneLine(error)} `, width)]], width, color))

  const state = task?.state
  if (task === undefined) {
    head.push(fit([['bold', ' Chat-to-Fix 监控 '], ['dim', ' 还没有任务，等第一个 @']]))
    head.push(fit([]), fit([]))
  } else {
    head.push(fit([['bold', ` ${task.id} `], [STATE_STYLE[state] ?? null, ` ${STATE_LABELS[state] ?? state}${task.endReason && state !== 'done' ? ` (${oneLine(task.endReason)})` : ''} `], ['dim', ` 经过 ${formatDuration(elapsedMs(task, now))}${task.runs?.length > 1 ? `  第 ${task.runs.length} 次运行` : ''}`]]))
    head.push(fit([['dim', ' 频道 '], [null, task.binding?.channel ?? '-'], ['dim', '  仓库 '], [null, task.binding?.repo ?? '-'], ['dim', '  分支 '], [null, task.repo?.branch ?? '-']]))
    head.push(fit([['dim', ' Jira '], [null, task.jira?.key ?? '-'], ['dim', task.jira?.url ? ` ${task.jira.url}` : ''], ['dim', '  MR '], [null, task.mr?.url ?? '-']]))
  }

  const steps = stepStates(task)
  const stepParts = [[null, ' ']]
  steps.forEach((s, i) => {
    if (i > 0) stepParts.push(['dim', ' -> '])
    const mark = { done: '[x]', current: '[>]', failed: '[!]', pending: '[ ]' }[s.mark]
    const style = { done: 'green', current: 'bold', failed: 'red', pending: 'dim' }[s.mark]
    stepParts.push([style, `${mark}${s.label}`])
  })
  head.push(fit(stepParts))

  const botParts = [['dim', ' 机器人 ']]
  botStates(task, records).forEach((b, i) => {
    if (i > 0) botParts.push([null, '  '])
    botParts.push([ROLE_STYLE[b.role] ?? null, b.label])
    botParts.push([b.state === 'working' ? 'green' : 'dim', b.state === 'working' ? ' 工作中' : b.state === 'idle' ? ' 空闲' : ' -'])
  })
  head.push(fit(botParts))

  const taskParts = [['dim', ' 任务 ']]
  newestFirst(tasks).slice(0, 12).forEach((t) => {
    const selected = t.id === task?.id
    taskParts.push([selected ? 'inverse' : (STATE_STYLE[t.state] ?? null), selected ? `[${t.id} ${STATE_LABELS[t.state] ?? t.state}]` : `${t.id} ${STATE_LABELS[t.state] ?? t.state}`])
    taskParts.push([null, ' '])
  })
  if ((tasks ?? []).length === 0) taskParts.push(['dim', '-'])
  head.push(fit(taskParts))

  const limit = scrollLimit(records.length, height, Boolean(error))
  const offset = Math.min(Math.max(0, scroll), limit)
  const rows = bodyHeight(height, Boolean(error))
  const end = records.length - offset
  const visible = records.slice(Math.max(0, end - rows), end)

  const rule = `-- 执行记录 (${records.length}) `
  head.push(fit([['dim', rule + '-'.repeat(Math.max(0, width - textWidth(rule)))]]))
  const lines = head.slice(0, Math.max(0, height - 1))
  for (const record of visible) lines.push(fit(recordLineParts(record)))
  while (lines.length < height - 1) lines.push('')
  const keys = ' q 退出  ↑↓/jk 滚动  G 最新  t 换任务'
  const follow = offset === 0 ? '跟随最新' : `已暂停 (距最新 ${offset} 条)`
  lines.push(height > 0 ? fit([['dim', padWidth(keys, Math.max(0, width - textWidth(follow) - 1))], [offset === 0 ? 'green' : 'yellow', follow]]) : '')
  return lines.slice(0, Math.max(0, height))
}

// ---------------------------------------------------------------- keys

/** Key names from a chunk of raw terminal input. */
export function parseKeys(chunk) {
  const names = []
  const table = {
    '\x03': 'quit', q: 'quit', '\x1b[A': 'up', '\x1bOA': 'up', k: 'up', '\x1b[B': 'down', '\x1bOB': 'down', j: 'down',
    '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[F': 'end', '\x1bOF': 'end', '\x1b[4~': 'end', '\x1b[8~': 'end', G: 'end',
    '\x1b[H': 'home', '\x1bOH': 'home', '\x1b[1~': 'home', '\x1b[7~': 'home', g: 'home', t: 'cycle',
  }
  for (const key of String(chunk).match(/\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Z]|[\s\S]/g) ?? []) if (table[key] !== undefined) names.push(table[key])
  return names
}

/** ui: { pinned: task id or null (auto), scroll }. ctx: { page, limit, taskIds, currentId }. */
export function reduceKey(ui, key, ctx) {
  const scroll = (n) => ({ ...ui, scroll: Math.min(ctx.limit, Math.max(0, n)) })
  switch (key) {
    case 'up': return scroll(ui.scroll + 1)
    case 'down': return scroll(ui.scroll - 1)
    case 'pageup': return scroll(ui.scroll + ctx.page)
    case 'pagedown': return scroll(ui.scroll - ctx.page)
    case 'home': return scroll(ctx.limit)
    case 'end': return scroll(0)
    case 'cycle': {
      const ids = ctx.taskIds ?? []
      if (ids.length === 0) return ui
      const next = ids[(Math.max(0, ids.indexOf(ctx.currentId)) + 1) % ids.length]
      return { pinned: next, scroll: 0 }
    }
    default: return ui
  }
}

// ---------------------------------------------------------------- control interface

class ControlError extends Error {
  declare kind: string
  constructor(kind, message) { super(message); this.kind = kind }
}

async function getJson(conn, path, fetchImpl) {
  let response
  try {
    response = await fetchImpl(`${conn.url}${path}`, { method: 'GET', headers: { 'x-chat-to-fix-token': conn.token }, signal: AbortSignal.timeout(5000) })
  } catch (error) {
    // Only the error code is kept: the message of a failed fetch is not worth showing and must never carry a header.
    throw new ControlError('unreachable', `控制接口连不上 (${conn.url})${error?.cause?.code ? `：${error.cause.code}` : error?.name === 'TimeoutError' ? '：超时' : ''}`)
  }
  let body
  let parsed = true
  try { body = await response.json() } catch { body = {}; parsed = false }
  if (response.status === 401) throw new ControlError('unauthorized', '令牌不对 (HTTP 401)：检查 --dir 或 --token-file')
  if (response.status === 404) throw new ControlError('not_found', `没有这个任务 (${path.split('?')[0]})`)
  if (!response.ok) throw new ControlError('error', `控制接口返回 ${response.status}${typeof body.error === 'string' ? ` (${body.error})` : ''}`)
  if (!parsed) throw new ControlError('error', '控制接口返回的不是 JSON')
  return body
}

/**
 * Reads the list and the picked task with its records. Never throws:
 * { ok: true, tasks, task, records } or { ok: false, kind, message }.
 */
export async function fetchSnapshot({ conn, taskId = null, fetchImpl = globalThis.fetch }: any) {
  try {
    const { tasks } = await getJson(conn, '/tasks', fetchImpl)
    if (!Array.isArray(tasks)) throw new ControlError('error', '控制接口返回的任务列表不对')
    const list = newestFirst(tasks)
    const picked = pickTask(list, taskId)
    if (picked === undefined) {
      if (taskId != null) return { ok: false, kind: 'not_found', message: `没有这个任务：${taskId}`, tasks: list }
      return { ok: true, tasks: list, task: undefined, records: [] }
    }
    const { records, ...task } = await getJson(conn, `/tasks/${encodeURIComponent(picked.id)}?records=1`, fetchImpl)
    return { ok: true, tasks: list, task, records: Array.isArray(records) ? records : [] }
  } catch (error) {
    if (error instanceof ControlError) return { ok: false, kind: error.kind, message: error.message }
    return { ok: false, kind: 'error', message: `读取失败：${oneLine(error?.message).slice(0, 120)}` }
  }
}

// ---------------------------------------------------------------- non-TTY output

/**
 * Plain appended lines for the changes since `prev`. Returns { lines, prev, ended }.
 * prev: { taskId, state, step, seen, error }.
 */
export function plainStep(prev, snap) {
  const lines = []
  const next = { ...prev }
  if (!snap.ok) {
    if (prev.error !== snap.message) lines.push(`!! ${snap.message}`)
    next.error = snap.message
    return { lines, prev: next, ended: false }
  }
  if (prev.error !== null && prev.error !== undefined) lines.push('-- 控制接口恢复')
  next.error = null
  const task = snap.task
  if (task === undefined) {
    if (prev.taskId !== 'none') lines.push('还没有任务')
    next.taskId = 'none'
    return { lines, prev: next, ended: false }
  }
  if (task.id !== prev.taskId) { next.taskId = task.id; next.state = null; next.step = null; next.seen = 0 }
  if (task.state !== next.state || task.step !== next.step) {
    lines.push(`== ${task.id} ${STATE_LABELS[task.state] ?? task.state}${task.step ? ` 步骤 ${STEP_LABELS[task.step] ?? task.step}` : ''}${task.jira?.key ? `  Jira ${task.jira.key}` : ''}${task.mr?.url ? `  MR ${task.mr.url}` : ''}`)
    next.state = task.state
    next.step = task.step
  }
  for (const record of snap.records.slice(next.seen)) lines.push(recordLinePlain(record))
  next.seen = snap.records.length
  return { lines, prev: next, ended: END_STATES.includes(task.state) }
}

export async function runPlain({ conn, taskId = null, out = (line) => console.log(line), fetchImpl = globalThis.fetch, intervalMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: any) {
  let prev: any = { taskId: undefined, state: null, step: null, seen: 0, error: null }
  for (;;) {
    const snap = await fetchSnapshot({ conn, taskId, fetchImpl })
    const step = plainStep(prev, snap)
    for (const line of step.lines) out(line)
    prev = step.prev
    if (step.ended) return
    await sleep(intervalMs)
  }
}

// ---------------------------------------------------------------- the terminal UI

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l'
const LEAVE = '\x1b[?7h\x1b[?25h\x1b[?1049l'

/**
 * Runs the full-screen view until the user quits. Restores the terminal on q, Ctrl-C, signals and errors.
 * input and output are the terminal streams (injected by tests).
 */
export function runTui({ conn, taskId = null, input = process.stdin, output = process.stdout, fetchImpl = globalThis.fetch, intervalMs = 2000, now = () => Date.now() }: any) {
  return new Promise<void>((done) => {
    let ui = { pinned: taskId, scroll: 0 }
    let data: any = { tasks: [], task: undefined, records: [] }
    let error = null
    let closed = false
    let busy = false
    let again = false
    let timer

    const size = () => ({ width: Math.max(1, output.columns || 80), height: Math.max(1, output.rows || 24) })
    const render = () => {
      if (closed) return
      const { width, height } = size()
      const lines = layout({ width, height, tasks: data.tasks, task: data.task, records: data.records, error, scroll: ui.scroll, now: now(), color: true })
      output.write(lines.map((line, i) => `\x1b[${i + 1};1H${line}\x1b[K`).join('') + '\x1b[J')
    }
    const poll = async () => {
      if (closed) return
      if (busy) { again = true; return }
      busy = true
      do {
        again = false
        const snap = await fetchSnapshot({ conn, taskId: ui.pinned, fetchImpl })
        if (closed) return
        if (snap.ok) {
          error = null
          // Keep the view where it is while the user reads older records.
          if (ui.scroll > 0 && data.task?.id === snap.task?.id) ui = { ...ui, scroll: ui.scroll + Math.max(0, snap.records.length - data.records.length) }
          data = { tasks: snap.tasks, task: snap.task, records: snap.records }
        } else {
          error = snap.message
          if (snap.tasks) data = { ...data, tasks: snap.tasks }
        }
        render()
      } while (again)
      busy = false
    }

    const handlers = {}
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      input.removeListener?.('data', onData)
      output.removeListener?.('resize', render)
      for (const [event, fn] of Object.entries(handlers)) process.removeListener(event, fn as any)
      try { input.setRawMode?.(false) } catch { /* not a TTY any more */ }
      input.pause?.()
      output.write(LEAVE)
      done()
    }
    const fail = (e) => {
      cleanup()
      console.error(`watch failed: ${oneLine(e?.message ?? e)}`)
      process.exitCode = 1
    }
    for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP']) handlers[event] = cleanup
    handlers['uncaughtException'] = fail
    handlers['unhandledRejection'] = fail
    handlers['exit'] = cleanup
    for (const [event, fn] of Object.entries(handlers)) process.on(event as any, fn as any)

    function onData(chunk) {
      for (const key of parseKeys(chunk)) {
        if (key === 'quit') return cleanup()
        const { height } = size()
        const hasBanner = Boolean(error)
        const before = ui.pinned
        ui = reduceKey(ui, key, { page: Math.max(1, bodyHeight(height, hasBanner) - 1), limit: scrollLimit(data.records.length, height, hasBanner), taskIds: data.tasks.map((t) => t.id), currentId: data.task?.id })
        if (ui.pinned !== before) { data = { ...data, task: undefined, records: [] }; render(); poll(); continue }
      }
      render()
    }

    try { input.setRawMode?.(true) } catch { /* ignore */ }
    input.resume?.()
    input.on('data', onData)
    output.on?.('resize', render)
    output.write(ENTER)
    render()
    timer = setInterval(poll, intervalMs)
    poll()
  })
}

// ---------------------------------------------------------------- command line

export function parseArgs(argv) {
  const o: any = {}
  const values = { '--dir': 'dir', '--url': 'url', '--token-file': 'tokenFile', '--interval': 'interval' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (values[arg] !== undefined) { if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`); o[values[arg]] = argv[++i] }
    else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`)
    else if (o.id === undefined) o.id = arg
    else throw new Error(`unexpected argument: ${arg}`)
  }
  return o
}

/** The control interface address and token: --dir, or --url with --token-file, or the environment. */
export function connect(o, env = process.env, readText = (path) => readFileSync(path, 'utf8')) {
  const token = o.tokenFile !== undefined ? readText(resolve(o.tokenFile)).trim() : undefined
  return connection({ dir: o.dir, url: o.url, token }, env, readText)
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const conn = connect(o)
  const intervalMs = o.interval ? Number(o.interval) * 1000 : 2000
  if (process.stdout.isTTY && process.stdin.isTTY) await runTui({ conn, taskId: o.id ?? null, intervalMs })
  else await runPlain({ conn, taskId: o.id ?? null, intervalMs })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`watch failed: ${error.message}`)
    process.exitCode = 1
  })
}
