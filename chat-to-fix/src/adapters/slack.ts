// The Slack adapter (spec 4, section 2.2, I5). Three functions:
//   readThread(origin)               -> [{ user: { id, name }, at, text, files }]
//   reply(origin, purpose, text)     -> the identifier of the message sent (string)
//   startThread(channel, text)       -> { ts, permalink } (opening message of a /fix discussion; permalink may be null)
// `origin` is the task's origin ({ channel, threadTs, ... }); the adapter can reach only that
// discussion. The fake keeps its files under <dataDir>/fake/slack/ (spec 4, section 2.3).
import { join } from 'node:path'
import { REPLY_PURPOSES } from '../task/contracts.ts'
import { AdapterError } from './errors.ts'
import { appendJsonLine, fakeRoot, readJson, updateJson } from './fake/files.ts'
import { DEFAULT_API_BASE, createSlackClient, neutralizeBroadcasts } from './slack-http.ts'

const SAFE_ID = /^[A-Za-z0-9._-]+$/

/** The file that holds the messages of one discussion. Shared with scripts/fake-event.ts. */
export function threadFile(dataDir, channel, threadTs) {
  for (const [name, value] of [['channel', channel], ['threadTs', threadTs]]) {
    if (typeof value !== 'string' || !SAFE_ID.test(value) || value === '.' || value === '..') {
      throw new AdapterError('bad_origin', `origin.${name} is missing or has characters that are not allowed`)
    }
  }
  return join(fakeRoot(dataDir), 'slack', 'threads', `${channel}-${threadTs}.json`)
}

export const repliesFile = (dataDir) => join(fakeRoot(dataDir), 'slack', 'replies.jsonl')

/** Chooses the implementation by `config.adapters.slack`. */
export function createSlackAdapter(config, options = {}) {
  if (config.adapters?.slack === 'real') return (createRealSlack as any)(config, options)
  return (createFakeSlack as any)(config, options)
}

// ---- the real implementation (Slack Web API) ----
const SLACK_CHANNEL = /^[A-Za-z0-9]{1,32}$/
const SLACK_TS = /^\d{1,12}\.\d{1,9}$/
const MAX_PAGES = 25 // 25 pages of 200 messages: far more than a bot can read anyway
const NAME_LOOKUP_CHUNK = 5
const REPLY_MAX_CHARS = 4000 // Slack renders at most about 4000 characters of `text` well

function checkSlackOrigin(origin) {
  const channel = origin?.channel
  const threadTs = origin?.threadTs
  if (typeof channel !== 'string' || !SLACK_CHANNEL.test(channel)) throw new AdapterError('bad_origin', 'origin.channel is missing or is not a Slack channel id')
  if (typeof threadTs !== 'string' || !SLACK_TS.test(threadTs)) throw new AdapterError('bad_origin', 'origin.threadTs is missing or is not a Slack timestamp')
  return { channel, threadTs }
}

function checkSlackChannel(channel) {
  if (typeof channel !== 'string' || !SLACK_CHANNEL.test(channel)) throw new AdapterError('bad_origin', 'channel is missing or is not a Slack channel id')
  return channel
}

const unescapeSlack = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * The real Slack adapter: same two functions as the fake. Bot token from env CHAT_TO_FIX_SLACK_TOKEN
 * (scopes: channels:history, groups:history, chat:write; users:read is optional: without it speakers
 * are shown by user id). `config.slack.apiBase` / `options.apiBase` replace the API host (tests).
 * `options.fetch`, `sleep`, `requestTimeoutMs`, `readBudgetMs` are test hooks.
 */
export function createRealSlack(config, options: any = {}) {
  const env = options.env ?? process.env
  const token = typeof env.CHAT_TO_FIX_SLACK_TOKEN === 'string' ? env.CHAT_TO_FIX_SLACK_TOKEN.trim() : ''
  if (token === '') throw new AdapterError('missing_token', 'adapters.slack is "real" but CHAT_TO_FIX_SLACK_TOKEN is not set')
  const warn = options.warn ?? ((...args) => console.warn(...args))
  const toolMs = (config?.limits?.toolTimeoutSeconds ?? 30) * 1000
  // Below the tool layer's limit, so a call that timed out there is also over here.
  const readBudgetMs = options.readBudgetMs ?? Math.max(1000, toolMs - 5000)
  const client = createSlackClient({
    token,
    baseUrl: config?.slack?.apiBase ?? options.apiBase ?? DEFAULT_API_BASE,
    fetchImpl: options.fetch ?? globalThis.fetch,
    requestTimeoutMs: options.requestTimeoutMs ?? Math.max(1000, Math.min(10_000, toolMs - 5000)),
    sleep: options.sleep,
    retryDelayMs: options.retryDelayMs,
    now: options.now,
  })
  const now = options.now ?? Date.now

  // user id -> display name, for the life of the process. `namesOff` is set when users:read is missing.
  const names = new Map()
  let namesOff = false
  let nameWarned = false

  async function lookupName(id, deadlineAt) {
    if (names.has(id)) return
    if (namesOff || deadlineAt - now() < 2000) return
    try {
      const { user } = await client.call('users.info', { query: { user: id }, read: true, deadlineAt })
      names.set(id, user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name || id)
    } catch (error: any) {
      if (error.code === 'user_not_found') names.set(id, id)
      else if (error.code === 'missing_scope' || error.code === 'no_permission') namesOff = true
      if (!nameWarned) { nameWarned = true; warn('chat-to-fix: slack: speaker names unavailable, showing user ids: %s', error.message) }
    }
  }

  async function resolveNames(ids, deadlineAt) {
    const todo = [...ids].filter((id) => !names.has(id))
    for (let i = 0; i < todo.length; i += NAME_LOOKUP_CHUNK) {
      await Promise.all(todo.slice(i, i + NAME_LOOKUP_CHUNK).map((id) => lookupName(id, deadlineAt)))
    }
  }

  const mentionPattern = /<@([UW][A-Za-z0-9]+)(?:\|[^>]*)?>/g
  const readableText = (text) => unescapeSlack(
    String(text ?? '')
      .replace(mentionPattern, (_, id) => `@${names.get(id) ?? id}`)
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1'),
  )

  return {
    async readThread(origin) {
      const { channel, threadTs } = checkSlackOrigin(origin)
      const deadlineAt = now() + readBudgetMs
      const raw = []
      let cursor
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await client.call('conversations.replies', {
          query: { channel, ts: threadTs, limit: 200, cursor }, read: true, deadlineAt,
        })
        if (Array.isArray(data.messages)) raw.push(...data.messages)
        cursor = data.response_metadata?.next_cursor
        if (data.has_more !== true || typeof cursor !== 'string' || cursor === '') break
        if (page === MAX_PAGES - 1) warn('chat-to-fix: slack: discussion %s/%s is longer than %d pages; the rest is not read', channel, threadTs, MAX_PAGES)
      }
      if (raw.length === 0) throw new AdapterError('thread_not_found', `no discussion for channel ${channel}, thread ${threadTs}`)

      const ids = new Set<string>()
      for (const m of raw) {
        if (typeof m?.user === 'string') ids.add(m.user)
        for (const found of String(m?.text ?? '').matchAll(mentionPattern)) ids.add(found[1])
      }
      await resolveNames(ids, deadlineAt)

      return raw.map((m) => {
        const id = m?.user ?? m?.bot_id ?? 'unknown'
        const seconds = Number(m?.ts)
        return {
          user: { id, name: names.get(m?.user) ?? m?.username ?? m?.bot_profile?.name ?? id },
          at: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null,
          text: readableText(m?.text),
          files: (Array.isArray(m?.files) ? m.files : [])
            .filter((f) => f && f.mode !== 'tombstone')
            .map((f) => ({ name: f.name ?? f.title ?? 'file', url: f.permalink ?? f.url_private })),
        }
      })
    },

    async reply(origin, purpose, text) {
      const { channel, threadTs } = checkSlackOrigin(origin)
      if (purpose !== 'system' && !REPLY_PURPOSES.includes(purpose)) throw new AdapterError('bad_purpose', `purpose must be one of ${REPLY_PURPOSES.join(', ')}, system`)
      if (typeof text !== 'string' || text.trim() === '') throw new AdapterError('bad_text', 'the reply text is empty')
      let safe = neutralizeBroadcasts(text)
      if (safe.length > REPLY_MAX_CHARS) safe = `${safe.slice(0, REPLY_MAX_CHARS - 1)}…`
      // One attempt only: a repeated chat.postMessage would post twice.
      const data = await client.call('chat.postMessage', {
        json: { channel, thread_ts: threadTs, text: safe, parse: 'none', unfurl_links: false, unfurl_media: false },
      })
      if (typeof data.ts !== 'string') throw new AdapterError('slack_bad_response', 'Slack accepted the reply but returned no message id')
      return data.ts
    },

    // The opening message of a /fix discussion: no thread_ts, sent once (a repeated post would open two
    // discussions). The permalink is best effort: the task works without it.
    async startThread(channel, text) {
      checkSlackChannel(channel)
      if (typeof text !== 'string' || text.trim() === '') throw new AdapterError('bad_text', 'the opening message text is empty')
      let safe = neutralizeBroadcasts(text)
      if (safe.length > REPLY_MAX_CHARS) safe = `${safe.slice(0, REPLY_MAX_CHARS - 1)}…`
      const data = await client.call('chat.postMessage', {
        json: { channel, text: safe, parse: 'none', unfurl_links: false, unfurl_media: false },
      })
      if (typeof data.ts !== 'string') throw new AdapterError('slack_bad_response', 'Slack accepted the message but returned no message id')
      let permalink = null
      try {
        const link = await client.call('chat.getPermalink', { query: { channel, message_ts: data.ts }, read: true })
        if (typeof link.permalink === 'string') permalink = link.permalink
      } catch (error: any) {
        warn('chat-to-fix: slack: no permalink for the opening message %s/%s: %s', channel, data.ts, error.message)
      }
      return { ts: data.ts, permalink }
    },
  }
}

export function createFakeSlack(config) {
  const dataDir = config.dataDir
  let sequence = 0

  return {
    async readThread(origin) {
      const messages = await readJson(threadFile(dataDir, origin?.channel, origin?.threadTs), undefined)
      if (messages === undefined) {
        throw new AdapterError('thread_not_found', `no fake discussion for channel ${origin.channel}, thread ${origin.threadTs}`)
      }
      if (!Array.isArray(messages)) throw new AdapterError('thread_invalid', 'the fake discussion file must hold a list of messages')
      return messages.map((m) => ({
        user: { id: m?.user?.id ?? 'unknown', name: m?.user?.name ?? m?.user?.id ?? 'unknown' },
        at: m?.at ?? null,
        text: typeof m?.text === 'string' ? m.text : '',
        files: Array.isArray(m?.files) ? m.files : [],
      }))
    },

    async reply(origin, purpose, text) {
      threadFile(dataDir, origin?.channel, origin?.threadTs) // validates the origin
      // `system` is the purpose of the notices the system itself posts (spec 3, section 4.6); the bots' tool offers only the other three.
      if (purpose !== 'system' && !REPLY_PURPOSES.includes(purpose)) throw new AdapterError('bad_purpose', `purpose must be one of ${REPLY_PURPOSES.join(', ')}, system`)
      if (typeof text !== 'string' || text.trim() === '') throw new AdapterError('bad_text', 'the reply text is empty')
      // A Slack-like message id: seconds.microseconds, unique inside this process.
      const id = `${Math.floor(Date.now() / 1000)}.${String(++sequence).padStart(6, '0')}`
      await appendJsonLine(repliesFile(dataDir), {
        id, at: new Date().toISOString(), channel: origin.channel, threadTs: origin.threadTs, purpose, text,
      })
      return id
    },

    // Writes the opening message as the first message of a new discussion, so readThread and the task's
    // thread lookup find it exactly like a real one.
    async startThread(channel, text) {
      if (typeof text !== 'string' || text.trim() === '') throw new AdapterError('bad_text', 'the opening message text is empty')
      let ts
      let file
      // A ts that no discussion file uses yet (the clock may not have moved since the last call).
      for (;;) {
        ts = `${Math.floor(Date.now() / 1000)}.${String(Date.now() % 1000).padStart(3, '0')}${String(++sequence % 1000).padStart(3, '0')}`
        file = threadFile(dataDir, channel, ts) // validates the channel
        if (await readJson(file, undefined) === undefined) break
      }
      const message = { ts, user: { id: 'U-BOT', name: 'chat-to-fix' }, at: new Date().toISOString(), text, files: [] }
      await updateJson(file, [], (messages) => ({ value: [...messages, message], result: undefined }))
      return { ts, permalink: `fake://slack/${channel}/${ts}` }
    },
  }
}
