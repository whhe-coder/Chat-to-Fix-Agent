// The git operations shared by the fake and the real repository adapter (spec 4, section 4.5).
//
// Every call runs `git` with execFile (no shell string), a timeout, and a minimal environment:
// the user's global and system git config are switched off, hooks are switched off, nothing may
// prompt, and author and committer come from the configuration value `commitAuthor`.
// The pattern (execFile + timeout + an explicit small env) follows the DS Bot reference
// bot/src/host/local-agents/discover.js:13 (outputOf) and :77.
//
// Directory rules: a code directory is always <worktreesDir>/T-<n>; anything else is refused, so a
// bot that is handed a wrong path cannot make this module touch another folder.
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile as readFileFs, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AdapterError } from './errors.js'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_BUFFER = 64 * 1024 * 1024
const MAX_FILE_BYTES = 5 * 1024 * 1024
const REF = /^[A-Za-z0-9][A-Za-z0-9._/@^~+-]*$/ // a branch, a tag or a commit id; never starts with "-"
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/

const isText = (v) => typeof v === 'string' && v.trim() !== ''

/** Config switches that make git independent of the machine it runs on. */
const SAFE_CONFIG = [
  'core.hooksPath=/dev/null', 'commit.gpgsign=false', 'tag.gpgsign=false', 'core.fsmonitor=false',
  'core.autocrlf=false', 'protocol.ext.allow=never', 'gc.auto=0', 'advice.detachedHead=false',
]

/** The environment of every git child process. */
export function gitEnv(author) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: tmpdir(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file:https:ssh',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: 'C',
    LC_ALL: 'C',
  }
  if (author) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = author.name
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = author.email
  }
  return env
}

/**
 * Runs one git command. Resolves with { stdout, stderr }; rejects with an AdapterError
 * (`git_timeout` and `git_unavailable` are retryable; `network` marks fetch and push as retryable).
 */
export function runGit(args, { cwd, author, timeoutMs = DEFAULT_TIMEOUT_MS, network = false, raw = false } = {}) {
  const full = [...SAFE_CONFIG.flatMap((c) => ['-c', c]), ...args]
  return new Promise((resolvePromise, reject) => {
    execFile('git', full, { cwd, env: gitEnv(author), timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: raw ? 'buffer' : 'utf8' }, (error, stdout, stderr) => {
      if (error === null) { resolvePromise({ stdout, stderr }); return }
      if (error.code === 'ENOENT') { reject(new AdapterError('git_unavailable', 'git is not installed or not on PATH', { retryable: false })); return }
      if (error.killed || error.signal === 'SIGTERM') { reject(new AdapterError('git_timeout', `git ${args[0]} took longer than ${Math.round(timeoutMs / 1000)}s`, { retryable: true })); return }
      const detail = String(stderr || error.message).trim().split('\n').slice(-3).join(' | ')
      reject(new AdapterError('git_failed', `git ${args[0]} failed: ${detail}`, { retryable: network, cause: error }))
    })
  })
}

/** Checks a path given by a bot; throws unless it is a plain relative path inside the repository. */
export function checkRelativePath(path) {
  if (!isText(path)) throw new AdapterError('bad_path', 'the path is missing')
  if (path.includes('\0')) throw new AdapterError('bad_path', 'the path contains a NUL character')
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith('\\')) throw new AdapterError('path_escape', 'the path must be relative to the repository')
  const parts = path.split(/[\\/]+/)
  if (parts.includes('..')) throw new AdapterError('path_escape', 'the path must not contain ".."')
  if (parts.includes('.git')) throw new AdapterError('path_escape', 'the path must not point into .git')
  return parts.filter((p) => p !== '' && p !== '.').join('/')
}

function checkRef(ref, what = 'ref') {
  if (!isText(ref) || !REF.test(ref) || ref.includes('..')) throw new AdapterError('bad_ref', `${what} "${ref}" is not a valid branch, tag or commit`)
  return ref
}

const inside = (root, target) => {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * @param {{ worktreesDir: string, commitAuthor: {name: string, email: string}, timeoutMs?: number }} options
 */
export function createGit({ worktreesDir, commitAuthor, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const run = (args, options = {}) => runGit(args, { author: commitAuthor, timeoutMs, ...options })
  const out = async (args, options) => (await run(args, options)).stdout

  /** The real path of a code directory; it must exist and sit directly inside worktreesDir. */
  async function codeDir(dir) {
    if (!isText(dir)) throw new AdapterError('bad_dir', 'the code directory is missing')
    let real
    let root
    try {
      real = await realpath(resolve(dir))
      root = await realpath(resolve(worktreesDir))
    } catch {
      throw new AdapterError('bad_dir', `the code directory ${dir} does not exist`)
    }
    if (!inside(root, real)) throw new AdapterError('bad_dir', `the code directory ${dir} is not inside the worktrees directory`)
    return real
  }

  async function mainRepo(binding) {
    if (!isText(binding?.localRepo)) throw new AdapterError('bad_binding', 'the binding has no localRepo')
    const repo = resolve(binding.localRepo)
    try { await out(['rev-parse', '--git-dir'], { cwd: repo }) } catch {
      throw new AdapterError('bad_binding', `${binding.localRepo} is not a git repository`)
    }
    return repo
  }

  const branchExists = async (repo, branch) => {
    try { await run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }); return true } catch { return false }
  }

  /**
   * Updates the local copy and creates <worktreesDir>/T-<n> on branch ai/<jiraKey>, starting from the
   * latest commit of the default branch. Returns { dir, branch, base }. Called again for the same
   * task and key it returns the existing directory.
   */
  async function prepare(binding, jiraKey, taskNo) {
    const repo = await mainRepo(binding)
    if (!isText(jiraKey) || !JIRA_KEY.test(jiraKey)) throw new AdapterError('bad_key', `"${jiraKey}" is not a Jira key`)
    const no = typeof taskNo === 'string' ? taskNo.replace(/^T-/, '') : String(taskNo)
    if (!/^\d+$/.test(no)) throw new AdapterError('bad_task_no', `"${taskNo}" is not a task number`)
    const defaultBranch = checkRef(binding.defaultBranch ?? 'master', 'default branch')
    const branch = `ai/${jiraKey}`
    const dir = join(resolve(worktreesDir), `T-${no}`)

    // 1. update the local copy: fetch the default branch into a private ref (parallel tasks do not clash)
    let source = isText(binding.remote) ? binding.remote : undefined
    if (source === undefined) {
      const remotes = (await out(['remote'], { cwd: repo })).split('\n').map((s) => s.trim())
      if (remotes.includes('origin')) source = 'origin'
    }
    let baseRef = defaultBranch
    if (source !== undefined) {
      const ref = `refs/chat-to-fix/base/${defaultBranch}`
      await run(['fetch', '--quiet', '--no-tags', source, `+refs/heads/${defaultBranch}:${ref}`], { cwd: repo, network: true })
      baseRef = ref
    }
    const latest = (await out(['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: repo })).trim()

    // 2. the separate directory
    await mkdir(worktreesDir, { recursive: true })
    await run(['worktree', 'prune'], { cwd: repo })
    const listing = await out(['worktree', 'list', '--porcelain'], { cwd: repo })
    const realDir = join(await realpath(resolve(worktreesDir)), `T-${no}`)
    const registered = listing.split('\n\n').find((block) => block.split('\n')[0] === `worktree ${realDir}`)
    if (registered !== undefined) {
      if (!registered.includes(`branch refs/heads/${branch}`)) throw new AdapterError('dir_in_use', `${dir} already holds another branch`)
    } else if (await branchExists(repo, branch)) {
      // The branch was kept by an earlier cleanup: continue on it, it is not reset.
      await run(['worktree', 'add', '--quiet', dir, branch], { cwd: repo })
    } else {
      await run(['worktree', 'add', '--quiet', '-b', branch, dir, latest], { cwd: repo })
    }
    const base = (await out(['merge-base', branch, latest], { cwd: repo })).trim()
    return { dir, branch, base }
  }

  /**
   * Changes of the directory relative to `base`. Untracked files are first registered as "to be
   * added" (git add -N) so that newly created files are counted and shown in the patch.
   */
  async function diff(dir, base) {
    const cwd = await codeDir(dir)
    checkRef(base, 'base')
    const untracked = (await out(['ls-files', '--others', '--exclude-standard', '-z'], { cwd })).split('\0').filter(Boolean)
    for (let i = 0; i < untracked.length; i += 200) {
      await run(['add', '--intent-to-add', '--', ...untracked.slice(i, i + 200)], { cwd })
    }
    const common = ['--no-color', '--no-ext-diff', '--no-renames']
    const numstat = await out(['diff', ...common, '--numstat', '-z', base, '--'], { cwd })
    const files = numstat.split('\0').filter(Boolean).map((record) => {
      const [added, removed, ...rest] = record.split('\t')
      return { path: rest.join('\t'), added: added === '-' ? 0 : Number(added), removed: removed === '-' ? 0 : Number(removed) }
    })
    const patch = await out(['diff', ...common, base, '--'], { cwd })
    return { files, patch, totalFiles: files.length, totalLines: files.reduce((n, f) => n + f.added + f.removed, 0) }
  }

  /**
   * The content of one file: from the working directory, or from `ref` (a branch, tag or commit).
   * Refuses absolute paths, "..", ".git" and (for the working directory) a symlink that leads out.
   */
  async function readFile(dir, path, ref) {
    const cwd = await codeDir(dir)
    const clean = checkRelativePath(path)
    if (clean === '') throw new AdapterError('bad_path', 'the path is empty')
    if (isText(ref)) {
      checkRef(ref)
      // `git show <ref>:<path>` returns the stored bytes; a symlink is shown as its target text, never followed.
      const blob = await run(['show', '--no-textconv', `${ref}:${clean}`], { cwd, raw: true })
      if (blob.stdout.length > MAX_FILE_BYTES) throw new AdapterError('file_too_large', `${clean} is larger than ${MAX_FILE_BYTES} bytes`)
      return blob.stdout.toString('utf8')
    }
    const full = join(cwd, clean)
    let real
    try { real = await realpath(full) } catch { throw new AdapterError('file_not_found', `${clean} does not exist`) }
    if (!inside(cwd, real)) throw new AdapterError('path_escape', `${clean} leads outside the repository`)
    const info = await lstat(real)
    if (!info.isFile()) throw new AdapterError('not_a_file', `${clean} is not a regular file`)
    if (info.size > MAX_FILE_BYTES) throw new AdapterError('file_too_large', `${clean} is larger than ${MAX_FILE_BYTES} bytes`)
    return readFileFs(real, 'utf8')
  }

  /** The last `n` (1 to 50) commits, optionally only those touching `path`. */
  async function log(dir, path, n = 10) {
    const cwd = await codeDir(dir)
    const count = Math.min(50, Math.max(1, Math.trunc(Number(n)) || 10))
    const args = ['log', `-n${count}`, '--no-color', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e']
    if (isText(path)) args.push('--', checkRelativePath(path))
    let stdout
    try { stdout = await out(args, { cwd }) } catch (error) {
      if (/does not have any commits/.test(error.message)) return []
      throw error
    }
    return stdout.split('\x1e').map((r) => r.trim()).filter(Boolean).map((record) => {
      const [sha, author, date, subject] = record.split('\x1f')
      return { sha, author, date, subject }
    })
  }

  /** The branch and the commit the directory is on. */
  async function head(dir) {
    const cwd = await codeDir(dir)
    const branch = (await out(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).trim()
    const sha = (await out(['rev-parse', 'HEAD'], { cwd })).trim()
    return { branch, sha }
  }

  /**
   * Commits everything in the directory (tracked, changed, deleted and new files) with the
   * configured author. `amend` replaces the last commit instead of adding one. Returns
   * { sha, committed } (`committed` is false when there was nothing new to commit).
   */
  async function commitAll(dir, { message, description, amend = false }) {
    const cwd = await codeDir(dir)
    if (!isText(message)) throw new AdapterError('bad_message', 'the commit message is missing')
    await run(['add', '-A'], { cwd })
    const dirty = (await out(['status', '--porcelain'], { cwd })).trim() !== ''
    if (dirty) {
      const args = ['commit', '--quiet', '--no-verify', '-m', message]
      if (isText(description)) args.push('-m', description)
      if (amend) args.push('--amend')
      await run(args, { cwd })
    }
    return { sha: (await out(['rev-parse', 'HEAD'], { cwd })).trim(), committed: dirty }
  }

  /** How many commits the directory's HEAD has that the default branch (as last fetched) does not. */
  async function commitsAhead(dir, defaultBranch) {
    const cwd = await codeDir(dir)
    checkRef(defaultBranch, 'default branch')
    let ref = `refs/chat-to-fix/base/${defaultBranch}`
    try { await run(['rev-parse', '--verify', '--quiet', ref], { cwd }) } catch { ref = defaultBranch }
    return Number((await out(['rev-list', '--count', `${ref}..HEAD`], { cwd })).trim())
  }

  /** Pushes the branch (forced: the branch belongs to the bot, and a second MR call may amend). */
  async function push(dir, remote, branch) {
    const cwd = await codeDir(dir)
    checkRef(branch, 'branch')
    if (!isText(remote)) throw new AdapterError('no_remote', 'the binding has no remote to push to')
    await run(['push', '--quiet', '--force', remote, `refs/heads/${branch}:refs/heads/${branch}`], { cwd, network: true })
  }

  /** Removes the worktree directory. The branch stays. Does nothing when the directory is gone. */
  async function cleanup(dir) {
    if (!isText(dir)) throw new AdapterError('bad_dir', 'the code directory is missing')
    let real
    try { real = await codeDir(dir) } catch (error) {
      // Gone already: nothing to remove. Anything else (outside worktreesDir) is refused.
      try { await lstat(resolve(dir)) } catch { return }
      throw error
    }
    const common = (await out(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: real })).trim()
    await run([`--git-dir=${common}`, 'worktree', 'remove', '--force', real])
    await rm(real, { recursive: true, force: true })
  }

  return { prepare, diff, readFile, log, head, commitsAhead, commitAll, push, cleanup, run: (args, options) => out(args, options) }
}
