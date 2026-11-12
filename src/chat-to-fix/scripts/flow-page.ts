// A live sequence-diagram debug page: watch a task flow between the bots, like a UML sequence diagram.
//
//   node scripts/flow-page.ts [--dir <first-run folder>] [--url <url> --token-file <path>] [--port 3092]
//
// Where it connects: --dir (the folder scripts/first-run.ts prepared: http-token and chat-to-fix.json),
// or --url with --token-file (or CHAT_TO_FIX_URL and CHAT_TO_FIX_HTTP_TOKEN), as scripts/show-task.ts.
// It serves ONE self-contained HTML page on 127.0.0.1 (default port 3092) and a GET-only JSON proxy:
//   GET /api/tasks        the task list of the control interface
//   GET /api/tasks/:id    the task (trimmed), its execution records turned into diagram arrows (?detailed=1 for every call) and the group chat
// The proxy adds the token on the server side. The token never reaches the browser, the page or any log.
// Only GET requests are sent to the control interface (GET /tasks, GET /tasks/:id?records=1).
//
// Lifelines, left to right: Slack, the watchdog (listener, queue, runner, gate), and the five bots.
// The record -> arrow mapping is the exported pure function buildArrows(records, task?, { detailed }):
// the concise view (default) shows only the main flow with short Chinese labels, `detailed` every tool call and narration.
// The page is two panes: the flow diagram on the left and the bot group chat (scripts/debug-ui/chat.ts) on the right.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connection } from './show-task.ts'
import { buildChat, CHAT_CSS, CHAT_JS } from './debug-ui/chat.ts'
import { fmtUsd, roundView, usageView } from '../src/task/usage.ts'

export const DEFAULT_PORT = 3092
export const LABEL_MAX = 200 // a safety cap only: the page cuts a label to the room it has between its lifelines

/** The lifelines, left to right. `id` is what an arrow's from/to hold. */
export const LANES = Object.freeze([
  { id: 'slackext', label: 'Slack' },
  { id: 'gate', label: '看门狗' },
  { id: 'main', label: '主 bot' },
  { id: 'slack', label: 'Slack bot' },
  { id: 'jira', label: 'Jira bot' },
  { id: 'pipeline', label: 'Git Pipeline bot' },
  { id: 'coding', label: '修复 bot' },
])
const LANE_IDS = LANES.map((l) => l.id)

export const STEP_LIST = Object.freeze([
  { id: 'fetch', label: '取讨论' }, { id: 'issue', label: '建工单' }, { id: 'prepare', label: '准备代码' }, { id: 'code', label: '写代码' },
  { id: 'mr', label: '开 MR' }, { id: 'ci', label: 'CI' }, { id: 'writeback', label: '回写' }, { id: 'close', label: '结束' },
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
 * @param {any} [task] the task object (its origin is used for the detail of the first arrow, its Jira key and MR link for labels)
 * @param {{ detailed?: boolean }} [options] `detailed`: every tool call and narration (default false: the concise main flow)
 * @returns {{ id: number, uid: string, recordIds: number[], from: string, to: string, kind: 'call'|'reply'|'self'|'notice', label: string,
 *   sub: string, detail: string, step: string|null, at: string|null, failed: boolean }[]} arrows (more fields: run, recordType, role, tool,
 *   args, result, ok, ms, resultAt, minor, unknown, pending; a concise arrow also has `parts`, one view per record behind it).
 *   `recordIds` are indexes into the records array; `uid` is stable while the records only grow.
 */
export function buildArrows(records, task = undefined, { detailed = false }: any = {}) {
  const all = buildDetailed(records, task)
  return detailed ? all : toConcise(all, task)
}

function buildDetailed(records, task) {
  const arrows: any[] = []
  let ri = -1 // index of the record being processed
  const perRecord: any = {}
  const pending: any[] = [] // tool calls that wait for their result: { role, tool, arrows: [] }
  const mirrors: any[] = [] // message_bot calls whose "@Name text" line the group mirrors: { role, to, text, arrow }
  const lastRound: any = {} // role -> normalized text of its latest round_end
  const lastRoundArrow: any = {} // role -> the arrow of that round_end (the group's copy of it joins its recordIds)
  const justEnded: any = {} // role -> true while its round_end has not yet been followed by another record of that role
  const lastCallRole: any = {} // tool -> role of its latest call (for records that do not name a role)
  const roundUsage: any = {} // role -> its usage records since its latest round_end (shown in that round's popup)
  let step: string | null = null
  let awaitTaskLine = false

  const push = (r, a) => {
    perRecord[ri] = (perRecord[ri] ?? -1) + 1
    const arrow = {
      id: arrows.length, uid: `${ri}.${perRecord[ri]}`, recordIds: [ri], key: null, sub: '',
      from: 'gate', to: 'gate', kind: 'self', label: '', detail: '', step, at: r.at ?? null, failed: false,
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
      push(r, { key: 'event', from: 'slackext', to: 'gate', kind: 'call', label: '@ 事件', detail: origin ? `${origin.text ?? ''}${origin.permalink ? `\n\n${origin.permalink}` : ''}` : text })
      push(r, { key: 'create', from: 'gate', to: 'gate', kind: 'self', label: '建任务/建群', detail: text })
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
      push(r, { key: 'end', from: 'gate', to: 'gate', kind: 'self', label: '解散群', detail: text, failed: /^run ended: (failed|timed_out)/.test(text) })
    } else if (/^notice \w+:/.test(text)) {
      const kind = /^notice (\w+):/.exec(text)[1]
      push(r, { from: 'gate', to: 'slackext', kind: 'notice', label: `通知 ${kind}`, detail: text })
    } else grey(r, text)
  }

  // A tool_result closes the oldest-first match of the same role and tool; the arrow keeps the result for its panel.
  const settle = (call, r, resultText, ok) => {
    call.done = true
    for (const a of call.arrows) {
      a.recordIds.push(ri)
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
        const arrow = lane === undefined
          ? push(r, { ...common, from: role, to: role, kind: 'self', label: `message_bot → ${to ?? '?'}`, detail: message, unknown: true })
          : push(r, { ...common, from: role, to: lane, kind: 'call', label: message, detail: message })
        made.push(arrow)
        mirrors.push({ role: r.role, to: String(to ?? ''), text: oneLine(`@${to} ${message}`), arrow })
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
    let arrow
    if (r.role === 'main') arrow = push(r, { from: 'main', to: 'main', kind: 'self', label: text, detail: text, minor: true, failed: Boolean(r.failed) })
    else if (isLane(r.role)) arrow = push(r, { from: r.role, to: 'main', kind: 'reply', label: text, detail: text, failed: Boolean(r.failed) })
    else arrow = grey(r, text)
    if (isLane(r.role)) lastRoundArrow[r.role] = arrow
    // what this round cost: the usage records the bot wrote since its previous round end (src/task/usage.ts roundView)
    const usage = isLane(r.role) ? roundView(roundUsage[r.role]) : null
    if (usage !== null) arrow.usage = usage
    if (isLane(r.role)) delete roundUsage[r.role]
  }

  // A usage record (one model call or one model of a CLI turn): drawn only in the detailed view, as a small self-loop;
  // its figures also go to the popup of the round it belongs to.
  const onUsage = (r) => {
    if (isLane(r.role)) (roundUsage[r.role] ??= []).push(r)
    const lane = roleLane(r)
    push(r, { from: lane, to: lane, kind: 'self', label: `用量 ${r.model ?? ''} ${r.unpriced ? '未定价' : fmtUsd(r.costUsd)}`.trim(), detail: String(r.text ?? ''), minor: true })
  }

  const onLine = (r) => {
    const text = String(r.text ?? '')
    if (!isLane(r.role)) {
      if (awaitTaskLine && /^Task /.test(text)) { awaitTaskLine = false; push(r, { key: 'task_to_main', from: 'gate', to: 'main', kind: 'call', label: '任务发到群里', detail: text }); return }
      const nudge = lastNotice()
      if (nudge !== undefined && Date.parse(r.at) - Date.parse(nudge.at) <= 5000) { nudge.detail = `${nudge.detail}\n\n${text}`; nudge.recordIds.push(ri); return }
      push(r, { from: 'gate', to: 'main', kind: 'notice', label: text, detail: text })
      return
    }
    const flat = oneLine(text)
    const mirror = mirrors.findIndex((m) => m.role === r.role && (flat === m.text || flat.startsWith(`@${m.to}`)))
    if (mirror >= 0) { mirrors[mirror].arrow.recordIds.push(ri); mirrors.splice(mirror, 1); return } // the group's copy of a message_bot call
    // the group's copy of a round_end: same text, or (the group rewrites links) the very next record of that role
    if (lastRound[r.role] === flat || justEnded[r.role]) { lastRoundArrow[r.role]?.recordIds.push(ri); delete lastRound[r.role]; delete justEnded[r.role]; return }
    push(r, { from: r.role, to: r.role, kind: 'self', label: text, detail: text, minor: true })
  }

  const list = Array.isArray(records) ? records : []
  for (let index = 0; index < list.length; index += 1) {
    const r = list[index]
    ri = index
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
        case 'usage': onUsage(r); break
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

// ------------------------------------------------------------------ the concise view

// What a call to a bot is called, by (target lane, step). Anything else falls back to the first words of the message.
const CALL_LABEL = Object.freeze({
  slack: { fetch: '取回讨论', writeback: '回复结果' },
  jira: { issue: '建单', writeback: '回写' },
  pipeline: { prepare: '准备代码', mr: '核对并开 MR' },
  coding: { code: '修复' },
})
// What a bot's round end is called, by (lane, step); a function gets the facts found so far.
const ROUND_LABEL = Object.freeze({
  slack: { fetch: '摘要（一轮结束）', writeback: '已回复' },
  jira: { issue: (f) => `Jira 单号${f.key ? ` ${f.key}` : ''}`, writeback: '已写' },
  pipeline: { prepare: '代码目录和分支', mr: 'MR 链接' },
  coding: { code: '改了什么' },
})
const REPLY_LABEL = Object.freeze({ ack: '回复已收到', result: '回复结果' })

const plain = (text) => oneLine(String(text ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`#>]/g, ''))
const firstLine = (text) => { for (const line of String(text ?? '').split('\n')) { const p = plain(line); if (p !== '') return p } return '' }
const urlIn = (text) => /[a-z][a-z0-9+.-]*:\/\/[^\s)）`，。]+/i.exec(String(text ?? ''))?.[0] ?? ''
const jsonOf = (text) => { try { return JSON.parse(String(text ?? '')) } catch { return undefined } }
const keyIn = (text) => /\b[A-Z][A-Z0-9]+-\d+\b/.exec(String(text ?? ''))?.[0] ?? ''

/** The first content line of a summary: the intro line ("摘要如下：") is skipped. */
function summaryLine(text) {
  const lines = String(text ?? '').split('\n').map(plain).filter((l) => l !== '')
  return lines.length > 1 && /摘要|总结|summary/i.test(lines[0]) ? lines[1] : lines[0] ?? ''
}

/** Files changed and test outcome, read from what the Coding bot said (the code step leaves no other trace before the MR step). */
function codingFacts(text, review) {
  const raw = String(text ?? '')
  // the files named on the lines that talk about the change; when no line does, every file the text names
  const filesIn = (text) => {
    const found = new Set<string>()
    for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#L\d+)?\)/g)) if (!/^[a-z]+:/i.test(m[1]) && /\.[A-Za-z0-9]{1,6}$/.test(m[1])) found.add(m[1].replace(/^.*\/worktrees\/[^/]+\//, ''))
    for (const m of text.matchAll(/`([\w.\-/]+\/[\w.\-]+\.[A-Za-z0-9]{1,6})`/g)) found.add(m[1])
    return [...found]
  }
  const about = filesIn(raw.split('\n').filter((line) => /修改|改了|改动|changed|modified/i.test(line)).join('\n'))
  const list = about.length > 0 ? about : filesIn(raw)
  const parts: string[] = []
  if (list.length > 0) parts.push(`改了 ${list.slice(0, 3).join('、')}${list.length > 3 ? ` 等 ${list.length} 个` : ''}`)
  const flat = oneLine(raw)
  const ratio = /(?:测试|tests?)[^。.;；\n]{0,20}?(\d+)\s*\/\s*(\d+)|(\d+)\s*\/\s*(\d+)\s*(?:个)?(?:测试|tests?|用例)?\s*(?:通过|passed|pass)/i.exec(flat)
  if (/(?:测试|tests?)[^。.;；]{0,12}(?:没有|未|没)(?:实际)?(?:运行|跑|执行)|(?:没有|未|没)(?:实际)?(?:运行|执行)[^。.;；]{0,6}(?:测试|tests?)|tests? (?:were |was )?not run/i.test(flat)) parts.push('测试未运行')
  else if (ratio) parts.push(`测试 ${ratio[1] ?? ratio[3]}/${ratio[2] ?? ratio[4]} 通过`)
  else if (/(?:测试|tests?)[^。.;；]{0,8}(?:全部)?通过|tests? pass/i.test(flat)) parts.push('测试通过')
  if (review) parts.push(`评审${review}`)
  return parts.join(' · ')
}

/** One record's view for the popup: what an arrow holds when it stands for several records. */
const partOf = (a) => ({
  recordIds: [...a.recordIds], recordType: a.recordType, at: a.at, step: a.step, from: a.from, to: a.to, role: a.role, tool: a.tool, label: a.label,
  detail: a.detail, args: a.args, result: a.result, ok: a.ok, ms: a.ms, resultAt: a.resultAt, failed: a.failed, pending: a.pending, usage: a.usage ?? null,
})

/**
 * The concise view of the detailed arrows: only the main flow, with short labels (tables above, keyed by role and step) and a grey
 * second line of key content. Step advances, task_read / jira_* / repo_* / mr_* self-loops, the main bot's own notes and the Slack
 * echo are hidden; the Slack read and its ack reply are one arrow; the Claude Code work is one self-loop with the narration and
 * tool calls behind it. Unknown records are hidden. Failures and watchdog notices always stay.
 */
function toConcise(all, task) {
  const out: any[] = []
  let advanceTo = 0 // the step number while no bot has been called since the advance
  let lastRead: any // the "读讨论" arrow: the ack reply that follows it joins it
  let work: any // the "Claude Code ..." self-loop while the Coding bot works
  const callStep: any = {} // lane -> step in which the main bot last called it
  let jiraTitle = ''
  let repoText = ''
  let mrUrl = ''
  let review = ''
  let jiraKey = task?.jira?.key ?? ''
  const stepNo = (id) => STEP_LIST.findIndex((s) => s.id === id) + 1

  const emit = (a, over: any = {}, parts: any[] | undefined = undefined) => {
    const list = parts ?? [partOf(a)]
    const c = { ...a, ...over, id: out.length, sub: clip(over.sub ?? '', LABEL_MAX), parts: list }
    c.label = clip(c.label)
    c.recordIds = [...new Set<number>(list.flatMap((p) => p.recordIds))].sort((x, y) => x - y)
    out.push(c)
    return c
  }
  const refresh = (c) => {
    c.pending = c.parts.some((p) => p.pending)
    c.failed = c.parts.some((p) => p.failed)
    c.ok = c.parts.some((p) => p.ok === false) ? false : c.parts.every((p) => p.ok === true) ? true : null
    c.ms = c.parts.reduce((sum, p) => sum + (p.ms ?? 0), 0) || null
    c.recordIds = [...new Set<number>(c.parts.flatMap((p) => p.recordIds))].sort((x, y) => x - y)
  }

  for (const a of all) {
    // facts that the hidden records hold
    if (a.tool === 'jira_create_issue') jiraTitle = jsonOf(a.args)?.title ?? jiraTitle
    if (a.tool === 'repo_prepare' && a.result) repoText = a.result
    if (a.tool === 'mr_open_draft' && a.result) mrUrl = urlIn(a.result) || mrUrl
    if (a.tool === 'review_report') { const verdict = jsonOf(a.args)?.verdict; review = verdict === 'pass' ? '通过' : verdict ? `：${verdict}` : review }
    if (keyIn(a.result) && a.tool === 'jira_create_issue') jiraKey = keyIn(a.result)

    if (a.recordType === 'advance') { advanceTo = stepNo(a.step); continue }

    // the Coding bot's own lane: its narration and tool calls are one "Claude Code" loop; refusals and errors stay red beside it
    if (a.role === 'coding' && a.from === 'coding' && a.to === 'coding' && a.recordType !== 'round_end') {
      let started = false
      if (work === undefined) {
        started = true
        work = emit(a, { label: 'Claude Code 定位并修改', kind: 'self', failed: false, pending: false, ok: null, ms: null, unknown: false, minor: false, tool: null, args: '', result: '', detail: '', uid: `${a.uid}s` }, a.failed ? [] : undefined)
      }
      if (!a.failed) {
        if (!started) work.parts.push(partOf(a))
        refresh(work)
        if (a.tool === 'review_report') work.sub = `评审${review}`
        continue
      }
    }

    if (a.tool === 'task_advance' && !a.failed) continue

    if (a.key === 'event') { emit(a, { sub: firstLine(a.detail) }); lastRead = undefined; continue }
    if (a.key === 'create') { emit(a, { label: '建任务，排队' }); continue }
    if (a.key === 'task_to_main') { emit(a, { label: '建群和成员，把任务发到群里' }); continue }
    if (a.key === 'end') { emit(a, { label: '解散群和成员，取下一个任务', sub: a.failed ? firstLine(a.detail) : '' }); continue }
    if (a.tool === 'task_close') { emit(a, { label: '结束任务', sub: jsonOf(a.args)?.outcome ? `结果 ${jsonOf(a.args).outcome}` : '' }); continue }

    if (a.tool === 'message_bot' && a.kind === 'call') {
      const message = a.detail
      const known = CALL_LABEL[a.to]?.[a.step]
      const prefix = advanceTo > 0 ? `进到第 ${advanceTo} 步，` : ''
      advanceTo = 0
      if (a.to === 'coding') work = undefined
      callStep[a.to] = a.step
      emit(a, { label: `${prefix}@ ${known ?? clip(firstLine(message), 14)}`, sub: firstLine(message) })
      lastRead = undefined
      continue
    }

    if (a.tool === 'slack_read_thread' && a.kind === 'call') {
      const count = /(\d+) message/.exec(a.result)?.[1]
      lastRead = emit(a, { label: '读讨论', sub: count ? `读到 ${count} 条消息` : '' })
      continue
    }
    if (a.tool === 'slack_reply' && a.kind === 'call') {
      const args = jsonOf(a.args)
      const purpose = String(args?.purpose ?? '')
      const label = REPLY_LABEL[purpose] ?? `回复 ${purpose}`.trim()
      const sub = firstLine(args?.text)
      if (purpose === 'ack' && lastRead !== undefined && lastRead === out.at(-1) && lastRead.from === a.from) {
        lastRead.parts.push(partOf(a))
        lastRead.label = '读讨论，回复已收到'
        lastRead.sub = lastRead.sub || sub
        refresh(lastRead)
        lastRead = undefined
      } else { emit(a, { label, sub }); lastRead = undefined }
      continue
    }
    if (a.tool?.startsWith('slack_') && a.kind === 'reply') { // the "Reply ... sent" echo is never drawn, a failure is
      if (a.failed) { emit(a, { sub: firstLine(a.detail) }); lastRead = undefined }
      continue
    }

    if (a.recordType === 'round_end' && a.kind === 'reply' && a.from !== 'main') {
      const text = a.detail
      // Label the answer by the step it was asked in: a writeback answer can land after the main
      // bot already moved on to close (second real run of T-1).
      const entry = ROUND_LABEL[a.from]?.[callStep[a.from] ?? a.step]
      const found = keyIn(text) || jiraKey
      const label = typeof entry === 'function' ? entry({ key: found }) : entry ?? clip(firstLine(text), 24)
      let sub = firstLine(text)
      if (a.from === 'slack' && a.step === 'fetch') sub = summaryLine(text)
      else if (a.from === 'jira' && a.step === 'issue') { const title = jiraTitle || /标题[：:]\s*(.+)/.exec(plain(text))?.[1] || ''; sub = [found, title].filter(Boolean).join(' · ') || sub }
      else if (a.from === 'pipeline' && a.step === 'prepare') {
        const branch = /branch ([^,\s)]+)/.exec(repoText)?.[1] ?? /分支[：:]\s*`?([^\s`]+)/.exec(text)?.[1]
        const dir = /directory (\S+)/.exec(repoText)?.[1] ?? /目录[：:]\s*`?([^\s`]+)/.exec(text)?.[1]
        if (branch || dir) sub = [branch, dir ? `…/${dir.split('/').slice(-2).join('/')}` : ''].filter(Boolean).join(' · ')
      } else if (a.from === 'pipeline' && a.step === 'mr') sub = urlIn(text) || mrUrl || task?.mr?.url || sub
      else if (a.from === 'coding') sub = codingFacts(text, review) || sub
      if (a.from === 'coding') work = undefined
      emit(a, { label, sub })
      lastRead = undefined
      continue
    }

    // failures and watchdog notices always stay; a refusal says why under the command
    if (a.failed || a.kind === 'notice') {
      const reason = (a.recordType === 'refusal' || a.recordType === 'tool_error') ? firstLine(String(a.detail).replace(/\s*\| attempted:.*$/, '')) : firstLine(a.detail)
      emit(a, { sub: reason === a.label ? '' : reason })
      lastRead = undefined
      continue
    }
    if (a.kind === 'call' && !a.unknown) { emit(a, { sub: firstLine(a.detail) }); lastRead = undefined }
  }
  return out
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
    usage: usageView(task.usage),
    runs: (task.runs ?? []).map((x) => ({ no: x.no, startedAt: x.startedAt ?? null, endedAt: x.endedAt ?? null, endReason: x.endReason ?? null })),
  }
}

const jsonForScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c')

/**
 * The page: inline CSS and JS, SVG drawing, no external resource, light and dark through prefers-color-scheme.
 * Two panes under one compact header: the flow diagram (left, takes the remaining width) and the bot group chat (right,
 * a portrait column of about 400 px, draggable between 340 and 520 px, can be hidden). The chat's CSS and JS are inlined
 * from scripts/debug-ui/chat.ts at the two CHAT placeholders.
 */
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>任务流程图</title>
<style>
:root {
  color-scheme: light;
  --bg: #faf9f6; --surface: #ffffff; --ink: #2b2b29; --muted: #8a8982; --line: #d8d6cf; --arrow: #333333; --lifeline: #bdbbb3;
  --lane-bg: #efeee9; --lane-line: #d8d6cf; --band: #cfcdc5; --hover: rgba(0, 0, 0, .045); --sel: rgba(0, 0, 0, .09);
  --c-fail: #c62828; --c-notice: #d9730d; --c-call: #333333; --c-reply: #333333; --c-self: #333333; --c-grey: #8a8982;
  --shadow: 0 8px 28px rgba(0, 0, 0, .28);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #1c1c1a; --surface: #262624; --ink: #e6e4de; --muted: #9a988f; --line: #3d3c37; --arrow: #d6d4cd; --lifeline: #66645d;
    --lane-bg: #2c2c29; --lane-line: #44433e; --band: #4a4943; --hover: rgba(255, 255, 255, .06); --sel: rgba(255, 255, 255, .13);
    --c-fail: #ff7070; --c-notice: #ffa24d; --c-call: #d6d4cd; --c-reply: #d6d4cd; --c-self: #d6d4cd; --c-grey: #9a988f;
    --shadow: 0 8px 28px rgba(0, 0, 0, .6);
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--ink); font: 12.5px/1.4 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; display: flex; flex-direction: column; overflow: hidden; }
body.dragging { cursor: col-resize; user-select: none; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 14px; padding: 5px 12px; background: var(--bg); border-bottom: 1px solid var(--line); }
header h1 { font-size: 13px; margin: 0; font-weight: 600; }
header .f { display: flex; gap: 5px; align-items: baseline; white-space: nowrap; min-width: 0; }
header .f.shrink { overflow: hidden; }
header .f.shrink a, header .f.shrink span:last-child { overflow: hidden; text-overflow: ellipsis; max-width: 30ch; }
header .k { color: var(--muted); }
header #costbox span:last-child { max-width: 80ch; }
header a { color: var(--ink); }
select { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; max-width: 280px; }
.badge { padding: 0 7px; border-radius: 9px; font-weight: 600; background: var(--lane-bg); border: 1px solid var(--lane-line); }
.badge.failed, .badge.timed_out { color: var(--c-fail); border-color: var(--c-fail); }
.badge.needs_info, .badge.stopped, .badge.expired { color: var(--c-notice); border-color: var(--c-notice); }
header label { display: flex; gap: 4px; align-items: center; color: var(--muted); cursor: pointer; white-space: nowrap; }
.live { margin-left: auto; color: var(--muted); display: flex; gap: 6px; align-items: center; white-space: nowrap; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.dot.bad { background: var(--c-fail); }
#banner { display: none; padding: 3px 12px; color: var(--c-fail); border-bottom: 1px solid var(--line); }
main { flex: 1; min-height: 0; display: flex; position: relative; }
#diagram { flex: 1; min-width: 0; position: relative; display: flex; }
#scroller { flex: 1; min-width: 0; overflow: auto; position: relative; }
#canvas { position: relative; }
#split { flex: none; width: 5px; cursor: col-resize; background: var(--line); opacity: .55; touch-action: none; }
#split:hover, #split:focus-visible, body.dragging #split { opacity: 1; outline: none; }
#chatpane { flex: none; width: 400px; min-width: 0; display: flex; flex-direction: column; background: var(--surface); }
#chat { flex: 1; min-height: 0; overflow: hidden; position: relative; } /* the chat scrolls inside itself (scripts/debug-ui/chat-client.js) */
body.nochat #split, body.nochat #chatpane { display: none; }
.lanes { display: flex; position: sticky; top: 0; z-index: 3; background: var(--bg); padding: 4px 0 0; }
.lanes.bottom { position: static; padding: 0 0 4px; }
.lane { flex: none; padding: 0 5px; }
.lane small { display: block; height: 14px; line-height: 14px; padding: 0 4px; text-align: center; font-size: 10px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lane i { display: block; height: 28px; line-height: 26px; padding: 0 4px; text-align: center; font-style: normal; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: var(--lane-bg); border: 1px solid var(--lane-line); border-radius: 3px; }
svg { display: block; font-family: inherit; }
svg text { fill: var(--ink); paint-order: stroke; stroke: var(--bg); stroke-width: 3px; stroke-linejoin: round; }
.lifeline { stroke: var(--lifeline); stroke-width: 1; }
.bandline { stroke: var(--band); stroke-width: 1; }
text.cap { font-size: 9.5px; fill: var(--muted); }
text.lbl { font-size: 12px; }
text.sub { font-size: 10.5px; fill: var(--muted); }
.arrow { cursor: pointer; outline: none; }
.arrow .hit { fill: transparent; }
.arrow:hover .hit, .arrow:focus-visible .hit { fill: var(--hover); }
.arrow.sel .hit { fill: var(--sel); }
.arrow .ln { fill: none; stroke: var(--arrow); stroke-width: 1.15; }
.arrow.sel .ln { stroke-width: 1.9; }
.arrow.reply .ln { stroke-dasharray: 5 3; }
.arrow.pending { opacity: .62; }
.arrow.grey .ln { stroke: var(--c-grey); }
.arrow.grey text.lbl { fill: var(--muted); }
.arrow.fail .ln { stroke: var(--c-fail); }
.arrow.fail text.lbl, .arrow.fail text.sub { fill: var(--c-fail); }
.arrow.notice .ln { stroke: var(--c-notice); }
.arrow.notice text.lbl, .arrow.notice text.sub { fill: var(--c-notice); }
.mk-n { fill: var(--arrow); } .mk-g { fill: var(--c-grey); } .mk-f { fill: var(--c-fail); } .mk-o { fill: var(--c-notice); }
.empty { padding: 40px; color: var(--muted); text-align: center; }
#jump { position: absolute; right: 18px; bottom: 12px; z-index: 6; display: none; border: 1px solid var(--lane-line); border-radius: 14px; padding: 4px 12px; background: var(--ink); color: var(--bg); font: inherit; font-weight: 600; cursor: pointer; box-shadow: var(--shadow); }
#modal { position: fixed; inset: 0; z-index: 50; display: none; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, .45); }
#modal.open { display: flex; }
#card { background: var(--surface); color: var(--ink); width: 100%; max-width: 800px; max-height: 88vh; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
#mhead { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px 8px; border-bottom: 1px solid var(--line); }
#mhead h2 { flex: 1; margin: 0; font-size: 14px; font-weight: 600; word-break: break-word; }
#mhead p { margin: 2px 0 0; color: var(--muted); font-size: 11.5px; font-weight: 400; word-break: break-word; }
#mclose { flex: none; border: 0; background: none; color: var(--muted); font-size: 22px; line-height: 1; cursor: pointer; padding: 0 4px; }
#mbody { overflow: auto; padding: 4px 14px 14px; }
.part { padding: 10px 0; border-bottom: 1px dashed var(--line); }
.part:last-child { border-bottom: 0; }
.phead { display: flex; flex-wrap: wrap; gap: 2px 8px; color: var(--muted); font-size: 11.5px; margin-bottom: 6px; }
.phead b { color: var(--ink); font-weight: 600; }
.phead .bad { color: var(--c-fail); font-weight: 600; }
.phead .warn { color: var(--c-notice); }
.usage { margin-top: 8px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); font-size: 11.5px; line-height: 1.55; }
.usage b { color: var(--ink); font-weight: 600; }
.usage .warn { color: var(--c-notice); }
.blk { margin-top: 8px; }
.bh { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 11px; margin-bottom: 3px; }
.bh button { font: inherit; font-size: 11px; color: var(--ink); background: var(--lane-bg); border: 1px solid var(--lane-line); border-radius: 3px; padding: 0 7px; cursor: pointer; }
.txt { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.55; }
.blk pre { margin: 0; padding: 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; white-space: pre-wrap; word-break: break-word; font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 38vh; overflow: auto; }
@media (max-width: 760px) {
  main { flex-direction: column; }
  #split { display: none; }
  #chatpane { width: auto !important; height: 42%; border-top: 1px solid var(--line); }
}
</style>
<style>/*CHAT_CSS*/</style>
</head>
<body>
<header>
  <h1>任务流程图</h1>
  <div class="f"><span class="k">任务</span><select id="pick" aria-label="选择任务"></select></div>
  <div class="f"><span class="k">状态</span><span id="state" class="badge">-</span></div>
  <div class="f"><span class="k">已用</span><span id="elapsed">-</span></div>
  <div class="f shrink" id="costbox" title="还没有用量记录"><span class="k">花费</span><span id="cost">-</span></div>
  <div class="f shrink"><span class="k">Jira</span><span id="jira">-</span></div>
  <div class="f shrink"><span class="k">MR</span><span id="mr">-</span></div>
  <div class="f"><span class="k">当前步骤</span><span id="step">-</span></div>
  <label title="显示每一次工具调用和旁白"><input type="checkbox" id="detailed"> 详细</label>
  <label title="显示或隐藏右侧的群聊"><input type="checkbox" id="chatToggle" checked> 群聊</label>
  <div class="live"><span class="dot" id="dot"></span><span id="liveText">连接中</span></div>
</header>
<div id="banner"></div>
<main>
  <section id="diagram"><div id="scroller"><div id="canvas"></div></div><button id="jump" type="button">↓ 最新</button></section>
  <div id="split" role="separator" aria-orientation="vertical" aria-label="调整群聊宽度" tabindex="0" title="拖动调整群聊宽度"></div>
  <section id="chatpane" aria-label="群聊"><div id="chat"></div></section>
</main>
<div id="modal" role="dialog" aria-modal="true" aria-labelledby="mtitle">
  <div id="card">
    <div id="mhead"><h2><span id="mtitle"></span><p id="msub"></p></h2><button id="mclose" type="button" aria-label="关闭">×</button></div>
    <div id="mbody"></div>
  </div>
</div>
<script type="application/json" id="boot">/*BOOT*/</script>
<script>/*CHAT_JS*/</script>
<script>
(function () {
  'use strict';
  var BOOT = JSON.parse(document.getElementById('boot').textContent);
  var LANES = BOOT.lanes, STEPS = BOOT.steps, STATES = BOOT.states, N = LANES.length;
  var KIND_NAME = { call: '调用', reply: '回复 / 结果', self: '自身动作', notice: '看门狗通知' };
  var LANE_NAME = {}; LANES.forEach(function (l) { LANE_NAME[l.id] = l.label; });
  var STEP_NAME = {}, STEP_CAP = {}; STEPS.forEach(function (s, i) { STEP_NAME[s.id] = (i + 1) + ' ' + s.label; STEP_CAP[s.id] = '第 ' + (i + 1) + ' 步 · ' + s.label; });
  var ROW_H = 32, PAD = 4, MIN_COL = 90, LOOP = 22, FS = 12, FS_SUB = 10.5, CHAT_MIN = 340, CHAT_MAX = 520, NS = 'http://www.w3.org/2000/svg';
  var $ = function (id) { return document.getElementById(id); };

  function stored(k, d) { try { var v = localStorage.getItem('flow-page:' + k); return v === null ? d : v; } catch (e) { return d; } }
  function store(k, v) { try { localStorage.setItem('flow-page:' + k, String(v)); } catch (e) { /* private window: the toggles still work, they are just not remembered */ } }
  function clampW(w) { return Math.max(CHAT_MIN, Math.min(CHAT_MAX, Math.round(w))); }

  var state = {
    tasks: [], taskId: null, userPicked: false, task: null, arrows: [], chat: null, fetchedAt: 0,
    sel: null, selIds: [], popup: null, stick: true, unseen: 0, sig: '', chatSig: '', prog: false, userAt: 0, lastW: 0,
    detailed: stored('detailed', '0') === '1', showChat: stored('chat', '1') !== '0', chatW: clampW(Number(stored('chatW', '400')) || 400), drag: false, error: null,
  };

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var mctx = null; try { mctx = document.createElement('canvas').getContext('2d'); } catch (e) { mctx = null; }
  var FONT = getComputedStyle(document.body).fontFamily;
  function tw(s, size) {
    if (mctx) { mctx.font = size + 'px ' + FONT; return mctx.measureText(s).width; }
    var w = 0; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); w += (c > 0x2e7f ? 1 : (c > 0x7f ? 0.66 : 0.53)) * size; } return w;
  }
  /** The longest start of the text that fits px pixels, with an ellipsis when it was cut. */
  function fit(s, px, size) {
    if (!s || px <= 8) return '';
    if (tw(s, size) <= px) return s;
    var lo = 0, hi = s.length;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (tw(s.slice(0, mid) + '…', size) <= px) lo = mid; else hi = mid - 1; }
    return lo > 0 ? s.slice(0, lo) + '…' : '…';
  }
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
    if (isWeb(url || text)) { var a = document.createElement('a'); a.href = url || text; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = text; a.title = text; el.appendChild(a); } else { el.textContent = text; el.title = text; }
  }
  function renderHeader() {
    var t = state.task, st = $('state');
    if (!t) { st.textContent = '-'; st.className = 'badge'; $('elapsed').textContent = '-'; $('jira').textContent = '-'; $('mr').textContent = '-'; $('step').textContent = '-'; $('cost').textContent = '-'; $('costbox').title = ''; return; }
    // the bill: total cost and usage, the average output speed with DSH's part and the derived part named (the strings are built on the server)
    $('cost').textContent = t.usage ? t.usage.line.replace(/^花费 /, '') : '-';
    $('costbox').title = t.usage ? t.usage.title : '还没有用量记录';
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
  function sortedTasks() { return state.tasks.slice().sort(function (a, b) { return idNum(b.id) - idNum(a.id); }); }
  function renderPicker() {
    var sel = $('pick'), list = sortedTasks();
    var key = list.map(function (t) { return [t.id, t.state, t.step, t.jiraKey].join('|'); }).join(';') + '#' + state.taskId;
    if (sel.getAttribute('data-key') === key) return;
    if (document.activeElement === sel && sel.options.length > 0) return; // do not rebuild a list the user has open; it is redone on the next poll
    sel.setAttribute('data-key', key);
    sel.textContent = '';
    if (!list.length) { var o = document.createElement('option'); o.textContent = '(没有任务)'; sel.appendChild(o); return; }
    list.forEach(function (t) {
      var o = document.createElement('option'); o.value = t.id;
      o.textContent = t.id + ' · ' + (STATES[t.state] || t.state) + (t.step ? ' · ' + (STEP_NAME[t.step] || t.step) : '') + (t.jiraKey ? ' · ' + t.jiraKey : '') + (t.totalUsd > 0 ? ' · $' + (t.totalUsd >= 0.01 ? t.totalUsd.toFixed(2) : t.totalUsd.toFixed(4)) + (t.unpriced ? '+' : '') : '');
      if (t.id === state.taskId) o.selected = true;
      sel.appendChild(o);
    });
  }
  function choose() {
    var list = sortedTasks();
    if (!list.length) return null;
    var want = state.userPicked ? state.taskId : (decodeURIComponent((location.hash || '').slice(1)) || null);
    if (want && list.some(function (t) { return t.id === want; })) { if (!state.userPicked && location.hash) state.userPicked = true; return want; }
    if (state.userPicked && state.taskId && list.some(function (t) { return t.id === state.taskId; })) return state.taskId;
    var running = list.filter(function (t) { return t.state === 'running'; })[0];
    return (running || list[0]).id;
  }

  // ---- the diagram -------------------------------------------------------------------------
  function tone(a) {
    if (a.failed) return 'f';
    if (a.kind === 'notice') return 'o';
    if (a.unknown || a.minor) return 'g';
    return 'n';
  }
  function laneIndex(id) { for (var i = 0; i < N; i++) if (LANES[i].id === id) return i; return -1; }
  function atBottom() { var s = $('scroller'); return s.scrollTop + s.clientHeight >= s.scrollHeight - 40; }
  /** A scroll the page makes itself must not be taken for the user leaving the bottom. */
  function setScroll(top, left) {
    var s = $('scroller'); state.prog = true;
    if (top != null) s.scrollTop = top;
    if (left != null) s.scrollLeft = left;
    requestAnimationFrame(function () { state.prog = false; });
  }
  function scrollEnd() { setScroll($('scroller').scrollHeight, null); }

  function render() {
    var scroller = $('scroller'), canvas = $('canvas');
    var top = scroller.scrollTop, left = scroller.scrollLeft;
    var arrows = state.arrows;
    var avail = scroller.clientWidth || 800;
    state.lastW = avail;
    var colW = Math.max(MIN_COL, avail / N), W = colW * N; // all lanes fit the width; below MIN_COL per lane the diagram scrolls sideways
    var cx = function (i) { return i * colW + colW / 2; };
    var multiRun = arrows.some(function (a) { return a.run > 1; });
    var parts = [], y = PAD, prevStep = null, prevRun = null, first = true;
    var rows = arrows.map(function (a) {
      var row = { a: a, top: y, band: first || a.step !== prevStep || a.run !== prevRun };
      first = false; prevStep = a.step; prevRun = a.run; y += ROW_H;
      return row;
    });
    var H = y + PAD;
    var svg = ['<svg id="svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" xmlns="' + NS + '"><defs>'];
    ['n', 'g', 'f', 'o'].forEach(function (k) {
      svg.push('<marker id="mk-' + k + '" viewBox="0 0 10 8" refX="10" refY="4" markerWidth="9" markerHeight="7.2" markerUnits="userSpaceOnUse" orient="auto"><path class="mk-' + k + '" d="M0,0 L10,4 L0,8 z"/></marker>');
    });
    svg.push('</defs>');
    for (var i = 0; i < N; i++) svg.push('<line class="lifeline" x1="' + cx(i) + '" y1="0" x2="' + cx(i) + '" y2="' + H + '"/>');

    rows.forEach(function (row) {
      var a = row.a, t = row.top, ya = t + 19, tn = tone(a);
      var fi = laneIndex(a.from), ti = laneIndex(a.to);
      if (fi < 0) fi = 1; if (ti < 0) ti = fi;
      var label = a.label + (a.pending ? ' …' : ''), sub = a.sub || '', body, bbL, bbR;
      var cls = 'arrow ' + a.kind + (tn === 'g' ? ' grey' : '') + (a.failed ? ' fail' : '') + (a.kind === 'notice' && !a.failed ? ' notice' : '') + (a.pending ? ' pending' : '') + (state.sel === a.uid ? ' sel' : '');
      if (fi === ti) {
        // a small rounded loop to the right of the lifeline, the label above it; at the right edge the text goes to the left instead
        var x = cx(fi), L = LOOP;
        var rightEdge = fi + 2 < N ? cx(fi + 2) - 8 : W - 6, leftEdge = fi - 2 >= 0 ? cx(fi - 2) + 8 : 6;
        var roomR = rightEdge - (x + 4), roomL = (x + L + 2) - leftEdge;
        var right = tw(label, FS) <= roomR || roomR >= roomL;
        var lab = fit(label, right ? roomR : roomL, FS);
        var y1 = t + 15, y2 = t + 25, r = 4;
        var path = 'M' + x + ' ' + y1 + ' H' + (x + L - r) + ' Q' + (x + L) + ' ' + y1 + ' ' + (x + L) + ' ' + (y1 + r) + ' V' + (y2 - r) + ' Q' + (x + L) + ' ' + y2 + ' ' + (x + L - r) + ' ' + y2 + ' H' + (x + 2);
        var tx, sx, sAnchor, sText, lw = tw(lab, FS);
        if (right) { tx = x + 4; sx = x + L + 8; sAnchor = 'start'; sText = fit(sub, rightEdge - sx, FS_SUB); bbL = x - 6; bbR = Math.max(x + L + 4, tx + lw, sx + tw(sText, FS_SUB)); }
        else { tx = x + L + 2; sx = x - 6; sAnchor = 'end'; sText = fit(sub, sx - leftEdge, FS_SUB); bbL = Math.min(x - 6, tx - lw, sx - tw(sText, FS_SUB)); bbR = x + L + 4; }
        body = '<path class="ln" d="' + path + '" marker-end="url(#mk-' + tn + ')"/><text class="lbl" x="' + tx + '" y="' + (t + 12.5) + '" text-anchor="' + (right ? 'start' : 'end') + '">' + esc(lab) + '</text>' +
          (sText ? '<text class="sub" x="' + sx + '" y="' + (t + 24) + '" text-anchor="' + sAnchor + '">' + esc(sText) + '</text>' : '');
      } else {
        var x1 = cx(fi), x2 = cx(ti), mid = (x1 + x2) / 2, span = Math.abs(x2 - x1);
        var lab2 = fit(label, span - 14, FS), sText2 = fit(sub, span - 30, FS_SUB);
        body = '<line class="ln" x1="' + x1 + '" y1="' + ya + '" x2="' + x2 + '" y2="' + ya + '" marker-end="url(#mk-' + tn + ')"/><text class="lbl" x="' + mid + '" y="' + (t + 12.5) + '" text-anchor="middle">' + esc(lab2) + '</text>' +
          (sText2 ? '<text class="sub" x="' + mid + '" y="' + (t + 30) + '" text-anchor="middle">' + esc(sText2) + '</text>' : '');
        bbL = Math.min(x1, x2) - 2; bbR = Math.max(x1, x2) + 2;
      }
      bbL = Math.max(0, bbL); bbR = Math.min(W, bbR);
      row.bbL = bbL; row.bbR = bbR;
      svg.push('<g class="' + cls + '" data-u="' + esc(a.uid) + '" tabindex="0" role="button" aria-label="' + esc(a.label) + '"><title>' + esc(a.label + (a.sub ? ' — ' + a.sub : '')) + '</title><rect class="hit" x="' + bbL + '" y="' + (t + 1) + '" width="' + (bbR - bbL) + '" height="' + (ROW_H - 2) + '" rx="3"/>' + body + '</g>');
    });
    // step bands: a thin line over the first row of a step, its caption inline at the left edge (right edge when a label is in the way)
    rows.forEach(function (row) {
      if (!row.band) return;
      var a = row.a, cap = (multiRun && a.run ? '第 ' + a.run + ' 次运行 · ' : '') + (a.step ? (STEP_CAP[a.step] || a.step) : '(步骤未知)');
      var cw = tw(cap, 9.5);
      var onLeft = !(row.bbL < 6 + cw + 10) || row.bbR > W - cw - 16;
      svg.push('<line class="bandline" x1="0" y1="' + row.top + '" x2="' + W + '" y2="' + row.top + '"/><text class="cap" x="' + (onLeft ? 6 : W - 6) + '" y="' + (row.top + 10) + '" text-anchor="' + (onLeft ? 'start' : 'end') + '">' + esc(cap) + '</text>');
    });
    svg.push('</svg>');
    var byRole = (state.task && state.task.usage && state.task.usage.byRole) || {};
    var laneHtml = LANES.map(function (l) { var u = byRole[l.id]; return '<div class="lane" style="width:' + colW + 'px"><i title="' + esc(l.label) + '">' + esc(l.label) + '</i><small title="' + esc(u ? u.subtitle + (u.tpsLabel ? '\n速度：' + u.tpsLabel : '') : '') + '">' + esc(u ? u.subtitle : '') + '</small></div>'; }).join('');
    canvas.style.width = W + 'px';
    canvas.innerHTML = '<div class="lanes" style="width:' + W + 'px">' + laneHtml + '</div>' + (arrows.length ? svg.join('') : '<div class="empty">这个任务还没有记录</div>') + '<div class="lanes bottom" style="width:' + W + 'px">' + laneHtml + '</div>';
    // follow the newest arrow only while the user is at the bottom, is not scrolling and has no popup open
    var follow = state.stick && !state.popup && Date.now() - state.userAt > 1500;
    if (follow) scrollEnd(); else setScroll(top, left);
    return follow;
  }

  // ---- selecting: the popup, the highlight in the diagram and in the chat -----------------------
  function arrowByUid(uid) { for (var i = 0; i < state.arrows.length; i++) if (state.arrows[i].uid === uid) return state.arrows[i]; return null; }
  function markSel() {
    var all = $('canvas').querySelectorAll('g.arrow.sel');
    for (var i = 0; i < all.length; i++) all[i].setAttribute('class', all[i].getAttribute('class').replace(' sel', ''));
    if (state.sel == null) return;
    var g = $('canvas').querySelector('g.arrow[data-u="' + String(state.sel).replace(/"/g, '') + '"]');
    if (g) g.setAttribute('class', g.getAttribute('class') + ' sel');
  }
  function highlightInChat(ids) { try { if (window.highlightChat) window.highlightChat($('chat'), ids || []); } catch (e) { /* the chat pane is optional */ } }
  /** The arrow that holds one of the records; a record no arrow shows (concise view) belongs to the nearest earlier arrow. */
  function arrowForRecords(ids) {
    if (!ids || !ids.length) return null;
    var i, a, best = null;
    for (i = 0; i < state.arrows.length && !best; i++) { a = state.arrows[i]; if ((a.recordIds || []).some(function (x) { return ids.indexOf(x) >= 0; })) best = a; }
    if (best) return best;
    var target = Math.min.apply(null, ids), candMax = -1;
    state.arrows.forEach(function (b) { var r = b.recordIds || []; if (!r.length) return; var mn = Math.min.apply(null, r); if (mn <= target && mn > candMax) { candMax = mn; best = b; } });
    return best || state.arrows[0] || null;
  }
  function onChatSelect(ids) {
    var a = arrowForRecords(ids);
    if (!a) return;
    state.sel = a.uid; state.selIds = ids || []; markSel();
    var g = $('canvas').querySelector('g.arrow[data-u="' + String(a.uid).replace(/"/g, '') + '"]');
    if (g) {
      var s = $('scroller'), rr = g.getBoundingClientRect(), sr = s.getBoundingClientRect();
      setScroll(s.scrollTop + (rr.top - sr.top) - s.clientHeight / 2, null);
      state.stick = atBottom(); // a scroll the page made by itself still decides whether the newest arrow is followed
    }
  }
  function openArrow(uid) {
    var a = arrowByUid(uid);
    if (!a) return;
    state.sel = a.uid; state.selIds = a.recordIds || []; markSel();
    openPopup(a);
    highlightInChat(state.selIds);
  }

  // ---- the popup ---------------------------------------------------------------------------
  var lastFocus = null;
  function copyText(text, btn) {
    var done = function () { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1200); };
    var fallback = function () {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = '复制失败'; }
      document.body.removeChild(ta);
    };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
  }
  function block(parent, title, text, mono) {
    if (!text) return;
    var b = document.createElement('div'); b.className = 'blk';
    var h = document.createElement('div'); h.className = 'bh';
    var t = document.createElement('span'); t.textContent = title;
    var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = '复制'; btn.onclick = function () { copyText(text, btn); };
    h.appendChild(t); h.appendChild(btn); b.appendChild(h);
    var body = document.createElement(mono ? 'pre' : 'div'); if (!mono) body.className = 'txt'; body.textContent = text; b.appendChild(body);
    parent.appendChild(b);
  }
  function span(parent, text, cls) { var s = document.createElement('span'); s.textContent = text; if (cls) s.className = cls; parent.appendChild(s); return s; }
  function partNode(p, i, n) {
    var sec = document.createElement('div'); sec.className = 'part';
    var head = document.createElement('div'); head.className = 'phead';
    if (n > 1) { var b = document.createElement('b'); b.textContent = '记录 ' + (i + 1) + '/' + n; head.appendChild(b); }
    var when = span(head, clock(p.at)); when.title = fullTime(p.at);
    span(head, p.step ? (STEP_CAP[p.step] || p.step) : '步骤未知');
    span(head, (LANE_NAME[p.from] || p.from) + (p.from === p.to ? ' (自身)' : ' → ' + (LANE_NAME[p.to] || p.to)));
    span(head, (p.recordType || '') + (p.tool ? ' · ' + p.tool : ''));
    if (p.failed || p.ok === false) span(head, '失败' + (p.ms != null ? ' · ' + p.ms + ' ms' : ''), 'bad');
    else if (p.pending) span(head, '等待结果 …', 'warn');
    else if (p.ok === true) span(head, 'ok' + (p.ms != null ? ' · ' + p.ms + ' ms' : ''));
    else if (p.ms != null) span(head, p.ms + ' ms');
    if (p.resultAt) { var rt = span(head, '结果 ' + clock(p.resultAt)); rt.title = fullTime(p.resultAt); }
    sec.appendChild(head);
    if (p.usage && p.usage.lines && p.usage.lines.length) {
      var u = document.createElement('div'); u.className = 'usage';
      var ut = document.createElement('b'); ut.textContent = p.usage.title + (p.usage.unpriced ? '（含未定价，未计入花费）' : ''); u.appendChild(ut);
      p.usage.lines.forEach(function (line) { var d = document.createElement('div'); d.textContent = line; u.appendChild(d); });
      sec.appendChild(u);
    }
    block(sec, '完整文本', p.detail, false);
    block(sec, '参数 args', p.args && p.args !== p.detail ? p.args : '', true);
    block(sec, '结果 result', p.result, true);
    return sec;
  }
  function openPopup(a) {
    var body = $('mbody'); body.textContent = '';
    $('mtitle').textContent = a.label || '(无标题)';
    $('msub').textContent = (KIND_NAME[a.kind] || a.kind) + (a.sub ? ' · ' + a.sub : '');
    var list = a.parts && a.parts.length ? a.parts : [a];
    list.forEach(function (p, i) { body.appendChild(partNode(p, i, list.length)); });
    lastFocus = document.activeElement;
    $('modal').className = 'open';
    state.popup = a.uid;
    body.scrollTop = 0;
    $('mclose').focus();
  }
  function closePopup() {
    if (!state.popup) return;
    state.popup = null; $('modal').className = ''; $('mbody').textContent = '';
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* the element is gone after a redraw */ } }
  }

  // ---- the chat pane -----------------------------------------------------------------------
  function chatSigOf(chat) {
    var m = chat && chat.messages || [], len = 0;
    m.forEach(function (x) { len += String(x.text || '').length + (x.ok === false ? 1 : 0); });
    return m.length + ':' + len + ':' + (m.length ? m[m.length - 1].id : '') + ':' + (chat && chat.usage ? chat.usage.line : '');
  }
  function renderChatPane() {
    var el = $('chat');
    if (!state.chat || !window.renderChat) return;
    var sig = chatSigOf(state.chat);
    if (sig === state.chatSig) return;
    state.chatSig = sig;
    // renderChat only touches what changed and keeps the reader's place (follows the newest message only at the bottom)
    try { window.renderChat(el, state.chat, { onSelect: onChatSelect }); } catch (e) { /* a broken chat pane must not stop the diagram */ }
  }

  // ---- polling -----------------------------------------------------------------------------
  function status(ok, text) { $('dot').className = 'dot' + (ok ? '' : ' bad'); $('liveText').textContent = text; }
  function sigOf(arrows, task) {
    return arrows.length + ':' + arrows.map(function (a) { return a.uid + (a.pending ? 'p' : '') + (a.failed ? 'f' : '') + (a.usage ? 'u' : '') + a.label.length + (a.sub || '').length + (a.parts ? a.parts.length : 0) + (a.result || '').length; }).join(',') + '|' + (task && task.usage ? task.usage.line : '');
  }
  function apply(d, taskId, detailed) {
    if (taskId !== state.taskId || detailed !== state.detailed) return; // a late answer for another task or the other view
    var before = state.arrows.length, sig = sigOf(d.arrows || [], d.task);
    state.task = d.task; state.fetchedAt = Date.now(); state.arrows = d.arrows || []; state.chat = d.chat || null;
    renderHeader();
    if (sig !== state.sig) {
      state.sig = sig;
      var followed = render();
      markSel();
      var grew = state.arrows.length - before;
      if (!followed && before > 0 && grew > 0) state.unseen += grew;
    }
    renderChatPane();
    $('jump').style.display = state.unseen > 0 ? 'block' : 'none';
    if (state.unseen > 0) $('jump').textContent = '↓ ' + state.unseen + ' 条新消息';
  }
  function taskPath(id) { return '/api/tasks/' + encodeURIComponent(id) + (state.detailed ? '?detailed=1' : ''); }
  function fetchTask() {
    var id = state.taskId, mode = state.detailed;
    return getJson(taskPath(id)).then(function (d) { apply(d, id, mode); });
  }
  function switchTo(id) {
    state.taskId = id; state.task = null; state.arrows = []; state.chat = null; state.sel = null; state.selIds = []; state.sig = ''; state.chatSig = '';
    state.stick = true; state.unseen = 0; closePopup();
    renderHeader(); render();
    try { if (window.renderChat) window.renderChat($('chat'), { members: [], messages: [] }, { onSelect: onChatSelect }); } catch (e) { /* see renderChatPane */ }
  }
  var timer = null;
  function poll() {
    getJson('/api/tasks').then(function (list) {
      state.tasks = list.tasks || [];
      var want = choose();
      if (want !== state.taskId) switchTo(want);
      renderPicker();
      if (!state.taskId) { $('canvas').innerHTML = '<div class="empty">还没有任务</div>'; return null; }
      return fetchTask();
    }).then(function () {
      state.error = null; $('banner').style.display = 'none'; status(true, '实时 · 每 2 秒');
    }).catch(function (e) {
      state.error = e.message; $('banner').textContent = '连接失败：' + e.message + '（继续重试，当前画面是上一次的数据）'; $('banner').style.display = 'block'; status(false, '断开');
    }).then(function () { timer = setTimeout(poll, 2000); });
  }

  // ---- wiring ------------------------------------------------------------------------------
  function uidOf(e) { var g = e.target.closest && e.target.closest('g.arrow'); return g ? g.getAttribute('data-u') : null; }
  $('canvas').addEventListener('click', function (e) { var u = uidOf(e); if (u != null) openArrow(u); });
  $('canvas').addEventListener('keydown', function (e) { if (e.key !== 'Enter' && e.key !== ' ') return; var u = uidOf(e); if (u != null) { e.preventDefault(); openArrow(u); } });
  var touched = function () { state.userAt = Date.now(); };
  ['wheel', 'touchmove', 'mousedown'].forEach(function (n) { $('scroller').addEventListener(n, touched, { passive: true }); });
  $('scroller').addEventListener('scroll', function () {
    if (state.prog) return;
    state.stick = atBottom();
    if (state.stick) { state.unseen = 0; $('jump').style.display = 'none'; }
  });
  $('jump').onclick = function () { state.stick = true; state.unseen = 0; state.userAt = 0; $('jump').style.display = 'none'; scrollEnd(); };
  $('pick').onchange = function () { state.userPicked = true; location.hash = '#' + encodeURIComponent(this.value); switchTo(this.value); renderPicker(); fetchTask().catch(function () {}); };
  $('detailed').checked = state.detailed;
  $('detailed').onchange = function () {
    state.detailed = this.checked; store('detailed', this.checked ? '1' : '0');
    state.arrows = []; state.sig = ''; state.sel = null; state.selIds = []; state.stick = true; state.unseen = 0; state.userAt = 0;
    render(); fetchTask().catch(function () {});
  };
  function applyChatLayout() {
    document.body.classList.toggle('nochat', !state.showChat);
    $('chatpane').style.width = state.chatW + 'px';
    $('chatToggle').checked = state.showChat;
  }
  $('chatToggle').onchange = function () { state.showChat = this.checked; store('chat', this.checked ? '1' : '0'); applyChatLayout(); };
  function setChatW(w) { state.chatW = clampW(w); $('chatpane').style.width = state.chatW + 'px'; }
  $('split').addEventListener('pointerdown', function (e) { e.preventDefault(); try { this.setPointerCapture(e.pointerId); } catch (x) { /* older engines */ } state.drag = true; document.body.classList.add('dragging'); });
  $('split').addEventListener('pointermove', function (e) { if (state.drag) setChatW(window.innerWidth - e.clientX); });
  var endDrag = function () { if (!state.drag) return; state.drag = false; document.body.classList.remove('dragging'); store('chatW', state.chatW); };
  $('split').addEventListener('pointerup', endDrag);
  $('split').addEventListener('pointercancel', endDrag);
  $('split').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setChatW(state.chatW + 20); store('chatW', state.chatW); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setChatW(state.chatW - 20); store('chatW', state.chatW); }
  });
  $('mclose').onclick = closePopup;
  $('modal').addEventListener('mousedown', function (e) { if (e.target === $('modal')) closePopup(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (state.popup) { closePopup(); return; }
    if (state.sel != null) { state.sel = null; state.selIds = []; markSel(); highlightInChat([]); }
  });
  $('pick').addEventListener('blur', renderPicker);
  var resizeTimer = null;
  var relayout = function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { if ($('scroller').clientWidth !== state.lastW) { render(); markSel(); } }, 80); };
  if (typeof ResizeObserver === 'function') new ResizeObserver(relayout).observe($('scroller')); else window.addEventListener('resize', relayout);
  setInterval(tickElapsed, 1000);
  applyChatLayout();
  render(); poll();
})();
</script>
</body>
</html>
`

// The served page: the boot data and the chat pane's CSS and JS go in at their placeholders (replacer functions: no `$` expansion).
const pageBody = () => PAGE_HTML
  .replace('/*BOOT*/', () => jsonForScript({ lanes: LANES, steps: STEP_LIST, states: STATE_LABELS }))
  .replace('/*CHAT_CSS*/', () => CHAT_CSS)
  .replace('/*CHAT_JS*/', () => CHAT_JS.replace(/<\/script/gi, '<\\/script'))

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
    const url = new URL(rawUrl ?? '/', 'http://127.0.0.1')
    const path = url.pathname
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
      // the diagram (concise unless ?detailed=1) and the group chat of the same records; a chat that fails to build must not stop the diagram
      let chat: any = { members: [], messages: [] }
      try { chat = buildChat(records ?? [], task) } catch { /* keep the empty chat */ }
      return json(200, { task: trimTask(task, now()), arrows: buildArrows(records ?? [], task, { detailed: url.searchParams.get('detailed') === '1' }), chat, serverNow: now() })
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
