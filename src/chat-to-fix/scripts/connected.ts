// Connect the imported agent to this repository's existing local credentials and service checks.
// Generated configuration contains addresses and IDs only. Tokens stay in the child environment.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGitlabConnection } from '../../gitlab/connection.js'
import { createJiraConnection } from '../../jira/connection.js'
import { loadConfig } from '../src/config.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = resolve(ROOT, '../..')
const text = (value) => typeof value === 'string' && value.trim() !== ''

export function bridgeEnv(env: any) {
  return {
    ...env,
    CHAT_TO_FIX_GITLAB_TOKEN: env.CHAT_TO_FIX_GITLAB_TOKEN || env.GITLAB_TOKEN,
    CHAT_TO_FIX_JIRA_TOKEN: env.CHAT_TO_FIX_JIRA_TOKEN || env.JIRA_TOKEN,
    CHAT_TO_FIX_JIRA_EMAIL: env.CHAT_TO_FIX_JIRA_EMAIL || env.JIRA_EMAIL,
    CHAT_TO_FIX_SLACK_TOKEN: env.CHAT_TO_FIX_SLACK_TOKEN || env.SLACK_BOT_TOKEN,
    CHAT_TO_FIX_SLACK_APP_TOKEN: env.CHAT_TO_FIX_SLACK_APP_TOKEN || env.SLACK_APP_TOKEN,
  }
}

function siteUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Jira site URL must be plain HTTPS')
  return url.origin
}

/** Use the same connection functions already tested by the local service. All calls are read-only. */
export async function checkConnections(env: any, fetchImpl = globalThis.fetch) {
  const gitlab = createGitlabConnection({ token: env.GITLAB_TOKEN, gitlabUrl: env.GITLAB_URL, project: env.GITLAB_PROJECT, fetchImpl })
  const jira = createJiraConnection({ token: env.JIRA_TOKEN, cloudId: env.JIRA_CLOUD_ID, boardId: env.JIRA_BOARD_ID, email: env.JIRA_EMAIL, fetchImpl })
  const [gitlabResult, jiraResult] = await Promise.allSettled([gitlab.checkConnection(env.GITLAB_BRANCH || 'master'), jira.checkBoard()])
  return {
    gitlab: gitlabResult.status === 'fulfilled' ? 'ok' : `failed: ${gitlabResult.reason?.status ?? gitlabResult.reason?.name ?? 'unknown'}`,
    jira: jiraResult.status === 'fulfilled' ? 'ok' : `failed: ${jiraResult.reason?.status ?? jiraResult.reason?.name ?? 'unknown'}`,
  }
}

export async function discoverJiraSite(env: any, fetchImpl = globalThis.fetch) {
  if (text(env.CHAT_TO_FIX_JIRA_SITE_URL)) return siteUrl(env.CHAT_TO_FIX_JIRA_SITE_URL)
  const authorization = text(env.JIRA_EMAIL)
    ? `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_TOKEN}`).toString('base64')}`
    : `Bearer ${env.JIRA_TOKEN}`
  const response = await fetchImpl(`https://api.atlassian.com/ex/jira/${env.JIRA_CLOUD_ID}/rest/api/3/serverInfo`, {
    headers: { Authorization: authorization, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Jira site lookup failed (HTTP ${response.status}); set CHAT_TO_FIX_JIRA_SITE_URL`)
  const info = await response.json()
  if (!text(info?.baseUrl)) throw new Error('Jira site lookup returned no baseUrl; set CHAT_TO_FIX_JIRA_SITE_URL')
  return siteUrl(info.baseUrl)
}

export function connectedConfig({ env, channel, localRepo, jiraSite, dataRoot = join(ROOT, '.data', 'connected') }: any) {
  if (!/^C[A-Z0-9]+$/.test(channel ?? '')) throw new Error('set --channel to the allowed Slack channel ID')
  if (!text(localRepo)) throw new Error('set --repo to a local checkout of the target GitLab project')
  if (!text(env.GITLAB_URL) || !text(env.GITLAB_PROJECT) || !text(env.JIRA_CLOUD_ID) || !text(env.JIRA_WORK_TYPE_FIELD_ID)) {
    throw new Error('GitLab or Jira settings are missing from the existing .env.local')
  }
  const gitlab = new URL(env.GITLAB_URL)
  if (gitlab.protocol !== 'https:' || gitlab.username || gitlab.password) throw new Error('GITLAB_URL must be plain HTTPS')
  const repo = resolve(localRepo)
  try { execFileSync('git', ['-C', repo, 'rev-parse', '--git-dir'], { stdio: 'ignore' }) }
  catch { throw new Error('--repo is not a Git checkout') }
  const data = resolve(dataRoot)
  const branch = env.GITLAB_BRANCH || 'master'
  return {
    dataDir: join(data, 'tasks'), worktreesDir: join(data, 'worktrees'), httpPort: 3090,
    apiModel: env.CHAT_TO_FIX_API_MODEL || 'anthropic/claude-sonnet-5-5',
    codingModel: env.CHAT_TO_FIX_CODING_MODEL || 'claude-code/claude-sonnet-5-5',
    engineAuth: env.ANTHROPIC_API_KEY ? 'apiKey' : 'login',
    adapters: { slack: 'real', jira: 'real', gitlab: 'real' },
    jira: {
      baseUrl: `https://api.atlassian.com/ex/jira/${env.JIRA_CLOUD_ID}`, browseUrl: siteUrl(jiraSite), apiVersion: '3',
      fields: { [env.JIRA_WORK_TYPE_FIELD_ID]: { value: env.CHAT_TO_FIX_WORK_TYPE || 'Tech Research' } },
    },
    gitlab: { baseUrl: gitlab.origin },
    slack: { inputMode: 'command' },
    bindings: [{
      channel, repo: env.GITLAB_PROJECT, localRepo: repo,
      remote: new URL(`${env.GITLAB_PROJECT.replace(/^\/+|\/+$/g, '')}.git`, `${gitlab.origin}/`).href,
      defaultBranch: branch, jiraProject: 'F2PGBA', issueType: 'Task', labels: ['chat-to-fix'],
    }],
    // The current scoped Jira token covers issue and comment writes. Transition needs its own grant.
    jiraTransitions: [],
  }
}

/** Keep the Agent's branches and worktrees out of the operator's normal checkout. */
export function prepareAgentRepo(source, dataRoot, remote) {
  const target = join(resolve(dataRoot), 'repo')
  if (!existsSync(target)) {
    mkdirSync(resolve(dataRoot), { recursive: true, mode: 0o700 })
    execFileSync('git', ['clone', '--local', '--no-hardlinks', source, target], { stdio: 'ignore', timeout: 120_000 })
  }
  try { execFileSync('git', ['-C', target, 'rev-parse', '--git-dir'], { stdio: 'ignore' }) }
  catch { throw new Error('the Agent repository is not a Git checkout') }
  execFileSync('git', ['-C', target, 'remote', 'set-url', 'origin', remote], { stdio: 'ignore' })
  return target
}

export function saveConfig(config: any, env: any, dataRoot = join(ROOT, '.data', 'connected')) {
  const root = resolve(dataRoot)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = join(root, 'chat-to-fix.json')
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  loadConfig({ path, env: { ...bridgeEnv(env), CHAT_TO_FIX_SLACK_TOKEN: bridgeEnv(env).CHAT_TO_FIX_SLACK_TOKEN || 'structure-check-only' } })
  return path
}

function argsOf(argv) {
  const out: any = { action: 'prepare' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') { out.action = 'check'; continue }
    if (argv[i] === '--start') { out.action = 'start'; continue }
    const key = { '--channel': 'channel', '--repo': 'localRepo', '--site-url': 'jiraSite', '--data': 'dataRoot' }[argv[i]]
    if (!key || !argv[i + 1]) throw new Error(`unknown or incomplete argument: ${argv[i]}`)
    out[key] = argv[++i]
  }
  return out
}

async function main() {
  const localEnv = join(PROJECT_ROOT, '.env.local')
  if (existsSync(localEnv)) process.loadEnvFile(localEnv)
  const env = bridgeEnv(process.env)
  const args = argsOf(process.argv.slice(2))
  if (args.action === 'check') {
    const result = await checkConnections(env)
    console.log(`GitLab ${result.gitlab}; Jira ${result.jira}; Slack ${text(env.CHAT_TO_FIX_SLACK_TOKEN) ? 'bot token present' : 'bot token missing'}`)
    return
  }
  if (args.action === 'start' && !text(env.CHAT_TO_FIX_SLACK_TOKEN)) throw new Error('SLACK_BOT_TOKEN is missing; Slack installation must finish before starting')
  if (args.action === 'start' && !text(env.CHAT_TO_FIX_SLACK_APP_TOKEN)) throw new Error('SLACK_APP_TOKEN is missing')
  const dataRoot = args.dataRoot ?? join(ROOT, '.data', 'connected')
  const jiraSite = args.jiraSite ?? await discoverJiraSite(env)
  const config = connectedConfig({ env, channel: args.channel ?? env.CHAT_TO_FIX_SLACK_CHANNEL, localRepo: args.localRepo ?? env.CHAT_TO_FIX_LOCAL_REPO, jiraSite, dataRoot })
  config.bindings[0].localRepo = prepareAgentRepo(config.bindings[0].localRepo, dataRoot, config.bindings[0].remote)
  const configPath = saveConfig(config, env, dataRoot)
  console.log(`Agent configuration prepared: ${configPath}`)
  if (args.action !== 'start') return
  const childEnv = { ...env, CHAT_TO_FIX_DATA: resolve(dataRoot), CHAT_TO_FIX_CONFIG: configPath,
    PATH: `${dirname(process.execPath)}:${env.PATH ?? ''}` }
  const start = spawn('sh', [join(ROOT, 'scripts', 'start-chat-to-fix.sh')], { cwd: ROOT, env: childEnv, stdio: 'inherit' })
  const exitCode = await new Promise<number>((done) => start.once('exit', (code) => done(code ?? 1)))
  if (exitCode !== 0) throw new Error('Agent startup failed')
  const httpToken = env.CHAT_TO_FIX_HTTP_TOKEN || readFileSync(join(resolve(dataRoot), 'http-token'), 'utf8').trim()
  const forwarder = spawn(process.execPath, [join(ROOT, 'scripts', 'slack-forwarder.ts'),
    '--url', `http://127.0.0.1:${config.httpPort}`], {
    cwd: ROOT, env: { ...childEnv, CHAT_TO_FIX_HTTP_TOKEN: httpToken }, stdio: 'inherit',
  })
  process.once('SIGINT', () => forwarder.kill('SIGINT'))
  process.once('SIGTERM', () => forwarder.kill('SIGTERM'))
  await new Promise((done) => forwarder.once('exit', done))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`connected setup failed: ${error.message}`); process.exitCode = 1 })
}
