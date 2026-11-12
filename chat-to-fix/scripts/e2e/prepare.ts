// Prepares the e2e run folder: one case repository per case, ONE chat-to-fix.json with one binding per case,
// the DSH overlay that names the Claude Code CLI, a manifest, and the commands. It starts nothing and calls no
// model. The layout is the one scripts/first-run.ts produces (same folders, same fake adapters, same overlay).
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, userInfo } from 'node:os'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../src/config.ts'
import { DEFAULT_KEYCHAIN_SERVICE, keychainHas, timestamp } from '../first-run.ts'
import { ciJobsOf, DEFAULT_CASE_IDS, loadCases } from './cases.ts'
import { createCaseRepo } from './workspace.ts'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MANIFEST = 'e2e-manifest.json'
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

const findOnPath = (name, env) => {
  for (const dir of String(env.PATH ?? '').split(delimiter)) if (dir !== '' && existsSync(join(dir, name))) return join(dir, name)
  return undefined
}
const isExecutable = (path) => { try { accessSync(path, constants.X_OK); return true } catch { return false } }
const portFree = (port) => new Promise((ok) => {
  const server = createServer()
  server.once('error', () => ok(false))
  server.listen(port, '127.0.0.1', () => server.close(() => ok(true)))
})
function claudeMdAbove(dir) {
  const found = []
  for (let d = dirname(dir); ; d = dirname(d)) {
    if (existsSync(join(d, 'CLAUDE.md'))) found.push(join(d, 'CLAUDE.md'))
    if (dirname(d) === d) break
  }
  return found
}

/** Keeps the cases in the order of the request; an unknown name is an error. */
export function selectCases(names: string[] | undefined) {
  return names === undefined || names.length === 0 ? DEFAULT_CASE_IDS : names
}

/**
 * Prepares the folder. Options: dir, cases (ids), port, apiModel, engineAuth, claudeBin, keychainService,
 * env, home, user, hasKeychainItem, now, casesDir. Returns { dir, configPath, patchPath, manifestPath, commandsPath,
 * manifest, claudeBin, keySource, blockers, warnings, commands, text, ready }.
 */
export async function prepareE2e(options: any = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const user = options.user ?? env.USER ?? userInfo().username
  const lookup = options.hasKeychainItem ?? keychainHas
  const keychainService = options.keychainService ?? DEFAULT_KEYCHAIN_SERVICE
  const port = options.port ?? 3090
  const apiModel = options.apiModel ?? 'anthropic/claude-sonnet-5-5'
  const engineAuth = options.engineAuth ?? 'apiKey'
  const ids = selectCases(options.cases)
  const dir = resolve(options.dir ?? join(home, 'chat-to-fix-runs', `e2e-${timestamp(options.now?.())}`))
  const blockers = []
  const warnings = []

  const cases = loadCases(ids, options.casesDir)
  // One config, one Slack input mode: a command case (the /fix slash command) cannot share a run with thread cases.
  const modes = [...new Set(cases.map((c) => c.inputMode ?? 'thread'))]
  if (modes.length > 1) throw new Error(`the selected cases mix input modes (${cases.map((c) => `${c.id}: ${c.inputMode ?? 'thread'}`).join(', ')}): run the command cases (inputMode "command") separately from the thread cases`)
  const inputMode = modes[0] ?? 'thread'
  if (dir === ROOT || dir.startsWith(ROOT + sep)) throw new Error(`the data folder must lie outside the project (${ROOT}): the Claude Code CLI would read project files from the parent folders`)
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`the folder ${dir} is not empty; use a new folder (or pass a prepared one to run it as it is)`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  // One repository per case: <dir>/repos/<id>/project and project.git.
  const manifestCases = []
  for (const c of cases) {
    const repo = createCaseRepo({ dir: join(dir, 'repos', c.id), files: c.repoFiles, message: `Initial ${c.id} repository` })
    // a CI case: its job scripts go to <dir>/ci/<id>/ (outside the repository, like a shared CI template)
    let ciJobs
    if (c.ci) {
      const ciFolder = join(dir, 'ci', c.id)
      cpSync(c.ciDir, ciFolder, { recursive: true })
      ciJobs = ciJobsOf(c, ciFolder)
    }
    manifestCases.push({ id: c.id, title: c.title, ...(c.inputMode ? { inputMode: c.inputMode } : {}), channel: c.channel, jiraProject: c.jiraProject, repo: `local/e2e-${c.id}`, localRepo: repo.localRepo, remote: repo.remote, defaultBranch: repo.defaultBranch, baseCommit: repo.commit, ...(ciJobs ? { ciJobs } : {}) })
  }

  const dataDir = join(dir, 'chat-to-fix')
  const configPath = join(dir, 'chat-to-fix.json')
  const config = {
    dataDir,
    worktreesDir: join(dataDir, 'worktrees'),
    httpPort: port,
    language: 'zh',
    apiModel,
    // pinned (the owner's decision): the Coding bot and its reviewer run on Sonnet 5.5 at high effort, not the CLI default
    codingModel: 'claude-code/claude-sonnet-5-5',
    codingEffort: 'high',
    engineAuth,
    adapters: { slack: 'fake', jira: 'fake', gitlab: 'fake' },
    ...(inputMode === 'command' ? { slack: { inputMode: 'command' } } : {}),
    bindings: manifestCases.map((m) => ({
      channel: m.channel, repo: m.repo, localRepo: m.localRepo, remote: m.remote, defaultBranch: m.defaultBranch,
      jiraProject: m.jiraProject, issueType: 'Bug', labels: ['chat-to-fix', 'e2e'], testCommands: ['sh test.sh'],
      ...(m.ciJobs ? { ciJobs: m.ciJobs } : {}),
    })),
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  loadConfig({ path: configPath, env: { ...env, ANTHROPIC_API_KEY: 'structure-check-only' } })

  const claudeBin = options.claudeBin ?? env.CLAUDE_BIN ?? findOnPath('claude', env)
  if (claudeBin === undefined || !existsSync(claudeBin)) blockers.push(`the Claude Code CLI was not found (${claudeBin ?? 'CLAUDE_BIN is not set and there is no claude on PATH'}); run . scripts/dev-env.sh or pass --claude-bin`)
  else if (!isExecutable(claudeBin)) blockers.push(`the Claude Code CLI ${claudeBin} is not executable`)
  const patchPath = join(dir, 'e2e.patch.yml')
  writeFileSync(patchPath, [
    '# e2e overlay: the Claude Code CLI of the Coding bot (the plugin row config is replaced whole).',
    '- id: chat-to-fix',
    '  config:',
    ...(claudeBin === undefined ? ['    {}'] : [`    claudeCommand: ${JSON.stringify(claudeBin)}`]),
    '',
  ].join('\n'))

  // The key: environment first, else the keychain item. Presence only; the value is never read here.
  let keySource
  if (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY !== '') keySource = 'env'
  else if (lookup(keychainService, user)) keySource = 'keychain'
  else blockers.push(`ANTHROPIC_API_KEY is not set and the keychain has no item "${keychainService}" for ${user} (add it with: security add-generic-password -a "$USER" -s ${keychainService} -w)`)
  for (const file of claudeMdAbove(dir)) warnings.push(`${file} is above the data folder; the Claude Code CLI will read it in the worktree. Use another --dir.`)
  if (port !== 0 && !(await portFree(port))) warnings.push(`port ${port} is in use on 127.0.0.1; pass --port with a free one`)

  const manifest = { version: 1, createdAt: new Date().toISOString(), port, apiModel, engineAuth, keychainService, claudeBin, configPath, patchPath, dataDir, cases: manifestCases }
  const manifestPath = join(dir, MANIFEST)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  const tokenFile = join(dir, 'http-token')
  const url = `http://127.0.0.1:${port}`
  const caseList = ids.join(',')
  const commands = {
    run: [
      `cd ${shq(ROOT)}`,
      '. scripts/dev-env.sh',
      `node scripts/e2e/run.ts --dir ${shq(dir)} --cases ${caseList}      # starts the system, injects the cases one by one, checks, stops, writes report.md / report.json`,
    ],
    watch: [
      `cd ${shq(ROOT)}`,
      `node scripts/show-task.ts T-1 --dir ${shq(dir)} --follow      # T-1, T-2, ... in the order of the cases`,
      `tail -f ${shq(join(dir, 'run', 'chat-to-fix.log'))}`,
    ],
    stop: [
      `cd ${shq(ROOT)}`,
      `curl -s -X POST -H "x-chat-to-fix-token: $(cat ${shq(tokenFile)})" ${url}/tasks/T-1/stop     # the cost kill switch for one task`,
      `CHAT_TO_FIX_DATA=${shq(dir)} sh scripts/stop-chat-to-fix.sh`,
    ],
  }
  const text = [
    ['1. run the suite (real models: this costs money; it stops the system when it ends or on Ctrl-C)', commands.run],
    ['2. watch (another terminal)', commands.watch],
    ['3. emergency stop', commands.stop],
  ].map(([title, lines]: any) => `# ${title}\n${lines.join('\n')}`).join('\n\n') + '\n'
  const commandsPath = join(dir, 'commands.txt')
  writeFileSync(commandsPath, text)

  return { dir, configPath, patchPath, manifestPath, commandsPath, manifest, claudeBin, keySource, blockers, warnings, commands, text, files: [configPath, patchPath, manifestPath, commandsPath], ready: blockers.length === 0 }
}

/** The manifest of a prepared folder, or undefined when the folder was not prepared by prepareE2e. */
export function loadManifest(dir: string) {
  const path = join(resolve(dir), MANIFEST)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}
