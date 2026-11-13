// The code repository adapter (spec 4, section 2.2 and 4.5, I5).
//   prepare(binding, jiraKey, taskNo)  -> { dir, branch, base }
//   diff(dir, base)                    -> { files: [{ path, added, removed }], patch, totalFiles, totalLines }
//   readFile(dir, path, ref?)          -> the file content (string)
//   log(dir, path?, n?)                -> [{ sha, author, date, subject }]
//   openDraftMR(binding, dir, branch, { title, description, jiraKey, commitMessage? }) -> { url, iid, sha }
//   getMR(binding, branch)             -> { state, pipeline, ... }
//   getChecks(binding, iid)            -> { status, sha, pipelineUrl, failedJobs }   (spec 7, 4.5)
//   getJobLog(binding, job, { maxChars }) -> the log tail (string)
//   retryJobs(binding, jobs)           -> { retried: [id] }
//   pushFix(binding, dir, branch, { message }) -> { sha }
//   cleanup(dir)                       -> undefined
// The git half (prepare, diff, readFile, log, commit, push, cleanup) is real git in both the fake
// and the real implementation (./git.js). Only the merge-request half differs: the fake keeps
// <dataDir>/fake/gitlab/mrs.json, the real one calls the GitLab REST API (./gitlab-http.js).
// The commit is one Conventional Commit line without a body (commitMessage, default `fix: <title>`; the tools
// put the Jira key in front, `KEY-1: fix: x`, and the adapter commits the message exactly as given);
// the MR title and description carry the details.
// The branch only grows (spec 7, 4.5): every commit is a new one (no amend) and every push is a normal
// push (no --force). A remote that moved makes the push fail with code `push_rejected`.
import { join } from 'node:path'
import { AdapterError } from './errors.ts'
import { fakeRoot, readJson, updateJson } from './fake/files.ts'
import { COMMIT_MESSAGE_MAX, commitMessageFromTitle, createGit, isCommitMessageOptionallyKeyed as isCommitMessage } from './git.ts'
import { createFakeCi } from './fake/ci.ts'
import { createRealGitlab } from './gitlab-http.ts'

export { createRealGitlab }

export const mrsFile = (dataDir) => join(fakeRoot(dataDir), 'gitlab', 'mrs.json')

const isText = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * Chooses the merge-request half by `config.adapters.gitlab`.
 * A merge-request backend has three functions:
 *   find(binding, branch) -> { url, headSha, ... } | undefined  (the open MR of the branch)
 *   upsertDraft(binding, { branch, title, description, jiraKey, headSha }) -> { url, iid }  (same branch -> same url)
 *   get(binding, branch) -> { state, pipeline, url, ... }
 *   getChecks(binding, iid), getJobLog(binding, job, options), retryJobs(binding, jobs)   (CI, spec 7)
 *   afterPush?(binding, { branch, sha, source })  fake only: records the new head and starts the simulated CI
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

  const remoteOf = (b) => (isText(b?.remote) ? b.remote : 'origin')
  /** A local repository that has the pushed commits: the main repository of the binding, else the code directory. */
  const sourceOf = (b, dir) => (isText(b?.localRepo) ? b.localRepo : dir)

  return {
    prepare: (binding, jiraKey, taskNo) => git.prepare(complete(binding), jiraKey, taskNo),
    diff: (dir, base) => git.diff(dir, base),
    readFile: (dir, path, ref) => git.readFile(dir, path, ref),
    log: (dir, path, n) => git.log(dir, path, n),
    cleanup: (dir) => git.cleanup(dir),

    /**
     * One real commit of everything in the directory, a real (normal) push, and the MR record. Called again
     * for the same branch it appends one more commit (never amends), pushes again and returns the same url.
     * Returns { url, iid, sha }: the sha is the commit that was pushed. A remote that moved: `push_rejected`.
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
      const commit = await git.commitAll(dir, { message })
      if (!commit.committed && existing === undefined && (await git.commitsAhead(dir, b?.defaultBranch ?? 'master')) === 0) {
        throw new AdapterError('nothing_to_commit', `the directory ${dir} has no changes to commit`)
      }
      await git.push(dir, remoteOf(b), branch)
      const opened = await mr.upsertDraft(b, { branch, title, description, jiraKey, headSha: commit.sha })
      await mr.afterPush?.(b, { branch, sha: commit.sha, source: sourceOf(b, dir) })
      return { url: opened.url, iid: opened.iid, sha: commit.sha }
    },

    /**
     * One CI fix round (spec 7, 4.5): everything in the directory as ONE new commit (the message is one
     * Conventional Commit line, for example `fix(ci): ...`), pushed normally. No change: `nothing_to_commit`;
     * the remote moved: `push_rejected` (nothing is pulled, nothing is forced). Returns { sha }.
     * When the tree is clean but this directory holds a commit the remote lacks (an earlier push failed
     * on the network), that commit is pushed instead of reporting nothing to commit.
     */
    async pushFix(binding, dir, branch, { message }: any = {}) {
      const b = complete(binding)
      if (!isCommitMessage(message)) {
        throw new AdapterError('bad_message', `the commit message must be one line "type(scope)?: summary" of at most ${COMMIT_MESSAGE_MAX} characters`)
      }
      const { branch: current } = await git.head(dir)
      if (current !== branch) throw new AdapterError('wrong_branch', `the directory is on ${current}, not on ${branch}`)
      const remote = remoteOf(b)
      const commit = await git.commitAll(dir, { message })
      if (!commit.committed) {
        const onRemote = await git.remoteHead(dir, remote, branch)
        const unpushed = onRemote !== undefined && onRemote !== commit.sha && (await git.isAncestorOfHead(dir, onRemote))
        if (!unpushed) throw new AdapterError('nothing_to_commit', `the directory ${dir} has no changes to commit`)
      }
      await git.push(dir, remote, branch)
      await mr.afterPush?.(b, { branch, sha: commit.sha, source: sourceOf(b, dir) })
      return { sha: commit.sha }
    },

    getChecks: (binding, iid) => mr.getChecks(complete(binding), iid),
    getJobLog: (binding, job, options) => mr.getJobLog(complete(binding), job, options ?? {}),
    retryJobs: (binding, jobs) => mr.retryJobs(complete(binding), jobs),

    getMR: (binding, branch) => mr.get(complete(binding), branch),

    /** Fake GitLab only (tests): resolves when no simulated CI job is running any more. Undefined for the real GitLab. */
    ciIdle: mr.ciIdle,
  }
}

export function createFakeGitlab(config) {
  const file = mrsFile(config.dataDir)
  const findByIid = async (binding, iid) => {
    const entry = Object.values(await readJson(file, {})).find((m: any) => String(m.iid) === String(iid) && (binding?.repo === undefined || m.repo === binding.repo)) as any
    return entry === undefined ? undefined : { repo: entry.repo, branch: entry.branch, headSha: entry.headSha, url: entry.url }
  }
  const ci = createFakeCi(config, { findMr: findByIid })

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
          return { value: mrs, result: { url: old.url, iid: old.iid } }
        }
        const repo = binding?.repo ?? 'unknown/unknown'
        const used = Object.values(mrs).filter((m: any) => m.repo === repo).map((m: any) => m.iid)
        const iid = Math.max(0, ...used) + 1
        mrs[branch] = {
          iid, repo, url: `fake://gitlab/${repo}/mr/${iid}`, branch, target: binding?.defaultBranch ?? 'master',
          title, description: description ?? '', jiraKey: jiraKey ?? null, draft: true, state: 'opened', pipeline: 'none',
          headSha, createdAt: now, updatedAt: now,
        }
        return { value: mrs, result: { url: mrs[branch].url, iid } }
      })
    },

    /** After a push of the task branch: the MR's head is the pushed commit; the simulated CI runs for it. */
    async afterPush(binding, { branch, sha, source }) {
      await updateJson(file, {}, (mrs: any) => {
        if (mrs[branch] === undefined) return { value: undefined, result: undefined }
        Object.assign(mrs[branch], { headSha: sha, updatedAt: new Date().toISOString() })
        return { value: mrs, result: undefined }
      })
      await ci.onPush(binding, { branch, sha, source })
    },

    getChecks: (binding, iid) => ci.getChecks(binding, iid),
    getJobLog: (binding, job, options) => ci.getJobLog(binding, job, options),
    retryJobs: (binding, jobs) => ci.retryJobs(binding, jobs),
    /** Fake only (tests): resolves when no simulated job is running. */
    ciIdle: () => ci.idle(),

    async get(_binding, branch) {
      const entry = (await readJson(file, {}))[branch]
      if (entry === undefined) throw new AdapterError('mr_not_found', `no merge request for branch ${branch}`)
      return { state: entry.state, pipeline: entry.pipeline, url: entry.url, draft: entry.draft, title: entry.title }
    },
  }
}
