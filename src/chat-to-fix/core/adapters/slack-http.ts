// Slack Web API client for the real Slack adapter (work package: real Slack). Global fetch only.
//
// What it does that a bare fetch does not:
//   - every request has its own timeout and the whole call has a deadline, both below the tool
//     layer's limit (limits.toolTimeoutSeconds, default 30 s), because the tool layer does not abort
//     the losing call (core/tools/register.ts) and a slow chat.postMessage could post later unseen;
//   - Slack answers HTTP 200 with { ok: false, error } for most failures: the error string is mapped
//     to an AdapterError code;
//   - retries only for reads (`read: true`): network errors, timeouts, 5xx and HTTP 429 (waiting for
//     Retry-After, capped). A write is never retried here; `retryable` is true on a write only when the
//     failure happened before the request could reach Slack (connection refused, DNS);
//   - the token goes only into the Authorization header: never into a message, a log line or an error.
import { AdapterError } from './errors.ts'

export const DEFAULT_API_BASE = 'https://slack.com/api'

// Slack error string -> [AdapterError code, hint]. Anything else becomes `slack_error`.
const KNOWN_ERRORS = {
  channel_not_found: ['channel_not_found', 'the channel does not exist or the bot cannot see it'],
  not_in_channel: ['not_in_channel', 'the Slack bot is not a member of the channel: invite it there first'],
  thread_not_found: ['thread_not_found', 'the discussion was not found in the channel'],
  message_not_found: ['thread_not_found', 'the discussion was not found in the channel'],
  is_archived: ['channel_archived', 'the channel is archived'],
  invalid_auth: ['invalid_auth', 'the Slack token is not valid'],
  not_authed: ['invalid_auth', 'the Slack token is missing or not valid'],
  account_inactive: ['invalid_auth', 'the Slack token belongs to a deactivated account'],
  token_revoked: ['invalid_auth', 'the Slack token was revoked'],
  token_expired: ['invalid_auth', 'the Slack token expired'],
  missing_scope: ['missing_scope', 'the Slack app lacks an OAuth scope'],
  no_permission: ['no_permission', 'the Slack app may not do this'],
  access_denied: ['no_permission', 'the Slack app may not do this'],
  restricted_action: ['no_permission', 'a workspace rule forbids the bot from posting here'],
  user_not_found: ['user_not_found', 'the user does not exist'],
  msg_too_long: ['message_too_long', 'the message is too long for Slack'],
  no_text: ['bad_text', 'the reply text is empty'],
  ratelimited: ['rate_limited', 'Slack is rate limiting this app'],
}
// Slack-side failures that are worth another attempt for a read.
const TRANSIENT_ERRORS = new Set(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'])
// Failures that happen before a request can reach the server: safe to repeat even for a write.
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])

const defaultSleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Parses a Retry-After header (seconds); falls back to one second. Returns milliseconds. */
export function retryAfterMs(header) {
  const seconds = typeof header === 'string' && header.trim() !== '' ? Number(header) : NaN
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : 1000
}

/**
 * @param {{ token: string, baseUrl?: string, fetchImpl?: Function, requestTimeoutMs?: number,
 *           retryDelayMs?: number, retryAfterCapMs?: number, readAttempts?: number,
 *           sleep?: (ms: number) => Promise<void>, now?: () => number }} options
 */
export function createSlackClient({
  token, baseUrl = DEFAULT_API_BASE, fetchImpl = globalThis.fetch, requestTimeoutMs = 10_000,
  retryDelayMs = 300, retryAfterCapMs = 10_000, readAttempts = 3, sleep = defaultSleep, now = Date.now,
}: any) {
  const base = String(baseUrl).replace(/\/+$/, '')

  /**
   * Calls one Slack Web API method and returns the parsed response (ok: true).
   * @param {string} method  For example 'conversations.replies'.
   * @param {{ query?: object, json?: object, read?: boolean, deadlineAt?: number }} [options]
   *   `query` makes a GET (reads), `json` a JSON POST (writes). `deadlineAt` (epoch ms) bounds the whole call.
   */
  async function call(method, { query, json, read = false, deadlineAt = now() + requestTimeoutMs }: any = {}) {
    const maxAttempts = read ? readAttempts : 1
    let url = `${base}/${method}`
    if (query !== undefined) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) params.set(key, String(value))
      url += `?${params}`
    }
    const headers: any = { authorization: `Bearer ${token}` }
    let body
    if (json !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8'
      body = JSON.stringify(json)
    }

    for (let attempt = 1; ; attempt++) {
      const remaining = deadlineAt - now()
      if (remaining <= 0) throw new AdapterError('slack_timeout', `Slack ${method} ran out of time`)
      const last = attempt >= maxAttempts
      let response
      try {
        response = await fetchImpl(url, { method: json !== undefined ? 'POST' : 'GET', headers, body, signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remaining)) })
      } catch (error: any) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        if (!last) { await sleep(Math.min(retryDelayMs * attempt, Math.max(0, deadlineAt - now()))); continue }
        // The cause is deliberately not attached: it is a network error, and the message names only the method.
        if (timedOut) throw new AdapterError('slack_timeout', `Slack ${method} did not answer in time${read ? '' : '; the request may or may not have been delivered'}`)
        const preSend = PRE_SEND_CODES.has(error?.cause?.code)
        throw new AdapterError('slack_unreachable', `cannot reach Slack (${method}): ${error?.cause?.code ?? 'network error'}`, { retryable: !read && preSend })
      }

      if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get('retry-after'))
        await response.text().catch(() => '')
        // A read waits for Retry-After (when it fits); a write is never repeated here.
        if (!last && wait <= retryAfterCapMs && wait < deadlineAt - now()) { await sleep(wait); continue }
        throw new AdapterError('rate_limited', `Slack is rate limiting this app (${method}); Retry-After ${Math.ceil(wait / 1000)} s`)
      }
      if (response.status >= 500) {
        await response.text().catch(() => '')
        if (!last) { await sleep(Math.min(retryDelayMs * attempt, Math.max(0, deadlineAt - now()))); continue }
        throw new AdapterError('slack_unavailable', `Slack answered HTTP ${response.status} (${method})`)
      }

      let data
      try { data = JSON.parse(await response.text()) } catch { data = undefined }
      if (data === undefined || data === null || typeof data !== 'object') {
        if (!last) { await sleep(Math.min(retryDelayMs * attempt, Math.max(0, deadlineAt - now()))); continue }
        throw new AdapterError('slack_bad_response', `Slack answered HTTP ${response.status} with something that is not JSON (${method})`)
      }
      if (data.ok === true) return data

      const error = typeof data.error === 'string' ? data.error : 'unknown_error'
      if (TRANSIENT_ERRORS.has(error) && !last) { await sleep(Math.min(retryDelayMs * attempt, Math.max(0, deadlineAt - now()))); continue }
      throw slackError(method, error, data)
    }
  }

  return { call }
}

/** Builds the AdapterError for a Slack `{ ok: false, error }` answer. */
export function slackError(method, error, data: any = {}) {
  const known = KNOWN_ERRORS[error]
  const [code, hint] = known ?? [TRANSIENT_ERRORS.has(error) ? 'slack_unavailable' : 'slack_error', 'Slack refused the request']
  let detail = `Slack ${method}: ${error}: ${hint}`
  if (error === 'missing_scope' && typeof data.needed === 'string') detail += ` (needed: ${data.needed})`
  return new AdapterError(code, detail)
}

/**
 * Text we post must not ping a whole channel or user group. `<!channel>`, `<!here>`, `<!everyone>`
 * and `<!subteam^ID>` become plain words with a zero-width space after the @; plain "@channel" and
 * friends get the same space; any other `<!...>` command is shown literally.
 */
export function neutralizeBroadcasts(text) {
  return String(text)
    .replace(/<!(channel|here|everyone)(\|[^>]*)?>/gi, (_, word) => `@​${word.toLowerCase()}`)
    .replace(/<!subteam\^[A-Za-z0-9]+(\|[^>]*)?>/gi, (_, label) => `@​${String(label ?? '').slice(1).replace(/^@/, '') || 'usergroup'}`)
    .replace(/(^|[^\w@])@(channel|here|everyone)\b/gi, '$1@​$2')
    .replace(/<!/g, '&lt;!')
}
