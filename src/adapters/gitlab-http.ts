// The real merge-request half of the repository adapter: GitLab REST API v4 (spec 4, section 2.2, I5).
// Same three functions as the fake (./repo.ts createFakeGitlab):
//   find(binding, branch)                                              -> { url, headSha, iid, ... } | undefined
//   upsertDraft(binding, { branch, title, description, jiraKey, headSha }) -> { url }
//   get(binding, branch)                                               -> { state, pipeline, url, draft, title }
//
// Rules (analysis notes B, section 1.4):
//  - Every request has its own timeout, shorter than the tool layer's (toolTimeoutSeconds, default 30 s):
//    the tool layer does not abort a call it gave up on, so a late create must not be possible.
//  - Only GET is retried inside the adapter (429 with Retry-After, 5xx, network errors, timeouts), within a
//    total time budget. A write is never repeated and its errors are never `retryable`, so the tool layer
//    cannot create a second MR. The one safe repeat is on our own 409 "already exists": find, then update.
//  - The token (env CHAT_TO_FIX_GITLAB_TOKEN, header PRIVATE-TOKEN) never appears in a message, an error
//    or a log. Redirects are not followed: the PRIVATE-TOKEN header would travel with them.
import { AdapterError, redactSecrets } from './errors.ts'

const TOKEN_ENV = 'CHAT_TO_FIX_GITLAB_TOKEN'
const isText = (v) => typeof v === 'string' && v.trim() !== ''
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** GitLab Draft rules: a title that starts with "Draft:", "[Draft]" or "(Draft)" (any case) is a draft. */
const DRAFT_PREFIX = /^\s*(\[draft\]|\(draft\)|draft:)\s*/i
export const isDraftTitle = (title) => DRAFT_PREFIX.test(String(title ?? ''))
/** The title with the Draft prefix (exactly one, not doubled). */
export const draftTitle = (title) => `Draft: ${String(title ?? '').replace(DRAFT_PREFIX, '').trim()}`

/** Retry-After as milliseconds: seconds ("3") or an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(value, now = Date.now()) {
  if (!isText(value)) return undefined
  if (/^\s*\d+\s*$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/**
 * @param {object} config  needs `gitlab.baseUrl`; `toolTimeoutSeconds` (default 30) sizes the timeouts.
 * @param {{ env?: object, warn?: Function, fetch?: Function, requestTimeoutMs?: number, budgetMs?: number,
 *           maxRetryAfterMs?: number, backoffMs?: number, retries?: number }} [options]
 *   `fetch` and the timing options exist for tests.
 */
export function createRealGitlab(config, options: any = {}) {
  const env = options.env ?? process.env
  const warn = options.warn ?? ((...args) => console.warn(...args))
  const doFetch = options.fetch ?? globalThis.fetch
  const baseUrl = config?.gitlab?.baseUrl
  const token = env[TOKEN_ENV]
  if (!isText(baseUrl)) throw new AdapterError('bad_config', 'adapters.gitlab is "real" but gitlab.baseUrl is not configured')
  if (!isText(token)) throw new AdapterError('missing_credentials', `adapters.gitlab is "real" but the environment variable ${TOKEN_ENV} is not set`)
  let api
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol')
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      warn('chat-to-fix: gitlab.baseUrl is plain http: the token is sent unencrypted')
    }
    api = `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/v4`
  } catch {
    throw new AdapterError('bad_config', 'gitlab.baseUrl is not a valid http(s) URL')
  }

  const toolMs = (Number(config?.toolTimeoutSeconds) > 0 ? Number(config.toolTimeoutSeconds) : 30) * 1000
  const requestTimeoutMs = options.requestTimeoutMs ?? Math.min(8000, Math.round(toolMs * 0.3))
  const budgetMs = options.budgetMs ?? Math.min(12000, Math.round(toolMs * 0.45))
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 5000
  const backoffMs = options.backoffMs ?? 400
  const retries = options.retries ?? 2
  const secrets = [token]

  const clean = (text) => redactSecrets(text, secrets)

  const projectOf = (binding) => {
    if (!isText(binding?.repo)) throw new AdapterError('bad_binding', 'the binding has no repo (GitLab project path)')
    return encodeURIComponent(binding.repo.trim().replace(/^\/+|\/+$/g, ''))
  }

  /** What GitLab said, short and without any secret. */
  async function detailOf(response) {
    let text = ''
    try { text = await response.text() } catch { /* ignore */ }
    try {
      const body = JSON.parse(text)
      const message = body?.message ?? body?.error ?? body?.error_description
      text = typeof message === 'string' ? message : message === undefined ? text : JSON.stringify(message)
    } catch { /* not JSON: use the raw text */ }
    return clean(text.replace(/\s+/g, ' ').trim().slice(0, 300))
  }

  /** Maps a failed HTTP answer to an AdapterError (never retryable here: retries happen inside `request`). */
  function failure(status, detail, what, retryAfter) {
    const tail = detail === '' ? '' : `: ${detail}`
    if (status === 401) return new AdapterError('gitlab_unauthorized', `GitLab refused the token (401) for ${what}${tail}`)
    if (status === 403) return new AdapterError('gitlab_forbidden', `GitLab denied ${what} (403)${tail}`)
    if (status === 404) return new AdapterError('gitlab_not_found', `GitLab does not know the project or the object for ${what} (404): check the repo path and the token's access${tail}`)
    if (status === 409) return new AdapterError('gitlab_conflict', `GitLab reports a conflict for ${what} (409)${tail}`)
    if (status === 429) return new AdapterError('gitlab_rate_limited', `GitLab rate limit reached for ${what} (429)${retryAfter === undefined ? '' : `, retry after ${Math.ceil(retryAfter / 1000)}s`}`)
    if (status >= 500) return new AdapterError('gitlab_unavailable', `GitLab failed for ${what} (${status})${tail}`)
    if (status >= 300 && status < 400) return new AdapterError('gitlab_redirect', `GitLab answered ${status} (redirect) for ${what}; check gitlab.baseUrl (use the final https address)`)
    return new AdapterError('gitlab_bad_request', `GitLab rejected ${what} (${status})${tail}`)
  }

  /**
   * One API call. `method` GET is retried (429, 5xx, network error, timeout) up to `retries` times inside the
   * time budget; anything else is sent exactly once. Resolves with { status, body }; a status that is not
   * in `accept` throws.
   */
  async function request(method, path, { query, body, accept = [200] }: { query?: object, body?: object, accept?: number[] } = {}) {
    const what = `${method} ${path.replace(/%2F/gi, '/')}`
    const url = new URL(`${api}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value))
    const started = Date.now()
    const canRetry = method === 'GET'
    for (let attempt = 0; ; attempt++) {
      const left = budgetMs - (Date.now() - started)
      let response
      let error
      let wait
      try {
        response = await doFetch(url, {
          method,
          redirect: 'manual',
          headers: { 'PRIVATE-TOKEN': token, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(1, canRetry ? Math.min(requestTimeoutMs, left) : requestTimeoutMs)),
        })
      } catch (caught) {
        // No answer: DNS, refused connection, reset, or we gave up waiting.
        const timedOut = caught?.name === 'TimeoutError' || caught?.name === 'AbortError'
        error = timedOut
          ? new AdapterError('gitlab_timeout', `GitLab did not answer ${what} within ${Math.round(requestTimeoutMs / 1000)}s`)
          : new AdapterError('gitlab_unreachable', `cannot reach GitLab for ${what}: ${clean(String(caught?.cause?.code ?? caught?.code ?? caught?.message ?? caught))}`)
        wait = backoffMs * (attempt + 1)
      }
      if (response !== undefined) {
        if (accept.includes(response.status)) {
          let parsed
          try { parsed = await response.json() } catch { throw new AdapterError('gitlab_bad_response', `GitLab sent an unreadable answer for ${what}`) }
          return { status: response.status, body: parsed }
        }
        const after = retryAfterMs(response.headers?.get?.('retry-after'))
        error = failure(response.status, await detailOf(response), what, after)
        wait = response.status === 429 ? (after ?? backoffMs) : response.status >= 500 ? backoffMs * (attempt + 1) : undefined
      }
      // Retry only a GET, only for 429, 5xx, no answer; stay inside the budget; never wait long.
      if (!canRetry || attempt >= retries || wait === undefined) throw error
      if (wait > maxRetryAfterMs || wait >= budgetMs - (Date.now() - started)) throw error
      await sleepFor(wait)
    }
  }

  const shape = (mr) => ({
    url: mr.web_url, headSha: mr.sha, iid: mr.iid, title: mr.title, description: mr.description ?? '',
    state: mr.state, draft: Boolean(mr.draft ?? mr.work_in_progress), target: mr.target_branch,
  })

  /** The open MR whose source is `branch`, or undefined. */
  async function find(binding, branch) {
    if (!isText(branch)) throw new AdapterError('bad_branch', 'the branch is missing')
    const { body } = await request('GET', `/projects/${projectOf(binding)}/merge_requests`, {
      query: { source_branch: branch, state: 'opened', per_page: 20 },
    })
    const list = (Array.isArray(body) ? body : []).filter((mr) => mr?.source_branch === branch)
    // One MR per branch is ours; if there are several, the newest iid is the one we keep working on.
    list.sort((a, b) => b.iid - a.iid)
    return list.length === 0 ? undefined : shape(list[0])
  }

  async function upsertDraft(binding, { branch, title, description }: any) {
    const project = projectOf(binding)
    const fields = { title: draftTitle(title), description: description ?? '' }
    const update = async (iid) => {
      const { body } = await request('PUT', `/projects/${project}/merge_requests/${iid}`, { body: fields })
      return { url: body.web_url }
    }
    const existing = await find(binding, branch)
    if (existing !== undefined) return update(existing.iid)
    const created = await request('POST', `/projects/${project}/merge_requests`, {
      body: { source_branch: branch, target_branch: binding?.defaultBranch ?? 'master', ...fields },
      accept: [201, 409],
    })
    if (created.status === 201) {
      if (!isText(created.body?.web_url)) throw new AdapterError('gitlab_bad_response', 'GitLab created the MR but sent no link')
      return { url: created.body.web_url }
    }
    // 409: another open MR for this source branch exists (made in between): update that one.
    const again = await find(binding, branch)
    if (again === undefined) throw new AdapterError('gitlab_conflict', `GitLab reports a conflict creating the MR for ${branch} but no open MR was found`)
    return update(again.iid)
  }

  async function get(binding, branch) {
    if (!isText(branch)) throw new AdapterError('bad_branch', 'the branch is missing')
    const project = projectOf(binding)
    // The list does not carry head_pipeline: take the newest MR of the branch (any state), then read it alone.
    const { body: list } = await request('GET', `/projects/${project}/merge_requests`, {
      query: { source_branch: branch, order_by: 'updated_at', sort: 'desc', per_page: 20 },
    })
    const found = (Array.isArray(list) ? list : []).find((mr) => mr?.source_branch === branch)
    if (found === undefined) throw new AdapterError('mr_not_found', `no merge request for branch ${branch}`)
    const { body: mr } = await request('GET', `/projects/${project}/merge_requests/${found.iid}`)
    return {
      state: mr.state, pipeline: mr.head_pipeline?.status ?? 'none', url: mr.web_url, draft: Boolean(mr.draft ?? mr.work_in_progress), title: mr.title,
      pipelineUrl: mr.head_pipeline?.web_url,
    }
  }

  return { find, upsertDraft, get }
}
