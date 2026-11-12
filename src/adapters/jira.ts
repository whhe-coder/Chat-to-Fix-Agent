// The Jira adapter (spec 4, section 2.2, I5).
//   createIssue(binding, { title, description, acceptance, permalink }) -> { key, url }
//   getIssue(key)          -> { key, title, description, status, comments, ...extras }
//   addComment(key, text)  -> undefined
//   transition(key, status)-> undefined
// The fake keeps <dataDir>/fake/jira/issues.json, keyed by issue key.
import { join } from 'node:path'
import { AdapterError, notImplemented } from './errors.ts'
import { fakeRoot, nextSuffix, readJson, updateJson } from './fake/files.ts'

export const issuesFile = (dataDir) => join(fakeRoot(dataDir), 'jira', 'issues.json')

/** Chooses the implementation by `config.adapters.jira`. */
export function createJiraAdapter(config, options = {}) {
  if (config.adapters?.jira === 'real') return createRealJira(config, options)
  return createFakeJira(config, options)
}

/** Plug-in point of the real implementation (work package R1): same four functions as the fake. */
export function createRealJira() {
  throw notImplemented('jira')
}

const text = (v) => typeof v === 'string' && v.trim() !== ''

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
    async createIssue(binding, { title, description, acceptance, permalink } = {}) {
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
