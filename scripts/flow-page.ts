// A live sequence-diagram debug page: watch a task flow between the bots, like a UML sequence diagram.
//
//   node scripts/flow-page.ts [--dir <first-run folder>] [--url <url> --token-file <path>] [--port 3092]
//
// Where it connects: --dir (the folder scripts/first-run.ts prepared: http-token and chat-to-fix.json),
// or --url with --token-file (or CHAT_TO_FIX_URL and CHAT_TO_FIX_HTTP_TOKEN), as scripts/show-task.ts.
// It serves ONE self-contained HTML page on 127.0.0.1 (default port 3092) and a GET-only JSON proxy:
//   GET /api/tasks        the task list of the control interface
//   GET /api/tasks/:id    the task (trimmed) and its execution records turned into diagram arrows
// The proxy adds the token on the server side. The token never reaches the browser, the page or any log.
// Only GET requests are sent to the control interface (GET /tasks, GET /tasks/:id?records=1).
//
// Lifelines, left to right: Slack, the watchdog (listener, queue, runner, gate), and the five bots.
// The record -> arrow mapping is the exported pure function buildArrows(records, task?).
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connection } from './show-task.ts'

export const DEFAULT_PORT = 3092
export const LABEL_MAX = 40

/** The lifelines, left to right. `id` is what an arrow's from/to hold. */
export const LANES = Object.freeze([
  { id: 'slackext', label: 'Slack', sub: 'Slack 本身' },
  { id: 'gate', label: '看门狗', sub: '监听 / 队列 / 门 / 运行器' },
  { id: 'main', label: '主 bot', sub: 'main' },
  { id: 'slack', label: 'Slack bot', sub: 'slack' },
  { id: 'jira', label: 'Jira bot', sub: 'jira' },
  { id: 'pipeline', label: 'GitLab bot', sub: 'pipeline' },
  { id: 'coding', label: '修复 bot', sub: 'coding' },
])
const LANE_IDS = LANES.map((l) => l.id)

export const STEP_LIST = Object.freeze([
  { id: 'fetch', label: '取讨论' }, { id: 'issue', label: '建工单' }, { id: 'prepare', label: '准备代码' }, { id: 'code', label: '写代码' },
  { id: 'mr', label: '开 MR' }, { id: 'writeback', label: '回写' }, { id: 'close', label: '结束' },
])
export const STATE_LABELS = Object.freeze({ queued: '排队中', running: '运行中', done: '已完成', needs_info: '需要补充信息', failed: '失败', timed_out: '超时', stopped: '已停止', expired: '已过期' })

const BOT_NAME_LANE = Object.freeze({ main: 'main', slack: 'slack', jira: 'jira', pipeline: 'pipeline', gitlab: 'pipeline', coding: 'coding' })

// Tools that are known to the task layer: a tool outside this table is drawn grey (unknown).
const TOOL_HINTS = Object.freeze({
  task_read: '读任务', task_records: '读记录', repo_prepare: '准备代码', repo_diff: '看改动', repo_read_file: '读文件', repo_log: '看历史',
  mr_open_draft: '开 Draft MR', mr_get: '查 MR', jira_create_issue: '建工单', jira_get_issue: '查工单', jira_add_comment: '加评论',
  jira_transition: '改状态', review_report: '评审结果',
})

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const clip = (text, n = LABEL_MAX) => {
  const chars = Array.from(oneLine(text))
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : chars.join('')
}
const isLane = (id) => LANE_IDS.includes(id)

/** Parses the JSON that follows the tool name in a tool_call text; undefined when it is not (complete) JSON. */
function argsOf(record) {
  const tool = String(record.tool ?? '')
  const text = String(record.text ?? '')
  const rest = tool !== '' && text.startsWith(tool) ? text.slice(tool.length).trim() : text.trim()
  if (rest === '') return { raw: '', value: undefined }
  try { return { raw: rest, value: JSON.parse(rest) } } catch { return { raw: rest, value: undefined } }
}
const pretty = (parsed) => (parsed.value !== undefined ? JSON.stringify(parsed.value, null, 2) : parsed.raw)

/** The text of a tool call that is worth reading in full (message, comment text, MR description...). */
function mainText(value) {
  if (value === null || typeof value !== 'object') return ''
  for (const key of ['message', 'text', 'description', 'what', 'comments']) if (typeof value[key] === 'string') return value[key]
  return ''
}

/**
 * Turns execution records (src/task/recorder.ts, gate.ts, monitor.ts, runner.ts) into diagram arrows.
 * Pure: no I/O. Never throws on an odd record: it becomes a grey self-loop on its role's lane.
 *
 * @param {any[]} records the records of one task, in file order
 * @param {any} [task] the task object (only its origin is used, for the detail of the first arrow)
 * @returns {{ id: number, from: string, to: string, kind: 'call'|'reply'|'self'|'notice', label: string, detail: string,
 *   step: string|null, at: string|null, failed: boolean }[]} arrows (more fields: run, recordType, role, tool, args, result,
 *   ok, ms, resultAt, minor, unknown, pending)
 */
export function buildArrows(records, task = undefined) {
  const arrows: any[] = []
  const pending: any[] = [] // tool calls that wait for their result: { role, tool, arrows: [] }
  const mirrors: any[] = [] // message_bot calls whose "@Name text" line the group mirrors: { role, to, text }
  const lastRound: any = {} // role -> normalized text of its latest round_end
  const justEnded: any = {} // role -> true while its round_end has not yet been followed by another record of that role
  const lastCallRole: any = {} // tool -> role of its latest call (for records that do not name a role)
  let step: string | null = null
  let awaitTaskLine = false

  const push = (r, a) => {
    const arrow = {
      id: arrows.length, from: 'gate', to: 'gate', kind: 'self', label: '', detail: '', step, at: r.at ?? null, failed: false,
      run: r.run ?? null, recordType: String(r.type ?? 'unknown'), role: r.role ?? null, tool: r.tool ?? null, args: '', result: '', ok: null, ms: null,
      resultAt: null, minor: false, unknown: false, pending: false, ...a,
    }
    arrow.label = clip(arrow.label)
    arrows.push(arrow)
    return arrow
  }
  const roleLane = (r) => (isLane(r?.role) ? r.role : 'gate')
  const grey = (r, label, extra: any = {}) => push(r, { from: roleLane(r), to: roleLane(r), kind: 'self', label, detail: String(r.text ?? ''), unknown: true, ...extra })
  const lastNotice = () => { const a = arrows.at(-1); return a !== undefined && a.kind === 'notice' && a.recordType === 'limit' ? a : undefined }

  const onSystem = (r) => {
    const text = String(r.text ?? '')
    if (/^run \d+ created/.test(text)) {
      const origin = task?.origin
      push(r, { from: 'slackext', to: 'gate', kind: 'call', label: '@ 事件', detail: origin ? `${origin.text ?? ''}${origin.permalink ? `\n\n${origin.permalink}` : ''}` : text })
      push(r, { from: 'gate', to: 'gate', kind: 'self', label: '建任务/建群', detail: text })
      awaitTaskLine = true
    } else if (r.tool === 'task_close') {
      const call = pending.find((p) => p.tool === 'task_close' && !p.done)
      if (call) { settle(call, r, text, r.ok !== false); return }
      push(r, { from: 'gate', to: 'gate', kind: 'self', label: '结束任务', detail: text, tool: 'task_close', result: text })
    } else if (r.tool === 'needs_info_confirm') {
      const call = pending.find((p) => p.tool === 'needs_info_confirm' && !p.done)
      if (call) { settle(call, r, text, r.ok !== false); return }
      push(r, { from: roleLane(r), to: 'gate', kind: 'call', label: '确认缺信息', detail: text })
    } else if (/^run ended/.test(text)) {
      push(r, { from: 'gate', to: 'gate', kind: 'self', label: '解散群', detail: text, failed: /^run ended: (failed|timed_out)/.test(text) })
    } else if (/^notice \w+:/.test(text)) {
      const kind = /^notice (\w+):/.exec(text)[1]
      push(r, { from: 'gate', to: 'slackext', kind: 'notice', label: `通知 ${kind}`, detail: text })
    } else grey(r, text)
  }

  // A tool_result closes the oldest-first match of the same role and tool; the arrow keeps the result for its panel.
  const settle = (call, r, resultText, ok) => {
    call.done = true
    for (const a of call.arrows) {
      a.pending = false
      a.result = resultText
      a.ok = r.ok ?? ok
      a.ms = r.ms ?? null
      a.resultAt = r.at ?? null
      a.recordType = `${a.recordType}+${r.type}`
      if (ok === false) a.failed = true
    }
    return call.arrows
  }

  const onToolCall = (r) => {
    const tool = String(r.tool || String(r.text ?? '').split(/\s+/)[0] || '')
    const parsed = argsOf({ ...r, tool })
    const value = parsed.value
    const role = roleLane(r)
    lastCallRole[tool] = role
    const common = { tool, args: pretty(parsed), detail: mainText(value), pending: true }
    const made = []
    if (tool === 'message_bot') {
      const targets = Array.isArray(value?.to) ? value.to : [value?.to]
      for (const to of targets) {
        const m = /^([A-Za-z]+)(?:-|$)/.exec(String(to ?? '').trim())
        const lane = m ? BOT_NAME_LANE[m[1].toLowerCase()] : undefined
        const message = typeof value?.message === 'string' ? value.message : parsed.raw
        if (lane === undefined) made.push(push(r, { ...common, from: role, to: role, kind: 'self', label: `message_bot → ${to ?? '?'}`, detail: message, unknown: true }))
        else made.push(push(r, { ...common, from: role, to: lane, kind: 'call', label: message, detail: message }))
        mirrors.push({ role: r.role, to: String(to ?? ''), text: oneLine(`@${to} ${message}`) })
      }
    } else if (tool.startsWith('slack_')) {
      const label = tool === 'slack_read_thread' ? '读讨论' : tool === 'slack_reply' ? `回复 ${value?.purpose ?? ''}`.trim() : tool
      made.push(push(r, { ...common, from: role, to: 'slackext', kind: 'call', label }))
    } else if (tool === 'request_code') {
      made.push(push(r, { ...common, from: role, to: 'pipeline', kind: 'call', label: `request_code ${value?.what ?? ''}`.trim() }))
    } else if (tool === 'task_advance') {
      made.push(push(r, { ...common, from: role, to: 'gate', kind: 'call', label: `task_advance → ${value?.to ?? '?'}` }))
    } else if (tool === 'task_close') {
      made.push(push(r, { ...common, from: role, to: 'gate', kind: 'call', label: `结束任务${value?.outcome ? ` (${value.outcome})` : ''}` }))
    } else if (tool === 'needs_info_confirm') {
      made.push(push(r, { ...common, from: role, to: 'gate', kind: 'call', label: '确认缺信息 needs_info_confirm' }))
    } else {
      const hint = TOOL_HINTS[tool]
      let label = hint ? `${tool} ${hint}` : tool || 'tool_call'
      if (tool === 'jira_transition' && value?.status) label = `${tool} → ${value.status}`
      else if (tool === 'review_report' && value?.verdict) label = `${tool} ${value.verdict}`
      else if (tool === 'repo_read_file' && value?.path) label = `${tool} ${value.path}`
      made.push(push(r, { ...common, from: role, to: role, kind: 'self', label, unknown: hint === undefined }))
    }
    pending.push({ role: r.role ?? null, tool, arrows: made, done: false })
  }

  const onToolResult = (r) => {
    const tool = String(r.tool ?? '')
    const text = String(r.text ?? '')
    const call = pending.find((p) => !p.done && p.tool === tool && p.role === (r.role ?? null))
    if (!call) { grey(r, `结果 ${tool}`, { tool, result: text, ok: r.ok ?? null, ms: r.ms ?? null, failed: r.ok === false }); return }
    const done = settle(call, r, text, r.ok)
    // A call to the Slack service gets its answer as a dashed arrow back.
    if (tool.startsWith('slack_')) {
      const first = done[0]
      const ok = r.ok !== false
      push(r, { from: 'slackext', to: first.from, kind: 'reply', label: ok ? (text.split(/\n|\. /)[0] || 'ok') : `失败: ${text}`, detail: text, tool, result: text, ok: r.ok ?? null, ms: r.ms ?? null, failed: !ok, resultAt: r.at ?? null })
    }
  }

  const onRoundEnd = (r) => {
    const text = String(r.text ?? '')
    if (isLane(r.role)) { lastRound[r.role] = oneLine(text); justEnded[r.role] = true }
    if (r.role === 'main') push(r, { from: 'main', to: 'main', kind: 'self', label: text, detail: text, minor: true, failed: Boolean(r.failed) })
    else if (isLane(r.role)) push(r, { from: r.role, to: 'main', kind: 'reply', label: text, detail: text, failed: Boolean(r.failed) })
    else grey(r, text)
  }

  const onLine = (r) => {
    const text = String(r.text ?? '')
    if (!isLane(r.role)) {
      if (awaitTaskLine && /^Task /.test(text)) { awaitTaskLine = false; push(r, { from: 'gate', to: 'main', kind: 'call', label: '任务发到群里', detail: text }); return }
      const nudge = lastNotice()
      if (nudge !== undefined && Date.parse(r.at) - Date.parse(nudge.at) <= 5000) { nudge.detail = `${nudge.detail}\n\n${text}`; return }
      push(r, { from: 'gate', to: 'main', kind: 'notice', label: text, detail: text })
      return
    }
    const flat = oneLine(text)
    const mirror = mirrors.findIndex((m) => m.role === r.role && (flat === m.text || flat.startsWith(`@${m.to}`)))
    if (mirror >= 0) { mirrors.splice(mirror, 1); return } // the group's copy of a message_bot call
    // the group's copy of a round_end: same text, or (the group rewrites links) the very next record of that role
    if (lastRound[r.role] === flat || justEnded[r.role]) { delete lastRound[r.role]; delete justEnded[r.role]; return }
    push(r, { from: r.role, to: r.role, kind: 'self', label: text, detail: text, minor: true })
  }

  for (const r of Array.isArray(records) ? records : []) {
    if (r === null || typeof r !== 'object') continue
    if (typeof r.step === 'string') step = r.step
    if (isLane(r.role) && r.type !== 'line' && r.type !== 'round_end') delete justEnded[r.role]
    try {
      switch (r.type) {
        case 'system': onSystem(r); break
        case 'line': onLine(r); break
        case 'notice': push(r, { from: 'gate', to: isLane(r.role) ? r.role : 'main', kind: 'notice', label: String(r.text ?? ''), detail: String(r.text ?? '') }); break
        case 'tool_call': onToolCall(r); break
        case 'tool_result': onToolResult(r); break
        case 'round_end': onRoundEnd(r); break
        case 'advance': {
          const m = /(\w+)\s*->\s*(\w+)/.exec(String(r.text ?? ''))
          const index = m ? STEP_LIST.findIndex((s) => s.id === m[2]) : -1
          if (m) step = m[2] // the arrow already belongs to the new step
          push(r, { from: 'gate', to: 'gate', kind: 'self', label: index >= 0 ? `进到第 ${index + 1} 步` : String(r.text ?? ''), detail: String(r.text ?? ''), step })
          break
        }
        case 'refused': {
          const to = isLane(r.role) ? r.role : lastCallRole[r.tool] ?? 'main'
          push(r, { from: 'gate', to, kind: 'reply', label: `拒绝: ${r.text ?? ''}`, detail: String(r.text ?? ''), failed: true, ok: false })
          break
        }
        // A tool use refused or failed inside Claude Code (src/task/recorder.ts onEngineLines):
        // a red self-loop on the bot's lane, labelled with the attempted command.
        case 'refusal':
        case 'tool_error': {
          const lane = isLane(r.role) ? r.role : 'coding'
          const text = String(r.text ?? '').replace(/^\s*▸\s*/, '')
          const attempted = /\| attempted: (.*)$/.exec(text)?.[1]
          const what = r.type === 'refusal' ? '被拒' : '失败'
          push(r, { from: lane, to: lane, kind: 'self', label: attempted ? `${what}: ${attempted}` : text, detail: text, failed: true, ok: false })
          break
        }
        case 'approval': push(r, { from: 'gate', to: isLane(r.role) ? r.role : lastCallRole[r.tool] ?? 'main', kind: 'notice', label: `拒绝审批 ${r.text ?? ''}`, detail: String(r.text ?? '') }); break
        case 'limit': push(r, { from: 'gate', to: r.check === 'engine_silent' ? 'coding' : 'main', kind: 'notice', label: `${r.check ?? 'limit'}: ${r.action ?? r.text ?? ''}`, detail: String(r.text ?? '') }); break
        default: grey(r, `${r.type ?? 'record'} ${r.text ?? ''}`.trim())
      }
    } catch {
      grey(r, String(r.type ?? 'record'))
    }
  }
  return arrows
}

// ------------------------------------------------------------------ the page

const trimTask = (task, now) => {
  const run = task.runs?.at?.(-1)
  const start = Date.parse(run?.startedAt ?? task.queuedAt ?? task.createdAt)
  const end = Date.parse(run?.endedAt ?? task.updatedAt)
  const elapsedMs = task.state === 'queued' ? now - Date.parse(task.queuedAt ?? task.createdAt) : task.state === 'running' ? now - start : end - start
  return {
    id: task.id, no: task.no ?? null, state: task.state, endReason: task.endReason ?? null, step: task.step ?? null, stepAt: task.stepAt ?? null,
    createdAt: task.createdAt ?? null, updatedAt: task.updatedAt ?? null, elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
    jira: { key: task.jira?.key ?? null, url: task.jira?.url ?? null }, mr: { url: task.mr?.url ?? null },
    binding: { channel: task.binding?.channel ?? null, repo: task.binding?.repo ?? null },
    runs: (task.runs ?? []).map((x) => ({ no: x.no, startedAt: x.startedAt ?? null, endedAt: x.endedAt ?? null, endReason: x.endReason ?? null })),
  }
}

const jsonForScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c')

/** The page: inline CSS and JS, SVG drawing, no external resource, light and dark through prefers-color-scheme. */
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>任务流程图</title>
<style>
:root {
  --bg: #f4f5f8; --surface: #ffffff; --ink: #1b2130; --muted: #667085; --line: #d3d8e1; --band: #e6eaf3; --band-ink: #3b4660;
  --c-call: #2563eb; --c-reply: #0d8f82; --c-self: #7c3aed; --c-notice: #e8710a; --c-fail: #dc2626; --c-grey: #8a93a3;
  --lifeline: #aeb6c6; --hover: rgba(37, 99, 235, .08); --sel: rgba(37, 99, 235, .17); --halo: #f4f5f8; --shadow: 0 1px 3px rgba(20, 30, 50, .12);
  --lane-slackext: #7b3f9e; --lane-gate: #b8650b; --lane-main: #2563eb; --lane-slack: #0f8fb0; --lane-jira: #1d4ed8; --lane-pipeline: #d4570f; --lane-coding: #0b8f5f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12151c; --surface: #1b202b; --ink: #e5e9f2; --muted: #9aa4b8; --line: #343c4d; --band: #252c3b; --band-ink: #b7c2da;
    --c-call: #5b9bff; --c-reply: #3fcbb9; --c-self: #b18cff; --c-notice: #ff9a3d; --c-fail: #ff6b6b; --c-grey: #7d879b;
    --lifeline: #4b556b; --hover: rgba(91, 155, 255, .12); --sel: rgba(91, 155, 255, .24); --halo: #12151c; --shadow: 0 1px 3px rgba(0, 0, 0, .5);
    --lane-slackext: #c58be6; --lane-gate: #f0a04b; --lane-main: #5b9bff; --lane-slack: #4cc3e3; --lane-jira: #7aa2ff; --lane-pipeline: #ff9060; --lane-coding: #4cd49c;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--ink); font: 13px/1.45 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; display: flex; flex-direction: column; overflow: hidden; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; padding: 8px 14px; background: var(--surface); border-bottom: 1px solid var(--line); }
header h1 { font-size: 14px; margin: 0; font-weight: 650; }
header .f { display: flex; gap: 5px; align-items: baseline; white-space: nowrap; }
header .k { color: var(--muted); }
header a { color: var(--c-call); }
select { font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; max-width: 260px; }
.badge { padding: 1px 8px; border-radius: 10px; font-weight: 600; background: var(--band); color: var(--band-ink); }
.badge.running { background: rgba(37, 99, 235, .15); color: var(--c-call); }
.badge.done { background: rgba(13, 143, 130, .17); color: var(--c-reply); }
.badge.failed, .badge.timed_out { background: rgba(220, 38, 38, .15); color: var(--c-fail); }
.badge.needs_info, .badge.stopped, .badge.expired, .badge.queued { background: rgba(232, 113, 10, .16); color: var(--c-notice); }
header label { display: flex; gap: 4px; align-items: center; color: var(--muted); cursor: pointer; }
.live { margin-left: auto; color: var(--muted); display: flex; gap: 6px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-reply); }
.dot.bad { background: var(--c-fail); }
#banner { display: none; padding: 5px 14px; background: rgba(220, 38, 38, .14); color: var(--c-fail); border-bottom: 1px solid var(--line); }
main { flex: 1; min-height: 0; display: flex; position: relative; }
#scroller { flex: 1; min-width: 0; overflow: auto; position: relative; }
#canvas { position: relative; }
.lanes { display: flex; position: sticky; top: 0; z-index: 3; background: var(--bg); padding: 6px 0 0; }
.lanes.bottom { position: static; padding: 0 0 6px; }
.lane { text-align: center; padding: 5px 4px; background: var(--surface); border: 1px solid var(--line); border-top: 3px solid var(--lc); border-radius: 6px; margin: 0 6px; box-shadow: var(--shadow); }
.lane b { display: block; font-size: 13px; }
.lane span { color: var(--muted); font-size: 11px; }
svg { display: block; font-family: inherit; }
svg text { font-size: 12px; fill: var(--ink); paint-order: stroke; stroke: var(--halo); stroke-width: 4px; stroke-linejoin: round; }
.lifeline { stroke: var(--lifeline); stroke-width: 1.3; stroke-dasharray: 4 5; }
.band rect { fill: var(--band); }
.band text { fill: var(--band-ink); font-weight: 650; stroke: none; }
.arrow { cursor: pointer; outline: none; }
.arrow .hit { fill: transparent; }
.arrow:hover .hit, .arrow:focus-visible .hit { fill: var(--hover); }
.arrow.sel .hit { fill: var(--sel); }
.arrow .ln { fill: none; stroke-width: 1.7; }
.arrow.sel .ln { stroke-width: 2.8; }
.arrow.reply .ln { stroke-dasharray: 7 5; }
.arrow.pending { opacity: .6; }
.arrow.minor text { font-size: 11px; fill: var(--muted); }
.arrow.fail text { fill: var(--c-fail); }
.t-call { stroke: var(--c-call); } .t-reply { stroke: var(--c-reply); } .t-self { stroke: var(--c-self); } .t-notice { stroke: var(--c-notice); } .t-fail { stroke: var(--c-fail); } .t-grey { stroke: var(--c-grey); }
.mk-call { fill: var(--c-call); } .mk-reply { fill: var(--c-reply); } .mk-self { fill: var(--c-self); } .mk-notice { fill: var(--c-notice); } .mk-fail { fill: var(--c-fail); } .mk-grey { fill: var(--c-grey); }
.empty { padding: 40px; color: var(--muted); text-align: center; }
#jump { position: absolute; right: 20px; bottom: 14px; z-index: 6; display: none; border: 0; border-radius: 16px; padding: 6px 14px; background: var(--c-call); color: #fff; font: inherit; font-weight: 600; cursor: pointer; box-shadow: var(--shadow); }
aside { width: 380px; flex: none; background: var(--surface); border-left: 1px solid var(--line); overflow: auto; padding: 12px 14px; display: none; }
aside.open { display: block; }
aside h2 { font-size: 13px; margin: 0 0 8px; padding-right: 26px; word-break: break-word; }
aside .x { position: absolute; right: 10px; top: 8px; border: 0; background: none; color: var(--muted); font-size: 18px; cursor: pointer; }
aside dl { margin: 0 0 8px; display: grid; grid-template-columns: 56px 1fr; gap: 3px 8px; }
aside dt { color: var(--muted); }
aside dd { margin: 0; word-break: break-word; }
aside h3 { font-size: 12px; margin: 12px 0 4px; color: var(--muted); font-weight: 600; }
aside pre { margin: 0; padding: 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; white-space: pre-wrap; word-break: break-word; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 42vh; overflow: auto; }
aside .bad { color: var(--c-fail); font-weight: 600; }
@media (max-width: 860px) {
  aside { position: absolute; left: 0; right: 0; bottom: 0; width: auto; max-height: 58%; z-index: 8; border-left: 0; border-top: 1px solid var(--line); box-shadow: 0 -4px 14px rgba(0, 0, 0, .2); }
}
</style>
</head>
<body>
<header>
  <h1>任务流程图</h1>
  <div class="f"><span class="k">任务</span><select id="pick" aria-label="选择任务"></select></div>
  <div class="f"><span class="k">状态</span><span id="state" class="badge">-</span></div>
  <div class="f"><span class="k">已用</span><span id="elapsed">-</span></div>
  <div class="f"><span class="k">Jira</span><span id="jira">-</span></div>
  <div class="f"><span class="k">MR</span><span id="mr">-</span></div>
  <div class="f"><span class="k">当前步骤</span><span id="step">-</span></div>
  <label><input type="checkbox" id="notes" checked> 旁白</label>
  <div class="live"><span class="dot" id="dot"></span><span id="liveText">连接中</span></div>
</header>
<div id="banner"></div>
<main>
  <div id="scroller"><div id="canvas"></div></div>
  <button id="jump" type="button">↓ 最新</button>
  <aside id="panel" aria-label="详情"></aside>
</main>
<script type="application/json" id="boot">/*BOOT*/</script>
<script>
(function () {
  'use strict';
  var BOOT = JSON.parse(document.getElementById('boot').textContent);
  var LANES = BOOT.lanes, STEPS = BOOT.steps, STATES = BOOT.states;
  var KIND_NAME = { call: '调用', reply: '回复 / 结果', self: '自身动作', notice: '看门狗通知' };
  var LANE_NAME = {}; LANES.forEach(function (l) { LANE_NAME[l.id] = l.label; });
  var STEP_NAME = {}; STEPS.forEach(function (s, i) { STEP_NAME[s.id] = (i + 1) + ' ' + s.label; });
  var ROW_H = 46, BAND_H = 30, PAD = 8, MIN_COL = 128, NS = 'http://www.w3.org/2000/svg';
  var $ = function (id) { return document.getElementById(id); };
  var state = { tasks: [], taskId: null, userPicked: false, task: null, arrows: [], fetchedAt: 0, sel: null, stick: true, unseen: 0, sig: '', showNotes: true, error: null };

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function textW(s) { var w = 0; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); w += c > 0x2e7f ? 12.6 : (c > 0x7f ? 8 : 6.4); } return w; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clock(at) { var d = new Date(at); if (isNaN(d.getTime())) return String(at || ''); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function fullTime(at) { var d = new Date(at); if (isNaN(d.getTime())) return String(at || '-'); return clock(at) + '.' + ('00' + d.getMilliseconds()).slice(-3) + '  (' + d.toISOString() + ')'; }
  function dur(ms) { if (!(ms >= 0)) return '-'; var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); s = s % 60; return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s); }
  function idNum(id) { var m = /(\d+)$/.exec(String(id)); return m ? Number(m[1]) : 0; }
  function isWeb(u) { return /^https?:\/\//i.test(String(u || '')); }

  function getJson(path) {
    return fetch(path, { cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status)); return b; });
    });
  }

  // ---- header ------------------------------------------------------------------------------
  function linkOrText(el, text, url) {
    el.textContent = '';
    if (!text) { el.textContent = '-'; return; }
    if (isWeb(url || text)) { var a = document.createElement('a'); a.href = url || text; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = text; el.appendChild(a); } else el.textContent = text;
  }
  function renderHeader() {
    var t = state.task;
    var st = $('state');
    if (!t) { st.textContent = '-'; st.className = 'badge'; $('elapsed').textContent = '-'; $('jira').textContent = '-'; $('mr').textContent = '-'; $('step').textContent = '-'; return; }
    st.textContent = (STATES[t.state] || t.state) + (t.endReason && t.endReason !== 'completed' ? ' (' + t.endReason + ')' : '');
    st.className = 'badge ' + t.state;
    linkOrText($('jira'), t.jira && t.jira.key, t.jira && t.jira.url);
    linkOrText($('mr'), t.mr && t.mr.url, t.mr && t.mr.url);
    $('step').textContent = t.step ? (STEP_NAME[t.step] || t.step) : '-';
    tickElapsed();
  }
  function tickElapsed() {
    var t = state.task; if (!t) return;
    var ms = t.elapsedMs; if (ms == null) { $('elapsed').textContent = '-'; return; }
    if (t.state === 'running' || t.state === 'queued') ms += Date.now() - state.fetchedAt;
    $('elapsed').textContent = dur(ms);
  }
  function renderPicker() {
    var sel = $('pick'), list = state.tasks.slice().sort(function (a, b) { return idNum(b.id) - idNum(a.id); });
    var key = list.map(function (t) { return [t.id, t.state, t.step, t.jiraKey].join('|'); }).join(';') + '#' + state.taskId;
    if (sel.getAttribute('data-key') === key) return;
    sel.setAttribute('data-key', key);
    sel.textContent = '';
    if (!list.length) { var o = document.createElement('option'); o.textContent = '(没有任务)'; sel.appendChild(o); return; }
    list.forEach(function (t) {
      var o = document.createElement('option'); o.value = t.id;
      o.textContent = t.id + ' · ' + (STATES[t.state] || t.state) + (t.step ? ' · ' + (STEP_NAME[t.step] || t.step) : '') + (t.jiraKey ? ' · ' + t.jiraKey : '');
      if (t.id === state.taskId) o.selected = true;
      sel.appendChild(o);
    });
  }
  function choose() {
    var list = state.tasks.slice().sort(function (a, b) { return idNum(b.id) - idNum(a.id); });
    if (!list.length) return null;
    var want = state.userPicked ? state.taskId : (decodeURIComponent((location.hash || '').slice(1)) || null);
    if (want && list.some(function (t) { return t.id === want; })) { if (!state.userPicked && location.hash) state.userPicked = true; return want; }
    if (state.userPicked && state.taskId && list.some(function (t) { return t.id === state.taskId; })) return state.taskId;
    var running = list.filter(function (t) { return t.state === 'running'; })[0];
    return (running || list[0]).id;
  }

  // ---- the diagram -------------------------------------------------------------------------
  function tone(a) {
    if (a.failed) return 'fail';
    if (a.kind === 'notice') return 'notice';
    if (a.unknown || a.minor) return 'grey';
    return a.kind === 'reply' ? 'reply' : a.kind === 'self' ? 'self' : 'call';
  }
  function laneIndex(id) { for (var i = 0; i < LANES.length; i++) if (LANES[i].id === id) return i; return -1; }

  function render() {
    var scroller = $('scroller'), canvas = $('canvas');
    var top = scroller.scrollTop, left = scroller.scrollLeft;
    var arrows = state.arrows.filter(function (a) { return state.showNotes || !a.minor; });
    var colW = Math.max(MIN_COL, Math.floor((scroller.clientWidth - 2) / LANES.length));
    var W = colW * LANES.length;
    var cx = function (i) { return i * colW + colW / 2; };
    var multiRun = state.arrows.some(function (a) { return a.run > 1; });
    var y = PAD, parts = [], rows = [], prevStep = null, prevRun = null, first = true;
    arrows.forEach(function (a) {
      if (first || a.step !== prevStep || a.run !== prevRun) {
        var name = a.step ? (STEP_NAME[a.step] || a.step) : '(步骤未知)';
        parts.push('<g class="band"><rect x="0" y="' + y + '" width="' + W + '" height="' + (BAND_H - 6) + '"/><text x="10" y="' + (y + 14) + '">' + (multiRun && a.run ? '第 ' + a.run + ' 次运行 · ' : '') + '步骤 ' + esc(name) + '</text></g>');
        y += BAND_H; first = false; prevStep = a.step; prevRun = a.run;
      }
      rows.push({ a: a, y: y + ROW_H / 2 }); y += ROW_H;
    });
    var H = y + PAD;
    var svg = ['<svg id="svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" xmlns="' + NS + '">'];
    svg.push('<defs>');
    ['call', 'reply', 'self', 'notice', 'fail', 'grey'].forEach(function (k) {
      svg.push('<marker id="mk-' + k + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="mk-' + k + '" d="M0,0 L10,5 L0,10 z"/></marker>');
    });
    svg.push('</defs>');
    LANES.forEach(function (l, i) { svg.push('<line class="lifeline" x1="' + cx(i) + '" y1="0" x2="' + cx(i) + '" y2="' + H + '"/>'); });
    svg.push(parts.join(''));
    rows.forEach(function (row) {
      var a = row.a, ry = row.y, t = tone(a);
      var fi = laneIndex(a.from), ti = laneIndex(a.to);
      if (fi < 0) fi = 1; if (ti < 0) ti = fi;
      var label = a.label + (a.pending ? ' …' : '');
      var lw = textW(label), body, bbL, bbR;
      var cls = 'arrow ' + a.kind + (a.minor ? ' minor' : '') + (a.failed ? ' fail' : '') + (a.pending ? ' pending' : '') + (state.sel === a.id ? ' sel' : '');
      if (fi === ti) {
        var x = cx(fi), room = W - x - 52, flip = lw > room && x - 52 > room, d = flip ? -1 : 1, LW = 34;
        var path = 'M' + x + ' ' + (ry - 9) + ' H' + (x + d * LW) + ' V' + (ry + 9) + ' H' + (x + d * 3);
        var tx = x + d * (LW + 8);
        body = '<path class="ln t-' + t + '" d="' + path + '" marker-end="url(#mk-' + t + ')"/><text x="' + tx + '" y="' + (ry + 4) + '" text-anchor="' + (flip ? 'end' : 'start') + '">' + esc(label) + '</text>';
        bbL = flip ? tx - lw - 4 : x - 6; bbR = flip ? x + 6 : tx + lw + 4;
      } else {
        var x1 = cx(fi), x2 = cx(ti), mid = (x1 + x2) / 2;
        var lx = Math.min(Math.max(mid, lw / 2 + 6), W - lw / 2 - 6);
        body = '<line class="ln t-' + t + '" x1="' + x1 + '" y1="' + ry + '" x2="' + x2 + '" y2="' + ry + '" marker-end="url(#mk-' + t + ')"/><circle cx="' + x1 + '" cy="' + ry + '" r="2.6" class="mk-' + t + '"/><text x="' + lx + '" y="' + (ry - 6) + '" text-anchor="middle">' + esc(label) + '</text>';
        bbL = Math.min(x1, x2, lx - lw / 2) - 4; bbR = Math.max(x1, x2, lx + lw / 2) + 4;
      }
      bbL = Math.max(0, bbL); bbR = Math.min(W, bbR);
      svg.push('<g class="' + cls + '" data-i="' + a.id + '" tabindex="0" role="button" aria-label="' + esc(a.label) + '"><rect class="hit" x="' + bbL + '" y="' + (ry - ROW_H / 2 + 3) + '" width="' + (bbR - bbL) + '" height="' + (ROW_H - 6) + '" rx="5"/>' + body + '</g>');
    });
    svg.push('</svg>');
    var head = '<div class="lanes" style="width:' + W + 'px">' + LANES.map(function (l) { return laneBox(l, colW); }).join('') + '</div>';
    var foot = '<div class="lanes bottom" style="width:' + W + 'px">' + LANES.map(function (l) { return laneBox(l, colW); }).join('') + '</div>';
    canvas.style.width = W + 'px';
    canvas.innerHTML = head + (arrows.length ? svg.join('') : '<div class="empty">这个任务还没有记录</div>') + foot;
    scroller.scrollTop = top; scroller.scrollLeft = left;
    if (state.stick) scrollEnd();
  }
  function laneBox(l, colW) {
    return '<div class="lane" style="width:' + colW + 'px;margin:0;border-radius:6px;--lc:var(--lane-' + l.id + ')"><b>' + esc(l.label) + '</b><span>' + esc(l.sub) + '</span></div>';
  }
  function scrollEnd() { var s = $('scroller'); s.scrollTop = s.scrollHeight; }

  // ---- the side panel ----------------------------------------------------------------------
  function section(panel, title, text) {
    if (!text) return;
    var h = document.createElement('h3'); h.textContent = title; panel.appendChild(h);
    var p = document.createElement('pre'); p.textContent = text; panel.appendChild(p);
  }
  function renderPanel() {
    var panel = $('panel'), a = state.arrows.filter(function (x) { return x.id === state.sel; })[0];
    if (!a) { panel.className = ''; panel.textContent = ''; return; }
    panel.className = 'open'; panel.textContent = '';
    var x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', '关闭');
    x.onclick = function () { state.sel = null; render(); renderPanel(); };
    panel.appendChild(x);
    var h = document.createElement('h2'); h.textContent = a.label || '(无标题)'; panel.appendChild(h);
    var dl = document.createElement('dl');
    var row = function (k, v, bad) { if (v == null || v === '') return; var dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; if (bad) dd.className = 'bad'; dl.appendChild(dt); dl.appendChild(dd); };
    row('种类', KIND_NAME[a.kind] || a.kind);
    row('方向', (LANE_NAME[a.from] || a.from) + (a.from === a.to ? ' (自身)' : ' → ' + (LANE_NAME[a.to] || a.to)));
    row('记录', a.recordType);
    row('时间', fullTime(a.at));
    row('步骤', a.step ? (STEP_NAME[a.step] || a.step) : '-');
    row('运行', a.run);
    row('角色', a.role);
    row('工具', a.tool);
    if (a.ok != null || a.ms != null) row('结果', (a.ok === false ? '失败' : a.ok === true ? 'ok' : '') + (a.ms != null ? ' · ' + a.ms + ' ms' : ''), a.ok === false);
    else if (a.pending) row('结果', '等待中 …');
    if (a.failed && a.ok == null) row('状态', '失败', true);
    if (a.resultAt) row('结果时间', fullTime(a.resultAt));
    panel.appendChild(dl);
    section(panel, '完整文本', a.detail);
    section(panel, '参数 args', a.args && a.args !== a.detail ? a.args : '');
    section(panel, '结果 result', a.result);
  }
  function select(id) { state.sel = (state.sel === id ? null : id); render(); renderPanel(); }

  // ---- polling -----------------------------------------------------------------------------
  function status(ok, text) { $('dot').className = 'dot' + (ok ? '' : ' bad'); $('liveText').textContent = text; }
  function sigOf(arrows) { return arrows.length + ':' + arrows.map(function (a) { return a.id + (a.pending ? 'p' : '') + (a.failed ? 'f' : '') + (a.result || '').length; }).join(','); }
  function apply(d, taskId) {
    if (taskId !== state.taskId) return;
    var before = state.arrows.length, sig = sigOf(d.arrows || []);
    state.task = d.task; state.fetchedAt = Date.now(); state.arrows = d.arrows || [];
    renderHeader();
    if (sig !== state.sig) {
      state.sig = sig;
      if (!state.stick && state.arrows.length > before) state.unseen += state.arrows.length - before;
      render();
      if (state.sel != null) renderPanel();
    }
    $('jump').style.display = !state.stick && state.unseen > 0 ? 'block' : 'none';
    if (state.unseen > 0) $('jump').textContent = '↓ ' + state.unseen + ' 条新消息';
  }
  function switchTo(id) {
    state.taskId = id; state.task = null; state.arrows = []; state.sel = null; state.sig = ''; state.stick = true; state.unseen = 0;
    renderHeader(); renderPanel(); render();
  }
  var timer = null;
  function poll() {
    getJson('/api/tasks').then(function (list) {
      state.tasks = list.tasks || [];
      var want = choose();
      if (want !== state.taskId) switchTo(want);
      renderPicker();
      if (!state.taskId) { $('canvas').innerHTML = '<div class="empty">还没有任务</div>'; return null; }
      var id = state.taskId;
      return getJson('/api/tasks/' + encodeURIComponent(id)).then(function (d) { apply(d, id); });
    }).then(function () {
      state.error = null; $('banner').style.display = 'none'; status(true, '实时 · 每 2 秒');
    }).catch(function (e) {
      state.error = e.message; $('banner').textContent = '连接失败：' + e.message + '（继续重试，当前画面是上一次的数据）'; $('banner').style.display = 'block'; status(false, '断开');
    }).then(function () { timer = setTimeout(poll, 2000); });
  }

  // ---- wiring ------------------------------------------------------------------------------
  $('canvas').addEventListener('click', function (e) { var g = e.target.closest && e.target.closest('g.arrow'); if (g) select(Number(g.getAttribute('data-i'))); });
  $('canvas').addEventListener('keydown', function (e) { if (e.key !== 'Enter' && e.key !== ' ') return; var g = e.target.closest && e.target.closest('g.arrow'); if (g) { e.preventDefault(); select(Number(g.getAttribute('data-i'))); } });
  $('scroller').addEventListener('scroll', function () {
    var s = $('scroller'); state.stick = s.scrollTop + s.clientHeight >= s.scrollHeight - 40;
    if (state.stick) { state.unseen = 0; $('jump').style.display = 'none'; }
  });
  $('jump').onclick = function () { state.stick = true; state.unseen = 0; $('jump').style.display = 'none'; scrollEnd(); };
  $('pick').onchange = function () { state.userPicked = true; location.hash = '#' + encodeURIComponent(this.value); switchTo(this.value); renderPicker(); getJson('/api/tasks/' + encodeURIComponent(this.value)).then(function (d) { apply(d, state.taskId); }).catch(function () {}); };
  $('notes').onchange = function () { state.showNotes = this.checked; render(); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.sel != null) { state.sel = null; render(); renderPanel(); } });
  var resizeTimer = null;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 120); });
  setInterval(tickElapsed, 1000);
  render(); poll();
})();
</script>
</body>
</html>
`

const pageBody = () => PAGE_HTML.replace('/*BOOT*/', () => jsonForScript({ lanes: LANES, steps: STEP_LIST, states: STATE_LABELS }))

// ------------------------------------------------------------------ the server and the GET-only proxy

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
})

/**
 * @param {{ conn: { url: string, token: string }, fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number }} deps
 * @returns `handle(method, rawUrl, hostHeader)` answers `{ status, headers, body }`; the HTTP server around it is `createFlowServer`.
 */
export function createFlowHandler({ conn, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 8000 }) {
  const json = (status, payload, headers = {}) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers }, body: JSON.stringify(payload) })

  // One GET to the control interface with the token header. The token is only used here; errors carry no URL.
  async function upstream(path) {
    let response
    try { response = await fetchImpl(`${conn.url}${path}`, { method: 'GET', headers: { 'x-chat-to-fix-token': conn.token }, signal: AbortSignal.timeout(timeoutMs) }) } catch { return { error: json(502, { error: 'control_interface_unreachable' }) } }
    let body
    try { body = await response.json() } catch { body = undefined }
    if (response.status === 404) return { error: json(404, { error: body?.error ?? 'not_found' }) }
    if (response.status === 401) return { error: json(502, { error: 'control_interface_rejected_token' }) }
    if (!response.ok || body === undefined) return { error: json(502, { error: `control_interface_status_${response.status}` }) }
    return { body }
  }

  return async function handle(method, rawUrl, hostHeader) {
    if (method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' })
    if (typeof hostHeader !== 'string' || !LOCAL_HOST.test(hostHeader)) return json(403, { error: 'bad_host' })
    const path = new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname
    if (path === '/' || path === '/index.html') return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS }, body: pageBody() }
    if (path === '/api/tasks') {
      const { body, error } = await upstream('/tasks')
      return error ?? json(200, { tasks: Array.isArray(body.tasks) ? body.tasks : [] })
    }
    const m = /^\/api\/tasks\/([A-Za-z0-9_-]{1,64})$/.exec(path)
    if (m) {
      const { body, error } = await upstream(`/tasks/${encodeURIComponent(m[1])}?records=1`)
      if (error) return error
      const { records, ...task } = body
      return json(200, { task: trimTask(task, now()), arrows: buildArrows(records ?? [], task), serverNow: now() })
    }
    return json(404, { error: 'not_found' })
  }
}

/** The node:http server on 127.0.0.1 around the handler. `port: 0` picks a free port. */
export function createFlowServer({ conn, port = DEFAULT_PORT, fetchImpl = globalThis.fetch, now = undefined, timeoutMs = undefined }: any) {
  const handle = createFlowHandler({ conn, fetchImpl, now, timeoutMs })
  const server = createServer((request, response) => {
    handle(request.method, request.url, request.headers.host).catch(() => ({ status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"internal_error"}' })).then(({ status, headers, body }) => {
      response.writeHead(status, headers)
      response.end(body)
    })
  })
  return {
    server,
    async listen() {
      await new Promise<void>((resolveListen, reject) => server.once('error', reject).listen(port, '127.0.0.1', () => resolveListen()))
      return (server.address() as any).port as number
    },
    close() { return new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections?.() }) },
  }
}

export function parseArgs(argv) {
  const o: any = {}
  const values = { '--dir': 'dir', '--url': 'url', '--token-file': 'tokenFile', '--port': 'port' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (values[arg] !== undefined) { if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`); o[values[arg]] = argv[++i] }
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (o.port !== undefined && !(Number.isInteger(Number(o.port)) && Number(o.port) >= 0 && Number(o.port) <= 65535)) throw new Error('--port must be a number from 0 to 65535')
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
  const flow = createFlowServer({ conn, port: o.port === undefined ? DEFAULT_PORT : Number(o.port) })
  const port = await flow.listen()
  console.log(`flow page: http://127.0.0.1:${port}/   (Ctrl-C to stop)`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`flow-page failed: ${error.code === 'EADDRINUSE' ? 'that port is already in use (use --port)' : error.message}`)
    process.exitCode = 1
  })
}
