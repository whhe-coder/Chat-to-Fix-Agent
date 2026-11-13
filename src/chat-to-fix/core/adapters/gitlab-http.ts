// The real merge-request half of the repository adapter: GitLab REST API v4 (spec 4, section 2.2, I5).
// Same three functions as the fake (./repo.ts createFakeGitlab):
//   find(binding, branch)                                              -> { url, headSha, iid, ... } | undefined
//   upsertDraft(binding, { branch, title, description, jiraKey, headSha }) -> { url, iid }
//   get(binding, branch)                                               -> { state, pipeline, url, draft, title }
// and the CI functions of spec 7 (4.5), same shapes as the simulated CI (./fake/ci.ts):
//   getChecks(binding, iid)                -> { status, sha, pipelineUrl, failedJobs: [{ id, name, url, pipelineId, projectId }] }
//   getJobLog(binding, job, { maxChars })  -> the log tail as text, colour codes and section markers removed
//   retryJobs(binding, jobs)               -> { retried: [id] }   (NOT verified on a real GitLab yet)
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

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// GitLab's collapsible-section markers: "section_start:<unix time>:<name>[options]\r\e[0K" (and section_end).
const SECTION_MARKER = /section_(?:start|end):\d+:[^\r\n\x1b]*\r?(?:\x1b\[0K)?/g

/**
 * A job log as plain text: GitLab section markers and ANSI control codes removed, line ends normalised
 * (a lone carriage return, used for progress bars, becomes a line break), then only the last `maxChars`
 * characters kept (the end of a log is where the failure is).
 */
export function cleanJobLog(raw, maxChars = 12000) {
  const text = String(raw ?? '').replace(SECTION_MARKER, '').replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const limit = Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 12000
  return text.length > limit ? text.slice(text.length - limit) : text
}

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

  /** A project in a URL: a numeric id or a path (encoded). */
  const refOf = (project) => encodeURIComponent(String(project).trim().replace(/^\/+|\/+$/g, ''))
  const projectOf = (binding) => {
    if (!isText(binding?.repo)) throw new AdapterError('bad_binding', 'the binding has no repo (GitLab project path)')
    return refOf(binding.repo)
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
   * in `accept` throws. `text: true` returns the body as a string (job logs) instead of parsed JSON; `headers` is
   * the answer's header list (for pagination).
   */
  async function request(method, path, { query, body, accept = [200], text = false }: { query?: object, body?: object, accept?: number[], text?: boolean } = {}) {
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
          headers: { 'PRIVATE-TOKEN': token, accept: text ? 'text/plain, */*' : 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
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
          try { parsed = text ? await response.text() : await response.json() } catch { throw new AdapterError('gitlab_bad_response', `GitLab sent an unreadable answer for ${what}`) }
          return { status: response.status, body: parsed, headers: response.headers }
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
    const update = async (existing) => {
      if (!existing.draft || existing.target !== (binding?.defaultBranch ?? 'master')) {
        throw new AdapterError('mr_not_owned', 'the task branch already has an open MR that is not the expected Draft MR')
      }
      const { body } = await request('PUT', `/projects/${project}/merge_requests/${existing.iid}`, { body: fields })
      return { url: body.web_url, iid: body.iid ?? existing.iid }
    }
    const existing = await find(binding, branch)
    if (existing !== undefined) return update(existing)
    const created = await request('POST', `/projects/${project}/merge_requests`, {
      body: { source_branch: branch, target_branch: binding?.defaultBranch ?? 'master', ...fields },
      accept: [201, 409],
    })
    if (created.status === 201) {
      if (!isText(created.body?.web_url)) throw new AdapterError('gitlab_bad_response', 'GitLab created the MR but sent no link')
      return { url: created.body.web_url, iid: created.body.iid }
    }
    // 409: another open MR for this source branch exists (made in between): update that one.
    const again = await find(binding, branch)
    if (again === undefined) throw new AdapterError('gitlab_conflict', `GitLab reports a conflict creating the MR for ${branch} but no open MR was found`)
    return update(again)
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

  // ---------- CI (spec 7, 4.5) ----------

  // GitLab pipeline statuses: still going (wait), or ended badly. Everything else (success, skipped, manual) is not a failure.
  const ACTIVE = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled', 'waiting_for_callback', 'canceling'])
  const BAD = new Set(['failed', 'canceled', 'cancelled']) // a cancelled job or pipeline counts as failed
  const MAX_DOWNSTREAM_DEPTH = 4

  /** All pages of a list endpoint (per_page 100, at most 10 pages). */
  async function listAll(path) {
    const all: any[] = []
    for (let page = 1; page <= 10; page++) {
      const { body, headers } = await request('GET', path, { query: { per_page: 100, page } })
      if (Array.isArray(body)) all.push(...body)
      const next = Number(headers?.get?.('x-next-page'))
      if (!Number.isInteger(next) || next <= page) break
      page = next - 1
    }
    return all
  }

  /**
   * One pipeline and what it triggers: { pending, failed: [CiJob] }.
   * Only work that counts is waited for: a running or queued allow_failure job or trigger job (and the downstream
   * pipeline of an allow_failure trigger job, which is not even read) neither holds the result back nor fails it.
   * Pending = a counting job or trigger job is still going, or the pipeline is active with no job that explains it.
   * Failed jobs that count (allow_failure ones do not), trigger jobs without a downstream pipeline that failed, and the
   * downstream pipelines, read with their own project id.
   * A downstream pipeline we cannot read (403/404) counts as failed, and the failed job's name says so.
   */
  async function evaluate(projectId, pipeline, depth) {
    const ref = refOf(projectId)
    const failed: any[] = []
    let pending = false
    let sawActive = false // some job or trigger job of this pipeline is still going (counting or not)
    const entry = (job, name = job.name) => ({ id: job.id, name, url: job.web_url ?? pipeline.web_url ?? null, pipelineId: pipeline.id, projectId })
    for (const bridge of await listAll(`/projects/${ref}/pipelines/${pipeline.id}/trigger_jobs`)) {
      const down = bridge?.downstream_pipeline
      if (ACTIVE.has(bridge?.status)) sawActive = true
      if (bridge?.allow_failure === true) continue // its result, and its downstream pipeline, do not count
      if (down?.id === undefined || down === null) {
        if (BAD.has(bridge?.status) && bridge?.allow_failure !== true) failed.push(entry(bridge))
        else if (ACTIVE.has(bridge?.status)) pending = true
        continue
      }
      if (depth >= MAX_DOWNSTREAM_DEPTH) continue
      const downProject = down.project_id ?? projectId
      let body
      try {
        body = (await request('GET', `/projects/${refOf(downProject)}/pipelines/${down.id}`)).body
      } catch (error) {
        if (error?.code !== 'gitlab_forbidden' && error?.code !== 'gitlab_not_found') throw error
        failed.push({ id: bridge.id, name: `${bridge.name} (downstream pipeline ${down.id} of project ${downProject} cannot be read: ${error.code === 'gitlab_forbidden' ? 'access denied' : 'not found'})`, url: down.web_url ?? bridge.web_url ?? null, pipelineId: pipeline.id, projectId })
        continue
      }
      // The trigger job and the pipeline it points at must agree on the commit; otherwise it is being replaced: wait.
      if (isText(down.sha) && isText(body?.sha) && down.sha !== body.sha) { pending = true; continue }
      const inner = await evaluate(body?.project_id ?? downProject, body, depth + 1)
      pending ||= inner.pending
      failed.push(...inner.failed)
    }
    // Jobs of the pipeline (retried-and-replaced jobs are not listed by default).
    for (const job of await listAll(`/projects/${ref}/pipelines/${pipeline.id}/jobs`)) {
      if (ACTIVE.has(job?.status)) sawActive = true
      if (job?.allow_failure === true) continue
      if (BAD.has(job?.status)) failed.push(entry(job))
      else if (ACTIVE.has(job?.status)) pending = true
    }
    // An active pipeline in which no job explains it (jobs not created yet, a status in transition): keep waiting.
    if (ACTIVE.has(pipeline.status) && !sawActive) pending = true
    // A failed pipeline without any failed job (a broken CI file, a pipeline cancelled before its jobs existed) still counts.
    if (BAD.has(pipeline.status) && failed.length === 0 && !pending) {
      failed.push({ id: `pipeline:${pipeline.id}`, name: `pipeline ${pipeline.id} (${pipeline.status}, no failed job listed)`, url: pipeline.web_url ?? null, pipelineId: pipeline.id, projectId })
    }
    return { pending, failed }
  }

  /**
   * The CI result of a merge request, for the MR's CURRENT commit only: an old head_pipeline of an earlier commit
   * is ignored (status pending until the new one exists). Only merge_request_event pipelines count; a push pipeline
   * for the same commit may contain only manual translation jobs. Several MR pipelines: the highest id.
   * Pending while any pipeline (main or downstream) is still going; failed only when all ended and some job counts.
   */
  async function getChecks(binding, iid) {
    const n = String(iid ?? '').trim()
    if (!/^\d+$/.test(n)) throw new AdapterError('bad_iid', 'the merge request iid is missing or not a number')
    const project = projectOf(binding)
    const { body: mr } = await request('GET', `/projects/${project}/merge_requests/${n}`)
    const sha = mr?.sha
    if (!isText(sha)) throw new AdapterError('gitlab_bad_response', `GitLab sent merge request ${n} without a commit`)
    const waiting = { status: 'pending', sha, pipelineUrl: null, failedJobs: [] }
    const ids = (await listAll(`/projects/${project}/merge_requests/${n}/pipelines`))
      .filter((p) => p?.sha === sha && p.source === 'merge_request_event')
      .map((p) => Number(p.id))
    if (mr.head_pipeline?.sha === sha && mr.head_pipeline.source === 'merge_request_event' && mr.head_pipeline.id !== undefined) ids.push(Number(mr.head_pipeline.id))
    if (ids.length === 0) return waiting
    const id = Math.max(...ids)
    const { body: pipeline } = await request('GET', `/projects/${project}/pipelines/${id}`)
    if (pipeline?.sha !== sha || pipeline?.source !== 'merge_request_event') return waiting
    const result = await evaluate(pipeline.project_id ?? mr.project_id ?? binding.repo, pipeline, 0)
    const status = result.pending ? 'pending' : result.failed.length > 0 ? 'failed' : 'passed'
    return { status, sha, pipelineUrl: pipeline.web_url ?? null, failedJobs: status === 'failed' ? result.failed : [] }
  }

  const jobIdOf = (job) => {
    const id = String(job?.id ?? '')
    if (!/^\d+$/.test(id)) throw new AdapterError('bad_job', `"${id}" is not a GitLab job id (it stands for a pipeline without a failed job)`)
    return id
  }
  const jobProjectOf = (binding, job) => (job?.projectId !== undefined && job.projectId !== null && String(job.projectId) !== '' ? refOf(job.projectId) : projectOf(binding))

  /** The end of a job's log (the job's own project, which may not be the MR's), as plain text. */
  async function getJobLog(binding, job, { maxChars }: { maxChars?: number } = {}) {
    const id = jobIdOf(job)
    const { body } = await request('GET', `/projects/${jobProjectOf(binding, job)}/jobs/${id}/trace`, { text: true })
    return cleanJobLog(body, maxChars ?? config?.limits?.ciLogMaxChars ?? 12000)
  }

  /**
   * Re-runs the given failed jobs, one POST each, never repeated (an error is not retryable here). Stops at the
   * first error; the message then lists the jobs already re-run. Not verified on a real GitLab yet.
   */
  async function retryJobs(binding, jobs) {
    const retried: Array<number | string> = []
    for (const job of Array.isArray(jobs) ? jobs : []) {
      const id = jobIdOf(job)
      try {
        await request('POST', `/projects/${jobProjectOf(binding, job)}/jobs/${id}/retry`, { accept: [200, 201] })
      } catch (error) {
        if (retried.length === 0 || !(error instanceof AdapterError)) throw error
        throw new AdapterError(error.code, `${error.message} (jobs already re-run before this error: ${retried.join(', ')})`)
      }
      retried.push(job.id)
    }
    return { retried }
  }

  return { find, upsertDraft, get, getChecks, getJobLog, retryJobs }
}
