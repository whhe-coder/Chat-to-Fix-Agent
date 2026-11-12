// The code repository adapter (spec 4, section 2.2 and 4.5, I5).
//   prepare(binding, jiraKey, taskNo)  -> { dir, branch, base }
//   diff(dir, base)                    -> { files: [{ path, added, removed }], patch, totalFiles, totalLines }
//   readFile(dir, path, ref?)          -> the file content (string)
//   log(dir, path?, n?)                -> [{ sha, author, date, subject }]
//   openDraftMR(binding, dir, branch, { title, description, jiraKey, commitMessage? }) -> { url }
//   getMR(binding, branch)             -> { state, pipeline, ... }
//   cleanup(dir)                       -> undefined
// The git half (prepare, diff, readFile, log, commit, push, cleanup) is real git in both the fake
// and the real implementation (./git.js). Only the merge-request half differs: the fake keeps
// <dataDir>/fake/gitlab/mrs.json, the real one calls the GitLab REST API (./gitlab-http.js).
// The commit is one Conventional Commit line without a body (commitMessage, default `fix: <title>`);
// the MR title and description carry the details.
import { join } from 'node:path'
import { AdapterError } from './errors.ts'
import { fakeRoot, readJson, updateJson } from './fake/files.ts'
import { COMMIT_MESSAGE_MAX, commitMessageFromTitle, createGit, isCommitMessage } from './git.ts'
import { createRealGitlab } from './gitlab-http.ts'

export { createRealGitlab }

export const mrsFile = (dataDir) => join(fakeRoot(dataDir), 'gitlab', 'mrs.json')

const isText = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * Chooses the merge-request half by `config.adapters.gitlab`.
 * A merge-request backend has three functions:
 *   find(binding, branch) -> { url, headSha, ... } | undefined  (the open MR of the branch)
 *   upsertDraft(binding, { branch, title, description, jiraKey, headSha }) -> { url }  (same branch -> same url)
 *   get(binding, branch) -> { state, pipeline, url, ... }
 */
export function createRepoAdapter(config, options: any = {}) {
  const mr: any = config.adapters?.gitlab === 'real' ? (createRealGitlab as any)(config, options) : createFakeGitlab(config)
  // With the real GitLab adapter, git gets the same token for https remotes on the GitLab host (git.ts gitAuthEnv).
  const realGitlab = config.adapters?.gitlab === 'real'
  const token = (options.env ?? process.env).CHAT_TO_FIX_GITLAB_TOKEN
  const auth = realGitlab && typeof token === 'string' && token !== '' ? { baseUrl: config.gitlab?.baseUrl, token } : undefined
  const git = createGit({ worktreesDir: config.worktreesDir, commitAuthor: config.commitAuthor, auth })

  /**
   * The task keeps a copy of the binding that may lack localRepo and remote: complete it from the
   * configured binding of the same channel (or, without a channel, of the same repository).
   */
  const complete = (binding) => {
    if (binding?.localRepo !== undefined) return binding
    const configured = (config.bindings ?? []).find((b) => (binding?.channel !== undefined ? b.channel === binding.channel : b.repo === binding?.repo))
    return configured === undefined ? binding : { ...configured, ...binding, localRepo: configured.localRepo, remote: binding?.remote ?? configured.remote }
  }

  return {
    prepare: (binding, jiraKey, taskNo) => git.prepare(complete(binding), jiraKey, taskNo),
    diff: (dir, base) => git.diff(dir, base),
    readFile: (dir, path, ref) => git.readFile(dir, path, ref),
    log: (dir, path, n) => git.log(dir, path, n),
    cleanup: (dir) => git.cleanup(dir),

    /**
     * One real commit of everything in the directory, a real push, and the MR record. Called again for
     * the same branch it amends our own commit (or adds one when someone committed since), pushes
     * again and returns the same url.
     */
    async openDraftMR(binding, dir, branch, { title, description, jiraKey, commitMessage }: any = {}) {
      const b = complete(binding)
      if (!isText(title)) throw new AdapterError('bad_title', 'the MR title is missing')
      const message = isText(commitMessage) ? commitMessage.trim() : commitMessageFromTitle(title)
      if (!isCommitMessage(message)) {
        throw new AdapterError('bad_message', `the commit message must be one line "type(scope)?: summary" of at most ${COMMIT_MESSAGE_MAX} characters`)
      }
      const { branch: current } = await git.head(dir)
      if (current !== branch) throw new AdapterError('wrong_branch', `the directory is on ${current}, not on ${branch}`)
      const existing = await mr.find(b, branch)
      const before = (await git.head(dir)).sha
      const commit = await git.commitAll(dir, {
        message,
        amend: existing !== undefined && existing.headSha === before,
      })
      if (!commit.committed && existing === undefined && (await git.commitsAhead(dir, b?.defaultBranch ?? 'master')) === 0) {
        throw new AdapterError('nothing_to_commit', `the directory ${dir} has no changes to commit`)
      }
      await git.push(dir, isText(b?.remote) ? b.remote : 'origin', branch)
      return mr.upsertDraft(b, { branch, title, description, jiraKey, headSha: commit.sha })
    },

    getMR: (binding, branch) => mr.get(complete(binding), branch),
  }
}

export function createFakeGitlab(config) {
  const file = mrsFile(config.dataDir)

  return {
    async find(_binding, branch) {
      return (await readJson(file, {}))[branch]
    },

    async upsertDraft(binding, { branch, title, description, jiraKey, headSha }) {
      return updateJson(file, {}, (mrs: any) => {
        const now = new Date().toISOString()
        const old = mrs[branch]
        if (old !== undefined) {
          Object.assign(old, { title, description: description ?? '', jiraKey: jiraKey ?? old.jiraKey, headSha, updatedAt: now })
          return { value: mrs, result: { url: old.url } }
        }
        const repo = binding?.repo ?? 'unknown/unknown'
        const used = Object.values(mrs).filter((m: any) => m.repo === repo).map((m: any) => m.iid)
        const iid = Math.max(0, ...used) + 1
        mrs[branch] = {
          iid, repo, url: `fake://gitlab/${repo}/mr/${iid}`, branch, target: binding?.defaultBranch ?? 'master',
          title, description: description ?? '', jiraKey: jiraKey ?? null, draft: true, state: 'opened', pipeline: 'none',
          headSha, createdAt: now, updatedAt: now,
        }
        return { value: mrs, result: { url: mrs[branch].url } }
      })
    },

    async get(_binding, branch) {
      const entry = (await readJson(file, {}))[branch]
      if (entry === undefined) throw new AdapterError('mr_not_found', `no merge request for branch ${branch}`)
      return { state: entry.state, pipeline: entry.pipeline, url: entry.url, draft: entry.draft, title: entry.title }
    },
  }
}
