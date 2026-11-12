// The HTTP side of the real Jira adapter (spec 4, section 2.2, I5): authentication, a per-request
// timeout, retries and the mapping of every failure to an AdapterError.
// Rules (wave 1 brief):
//   - every request has its own timeout, shorter than the tool layer's 30 s, so a call that the tool
//     layer gave up on cannot go on in the background for long;
//   - only GET is retried here (429 and 5xx, honouring Retry-After); a write (create, comment,
//     transition) is sent once and its errors are never `retryable`, so the tool layer cannot
//     duplicate it;
//   - the token never appears in an error message (it is also scrubbed from Jira's own text).
import { AdapterError } from './errors.ts'

export const DEFAULT_TIMEOUT_MS = 20_000
export const DEFAULT_BUDGET_MS = 27_000
export const DEFAULT_MAX_RETRIES = 2
export const DEFAULT_MAX_RETRY_WAIT_MS = 5_000
const MIN_ATTEMPT_MS = 1_000
const ERROR_TEXT_MAX = 600

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Retry-After as milliseconds: delta-seconds or an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/** What Jira says about a failed request: errorMessages, errors{field: text} or message, cut short. */
export function jiraDetail(data, rawText = '') {
  const parts = []
  if (data && typeof data === 'object') {
    if (Array.isArray(data.errorMessages)) parts.push(...data.errorMessages.filter((m) => typeof m === 'string' && m !== ''))
    if (data.errors && typeof data.errors === 'object') {
      for (const [field, why] of Object.entries(data.errors)) parts.push(`${field}: ${why}`)
    }
    if (typeof data.message === 'string' && data.message !== '') parts.push(data.message)
  }
  // A non-JSON body (an HTML login page, a proxy error) is not shown: it is long and says little.
  const text = parts.join('; ')
  return text.length > ERROR_TEXT_MAX ? `${text.slice(0, ERROR_TEXT_MAX)}...` : text
}

/**
 * @param {{ baseUrl: string, authorization: string, fetch?: Function, timeoutMs?: number, budgetMs?: number,
 *           maxRetries?: number, maxRetryWaitMs?: number, secrets?: string[], sleep?: Function }} options
 *   `baseUrl` has no trailing slash. `secrets` are strings to scrub from every message.
 */
export function createJiraHttp({ baseUrl, authorization, fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, budgetMs = DEFAULT_BUDGET_MS,
  maxRetries = DEFAULT_MAX_RETRIES, maxRetryWaitMs = DEFAULT_MAX_RETRY_WAIT_MS, secrets = [], sleep = sleepFor }: any) {
  const hidden = [...secrets, authorization, authorization.replace(/^(Basic|Bearer) /, '')].filter((s) => typeof s === 'string' && s.length >= 4)
  const scrub = (text) => hidden.reduce((out, secret) => out.split(secret).join('***'), String(text))
  const fail = (code, message, retryable = false) => new AdapterError(code, scrub(message), { retryable })

  /** One HTTP exchange. Resolves to { status, headers, data, text }; a transport failure becomes an AdapterError. */
  async function once(method, url, body, limitMs, idempotent) {
    let response
    let text
    try {
      response = await fetchImpl(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(limitMs),
        headers: {
          Accept: 'application/json',
          Authorization: authorization,
          'User-Agent': 'chat-to-fix',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      text = await response.text()
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw fail('timeout', `Jira did not answer within ${Math.round(limitMs / 1000)}s${idempotent ? '' : '; the request may or may not have been applied'}`, idempotent)
      }
      const reason = error?.cause?.code ?? error?.code ?? error?.name ?? 'error'
      throw fail('network_error', `cannot reach Jira (${reason})`, idempotent)
    }
    let data
    try { data = text === '' ? undefined : JSON.parse(text) } catch { data = undefined }
    return { status: response.status, headers: response.headers, data, text }
  }

  function failureOf(result, notFound, idempotent) {
    const { status, data } = result
    const detail = jiraDetail(data)
    const tail = detail ? `: ${detail}` : ''
    if (status >= 300 && status < 400) {
      return fail('bad_config', `Jira answered with a redirect (HTTP ${status}) to ${scrub(result.headers.get('location') ?? 'another address')}; check jira.baseUrl`)
    }
    if (status === 400) return fail('jira_rejected', `Jira rejected the request (HTTP 400)${tail}`)
    if (status === 401) return fail('auth_failed', 'Jira did not accept the credentials (HTTP 401); check CHAT_TO_FIX_JIRA_TOKEN and the e-mail (CHAT_TO_FIX_JIRA_EMAIL or jira.email)')
    if (status === 403) return fail('forbidden', `Jira refused the request (HTTP 403): the user lacks a permission${tail}`)
    if (status === 404) return fail(notFound?.code ?? 'jira_not_found', notFound?.message ?? `Jira does not know this address (HTTP 404)${tail}; check jira.baseUrl`)
    if (status === 429) {
      const wait = retryAfterMs(result.headers.get('retry-after'))
      return fail('rate_limited', `Jira is rate limiting the requests (HTTP 429)${wait === undefined ? '' : `; retry after ${Math.ceil(wait / 1000)}s`}`)
    }
    if (status >= 500) return fail('jira_unavailable', `Jira failed (HTTP ${status})${tail}`)
    return fail('jira_error', `Jira answered with an unexpected status (HTTP ${status})${tail}`)
  }

  /**
   * @param {string} method  'GET' or a write method.
   * @param {string} path    Path below the base URL, starting with '/'.
   * @param {{ body?: unknown, notFound?: { code: string, message: string } }} [options]
   * @returns {Promise<any>} The parsed JSON body (undefined for an empty body).
   */
  async function request(method, path, { body, notFound }: any = {}) {
    const url = `${baseUrl}${path}`
    const idempotent = method === 'GET'
    const started = Date.now()
    for (let attempt = 0; ; attempt++) {
      const left = budgetMs - (Date.now() - started)
      const result = await once(method, url, body, idempotent ? Math.min(timeoutMs, Math.max(MIN_ATTEMPT_MS, left)) : timeoutMs, idempotent)
      if (result.status >= 200 && result.status < 300) return result.data ?? (result.text === '' ? undefined : result.text)
      if (idempotent && (result.status === 429 || result.status >= 500) && attempt < maxRetries) {
        const wait = retryAfterMs(result.headers.get('retry-after')) ?? 500 * 2 ** attempt
        // Wait only when the wait is reasonable and the rest of the budget can still hold an attempt.
        if (wait <= maxRetryWaitMs && Date.now() - started + wait + MIN_ATTEMPT_MS <= budgetMs) {
          await sleep(wait)
          continue
        }
      }
      // After the retries above the failure is final for a GET too (retryable stays false).
      throw failureOf(result, notFound, idempotent)
    }
  }

  return { request }
}
