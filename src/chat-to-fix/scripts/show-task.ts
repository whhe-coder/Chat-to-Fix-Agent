// Prints a task's state and its execution records from the control interface, in readable form.
//
//   node scripts/show-task.ts [T-1] [--dir <first-run data folder>] [--url <url>] [--token <token>]
//        [--follow] [--full] [--interval <seconds>]
//
// Where it connects: --url / --token, else CHAT_TO_FIX_URL / CHAT_TO_FIX_HTTP_TOKEN, else --dir (the
// folder scripts/first-run.ts prepared: it holds http-token and chat-to-fix.json with the port).
// Without a task id it lists the tasks. --follow keeps polling and prints only new records until the
// task has ended. --full does not shorten the text of a record. The token is never printed.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fmtTokens, fmtTps, fmtUsd } from '../src/task/usage.ts'

const END_STATES = ['done', 'failed', 'stopped', 'timed_out', 'needs_info', 'expired']
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const clock = (at) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? String(at ?? '').padEnd(8) : d.toISOString().slice(11, 19)
}

/** The summary of a task: state, step, run, and what the steps have produced so far. */
export function formatTask(task) {
  const run = task.runs?.at(-1)
  const lines = [
    `${task.id}  ${task.state}${task.endReason ? ` (${task.endReason})` : ''}  step=${task.step ?? '-'}  run ${task.runs?.length ?? 0}${run?.endedAt ? ' (ended)' : ''}`,
    `  slack   read=${Boolean(task.slack?.readAt)} sent=${Object.entries(task.slack?.sent ?? {}).filter(([, v]) => v).map(([k]) => k).join(',') || '-'}`,
    `  jira    ${task.jira?.key ?? '-'} ${task.jira?.url ?? ''}${task.jira?.commentedMr ? '  (MR commented)' : ''}`,
    `  repo    branch=${task.repo?.branch ?? '-'} dir=${task.repo?.dir ?? '-'}`,
    `  review  ${task.review ? `${task.review.verdict ?? '?'} (rounds ${task.review.rounds ?? '?'})` : '-'}`,
    `  mr      ${task.mr?.url ?? '-'}`,
  ]
  if (task.needsInfo?.main || task.needsInfo?.coding) lines.push(`  needs   ${oneLine(JSON.stringify(task.needsInfo))}`)
  lines.push(...formatUsage(task.usage))
  return lines.join('\n')
}

// Where a speed comes from: DSH's own measurement (API bots) or derived from the CLI result (Coding bot).
const BASIS = { 'dsh-decode': 'DSH sessionStats: decodeTokens / decodeMs', 'cli-api': 'derived: CLI output tokens / duration_api_ms', 'cli-wall': 'derived: CLI output tokens / duration_ms' }
const tokensOf = (b) => `in ${fmtTokens(b.input)} / out ${fmtTokens(b.output)} / cache read ${fmtTokens(b.cacheRead)} / cache write ${fmtTokens(b.cacheWrite)}`

/** The token bill of a task: the total, then one line per role (models, cost, tokens, speed) and per model. */
export function formatUsage(usage) {
  if (!usage || !(usage.calls > 0)) return ['  usage   none yet']
  const note = (b) => (b.unpriced ? '  (some calls unpriced: left out of the cost)' : '')
  const lines = [`  usage   ${fmtUsd(usage.totalUsd)}  ${tokensOf(usage)}  ${usage.calls} calls${usage.outputTps ? `  avg ${fmtTps(usage.outputTps)}` : ''}${note(usage)}`]
  for (const [role, b] of Object.entries<any>(usage.byRole ?? {})) {
    const basis = BASIS[b.last?.tpsBasis] ?? ''
    lines.push(`          ${role.padEnd(9)} ${b.models.join(', ')}${b.last?.effort ? ` (effort ${b.last.effort})` : ''}  ${fmtUsd(b.usd)}  ${tokensOf(b)}${b.outputTps ? `  ${fmtTps(b.outputTps)}${basis ? ` [${basis}]` : ''}` : ''}${note(b)}`)
  }
  const runs = Object.entries<any>(usage.byRun ?? {})
  if (runs.length > 1) lines.push(`          per run: ${runs.map(([no, b]) => `run ${no} ${fmtUsd(b.usd)}`).join(', ')}`)
  return lines
}

/** One record as one line: time, step, role, kind, tool, text. */
export function formatRecord(record, { full = false } = {}) {
  const kind = record.type === 'tool_result' ? `tool_result${record.ok === false ? ' FAILED' : ''}` : record.type
  const head = `${clock(record.at)} ${String(record.step ?? '-').padEnd(9)} ${String(record.role ?? '-').padEnd(8)} ${String(kind ?? '-').padEnd(11)}`
  // A tool_call's text already starts with the tool name; a tool_result's does not.
  const tool = record.type !== 'tool_call' && record.tool ? `${record.tool} ` : ''
  const text = oneLine(record.text)
  return `${head} ${tool}${full ? text : clip(text, 200)}`
}

export function connection(o, env, readText = (path) => readFileSync(path, 'utf8')) {
  let url = o.url ?? env.CHAT_TO_FIX_URL
  let token = o.token ?? env.CHAT_TO_FIX_HTTP_TOKEN
  if (o.dir !== undefined) {
    const dir = resolve(o.dir)
    if (token === undefined) token = readText(join(dir, 'http-token')).trim()
    if (url === undefined) url = `http://127.0.0.1:${JSON.parse(readText(join(dir, 'chat-to-fix.json'))).httpPort}`
  }
  if (!url || !token) throw new Error('no connection: give --dir, or --url and --token (or CHAT_TO_FIX_URL and CHAT_TO_FIX_HTTP_TOKEN)')
  return { url: url.replace(/\/+$/, ''), token }
}

async function get(conn, path, fetchImpl) {
  const response = await fetchImpl(`${conn.url}${path}`, { headers: { 'x-chat-to-fix-token': conn.token } })
  let body
  try { body = await response.json() } catch { body = {} }
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}${body.error ? ` (${body.error})` : ''}`)
  return body
}

/** Prints one task (or the list). Returns the task when one was printed. */
export async function showTask({ id, conn, full = false, follow = false, intervalMs = 3000, out = (line) => console.log(line), fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: any) {
  if (id === undefined) {
    const { tasks } = await get(conn, '/tasks', fetchImpl)
    if (tasks.length === 0) out('no tasks')
    for (const t of tasks) out(`${t.id}  ${t.state}  step=${t.step ?? '-'}  jira=${t.jiraKey ?? '-'}  mr=${t.mrUrl ?? '-'}  cost=${fmtUsd(t.totalUsd ?? 0)}${t.unpriced ? '+unpriced' : ''}`)
    return undefined
  }
  const path = `/tasks/${encodeURIComponent(id)}?records=1`
  let seen = 0
  let first = true
  for (;;) {
    const task = await get(conn, path, fetchImpl)
    if (first) { out(formatTask(task)); out(`-- execution records (${task.records?.length ?? 0}) --`); first = false }
    for (const record of (task.records ?? []).slice(seen)) out(formatRecord(record, { full }))
    seen = task.records?.length ?? 0
    if (!follow || END_STATES.includes(task.state)) {
      if (follow) out(formatTask(task))
      return task
    }
    await sleep(intervalMs)
  }
}

function parseArgs(argv) {
  const o: any = {}
  const values = { '--dir': 'dir', '--url': 'url', '--token': 'token', '--interval': 'interval' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--follow') o.follow = true
    else if (arg === '--full') o.full = true
    else if (values[arg] !== undefined) { if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`); o[values[arg]] = argv[++i] }
    else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`)
    else if (o.id === undefined) o.id = arg
    else throw new Error(`unexpected argument: ${arg}`)
  }
  return o
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2))
  showTask({ id: o.id, conn: connection(o, process.env), full: o.full, follow: o.follow, intervalMs: o.interval ? Number(o.interval) * 1000 : undefined }).catch((error) => {
    console.error(`show-task failed: ${error.message}`)
    process.exitCode = 1
  })
}
