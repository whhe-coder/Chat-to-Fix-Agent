// The Slack event forwarder: the entry for real Slack @s (spec 3 section 3.1, hookup design).
//
//   CHAT_TO_FIX_SLACK_APP_TOKEN=xapp-... CHAT_TO_FIX_HTTP_TOKEN=<t> \
//   node scripts/slack-forwarder.ts [--url http://127.0.0.1:3090] [--token <t>] [--api-base <slack api url>] [--command /fix] [--no-enrich]
//
// It opens a Slack Socket Mode connection (no public URL needed), acknowledges every envelope at
// once, turns each `app_mention` event into the body that POST /events of the control interface
// expects, and posts it there (header x-chat-to-fix-token). Bot messages, edits and our own messages
// are ignored. A dropped connection or a "disconnect" envelope reconnects with backoff.
//
// The slash command (default /fix, config slack.slashCommand, --command or CHAT_TO_FIX_SLASH_COMMAND) is
// the primary entry: a `slash_commands` envelope is acknowledged at once (with a usage text in the ack
// when the text is empty or the context is not a channel), turned into { source: 'slash', ... } and
// posted to /events; the answer becomes an ephemeral message to the requester through response_url
// (used once, never logged). The @ (app_mention) stays the follow-up path inside a task's thread.
//
// Environment: CHAT_TO_FIX_SLACK_APP_TOKEN (app-level token, scope connections:write; required),
// CHAT_TO_FIX_SLACK_TOKEN (bot token; optional: when set, the forwarder also asks Slack for the
// message permalink and the speaker's name, best effort), CHAT_TO_FIX_URL, CHAT_TO_FIX_HTTP_TOKEN
// (defaults for --url and --token, as in scripts/fake-event.ts). No token is ever printed.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, DEFAULT_SLASH_COMMAND } from '../src/config.ts'

const DEFAULT_API_BASE = 'https://slack.com/api'
const IGNORED_SUBTYPES = new Set(['bot_message', 'message_changed', 'message_deleted', 'message_replied'])
// Answers of apps.connections.open that retrying cannot fix.
const FATAL_OPEN_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'missing_scope', 'not_allowed_token_type', 'invalid_arguments'])

// Handled slash commands remembered (by trigger_id) so that a redelivered envelope never answers twice.
const SEEN_TRIGGERS_MAX = 500

const unescapeSlack = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const isText = (v) => typeof v === 'string' && v.trim() !== ''
const isHttpUrl = (v) => {
  if (!isText(v)) return false
  try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false }
}

/**
 * Converts the payload of an `events_api` envelope (an `event_callback`) into the body of POST /events.
 * Pure. Returns { ok: true, body } or { ok: false, reason } for events that are not a human @ of the bot.
 * The body: { eventId, channel, threadTs, messageTs, user: { id }, text, files }; the leading mention of
 * the bot is cut from the text. `permalink` and `user.name` are added later by enrich, when possible.
 */
export function appMentionToEvent(payload) {
  const event = payload?.event
  if (event === undefined || event === null || typeof event !== 'object') return { ok: false, reason: 'no_event' }
  if (event.type !== 'app_mention') return { ok: false, reason: `not_app_mention (${event.type})` }
  if (!isText(payload.event_id)) return { ok: false, reason: 'no_event_id' }
  if (event.bot_id !== undefined && event.bot_id !== null) return { ok: false, reason: 'bot_message' }
  if (IGNORED_SUBTYPES.has(event.subtype)) return { ok: false, reason: `subtype_${event.subtype}` }
  if (event.edited !== undefined) return { ok: false, reason: 'edited' }
  const botIds = (Array.isArray(payload.authorizations) ? payload.authorizations : []).map((a) => a?.user_id).filter(isText)
  if (botIds.includes(event.user)) return { ok: false, reason: 'own_message' }
  if (!isText(event.channel) || !isText(event.ts) || !isText(event.user)) return { ok: false, reason: 'incomplete_event' }

  const raw = typeof event.text === 'string' ? event.text : ''
  // "<@UBOT> fix the login button" -> "fix the login button". Only the bot's own leading mention is cut.
  const lead = /^\s*<@([UW][A-Za-z0-9]+)(?:\|[^>]*)?>[\s,:]*/.exec(raw)
  let text = lead !== null && (botIds.length === 0 || botIds.includes(lead[1])) ? raw.slice(lead[0].length) : raw
  text = unescapeSlack(text).trim()
  // A bare "@bot" in a discussion has no text left; /events needs some, so it keeps the original.
  if (text === '') text = unescapeSlack(raw).trim() || '(empty mention)'

  const files = (Array.isArray(event.files) ? event.files : [])
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({ name: f.name ?? f.title ?? 'file', url: f.permalink ?? f.url_private }))
  return {
    ok: true,
    body: {
      eventId: payload.event_id,
      channel: event.channel,
      threadTs: isText(event.thread_ts) ? event.thread_ts : event.ts,
      messageTs: event.ts,
      user: { id: event.user },
      text,
      files,
    },
  }
}

/** "fix" or "/fix" -> "/fix"; anything unusable falls back to the default. */
const normalizeCommand = (command) => {
  const text = typeof command === 'string' ? command.trim().toLowerCase() : ''
  const withSlash = text.startsWith('/') ? text : `/${text}`
  return /^\/[a-z0-9_-]{1,32}$/.test(withSlash) ? withSlash : DEFAULT_SLASH_COMMAND
}

const usageText = (command) => `用法：${command} 加上问题描述，例如：${command} 登录页的“忘记密码”链接点了没反应。请在已绑定的频道里使用。`
const dmText = (command) => `暂不支持在私信里使用 ${command}，请在绑定的频道里用 ${command}。`

/**
 * Converts the payload of a `slash_commands` envelope into the body of POST /events (design: the
 * slash command opens a task; the server posts the opening message). Pure.
 * Returns { ok: true, body } with body { source: 'slash', eventId: 'slash:<trigger_id>', channel,
 * user: { id, name? }, text } (no threadTs; response_url stays with the forwarder), or
 * { ok: false, reason, message? }: `message` is the Chinese text the requester should see at once
 * (empty text, a DM or another context that is not a channel); without it the command is just ignored.
 */
export function slashCommandToEvent(payload, { command = DEFAULT_SLASH_COMMAND }: any = {}) {
  const wanted = normalizeCommand(command)
  if (payload === undefined || payload === null || typeof payload !== 'object') return { ok: false, reason: 'no_payload' }
  if (typeof payload.command !== 'string' || payload.command.trim().toLowerCase() !== wanted) return { ok: false, reason: `wrong_command (${typeof payload.command === 'string' ? payload.command : 'none'})` }
  if (!isText(payload.channel_id) || !isText(payload.user_id) || !isText(payload.trigger_id)) return { ok: false, reason: 'incomplete_command' }
  const channel = payload.channel_id.trim()
  const name = typeof payload.channel_name === 'string' ? payload.channel_name : ''
  // Channels are C… (G… for old private groups). D… is a DM with the bot; a group DM is G… named mpdm-….
  if (channel.startsWith('D') || name === 'directmessage') return { ok: false, reason: 'dm', message: dmText(wanted) }
  if (!/^[CG]/.test(channel) || name.startsWith('mpdm-')) return { ok: false, reason: 'not_a_channel', message: dmText(wanted) }
  const text = unescapeSlack(typeof payload.text === 'string' ? payload.text : '').trim()
  if (text === '') return { ok: false, reason: 'empty_text', message: usageText(wanted) }
  const user: any = { id: payload.user_id.trim() }
  if (isText(payload.user_name)) user.name = payload.user_name.trim()
  return { ok: true, body: { source: 'slash', eventId: `slash:${payload.trigger_id.trim()}`, channel, user, text } }
}

/**
 * The ephemeral text for the requester from the answer of /events (`undefined` = unreachable).
 * Pure. 202 and 200 (a repeated command) name the task; 422/429/502 are the refusals of design 4.2.
 */
export function slashFeedback(result, { command = DEFAULT_SLASH_COMMAND }: any = {}) {
  if (result === undefined || result === null) return '服务暂时不可用，请稍后再试。'
  const { status, body } = result
  if ((status === 202 || status === 200) && isText(body?.taskId)) {
    const link = isText(body.permalink) ? `：${body.permalink}` : ''
    return `已建任务 ${body.taskId}${link}`
  }
  if (status === 422) return `这个频道没有接入 Chat-to-Fix，请在绑定的频道里用 ${normalizeCommand(command)}。`
  if (status === 429) return '修复队列已满，请稍后再试。'
  if (status === 502) {
    const code = typeof body?.error === 'string' ? body.error.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) : ''
    if (code === 'not_in_channel') return '机器人不在这个频道，请先邀请它。'
    return `机器人没能在频道里发出开头消息${code === '' ? '' : `（${code}）`}，请稍后再试或联系管理员。`
  }
  if (status >= 500) return '服务暂时不可用，请稍后再试。'
  return `请求没有被受理（HTTP ${status}），请联系管理员。`
}

function abortableDelay(ms, signal) {
  return new Promise<void>((resolveDelay) => {
    if (signal.aborted) return resolveDelay()
    const timer = setTimeout(done, ms)
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolveDelay() }
    signal.addEventListener('abort', done, { once: true })
  })
}

class FatalError extends Error {
  declare fatal: boolean
  constructor(message) { super(message); this.fatal = true }
}

/**
 * @param {object} options
 *   appToken, url, token       required: app-level token, control interface URL and token.
 *   botToken                   optional: enables the permalink and name lookups.
 *   slashCommand               the slash command name handled (default /fix).
 *   apiBase, fetchImpl, WebSocketImpl, log        injection points (tests).
 *   minBackoffMs, maxBackoffMs, disconnectDelayMs, helloTimeoutMs, postAttempts, postRetryMs, random   timing.
 * @returns {{ run: () => Promise<void>, stop: () => Promise<void>, handleEnvelope: (envelope: object) => Promise<object|undefined> }}
 */
export function createForwarder({
  appToken, botToken, url, token, apiBase = DEFAULT_API_BASE, slashCommand = DEFAULT_SLASH_COMMAND,
  fetchImpl = globalThis.fetch, WebSocketImpl = (globalThis as any).WebSocket,
  log = (message) => console.log(`[slack-forwarder] ${message}`),
  minBackoffMs = 1000, maxBackoffMs = 30_000, disconnectDelayMs = 250, helloTimeoutMs = 15_000,
  postAttempts = 4, postRetryMs = 500, random = Math.random,
}: any) {
  if (!isText(appToken)) throw new Error('createForwarder: appToken is required')
  if (!isText(url) || !isText(token)) throw new Error('createForwarder: url and token of the control interface are required')
  const api = String(apiBase).replace(/\/+$/, '')
  const eventsUrl = `${String(url).replace(/\/+$/, '')}/events`
  const stopSignal = new AbortController()
  const pending = new Set<Promise<any>>()
  const names = new Map()
  const command = normalizeCommand(slashCommand)
  const seenTriggers = new Set<string>()
  let current

  // ---- Slack Web API (best effort ones and the connection opener) ----
  async function slackCall(method, { query, post = false, bearer, timeoutMs = 10_000 }: any) {
    let target = `${api}/${method}`
    if (query !== undefined) target += `?${new URLSearchParams(query)}`
    const response = await fetchImpl(target, {
      method: post ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${bearer}`, ...(post ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 429) {
      const header = response.headers.get('retry-after')
      const seconds = header === null || header.trim() === '' ? NaN : Number(header)
      const error: any = new Error(`Slack rate limits ${method}`)
      error.retryAfterMs = (Number.isFinite(seconds) ? seconds : 5) * 1000
      throw error
    }
    let data
    try { data = JSON.parse(await response.text()) } catch { data = undefined }
    if (data?.ok !== true) {
      const code = typeof data?.error === 'string' ? data.error : `http_${response.status}`
      throw method === 'apps.connections.open' && FATAL_OPEN_ERRORS.has(code) ? new FatalError(`Slack ${method}: ${code}`) : new Error(`Slack ${method}: ${code}`)
    }
    return data
  }

  /** Adds permalink and user.name when a bot token is available; any failure just leaves them out. */
  async function enrich(body) {
    if (!isText(botToken)) return body
    const out = { ...body, user: { ...body.user } }
    const permalink = slackCall('chat.getPermalink', { query: { channel: body.channel, message_ts: body.messageTs }, bearer: botToken, timeoutMs: 4000 })
      .then((data) => { if (isText(data.permalink)) out.permalink = data.permalink }, () => {})
    const name = names.has(body.user.id)
      ? Promise.resolve(names.get(body.user.id))
      : slackCall('users.info', { query: { user: body.user.id }, bearer: botToken, timeoutMs: 4000 })
        .then((data) => {
          const found = data.user?.profile?.display_name || data.user?.profile?.real_name || data.user?.real_name || data.user?.name
          if (isText(found)) names.set(body.user.id, found)
          return found
        }, () => undefined)
    const found = await Promise.all([permalink, name]).then(([, n]) => n)
    if (isText(found)) out.user.name = found
    return out
  }

  // ---- delivery to the control interface ----
  // `coded`: a 5xx that carries an error code in its body is an answer (for example 502 not_in_channel), not retried.
  async function postEvent(body, { coded = false }: any = {}) {
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= postAttempts
      let response
      try {
        response = await fetchImpl(eventsUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-chat-to-fix-token': token },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        })
      } catch (error: any) {
        if (!last && !stopSignal.signal.aborted) { await abortableDelay(postRetryMs * 2 ** (attempt - 1), stopSignal.signal); continue }
        log(`event ${body.eventId}: the control interface is unreachable (${error?.cause?.code ?? error?.name ?? 'error'}); the event is dropped`)
        return undefined
      }
      const text = await response.text().catch(() => '')
      let parsed
      try { parsed = JSON.parse(text) } catch { parsed = {} }
      if (parsed === null || typeof parsed !== 'object') parsed = {}
      if (response.status >= 500 && !last && !(coded && isText(parsed.error))) { await abortableDelay(postRetryMs * 2 ** (attempt - 1), stopSignal.signal); continue }
      // 202 new task, 200 duplicate or already running, 422 channel not bound, 429 queue full: all final.
      log(`event ${body.eventId} (channel ${body.channel}): HTTP ${response.status}${parsed.error ? ` ${parsed.error}` : ''}${parsed.taskId ? ` task ${parsed.taskId}` : ''}`)
      return { status: response.status, body: parsed }
    }
  }

  // ---- the slash command ----
  /** One ephemeral message to the requester through response_url; one attempt, nothing about the URL is logged. */
  async function respond(responseUrl, text) {
    if (!isHttpUrl(responseUrl)) { log('slash command: no usable response_url; the requester gets no message'); return false }
    try {
      const response = await fetchImpl(responseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response_type: 'ephemeral', text }),
        signal: AbortSignal.timeout(10_000),
      })
      await response.text().catch(() => '')
      if (response.status >= 200 && response.status < 300) return true
      log(`slash command: the ephemeral message was refused (HTTP ${response.status})`)
    } catch (error: any) {
      log(`slash command: the ephemeral message could not be sent (${error?.cause?.code ?? error?.name ?? 'error'})`)
    }
    return false
  }

  /**
   * Delivers a converted slash command to /events and tells the requester the outcome. The immediate
   * texts (empty, DM) were already given in the acknowledgement, so a rejected conversion only logs.
   * Resolves { status, body, text, sent } or undefined when nothing was delivered.
   */
  async function handleSlash(payload, converted) {
    if (!converted.ok) { log(`ignored a slash command: ${converted.reason}`); return undefined }
    const trigger = converted.body.eventId
    if (seenTriggers.has(trigger)) { log(`slash command ${trigger}: already handled; ignored`); return undefined }
    seenTriggers.add(trigger)
    if (seenTriggers.size > SEEN_TRIGGERS_MAX) seenTriggers.delete(seenTriggers.values().next().value)
    const result = await postEvent(converted.body, { coded: true })
    const text = slashFeedback(result, { command })
    const sent = await respond(payload?.response_url, text)
    return { status: result?.status, body: result?.body, text, sent }
  }

  /** Converts, enriches and delivers one events_api (or slash_commands) envelope. Resolves with the delivery result, or undefined when skipped. */
  async function handleEnvelope(envelope) {
    if (envelope?.type === 'slash_commands') return handleSlash(envelope.payload, slashCommandToEvent(envelope.payload, { command }))
    const converted = appMentionToEvent(envelope?.payload)
    if (!converted.ok) { log(`ignored an event: ${converted.reason}`); return undefined }
    return postEvent(await enrich(converted.body))
  }

  // ---- the socket ----
  async function openConnection() {
    for (;;) {
      try {
        const data = await slackCall('apps.connections.open', { post: true, bearer: appToken })
        if (!isText(data.url)) throw new Error('Slack apps.connections.open returned no url')
        return data.url
      } catch (error: any) {
        if (error.retryAfterMs === undefined || stopSignal.signal.aborted) throw error
        log(`rate limited by Slack; waiting ${Math.ceil(error.retryAfterMs / 1000)} s`)
        await abortableDelay(error.retryAfterMs, stopSignal.signal)
        if (stopSignal.signal.aborted) throw error
      }
    }
  }

  /** Runs one connection until it closes. Resolves { hello, quick }: was it established, and did Slack ask for the reconnect. */
  function runSocket(wsUrl) {
    return new Promise<{ hello: boolean, quick: boolean }>((resolveSocket) => {
      const state = { hello: false, quick: false }
      const ws = new WebSocketImpl(wsUrl)
      current = ws
      let finished = false
      const helloTimer = setTimeout(() => { log('no hello from Slack in time; reconnecting'); try { ws.close() } catch {} ; finish() }, helloTimeoutMs)
      function finish() {
        if (finished) return
        finished = true
        clearTimeout(helloTimer)
        if (current === ws) current = undefined
        resolveSocket(state)
      }
      ws.addEventListener('message', (event) => {
        let message
        try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch { return }
        if (message === null || typeof message !== 'object') return
        if (message.type === 'hello') { state.hello = true; clearTimeout(helloTimer); log('connected to Slack'); return }
        if (message.type === 'disconnect') {
          log(`Slack asked to reconnect (${message.reason ?? 'no reason'})`)
          state.quick = true
          try { ws.close() } catch {}
          return
        }
        // Acknowledge first (Slack wants it within 3 s), then work on the event. A slash command whose
        // requester must be told at once (empty text, a DM) carries that text in the acknowledgement.
        if (isText(message.envelope_id)) {
          const ack: any = { envelope_id: message.envelope_id }
          const slash = message.type === 'slash_commands' ? slashCommandToEvent(message.payload, { command }) : undefined
          if (slash !== undefined && !slash.ok && isText(slash.message)) ack.payload = { response_type: 'ephemeral', text: slash.message }
          try { ws.send(JSON.stringify(ack)) } catch (error: any) { log(`could not acknowledge an envelope: ${error?.message ?? error}`) }
          const work = slash !== undefined ? () => handleSlash(message.payload, slash) : message.type === 'events_api' ? () => handleEnvelope(message) : undefined
          if (work !== undefined) {
            const job = work().catch((error) => log(`event handling failed: ${error?.message ?? error}`)).finally(() => pending.delete(job))
            pending.add(job)
          }
        }
      })
      ws.addEventListener('close', finish)
      ws.addEventListener('error', () => { log('socket error'); try { ws.close() } catch {} ; finish() })
    })
  }

  /** Connects and stays connected until stop() is called; rejects only on an error retrying cannot fix (bad app token). */
  async function run() {
    let delay = minBackoffMs
    while (!stopSignal.signal.aborted) {
      let result = { hello: false, quick: false }
      try {
        const wsUrl = await openConnection()
        if (stopSignal.signal.aborted) break
        result = await runSocket(wsUrl)
      } catch (error: any) {
        if (error?.fatal) throw error
        log(`connection failed: ${error?.message ?? error}`)
      }
      if (stopSignal.signal.aborted) break
      let wait
      if (result.quick) { wait = disconnectDelayMs; delay = minBackoffMs } else if (result.hello) { delay = minBackoffMs; wait = delay } else { wait = delay; delay = Math.min(delay * 2, maxBackoffMs) }
      const jittered = Math.round(wait * (0.75 + random() * 0.5))
      log(`reconnecting in ${jittered} ms`)
      await abortableDelay(jittered, stopSignal.signal)
    }
  }

  async function stop() {
    stopSignal.abort()
    try { current?.close(1000) } catch {}
    // Let events that were already acknowledged finish their delivery.
    await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 5000).unref())])
  }

  return { run, stop, handleEnvelope }
}

function parseArgs(argv) {
  const options: any = {}
  const names = { '--url': 'url', '--token': 'token', '--api-base': 'apiBase', '--command': 'command' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-enrich') { options.noEnrich = true; continue }
    const key = names[argv[i]]
    if (key === undefined || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument: ${argv[i]}`)
    options[key] = argv[++i]
  }
  return options
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const appToken = process.env.CHAT_TO_FIX_SLACK_APP_TOKEN
  const url = o.url ?? process.env.CHAT_TO_FIX_URL
  const token = o.token ?? process.env.CHAT_TO_FIX_HTTP_TOKEN
  const missing = [['CHAT_TO_FIX_SLACK_APP_TOKEN', appToken], ['--url or CHAT_TO_FIX_URL', url], ['--token or CHAT_TO_FIX_HTTP_TOKEN', token]].filter(([, v]) => !isText(v)).map(([k]) => k)
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`)
  // Command name: --command, then CHAT_TO_FIX_SLASH_COMMAND, then slack.slashCommand of the config file, then /fix.
  let slashCommand = o.command ?? process.env.CHAT_TO_FIX_SLASH_COMMAND
  if (!isText(slashCommand) && isText(process.env.CHAT_TO_FIX_CONFIG)) {
    try { slashCommand = loadConfig().slack.slashCommand } catch (error: any) { console.warn(`[slack-forwarder] could not read the configuration (${error.message}); the command stays ${DEFAULT_SLASH_COMMAND}`) }
  }
  const forwarder = createForwarder({
    appToken, url, token, slashCommand,
    botToken: o.noEnrich ? undefined : process.env.CHAT_TO_FIX_SLACK_TOKEN,
    apiBase: o.apiBase ?? DEFAULT_API_BASE,
  })
  const quit = () => { void forwarder.stop() }
  process.once('SIGINT', quit)
  process.once('SIGTERM', quit)
  await forwarder.run()
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`slack-forwarder failed: ${error.message}`)
    process.exitCode = 1
  })
}
