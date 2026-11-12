// Files, git and process helpers of the e2e suite: building a case repository, looking at a finished
// worktree, and running test commands in copies of it. Nothing here touches a model or a network.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const AUTHOR = { name: 'Test Author', email: 'test@example.com' }
const CLEAN_ENV = { PATH: process.env.PATH ?? '', HOME: tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' }

export const tailOf = (text: string, lines = 12) => String(text).trimEnd().split('\n').slice(-lines).join('\n')

/** Runs a shell command line; never throws. { code, out } where out is stdout + stderr. */
export function sh(command: string, cwd: string, { timeoutMs = 60_000 } = {}) {
  const r = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...CLEAN_ENV, HOME: process.env.HOME ?? tmpdir() } })
  return { code: r.status ?? (r.error ? 124 : 1), out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` }
}

/** Runs an executable with arguments (no shell); never throws. */
export function run(file: string, args: string[], cwd: string, { timeoutMs = 60_000, env = {} as any } = {}) {
  const r = spawnSync(file, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...CLEAN_ENV, ...env } })
  return { code: r.status ?? (r.error ? 124 : 1), out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` }
}

const git = (args: string[], cwd: string) => run('git', args, cwd)
const gitOut = (args: string[], cwd: string) => {
  const r = git(args, cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${tailOf(r.out, 3)}`)
  return r.out.trim()
}

export function writeTree(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

/** A new temporary folder (the caller removes it). */
export const tempDir = (prefix = 'chat-to-fix-e2e-') => mkdtempSync(join(tmpdir(), prefix))

/** Copies a folder without its .git entry. */
export function copyDir(from: string, to: string) {
  cpSync(from, to, { recursive: true, filter: (source) => !/(^|[\\/])\.git$/.test(source) })
}

/**
 * Creates <dir>/project (local repository on `defaultBranch`, one commit, remote `origin`) and
 * <dir>/project.git (the bare repository holding the commit). Same layout as scripts/make-test-repo.ts.
 */
export function createCaseRepo({ dir, files, defaultBranch = 'master', message = 'Initial commit' }: { dir: string, files: Record<string, string>, defaultBranch?: string, message?: string }) {
  const root = resolve(dir)
  const localRepo = join(root, 'project')
  const remote = join(root, 'project.git')
  mkdirSync(localRepo, { recursive: true })
  gitOut(['init', '--quiet', '--bare', '-b', defaultBranch, remote], root)
  gitOut(['init', '--quiet', '-b', defaultBranch, localRepo], root)
  writeTree(localRepo, files)
  gitOut(['add', '-A'], localRepo)
  gitOut(['-c', `user.name=${AUTHOR.name}`, '-c', `user.email=${AUTHOR.email}`, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message], localRepo)
  gitOut(['remote', 'add', 'origin', remote], localRepo)
  gitOut(['push', '--quiet', 'origin', `${defaultBranch}:${defaultBranch}`], localRepo)
  return { localRepo, remote, defaultBranch, commit: gitOut(['rev-parse', 'HEAD'], localRepo) }
}

/**
 * What the checks need to know about a finished worktree, read with git (read-only):
 * { branch, commits: [{ sha, subject, body }], changedFiles, uncommitted, diff, remoteBranches, remoteDefaultHead,
 *   localDefaultHead, headDir, baseDir, cleanup() }. headDir / baseDir are plain copies of the files at the branch
 * head and at the base commit (made with git archive) in a temporary folder; cleanup() removes them.
 */
export function inspectWorkspace({ worktreeDir, base, remote, localRepo, defaultBranch = 'master' }: { worktreeDir: string, base: string, remote?: string, localRepo?: string, defaultBranch?: string }) {
  const tmp = tempDir()
  const cwd = resolve(worktreeDir)
  const archive = (ref: string, name: string) => {
    const target = join(tmp, name)
    mkdirSync(target, { recursive: true })
    const tar = join(tmp, `${name}.tar`)
    gitOut(['archive', '--format=tar', '-o', tar, ref], cwd)
    const r = run('tar', ['-xf', tar, '-C', target], tmp)
    if (r.code !== 0) throw new Error(`tar failed: ${tailOf(r.out, 3)}`)
    return target
  }
  const log = gitOut(['log', '--format=%H%x1f%s%x1f%b%x1e', `${base}..HEAD`], cwd)
  const commits = log.split('\x1e').map((s) => s.replace(/^\n+/, '')).filter((s) => s.trim() !== '').map((entry) => {
    const [sha, subject, body] = entry.split('\x1f')
    return { sha: sha.trim(), subject, body: (body ?? '').trim() }
  })
  const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean)
  const remoteHeads = remote !== undefined && existsSync(remote) ? run('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], tmp) : undefined
  const remoteMap = Object.fromEntries(lines(remoteHeads?.code === 0 ? remoteHeads.out : '').map((l) => l.split(' ')))
  const localHead = localRepo !== undefined && existsSync(localRepo) ? run('git', ['-C', localRepo, 'rev-parse', `refs/heads/${defaultBranch}`], tmp) : undefined
  return {
    branch: gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    commits,
    changedFiles: lines(gitOut(['diff', '--name-only', base, 'HEAD'], cwd)),
    uncommitted: lines(gitOut(['status', '--porcelain'], cwd)),
    diff: gitOut(['diff', base, 'HEAD'], cwd),
    remoteBranches: Object.keys(remoteMap),
    remoteDefaultHead: remoteMap[defaultBranch],
    localDefaultHead: localHead?.code === 0 ? localHead.out.trim() : undefined,
    headDir: archive('HEAD', 'head'),
    baseDir: archive(base, 'base'),
    cleanup() { rmSync(tmp, { recursive: true, force: true }) },
  }
}

/** Copies `dir`, adds the hidden files, runs each hidden test with node. [{ file, code, out }] */
export function runHidden(dir: string, hiddenFiles: Record<string, string>, hiddenTests: string[], { timeoutMs = 60_000 } = {}) {
  const tmp = tempDir()
  try {
    copyDir(dir, tmp)
    writeTree(tmp, hiddenFiles)
    return hiddenTests.map((file) => ({ file, ...run(process.execPath, [file], tmp, { timeoutMs }) }))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const TEST_NAME = /\b(?:test|it)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g

/** The names of the tests written with test('name', ...) or it('name', ...) in a text. */
export const testNamesOf = (source: string) => [...String(source).matchAll(TEST_NAME)].map((m) => m[2].replace(/\\(['"`])/g, '$1'))

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function listTestFiles(dir: string) {
  const found = []
  const walk = (rel: string) => {
    let names = []
    try { names = readdirSync(join(dir, rel)).sort() } catch { return }
    for (const name of names) {
      const next = `${rel}/${name}`
      if (statSync(join(dir, next)).isDirectory()) walk(next)
      else if (name.endsWith('.test.js')) found.push(next)
    }
  }
  walk('test')
  return found
}

/**
 * For a case that asks for a unit test: which tests are new in the head (by name, per file), and do they fail on
 * the base code? The head's test/ folder is laid over a copy of the base files and only the new tests are run
 * (node --test-name-pattern). { added: [{ file, names }], ran, failed, runs: [{ file, code, tests, fail, out }] }
 */
export function newTestsOnBase({ headDir, baseDir, readTextOf = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8') }: { headDir: string, baseDir: string, readTextOf?: (dir: string, file: string) => string }) {
  const added = []
  for (const file of listTestFiles(headDir)) {
    const head = testNamesOf(readTextOf(headDir, file))
    const before = existsSync(join(baseDir, file)) ? new Set(testNamesOf(readTextOf(baseDir, file))) : new Set()
    const names = head.filter((name) => !before.has(name))
    if (names.length > 0) added.push({ file, names })
  }
  const tmp = tempDir()
  try {
    copyDir(baseDir, tmp)
    copyDir(join(headDir, 'test'), join(tmp, 'test'))
    const runs = added.map(({ file, names }) => {
      const pattern = `^(?:${names.map(escapeRegExp).join('|')})$`
      const r = run(process.execPath, ['--test-reporter=tap', `--test-name-pattern=${pattern}`, file], tmp)
      return { file, code: r.code, tests: Number(/^# tests (\d+)/m.exec(r.out)?.[1] ?? 0), fail: Number(/^# fail (\d+)/m.exec(r.out)?.[1] ?? 0), out: tailOf(r.out, 20) }
    })
    return { added, ran: runs.reduce((n, r) => n + r.tests, 0), failed: runs.reduce((n, r) => n + r.fail, 0), runs }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Runs the commands that need a real folder: test.sh, the hidden tests on head and base, the new tests on base. */
export function collectEvidence({ caseDef, ws }: { caseDef: any, ws: any }) {
  const evidence: any = {}
  const t = sh('sh test.sh', ws.headDir)
  evidence.testSh = { code: t.code, out: tailOf(t.out, 15) }
  evidence.hiddenHead = runHidden(ws.headDir, caseDef.hiddenFiles, caseDef.hiddenTests).map((r) => ({ ...r, out: tailOf(r.out, 15) }))
  evidence.hiddenBase = runHidden(ws.baseDir, caseDef.hiddenFiles, caseDef.hiddenTests).map((r) => ({ ...r, out: tailOf(r.out, 15) }))
  if (caseDef.requiresNewTest) evidence.newTests = newTestsOnBase({ headDir: ws.headDir, baseDir: ws.baseDir })
  return evidence
}
