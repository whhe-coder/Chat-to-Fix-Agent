// The bot group chat for the debug UI (right pane): the task group's conversation as the bots saw it,
// turned from a task's execution records (core/task/recorder.ts) into chat messages.
//
//   buildChat(records, task) -> { title, state, step, members, messages }   (pure, node-testable)
//   CHAT_CSS / CHAT_JS                                                      (browser code the page inlines)
//   renderMarkdown(text, opts)                                              (the same Markdown code the browser runs, for tests)
//
// The browser code lives next to this file (chat-client.js, chat.css) so it is plain JS/CSS, not escaped template
// strings. CHAT_JS defines window.renderChat(container, chat, { onSelect(recordIds) }) and
// window.highlightChat(container, recordIds). It uses no external resource, no import and no build step.
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { roundView, summarize, usageView } from '../../core/task/usage.ts'

export const CHAT_CSS: string = readFileSync(new URL('./chat.css', import.meta.url), 'utf8')
export const CHAT_JS: string = readFileSync(new URL('./chat-client.js', import.meta.url), 'utf8')

/** The bots of a task, in lane order. */
export const BOT_ROLES = Object.freeze(['main', 'slack', 'jira', 'pipeline', 'coding'])
const ROLE_LABEL = { main: 'Main', slack: 'Slack', jira: 'Jira', pipeline: 'Pipeline', coding: 'Coding' }
// One colour per role (mid-saturation inks that read on light and dark grounds; palette after the DS Bot INKS).
const ROLE_COLOR = { main: '#4d6bfe', slack: '#ec2f6b', jira: '#2563eb', pipeline: '#ff6b1a', coding: '#10b981', user: '#8a8f98' }
const STEP_LABEL = { fetch: '取讨论', issue: '建工单', prepare: '准备代码', code: '写代码', mr: '开 MR', ci: 'CI', writeback: '回写', close: '结束' }
const stepLabel = (id) => STEP_LABEL[id] ?? id

// usage: what the bot cost so far (core/task/usage.ts usageView byRole): model, cost, tokens and the latest speed with its source tag
export type ChatMember = { role: string, name: string, color: string, usage?: any }
export type ChatMessage = {
  id: string, recordIds: number[], at: string | null, step: string | null, role: string | null, botId: string | null,
  kind: 'message' | 'tool' | 'notice' | 'system' | 'refusal', text: string,
  tool?: string, ok?: boolean, ms?: number, result?: string, usage?: any,
}
export type Chat = { title: string, state: string | null, step: string | null, members: ChatMember[], messages: ChatMessage[], usage?: any }

const norm = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const MATERIAL = /-----BEGIN MATERIAL-----\n([\s\S]*?)\n-----END MATERIAL-----/

/**
 * Turns a task's records (GET /tasks/:id?records=1) into chat messages.
 * `recordIds` of a message are 0-based indexes into `records`; every record appears in at most one message.
 * - a bot's round_end and its mirrored group line are ONE message (both record ids);
 * - a tool_call and its tool_result are ONE `tool` row (args in `text`, the result in `result`);
 * - the first group line (the task kick-off) is shown as the Slack user's message;
 * - watchdog notices and run/step/close events are `notice` / `system` rows; refusals and tool errors are `refusal` rows.
 * @param {object[]} records
 * @param {object} [task]
 * @returns {Chat}
 */
export function buildChat(records, task?): Chat {
  const list = Array.isArray(records) ? records : []
  const run = task?.runs?.at?.(-1)
  const roleOfBot = new Map<string, string>()
  for (const [role, id] of Object.entries(run?.bots ?? {})) roleOfBot.set(String(id), role)
  const roles = new Set<string>(Object.keys(run?.bots ?? {}))
  for (const r of list) {
    if (typeof r?.botId === 'string' && typeof r?.role === 'string') { roleOfBot.set(r.botId, r.role); roles.add(r.role) }
  }
  // Bot names are the ones the records use in @mentions ("Slack-1"); a bot nobody mentioned is "<Role>-1".
  const names = new Map<string, string>()
  for (const r of list) {
    for (const m of String(r?.text ?? '').matchAll(/@([A-Za-z]+-\d+)/g)) {
      const role = m[1].split('-')[0].toLowerCase()
      if ((BOT_ROLES as string[]).includes(role) && !names.has(role)) names.set(role, m[1])
    }
  }
  const members: ChatMember[] = []
  const roleList = [...BOT_ROLES.filter((r) => roles.has(r)), ...[...roles].filter((r) => !(BOT_ROLES as string[]).includes(r))]
  for (const role of roleList) {
    members.push({ role, name: names.get(role) ?? `${ROLE_LABEL[role] ?? role}-1`, color: ROLE_COLOR[role] ?? ROLE_COLOR.user })
  }

  // The bill: the task's running summary, or (a task not at hand) the one the usage records add up to.
  const view = usageView(task?.usage?.calls > 0 ? task.usage : summarize(list))
  for (const member of members) member.usage = view?.byRole?.[member.role] ?? null
  const roundUsage = new Map<string, any[]>() // role -> its usage records since its last round end
  const messages: ChatMessage[] = []
  const push = (m: Omit<ChatMessage, 'id'>): ChatMessage => { const msg = { id: `m${messages.length}`, ...m } as ChatMessage; messages.push(msg); return msg }
  const base = (r, i, kind: ChatMessage['kind'], text: string) => ({
    recordIds: [i], at: r.at ?? null, step: r.step ?? null, role: r.role ?? roleOfBot.get(r.botId) ?? null, botId: r.botId ?? null, kind, text,
  })
  const openCalls = new Map<string, ChatMessage[]>() // botId|tool -> calls waiting for their result
  const lastSpoken = new Map<string, { msg: ChatMessage, srcs: Set<string> }>() // botId -> its last 'message'
  let userSeen = false

  // A bot's text arrives twice, as its round_end and as the group line the host mirrors; the two are one message.
  const say = (r, i, src: 'line' | 'round_end', ok?: boolean) => {
    const key = r.botId ?? r.role ?? ''
    const prev = lastSpoken.get(key)
    // the mirror lands right after the round end (adjacent records), never a later identical answer
    if (prev && !prev.srcs.has(src) && norm(prev.msg.text) === norm(r.text) && i - prev.msg.recordIds.at(-1) <= 3) {
      prev.msg.recordIds.push(i)
      prev.srcs.add(src)
      if (ok === false) prev.msg.ok = false
      return
    }
    const msg = push({ ...base(r, i, 'message', String(r.text)), ...(ok === false ? { ok: false } : {}) })
    // what this round of the bot cost (a round_end closes it)
    const role = r.role ?? roleOfBot.get(r.botId) ?? ''
    if (src === 'round_end') {
      const usage = roundView(roundUsage.get(role))
      if (usage !== null) msg.usage = usage
      roundUsage.delete(role)
    }
    lastSpoken.set(key, { msg, srcs: new Set([src]) })
  }

  for (let i = 0; i < list.length; i += 1) {
    const r = list[i]
    if (r === null || typeof r !== 'object') continue
    const text = typeof r.text === 'string' ? r.text : r.text == null ? '' : String(r.text)
    switch (r.type) {
      case 'line': {
        if (r.botId == null && r.role == null) {
          const material = MATERIAL.exec(text)
          if (!userSeen && material) {
            userSeen = true
            const link = task?.origin?.permalink ?? /Slack discussion: (\S+)/.exec(text)?.[1]
            push({ ...base(r, i, 'message', link ? `${material[1]}\n\n[Slack 讨论](${link})` : material[1]), role: 'user', botId: null })
          } else if (text.trim() !== '') push(base(r, i, 'system', text))
        } else if (text.trim() !== '') say({ ...r, text }, i, 'line')
        break
      }
      case 'usage': {
        const role = r.role ?? roleOfBot.get(r.botId) ?? ''
        roundUsage.set(role, [...(roundUsage.get(role) ?? []), r])
        break
      }
      case 'round_end': {
        if (text.trim() !== '') say({ ...r, text }, i, 'round_end', r.failed ? false : undefined)
        else {
          roundUsage.delete(r.role ?? roleOfBot.get(r.botId) ?? '') // an empty round has no message to carry its cost
          if (r.failed) push({ ...base(r, i, 'refusal', '这一轮失败了，没有回答'), ok: false })
        }
        break
      }
      case 'tool_call': {
        const tool = String(r.tool ?? '')
        const args = tool !== '' && text.startsWith(tool) ? text.slice(tool.length).trim() : text
        const msg = push({ ...base(r, i, 'tool', args), tool })
        const key = `${r.botId ?? ''}|${tool}`
        openCalls.set(key, [...(openCalls.get(key) ?? []), msg])
        break
      }
      case 'tool_result': {
        const tool = String(r.tool ?? '')
        const key = `${r.botId ?? ''}|${tool}`
        const open = openCalls.get(key)
        const call = open?.shift()
        const fields = { ...(typeof r.ok === 'boolean' ? { ok: r.ok } : {}), ...(typeof r.ms === 'number' ? { ms: r.ms } : {}), result: text }
        if (call) { call.recordIds.push(i); Object.assign(call, fields) } else push({ ...base(r, i, 'tool', ''), tool, ...fields })
        break
      }
      case 'advance': {
        const m = /^(\S+) -> (\S+)$/.exec(text.trim())
        push(base(r, i, 'system', m ? `步骤推进：${stepLabel(m[1])} → ${stepLabel(m[2])}` : `步骤推进：${text}`))
        break
      }
      case 'notice': push(base(r, i, 'notice', text)); break
      case 'limit': push(base(r, i, 'notice', `限制：${text}`)); break
      case 'approval': case 'refused': case 'refusal': case 'tool_error': push({ ...base(r, i, 'refusal', text), ok: false, ...(r.tool ? { tool: String(r.tool) } : {}) }); break
      case 'system': {
        let m
        if ((m = /^run (\d+) created: group \S+,\s*bots (.*)$/.exec(text))) push(base(r, i, 'system', `第 ${m[1]} 次运行已创建，${m[2].trim().split(/\s+/).length} 个 bot 入群`))
        else if ((m = /^closed: (\S+), state (\S+), end reason (\S+)/.exec(text))) push(base(r, i, 'system', `任务已关闭：${m[1]}（状态 ${m[2]}，原因 ${m[3]}）`))
        else if ((m = /^run ended: (.*)$/.exec(text))) push(base(r, i, 'system', `运行结束：${m[1]}`))
        else if ((m = /^notice (\w+): ([\s\S]*)$/.exec(text))) push(base(r, i, 'notice', m[2]))
        else if ((m = /^needs info confirmed by (\S+)/.exec(text))) push(base(r, i, 'system', `${m[1]} 确认需要补充信息`))
        else if (text.trim() !== '') push(base(r, i, 'system', text))
        break
      }
      default:
        if (text.trim() !== '') push(base(r, i, 'system', `[${r.type}] ${text}`))
    }
  }

  const user = task?.origin?.user
  if (userSeen || user?.name) members.push({ role: 'user', name: String(user?.name ?? 'Slack 用户'), color: ROLE_COLOR.user })
  return {
    title: task?.id ? `Fix ${task.id}` : '任务群聊',
    state: task?.state ?? null,
    step: task?.step ?? null,
    members,
    messages,
    usage: view,
  }
}

let markdownFn: ((text: string, opts?: object) => string) | undefined
/**
 * The browser's Markdown renderer (window.chatMarkdown in CHAT_JS), loaded in a sandbox so tests run the very code the
 * page runs. Returns an HTML string; every input character is HTML-escaped, only http(s) and fake: links survive.
 * @param {string} text
 * @param {{ names?: string[], colors?: Record<string, string> }} [opts]  member names to highlight as @mentions, and their colours
 */
export function renderMarkdown(text: string, opts?: { names?: string[], colors?: Record<string, string> }): string {
  if (!markdownFn) {
    const sandbox: any = { window: {} }
    runInNewContext(CHAT_JS, sandbox)
    markdownFn = sandbox.window.chatMarkdown
  }
  return markdownFn!(text, opts)
}
