import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bridgeEnv, connectedConfig, prepareAgentRepo, saveConfig } from '../scripts/connected.ts'

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
