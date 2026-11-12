import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { agentAlreadyRunning, bridgeEnv, connectedConfig, prepareAgentRepo, saveConfig } from '../scripts/connected.ts'

const execFileAsync = promisify(execFile)

test('已运行 Agent 的有效 token 和健康接口可避免重复启动', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'chat-to-fix-running-'))
  writeFileSync(join(dataRoot, 'http-token'), 'local-token\n', { mode: 0o600 })
  const server = createServer((request, response) => {
    const authorized = request.headers['x-chat-to-fix-token'] === 'local-token'
    response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' })
    response.end(authorized ? '{"up":true}' : '{"error":"unauthorized"}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as any).port
  try {
    assert.equal(await agentAlreadyRunning({ env: {}, dataRoot, port }), true)
    assert.equal(await agentAlreadyRunning({ env: { CHAT_TO_FIX_HTTP_TOKEN: 'wrong' }, dataRoot, port }), false)
    const configPath = join(dataRoot, 'chat-to-fix.json')
    writeFileSync(configPath, JSON.stringify({ httpPort: port }))
    const runDir = join(dataRoot, 'run')
    mkdirSync(runDir)
    const logPath = join(runDir, 'chat-to-fix.log')
    writeFileSync(logPath, '原有 Agent 日志\n')
    const startScript = join(import.meta.dirname, '../scripts/start-chat-to-fix.sh')
    const startEnv = { ...process.env, CHAT_TO_FIX_DATA: dataRoot, CHAT_TO_FIX_CONFIG: configPath }
    const existing = await execFileAsync('sh', [startScript], {
      env: { ...startEnv, CHAT_TO_FIX_HTTP_TOKEN: 'local-token' }, encoding: 'utf8',
    })
    assert.match(existing.stdout, /Agent already running.*PID file missing/)
    assert.equal(readFileSync(logPath, 'utf8'), '原有 Agent 日志\n')
    await assert.rejects(execFileAsync('sh', [startScript], {
      env: { ...startEnv, CHAT_TO_FIX_HTTP_TOKEN: 'wrong' }, encoding: 'utf8',
    }), (error: any) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /is occupied; not starting another Agent/)
      return true
    })
    assert.equal(readFileSync(logPath, 'utf8'), '原有 Agent 日志\n')
    await assert.rejects(execFileAsync('sh', [join(import.meta.dirname, '../scripts/stop-chat-to-fix.sh')], {
      env: { ...process.env, CHAT_TO_FIX_DATA: dataRoot, CHAT_TO_FIX_HTTP_TOKEN: '' }, encoding: 'utf8',
    }), (error: any) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /Agent is running but .* is missing/)
      return true
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('existing tokens reach real adapters without entering the saved configuration', () => {
  const env = {
    GITLAB_URL: 'https://gitlab.example.com', GITLAB_PROJECT: 'account-platform/free-to-play-pc', GITLAB_BRANCH: 'master',
    GITLAB_TOKEN: 'gl-secret', JIRA_TOKEN: 'jira-secret', JIRA_EMAIL: 'user@example.com',
    JIRA_CLOUD_ID: '11111111-1111-1111-1111-111111111111', JIRA_WORK_TYPE_FIELD_ID: 'customfield_12345',
    SLACK_BOT_TOKEN: 'xoxb-secret', SLACK_APP_TOKEN: 'xapp-secret', // still in .env.local for the Slack Bot; this service ignores them
  }
  const dataRoot = mkdtempSync(join(tmpdir(), 'chat-to-fix-connected-'))
  try {
    const config = connectedConfig({ env, channel: 'C123ABC', localRepo: resolve('..'), jiraSite: 'https://site.atlassian.net', dataRoot })
    assert.deepEqual(config.adapters, { slack: 'outbox', jira: 'real', gitlab: 'real' })
    assert.equal(config.jira.apiVersion, '3')
    assert.equal(config.slack.inputMode, 'command')
    assert.equal(config.slack.mentions, false)
    assert.equal(config.bindings[0].remote, 'https://gitlab.example.com/account-platform/free-to-play-pc.git')
    assert.equal(bridgeEnv(env).CHAT_TO_FIX_SLACK_TOKEN, undefined) // no Slack token is handed to this service
    const path = saveConfig(config, bridgeEnv(env), dataRoot)  // loads without any Slack token
    const saved = readFileSync(path, 'utf8')
    for (const secret of [env.GITLAB_TOKEN, env.JIRA_TOKEN, env.SLACK_BOT_TOKEN, env.SLACK_APP_TOKEN]) assert.equal(saved.includes(secret), false)
  } finally { rmSync(dataRoot, { recursive: true, force: true }) }
})

test('Agent uses an isolated clone and keeps the source checkout unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'chat-to-fix-repo-'))
  const source = join(root, 'source')
  mkdirSync(source)
  const git = (args, cwd = source) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  try {
    git(['init', '-q'])
    writeFileSync(join(source, 'README.md'), 'source\n')
    git(['add', 'README.md'])
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'test'])
    const sourceHead = git(['rev-parse', 'HEAD'])
    const isolated = prepareAgentRepo(source, join(root, 'data'), 'https://gitlab.example.com/group/project.git')
    assert.equal(git(['rev-parse', 'HEAD'], isolated), sourceHead)
    assert.equal(git(['remote', 'get-url', 'origin'], isolated), 'https://gitlab.example.com/group/project.git')
    assert.equal(git(['rev-parse', 'HEAD']), sourceHead)
    assert.equal(prepareAgentRepo(source, join(root, 'data'), 'https://gitlab.example.com/group/project.git'), isolated)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
