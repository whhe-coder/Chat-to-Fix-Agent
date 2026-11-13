// Prepares a first real run of chat-to-fix: real models, fake Slack, Jira and GitLab, a throwaway
// test repository. It only PREPARES: it does not start the system and calls no model.
//
//   . scripts/dev-env.sh && node scripts/first-run.ts [--dir <data folder>] [--port 3090] [--channel C0456]
//        [--api-model anthropic/claude-sonnet-5-5] [--keychain-service chat-to-fix-anthropic]
//
// What it does:
//  1. makes a NEW data folder OUTSIDE the project (default ~/chat-to-fix-runs/<timestamp>); a folder
//     that already holds something is refused, so every trial starts clean (task and worktree names
//     repeat across trials);
//  2. makes the test repository there (scripts/make-test-repo.ts: its `sh test.sh` fails on purpose);
//  3. writes chat-to-fix.json (all adapters fake, one binding with testCommands ["sh test.sh"]) and
//     validates it; all five bots run on the Anthropic API with the one key ANTHROPIC_API_KEY;
//  4. checks the credentials WITHOUT reading them out: ANTHROPIC_API_KEY in the environment, else an
//     item in the macOS keychain (existence only, never `-w` here); the value is never printed or written;
//  5. prints the exact commands to start, inject a fake @, watch, and stop (also saved in commands.txt).
// Exit code 1 when something blocks the run (the key missing); the files are still written.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../core/config.ts'
import { createTestRepo } from './make-test-repo.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_KEYCHAIN_SERVICE = 'chat-to-fix-anthropic'
export const SAMPLE_REPORT = '商店折扣价算错了：applyDiscount(100, 10) 返回 110，应该是 90（src/price.js）。运行 sh test.sh 可以复现。'

const pad = (n) => String(n).padStart(2, '0')
/** 20261112-143005 (local time). */
export const timestamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

/** True when the keychain holds the item. Existence only: no -w, nothing is printed or read. */
export function keychainHas(service, account) {
  try {
    execFileSync('security', ['find-generic-password', '-a', account, '-s', service], { stdio: 'ignore' })
    return true
  } catch { return false }
}


const portFree = (port) => new Promise((ok) => {
  const server = createServer()
  server.once('error', () => ok(false))
  server.listen(port, '127.0.0.1', () => server.close(() => ok(true)))
})

const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

/**
 * Prepares the run. Returns { dir, files, blockers, warnings, commands, ready }.
 * Options: dir, port, channel, apiModel, keychainService, env, home, user,
 * hasKeychainItem (injected: (service, account) => boolean), now.
 */
export async function prepareFirstRun(options: any = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const user = options.user ?? env.USER ?? userInfo().username
  const lookup = options.hasKeychainItem ?? keychainHas
  const keychainService = options.keychainService ?? DEFAULT_KEYCHAIN_SERVICE
  const port = options.port ?? 3090
  const channel = options.channel ?? 'C0456'
  const apiModel = options.apiModel ?? 'anthropic/claude-sonnet-5-5'
  const dir = resolve(options.dir ?? join(home, 'chat-to-fix-runs', timestamp(options.now?.())))
  const blockers = []
  const warnings = []

  if (dir === ROOT || dir.startsWith(ROOT + sep)) throw new Error(`the data folder must lie outside the project (${ROOT}): trial data and worktrees stay out of the checkout`)
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`the data folder ${dir} is not empty; use a new folder for every trial`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  // The test repository: <dir>/test-repo/project and project.git.
  const repo = await createTestRepo({ dir: join(dir, 'test-repo') })

  const dataDir = join(dir, 'chat-to-fix')
  const configPath = join(dir, 'chat-to-fix.json')
  const config = {
    dataDir,
    worktreesDir: join(dataDir, 'worktrees'),
    httpPort: port,
    language: 'zh',
    apiModel,
    // pinned (the owner's decision): the Coding bot and its reviewer run on Sonnet 5.5 at high effort
    codingModel: 'anthropic/claude-sonnet-5-5',
    codingEffort: 'high',
    adapters: { slack: 'fake', jira: 'fake', gitlab: 'fake' },
    bindings: [{
      channel, repo: 'local/sample-shop', localRepo: repo.localRepo, remote: repo.remote, defaultBranch: repo.defaultBranch,
      jiraProject: 'DEMO', issueType: 'Bug', labels: ['chat-to-fix'], testCommands: ['sh test.sh'],
    }],
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  // Structure check only: the key is stood in for, whether it is set is checked below.
  loadConfig({ path: configPath, env: { ...env, ANTHROPIC_API_KEY: 'structure-check-only' } })

  // The key: environment first, else the keychain item. Presence only; the value is never read here.
  let keySource
  if (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY !== '') keySource = 'env'
  else if (lookup(keychainService, user)) keySource = 'keychain'
  else blockers.push(`ANTHROPIC_API_KEY is not set and the keychain has no item "${keychainService}" for ${user} (add it with: security add-generic-password -a "$USER" -s ${keychainService} -w)`)

  if (!(await portFree(port)) && port !== 0) warnings.push(`port ${port} is in use on 127.0.0.1; pass --port with a free one`)

  const url = `http://127.0.0.1:${port}`
  const tokenFile = join(dir, 'http-token')
  const exportKey = keySource === 'keychain'
    ? [`export ANTHROPIC_API_KEY="$(security find-generic-password -a "$USER" -s ${keychainService} -w)"`]
    : keySource === 'env' ? [] : ['read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY   # type the key; it is not echoed']
  const commands = {
    start: [
      `cd ${shq(ROOT)}`,
      '. scripts/dev-env.sh',
      `export CHAT_TO_FIX_DATA=${shq(dir)}`,
      ...exportKey,
      'sh scripts/start-chat-to-fix.sh',
    ],
    inject: [
      `cd ${shq(ROOT)}`,
      `export CHAT_TO_FIX_URL=${url}`,
      `export CHAT_TO_FIX_HTTP_TOKEN="$(cat ${shq(tokenFile)})"`,
      `export CHAT_TO_FIX_DATA_DIR=${shq(dataDir)}`,
      `node scripts/fake-event.ts --channel ${channel} --text ${shq(SAMPLE_REPORT)}`,
    ],
    watch: [
      `cd ${shq(ROOT)}`,
      `node scripts/show-task.ts T-1 --dir ${shq(dir)}              # state and execution records`,
      `node scripts/show-task.ts T-1 --dir ${shq(dir)} --follow     # keep printing until the task ends`,
      `tail -f ${shq(join(dir, 'run', 'chat-to-fix.log'))}`,
      `cat ${shq(join(dataDir, 'fake', 'slack', 'replies.jsonl'))}`,
      `cat ${shq(join(dataDir, 'fake', 'jira', 'issues.json'))}`,
      `cat ${shq(join(dataDir, 'fake', 'gitlab', 'mrs.json'))}`,
      `git -C ${shq(join(dataDir, 'worktrees', 'T-1'))} diff`,
    ],
    stop: [
      `cd ${shq(ROOT)}`,
      `curl -s -X POST -H "x-chat-to-fix-token: $(cat ${shq(tokenFile)})" ${url}/tasks/T-1/stop     # the cost kill switch for one task`,
      `CHAT_TO_FIX_DATA=${shq(dir)} sh scripts/stop-chat-to-fix.sh`,
    ],
  }
  const text = [
    ['1. start (new terminal; the system runs in the background)', commands.start],
    ['2. inject a fake Slack @ (needs the system up; run in the same terminal as step 3 or any shell)', commands.inject],
    ['3. watch', commands.watch],
    ['4. stop', commands.stop],
  ].map(([title, lines]: any) => `# ${title}\n${lines.join('\n')}`).join('\n\n') + '\n'
  const commandsPath = join(dir, 'commands.txt')
  writeFileSync(commandsPath, text)

  return {
    dir, configPath, commandsPath, repo, keySource, blockers, warnings, commands, text,
    files: [configPath, commandsPath],
    ready: blockers.length === 0,
  }
}

function parseArgs(argv) {
  const names = { '--dir': 'dir', '--port': 'port', '--channel': 'channel', '--api-model': 'apiModel', '--keychain-service': 'keychainService' }
  const options: any = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]]
    if (key === undefined || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument: ${argv[i]}`)
    options[key] = key === 'port' ? Number(argv[i + 1]) : argv[i + 1]
  }
  if (options.port !== undefined && !(Number.isInteger(options.port) && options.port >= 0 && options.port < 65536)) throw new Error('--port must be an integer from 0 to 65535')
  return options
}

async function main() {
  const result = await prepareFirstRun(parseArgs(process.argv.slice(2)))
  console.log(`Prepared a first run in ${result.dir}`)
  console.log(`  test repository   ${result.repo.localRepo} (its tests fail on purpose)`)
  console.log(`  configuration     ${result.configPath} (fake Slack, Jira, GitLab; all five bots on the Anthropic API)`)
  console.log(`  Anthropic key     ${result.keySource === 'env' ? 'set in the environment' : result.keySource === 'keychain' ? 'found in the keychain (it is read only when you run the start command)' : 'NOT AVAILABLE'}`)
  for (const warning of result.warnings) console.log(`WARNING: ${warning}`)
  for (const blocker of result.blockers) console.log(`BLOCKED: ${blocker}`)
  console.log('\nNothing was started and no model was called. Commands (also in ' + result.commandsPath + '):\n')
  console.log(result.text)
  if (!result.ready) process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`first-run failed: ${error.message}`)
    process.exitCode = 1
  })
}
