// The Jira adapter (spec 4, section 2.2, I5).
//   createIssue(binding, { title, description, acceptance, permalink }) -> { key, url }
//   getIssue(key)          -> { key, title, description, status, comments, ...extras }
//   addComment(key, text)  -> undefined
//   transition(key, status)-> undefined
// The fake keeps <dataDir>/fake/jira/issues.json, keyed by issue key.
import { join } from 'node:path'
import { AdapterError } from './errors.ts'
import { fakeRoot, nextSuffix, readJson, updateJson } from './fake/files.ts'
import { createJiraHttp } from './jira-http.ts'

export const issuesFile = (dataDir) => join(fakeRoot(dataDir), 'jira', 'issues.json')

/** Chooses the implementation by `config.adapters.jira`. */
export function createJiraAdapter(config, options = {}) {
  if (config.adapters?.jira === 'real') return (createRealJira as any)(config, options)
  return (createFakeJira as any)(config, options)
}

const text = (v) => typeof v === 'string' && v.trim() !== ''
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/
const COMMENT_PAGE = 100
const COMMENT_PAGES_MAX = 10
/** Stays well below the tool layer's 30 s (src/tools/register.ts) so a late reply cannot outlive its tool call. */
const REAL_TIMEOUT_MS = 20_000

/** Jira text is a string in REST v2; flattens an Atlassian document (v3 style) if one ever shows up. */
function plain(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  const out = []
  const walk = (node) => {
    if (!isObject(node)) return
    if (node.type === 'text' && typeof node.text === 'string') out.push(node.text)
    if (node.type === 'hardBreak') out.push('\n')
    if (Array.isArray(node.content)) node.content.forEach(walk)
    if (['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(node.type)) out.push('\n')
  }
  walk(value)
  return out.join('').trim()
}

const commentOf = (c) => ({
  id: String(c.id),
  at: c.created,
  author: { id: c.author?.accountId ?? c.author?.name, name: c.author?.displayName ?? c.author?.name ?? c.author?.emailAddress },
  text: plain(c.body),
})

/**
 * The real Jira adapter: the same four functions as the fake. Jira Cloud scoped tokens use the
 * gateway at api.atlassian.com and REST v3 with Atlassian Document Format bodies.
 *   config.jira = { baseUrl, email?, fields? }; token in env CHAT_TO_FIX_JIRA_TOKEN; the e-mail may also
 *   come from env CHAT_TO_FIX_JIRA_EMAIL. With an e-mail: Basic auth `email:token` (Jira Cloud API token);
 *   without: `Authorization: Bearer <token>`.
 *   Create payload fields = project, issuetype, summary, description, labels, then config.jira.fields,
 *   then binding.jiraFields (later ones override earlier ones).
 * @param {object} config
 * @param {{ env?: object, warn?: Function, fetch?: Function, timeoutMs?: number, budgetMs?: number,
 *           maxRetries?: number, maxRetryWaitMs?: number, sleep?: Function }} [options]  The last five are test hooks.
 */
export function createRealJira(config, options: any = {}) {
  const env = options.env ?? process.env
  const jira = config?.jira ?? {}
  const token = text(env.CHAT_TO_FIX_JIRA_TOKEN) ? env.CHAT_TO_FIX_JIRA_TOKEN.trim() : undefined
  if (token === undefined) throw new AdapterError('bad_config', 'adapters.jira is "real" but CHAT_TO_FIX_JIRA_TOKEN is not set')
  let base
  try {
    base = new URL(jira.baseUrl)
  } catch {
    throw new AdapterError('bad_config', 'adapters.jira is "real" but jira.baseUrl is missing or not a URL')
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new AdapterError('bad_config', 'jira.baseUrl must be an http(s) URL')
  if (base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') {
    throw new AdapterError('bad_config', 'jira.baseUrl must not hold credentials, a query or a fragment')
  }
  const baseUrl = `${base.origin}${base.pathname.replace(/\/+$/, '')}`
  const apiVersion = jira.apiVersion ?? '2'
  if (apiVersion !== '2' && apiVersion !== '3') throw new AdapterError('bad_config', 'jira.apiVersion must be 2 or 3')
  const browseUrl = jira.browseUrl ?? baseUrl
  let browseBase
  try {
    const url = new URL(browseUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol')
    if (url.username || url.password || url.search || url.hash) throw new Error('credentials')
    browseBase = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch { throw new AdapterError('bad_config', 'jira.browseUrl must be an http(s) URL without credentials') }
  const email = text(jira.email) ? jira.email.trim() : text(env.CHAT_TO_FIX_JIRA_EMAIL) ? env.CHAT_TO_FIX_JIRA_EMAIL.trim() : undefined
  const authorization = email === undefined ? `Bearer ${token}` : `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
  const timeoutMs = options.timeoutMs ?? Math.min(REAL_TIMEOUT_MS, Math.max(1000, ((config?.limits?.toolTimeoutSeconds ?? 30) - 8) * 1000))
  const http = createJiraHttp({
    baseUrl, authorization, secrets: [token], timeoutMs,
    fetch: options.fetch, budgetMs: options.budgetMs, maxRetries: options.maxRetries, maxRetryWaitMs: options.maxRetryWaitMs, sleep: options.sleep,
  })
  const api = `/rest/api/${apiVersion}`
  const adf = (value) => ({ type: 'doc', version: 1, content: String(value).replace(/\r\n?/g, '\n').split('\n').map((line) => ({
    type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}),
  })) })
  const issuePath = (key) => `${api}/issue/${encodeURIComponent(key)}`
  const missing = (key) => ({ code: 'issue_not_found', message: `issue ${key} does not exist or is not visible to the Jira user` })

  function needKey(key) {
    if (!text(key)) throw new AdapterError('bad_key', 'the issue key is missing')
    const clean = key.trim()
    if (!KEY_PATTERN.test(clean)) throw new AdapterError('bad_key', `"${clean.slice(0, 40)}" is not a Jira issue key`)
    return clean
  }

  return {
    async createIssue(binding, { title, description, acceptance, permalink }: any = {}) {
      if (!text(binding?.jiraProject)) throw new AdapterError('bad_binding', 'the binding has no jiraProject')
      if (!text(title)) throw new AdapterError('bad_title', 'the issue title is missing')
      for (const extra of [jira.fields, binding.jiraFields]) {
        if (extra !== undefined && !isObject(extra)) throw new AdapterError('bad_binding', 'jira.fields and jiraFields must be objects')
      }
      // Acceptance criteria live in the description (the existing automation reads them there).
      const body = [text(description) ? description.trim() : '', text(acceptance) ? `Acceptance criteria:\n${acceptance.trim()}` : ''].filter(Boolean).join('\n\n')
      const type = String(binding.issueType ?? 'Bug').trim()
      const fields = {
        project: { key: binding.jiraProject.trim() },
        issuetype: /^\d+$/.test(type) ? { id: type } : { name: type },
        summary: title.trim().replace(/\s+/g, ' ').slice(0, 255),
        description: apiVersion === '3' ? adf(body) : body,
        ...(Array.isArray(binding.labels) && binding.labels.length > 0 ? { labels: [...binding.labels] } : {}),
        ...jira.fields,
        ...binding.jiraFields,
      }
      const created = await http.request('POST', `${api}/issue`, {
        body: { fields },
        notFound: { code: 'project_not_found', message: `Jira answered 404 to the create request; check jira.baseUrl and that project ${binding.jiraProject} exists` },
      })
      if (!isObject(created) || !text(created.key)) {
        throw new AdapterError('bad_response', 'Jira answered the create request without an issue key; the issue may have been created, check the project before trying again')
      }
      return { key: created.key, url: `${browseBase}/browse/${created.key}` }
    },

    async getIssue(key) {
      const id = needKey(key)
      const fieldList = 'summary,description,status,issuetype,project,labels,created,comment'
      const issue = await http.request('GET', `${issuePath(id)}?fields=${fieldList}`, { notFound: missing(id) })
      if (!isObject(issue) || !isObject(issue.fields)) throw new AdapterError('bad_response', `Jira answered the read of ${id} with something that is not an issue`)
      const f = issue.fields
      const comments = Array.isArray(f.comment?.comments) ? [...f.comment.comments] : []
      // The issue read can hold only the first comments; page through the rest.
      const total = Number.isInteger(f.comment?.total) ? f.comment.total : comments.length
      for (let page = 0; comments.length < total && page < COMMENT_PAGES_MAX; page++) {
        const more = await http.request('GET', `${issuePath(id)}/comment?orderBy=created&startAt=${comments.length}&maxResults=${COMMENT_PAGE}`, { notFound: missing(id) })
        const list = Array.isArray(more?.comments) ? more.comments : []
        if (list.length === 0) break
        comments.push(...list)
      }
      return {
        key: issue.key ?? id,
        url: `${browseBase}/browse/${issue.key ?? id}`,
        title: f.summary ?? '',
        description: plain(f.description),
        status: f.status?.name ?? 'unknown',
        comments: comments.map(commentOf),
        project: f.project?.key,
        type: f.issuetype?.name,
        labels: Array.isArray(f.labels) ? f.labels : [],
        createdAt: f.created,
      }
    },

    async addComment(key, body) {
      const id = needKey(key)
      if (!text(body)) throw new AdapterError('bad_text', 'the comment text is empty')
      await http.request('POST', `${issuePath(id)}/comment`, { body: { body: apiVersion === '3' ? adf(body) : body }, notFound: missing(id) })
    },

    async transition(key, status) {
      const id = needKey(key)
      if (!text(status)) throw new AdapterError('bad_status', 'the status is missing')
      const wanted = status.trim().toLowerCase()
      const allowed = config?.jiraTransitions
      if (Array.isArray(allowed) && !allowed.some((name) => String(name).trim().toLowerCase() === wanted)) {
        throw new AdapterError('status_not_allowed', `status "${status.trim()}" is not in the configured jiraTransitions (${allowed.join(', ') || 'none'})`)
      }
      const listed = await http.request('GET', `${issuePath(id)}/transitions`, { notFound: missing(id) })
      const available = Array.isArray(listed?.transitions) ? listed.transitions : []
      // Prefer the target status; fall back to the transition's own name (some workflows name them alike).
      const match = available.find((t) => String(t.to?.name ?? '').toLowerCase() === wanted) ?? available.find((t) => String(t.name ?? '').toLowerCase() === wanted)
      if (!match) {
        // Retried or already moved by someone: being in the target status is success.
        const now = await http.request('GET', `${issuePath(id)}?fields=status`, { notFound: missing(id) })
        if (String(now?.fields?.status?.name ?? '').toLowerCase() === wanted) return
        const names = available.map((t) => t.to?.name ?? t.name).filter(Boolean)
        throw new AdapterError('transition_not_available', `${id} cannot move to "${status.trim()}" from its current status; available: ${names.join(', ') || 'none'}`)
      }
      await http.request('POST', `${issuePath(id)}/transitions`, { body: { transition: { id: String(match.id) } }, notFound: missing(id) })
    },
  }
}

export function createFakeJira(config) {
  const file = issuesFile(config.dataDir)

  async function mutate(key, change) {
    if (!text(key)) throw new AdapterError('bad_key', 'the issue key is missing')
    return updateJson(file, {}, (issues) => {
      const issue = issues[key]
      if (issue === undefined) throw new AdapterError('issue_not_found', `issue ${key} does not exist`)
      change(issue)
      return { value: issues, result: undefined }
    })
  }

  return {
    async createIssue(binding, { title, description, acceptance, permalink }: any = {}) {
      if (!text(binding?.jiraProject)) throw new AdapterError('bad_binding', 'the binding has no jiraProject')
      if (!text(title)) throw new AdapterError('bad_title', 'the issue title is missing')
      return updateJson(file, {}, (issues) => {
        const prefix = `${binding.jiraProject}-`
        const key = `${prefix}${nextSuffix(Object.keys(issues), prefix)}`
        issues[key] = {
          key,
          url: `fake://jira/${key}`,
          project: binding.jiraProject,
          type: binding.issueType ?? 'Bug',
          labels: [...(binding.labels ?? [])],
          title,
          description: description ?? '',
          acceptance: acceptance ?? '',
          permalink: permalink ?? null,
          status: 'To Do',
          comments: [],
          createdAt: new Date().toISOString(),
        }
        return { value: issues, result: { key, url: issues[key].url } }
      })
    },

    async getIssue(key) {
      const issues = await readJson(file, {})
      const issue = text(key) ? issues[key] : undefined
      if (issue === undefined) throw new AdapterError('issue_not_found', `issue ${key} does not exist`)
      return structuredClone(issue)
    },

    async addComment(key, body) {
      if (!text(body)) throw new AdapterError('bad_text', 'the comment text is empty')
      await mutate(key, (issue) => {
        issue.comments.push({ id: `${key}-c${issue.comments.length + 1}`, text: body, at: new Date().toISOString() })
      })
    },

    async transition(key, status) {
      if (!text(status)) throw new AdapterError('bad_status', 'the status is missing')
      await mutate(key, (issue) => { issue.status = status })
    },
  }
}
