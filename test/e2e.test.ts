// The end-to-end bench of spec 4, section 4.8, with the fake Slack, Jira and GitLab adapters and
// real git on a local test repository. The bot layer is the in-memory fake, and the test plays
// the five bots by calling their tools; everything between the tools and the files is real:
// listener, queue, runner, tool registry, step checks, adapters, recorder.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { createApp } from '../src/app.ts'
import { createTestRepo } from '../scripts/make-test-repo.ts'
import { sendFakeEvent } from '../scripts/fake-event.ts'
import { createFakeBotLayer } from './helpers/fake-botlayer.ts'

async function rig(t) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-e2e-'))
  const made = await createTestRepo({ dir: join(dir, 'repo') })
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify({
    dataDir: join(dir, 'data'),
    worktreesDir: join(dir, 'worktrees'),
    httpPort: 0,
    apiModel: 'anthropic/test',
    adapters: { slack: 'fake', jira: 'fake', gitlab: 'fake' },
    commitAuthor: { name: 'chat-to-fix', email: 'chat-to-fix@example.com' },
    jiraTransitions: ['In Review'],
    bindings: [{
      channel: 'C1', repo: 'group/project', localRepo: made.localRepo, remote: made.remote,
      defaultBranch: made.defaultBranch, jiraProject: 'DEMO', issueType: 'Bug', labels: ['chat-to-fix'],
    }],
  }))
  const config = loadConfig({ path: configPath, env: {} })
  const botlayer = createFakeBotLayer()
  const warnings = []
  const app = createApp({ config, botlayer, token: 'tok', warn: (...args) => warnings.push(args.join(' ')) })
  const port = await app.start()
  t.after(() => app.stop())
  const url = `http://127.0.0.1:${port}`

  const inState = async (id, state) => {
    for (let i = 0; i < 300; i++) {
      const task = await app.store.getTask(id)
      if (task?.state === state) return task
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`task ${id} did not reach ${state}; warnings: ${warnings.join(' | ')}`)
  }
  // One @ in Slack: the discussion file is written and the event is posted to the listener.
  const mention = async (text, threadTs) => {
    const sent = await sendFakeEvent({ channel: 'C1', text, threadTs, dataDir: config.dataDir, url, token: 'tok' })
    return sent
  }
  const start = async (text) => {
    const sent = await mention(text)
    assert.equal(sent.status, 202, JSON.stringify(sent.body))
    const task = await inState(sent.body.taskId, 'running')
    const run = task.runs.at(-1)
    const tool = (role, name, args = {}) => app.tools.call(name, run.bots[role], args)
    const roundEnd = async (role, text) => {
      botlayer.emit.roundEnd({ sessionId: run.bots[role], botId: run.bots[role], groupId: run.groupId, text, failed: false, at: new Date().toISOString() })
      await app.recorder.flush()
    }
    return { id: task.id, run, tool, roundEnd, threadTs: sent.threadTs }
  }
  const fake = async (path) => JSON.parse(await readFile(join(config.dataDir, 'fake', path), 'utf8'))
  const replies = async () => (await readFile(join(config.dataDir, 'fake', 'slack', 'replies.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  return { app, botlayer, config, made, warnings, inState, mention, start, fake, replies, git }
}

const ok = (text) => { assert.doesNotMatch(text, /^tool failed|^Cannot|refused/i, text); return text }

// The first three steps are the same in every scenario.
async function throughPrepare(r, s) {
  ok(await s.tool('slack', 'slack_read_thread'))
  ok(await s.tool('slack', 'slack_reply', { purpose: 'ack', text: 'Received. Working on it.' }))
  await s.roundEnd('slack', 'Summary: applyDiscount adds the discount instead of subtracting it.')
  ok(await s.tool('main', 'task_advance', { to: 'issue' }))

  ok(await s.tool('jira', 'jira_create_issue', {
    title: 'applyDiscount adds the discount', description: 'applyDiscount(100, 10) returns 110.', acceptance: 'applyDiscount(100, 10) returns 90.',
  }))
  ok(await s.tool('main', 'task_advance', { to: 'prepare' }))

  ok(await s.tool('pipeline', 'repo_prepare'))
  ok(await s.tool('main', 'task_advance', { to: 'code' }))
  return r.app.store.getTask(s.id)
}

// What Claude Code does in step 4, done by hand: the one-line fix in the task's code directory.
async function fixTheBug(dir) {
  const file = join(dir, 'src', 'price.js')
  const before = await readFile(file, 'utf8')
  const after = before.replace('return price + (price * percent) / 100', 'return price - (price * percent) / 100')
  assert.notEqual(after, before, `the sample bug was not found in:\n${before}`)
  await writeFile(file, after)
}

test('normal: one @ goes through the seven steps with the fake Slack, Jira and GitLab', async (t) => {
  const r = await rig(t)
  const s = await r.start('applyDiscount gives the wrong price')

  // A bot cannot use another bot's service.
  assert.match(await s.tool('main', 'slack_reply', { purpose: 'ack', text: 'x' }), /tool failed/)
  assert.match(await s.tool('slack', 'jira_create_issue', { title: 'x', description: 'x', acceptance: 'x' }), /tool failed/)
  // A write tool outside its step is refused by the step checks.
  assert.doesNotMatch(await s.tool('pipeline', 'mr_open_draft', { title: 'x', description: 'x' }), /fake:\/\/gitlab/)

  let task = await throughPrepare(r, s)
  assert.equal(task.jira.key, 'DEMO-1')
  assert.equal(task.repo.branch, 'ai/DEMO-1')
  assert.ok(existsSync(join(task.repo.dir, 'src', 'price.js')), 'the code directory is a checkout of the repository')
  assert.deepEqual(r.botlayer.callsOf('setGroupWorkDir').at(-1).args, [s.run.groupId, task.repo.dir])

  // Step 4: the change, the test, the review.
  assert.throws(() => execFileSync('sh', ['test.sh'], { cwd: task.repo.dir, stdio: 'pipe' }), 'the test fails before the fix')
  await fixTheBug(task.repo.dir)
  execFileSync('sh', ['test.sh'], { cwd: task.repo.dir, stdio: 'pipe' })
  ok(await s.tool('coding', 'review_report', { verdict: 'pass', comments: 'One line changed; the test passes.', rounds: 1 }))
  ok(await s.tool('main', 'task_advance', { to: 'mr' }))

  // Step 5.
  assert.match(ok(await s.tool('pipeline', 'repo_diff')), /src\/price\.js/)
  assert.match(ok(await s.tool('pipeline', 'mr_open_draft', { title: 'DEMO-1 Fix applyDiscount', description: 'Subtract the discount.' })), /fake:\/\/gitlab\/group\/project\/mr\/1/)
  ok(await s.tool('main', 'task_advance', { to: 'writeback' }))

  // Step 6.
  ok(await s.tool('jira', 'jira_add_comment', { text: 'A Draft MR is open for review.' }))
  ok(await s.tool('slack', 'slack_reply', { purpose: 'result', text: 'Done: a Draft MR is open.' }))
  assert.match(await s.tool('slack', 'slack_reply', { purpose: 'result', text: 'again' }), /already sent/)
  ok(await s.tool('main', 'task_advance', { to: 'close' }))

  // Step 7.
  ok(await s.tool('main', 'task_close', { outcome: 'done' }))
  task = await r.inState(s.id, 'done')

  // What spec 4, 4.8 expects of the normal scenario.
  const issues = await r.fake('jira/issues.json')
  assert.deepEqual(Object.keys(issues), ['DEMO-1'])
  assert.ok(issues['DEMO-1'].comments.some(comment => comment.text.includes(task.mr.url)), 'the issue carries the MR link')
  assert.match(issues['DEMO-1'].description, /Slack discussion:/)
  assert.match(r.git(r.made.remote, 'branch', '--list', 'ai/DEMO-1'), /ai\/DEMO-1/, 'the bare repository has the branch')
  assert.match(r.git(r.made.remote, 'log', '-1', '--format=%an %s', 'ai/DEMO-1'), /^chat-to-fix /)
  assert.match(r.git(r.made.remote, 'show', 'ai/DEMO-1:src/price.js'), /return price - \(price \* percent\) \/ 100/)
  assert.deepEqual((await r.replies()).map(reply => reply.purpose), ['ack', 'result'])
  const mrs = await r.fake('gitlab/mrs.json')
  assert.equal(Object.values(mrs).length, 1)
  assert.equal(r.botlayer.bots.size, 0)
  assert.equal(r.botlayer.groups.size, 0)
  assert.deepEqual(r.warnings, [])
})

test('review not passed: the MR is refused, the task ends as failed, the branch is kept', async (t) => {
  const r = await rig(t)
  const s = await r.start('applyDiscount gives the wrong price')
  const task = await throughPrepare(r, s)

  await fixTheBug(task.repo.dir)
  ok(await s.tool('coding', 'review_report', { verdict: 'fail', comments: 'The rounding is still wrong after three rounds.', rounds: 3 }))
  assert.match(await s.tool('main', 'task_advance', { to: 'mr' }), /Cannot advance/)
  assert.doesNotMatch(await s.tool('pipeline', 'mr_open_draft', { title: 'x', description: 'x' }), /fake:\/\/gitlab/)
  ok(await s.tool('main', 'task_close', { outcome: 'failed', note: 'The review did not pass after three rounds.' }))

  const ended = await r.inState(s.id, 'failed')
  assert.equal(ended.mr?.url, undefined)
  assert.equal(existsSync(join(r.config.dataDir, 'fake', 'gitlab', 'mrs.json')), false, 'no MR was recorded')
  assert.match(r.git(r.made.localRepo, 'branch', '--list', 'ai/DEMO-1'), /ai\/DEMO-1/, 'the branch is kept')
  // The system told the person in the original discussion.
  const sent = await r.replies()
  assert.deepEqual(sent.map(reply => reply.purpose), ['ack', 'system'])
  assert.match(sent.at(-1).text, new RegExp(s.id))
})

test('missing information: both confirm, the question is asked, and a new @ in the discussion reruns the same task', async (t) => {
  const r = await rig(t)
  const s = await r.start('the price is wrong somewhere')
  await throughPrepare(r, s)

  ok(await s.tool('coding', 'needs_info_confirm', { text: 'Which function gives the wrong price?' }))
  assert.match(await s.tool('slack', 'slack_reply', { purpose: 'question', text: 'Which function?' }), /tool failed|refused|not allowed|Cannot/i)
  ok(await s.tool('main', 'needs_info_confirm', { text: 'Which function gives the wrong price, and for which input?' }))
  ok(await s.tool('slack', 'slack_reply', { purpose: 'question', text: 'Which function gives the wrong price, and for which input?' }))
  ok(await s.tool('main', 'task_close', { outcome: 'needs_info' }))
  await r.inState(s.id, 'needs_info')
  assert.deepEqual((await r.replies()).map(reply => reply.purpose), ['ack', 'question'])

  // The person answers in the same discussion with a new @: a second run of the same task.
  const again = await r.mention('It is applyDiscount, with 100 and 10.', s.threadTs)
  assert.equal(again.status, 202)
  assert.equal(again.body.taskId, s.id)
  const rerun = await r.inState(s.id, 'running')
  assert.equal(rerun.runs.length, 2)
  assert.equal(rerun.jira.key, 'DEMO-1')
  const second = rerun.runs.at(-1)
  // The Slack bot now reads both messages; the Jira bot does not create a second issue.
  const thread = await r.app.tools.call('slack_read_thread', second.bots.slack, {})
  assert.match(thread, /the price is wrong somewhere/)
  assert.match(thread, /It is applyDiscount/)
  assert.match(await r.app.tools.call('slack_reply', second.bots.slack, { purpose: 'ack', text: 'again' }), /already sent/)
  await r.app.store.patchTask(s.id, { step: 'issue' })
  assert.match(await r.app.tools.call('jira_create_issue', second.bots.jira, { title: 'x', description: 'x', acceptance: 'x' }), /DEMO-1/)
  assert.deepEqual(Object.keys(await r.fake('jira/issues.json')), ['DEMO-1'])
})
