// The code repository adapter (spec 4, section 2.2 and 4.5, I5).
//   prepare(binding, jiraKey, taskNo)  -> { dir, branch, base }
//   diff(dir, base)                    -> { files: [{ path, added, removed }], patch, totalFiles, totalLines }
//   readFile(dir, path, ref?)          -> the file content (string)
//   log(dir, path?, n?)                -> [{ sha, author, date, subject }]
//   openDraftMR(binding, dir, branch, { title, description, jiraKey }) -> { url }
//   getMR(binding, branch)             -> { state, pipeline, ... }
//   cleanup(dir)                       -> undefined
// The git half (prepare, diff, readFile, log, commit, push, cleanup) is real git in both the fake
// and the real implementation (./git.js). Only the merge-request half differs: the fake keeps
// <dataDir>/fake/gitlab/mrs.json, a real one will call GitLab (plug in at createRealGitlab).
import { join } from 'node:path'
import { AdapterError, notImplemented } from './errors.js'
import { fakeRoot, readJson, updateJson } from './fake/files.js'
import { createGit } from './git.js'

export const mrsFile = (dataDir) => join(fakeRoot(dataDir), 'gitlab', 'mrs.json')

const isText = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * Chooses the merge-request half by `config.adapters.gitlab`.
 * A merge-request backend has two functions:
 *   upsertDraft(binding, { branch, title, description, jiraKey, headSha }) -> { url }  (same branch -> same url)
 *   get(binding, branch) -> { state, pipeline, url, ... }
 */
export function createRepoAdapter(config, options = {}) {
  const mr = config.adapters?.gitlab === 'real' ? createRealGitlab(config, options) : createFakeGitlab(config)
  const git = createGit({ worktreesDir: config.worktreesDir, commitAuthor: config.commitAuthor })

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
    async openDraftMR(binding, dir, branch, { title, description, jiraKey } = {}) {
      const b = complete(binding)
      if (!isText(title)) throw new AdapterError('bad_title', 'the MR title is missing')
      const { branch: current } = await git.head(dir)
      if (current !== branch) throw new AdapterError('wrong_branch', `the directory is on ${current}, not on ${branch}`)
      const existing = await mr.find(b, branch)
      const before = (await git.head(dir)).sha
      const commit = await git.commitAll(dir, {
        message: title,
        description,
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

/** Plug-in point of the real GitLab half (work package R1): same three functions as the fake. */
export function createRealGitlab() {
  throw notImplemented('gitlab')
}

export function createFakeGitlab(config) {
  const file = mrsFile(config.dataDir)

  return {
    async find(_binding, branch) {
      return (await readJson(file, {}))[branch]
    },

    async upsertDraft(binding, { branch, title, description, jiraKey, headSha }) {
      return updateJson(file, {}, (mrs) => {
        const now = new Date().toISOString()
        const old = mrs[branch]
        if (old !== undefined) {
          Object.assign(old, { title, description: description ?? '', jiraKey: jiraKey ?? old.jiraKey, headSha, updatedAt: now })
          return { value: mrs, result: { url: old.url } }
        }
        const repo = binding?.repo ?? 'unknown/unknown'
        const used = Object.values(mrs).filter((m) => m.repo === repo).map((m) => m.iid)
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
