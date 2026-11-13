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
import { loadConfig } from '../core/config.ts'
import { createApp } from '../core/app.ts'
import { createAdapters } from '../core/adapters/index.ts'
import { createTestRepo } from '../scripts/make-test-repo.ts'
import { sendFakeEvent } from '../scripts/fake-event.ts'
import { createFakeBotLayer } from './helpers/fake-botlayer.ts'

// The simulated CI of the binding (spec 7, 4.5): the unit tests plus a lint job that fails until the stale "BUG" comment
// of src/price.js is removed. The Coding bot's step-4 fix (fixTheBug) leaves the comment, so pipeline 1 fails on lint.
const TESTS = { name: 'tests', command: 'sh test.sh' }
const LINT = { name: 'lint', command: 'if grep -n BUG src/price.js; then echo "lint: remove the stale BUG comment"; exit 1; fi' }

async function rig(t, { binding = {} }: any = {}) {
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
      ...binding,
    }],
  }))
  const config = loadConfig({ path: configPath, env: { ANTHROPIC_API_KEY: 'test-key' } })
  const botlayer = createFakeBotLayer()
  const warnings = []
  const warn = (...args) => warnings.push(args.join(' '))
  // The test owns the clock the monitor sees (spec 7: poll by advancing it) and the adapters (ciIdle waits for the simulated jobs).
  const clock = { t: Date.now() }
  const adapters = createAdapters(config, { warn })
  const app = createApp({ config, botlayer, adapters, token: 'tok', warn, now: () => clock.t })
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
  const mention = async (text, threadTs?) => {
    const sent = await sendFakeEvent({ channel: 'C1', text, threadTs, dataDir: config.dataDir, url, token: 'tok' })
    return sent
  }
  const start = async (text) => {
    const sent = await mention(text)
    assert.equal(sent.status, 202, JSON.stringify(sent.body))
    const task = await inState(sent.body.taskId, 'running')
    const run = task.runs.at(-1)
    botlayer.setQuiet(run.groupId, false)
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
  // Drives the monitor like the 5 second timer would, with the clock moved on: waits for the simulated jobs, advances
  // the clock, ticks, until `done(task)`.
  const poll = async (id, done, { seconds = 20, max = 25 }: any = {}) => {
    for (let i = 0; i < max; i++) {
      await adapters.repo.ciIdle()
      clock.t += seconds * 1000
      await app.monitor.tick()
      const task = await app.store.getTask(id)
      if (done(task)) return task
    }
    throw new Error(`the CI of ${id} did not reach the expected state: ${JSON.stringify((await app.store.getTask(id)).ci)}; warnings: ${warnings.join(' | ')}`)
  }
  const advanceClock = (minutes) => { clock.t += minutes * 60_000 }
  // What the monitor told the Main bot, and what the system said in the discussion.
  const systemPosts = () => botlayer.posts.filter(post => post.text.startsWith('[system]')).map(post => post.text)
  const notices = async () => (await replies()).filter(reply => reply.purpose === 'system').map(reply => reply.text)
  return { app, botlayer, config, made, warnings, inState, mention, start, fake, replies, git, poll, advanceClock, systemPosts, notices, adapters }
}

const ok = (text) => { assert.doesNotMatch(text, /^tool failed|^Cannot|refused/i, text); return text }

// The first three steps are the same in every scenario.
async function throughPrepare(r, s) {
  ok(await s.tool('slack', 'slack_read_thread'))
  ok(await s.tool('slack', 'slack_reply', { purpose: 'ack', text: 'Received. Working on it.' }))
  await s.roundEnd('slack', 'Summary: applyDiscount adds the discount instead of subtracting it.')
  ok(await s.tool('main', 'task_advance', { to: 'issue' }))

  const sourceQuote = (await r.app.store.getTask(s.id)).origin.text
  ok(await s.tool('jira', 'jira_assess_request', {
    sourceQuote, problem: 'applyDiscount gives the wrong price', outcome: 'The calculated price is correct',
  }))
  ok(await s.tool('jira', 'jira_create_issue', {
    title: 'applyDiscount adds the discount', description: 'applyDiscount(100, 10) returns 110.', acceptance: 'applyDiscount(100, 10) returns 90.',
  }))
  ok(await s.tool('main', 'task_advance', { to: 'prepare' }))

  ok(await s.tool('pipeline', 'repo_prepare'))
  ok(await s.tool('main', 'task_advance', { to: 'code' }))
  return r.app.store.getTask(s.id)
}

test('a greeting asks for details before Jira creation', async (t) => {
  const r = await rig(t)
  const s = await r.start('你好')
  ok(await s.tool('slack', 'slack_read_thread'))
  ok(await s.tool('slack', 'slack_reply', { purpose: 'ack', text: '收到。' }))
  await s.roundEnd('slack', '只有“你好”；没有问题、目标或验收标准。')
  ok(await s.tool('main', 'task_advance', { to: 'issue' }))
  assert.match(await s.tool('jira', 'jira_assess_request', { sourceQuote: '你好', problem: 'fix greeting', outcome: 'it works' }), /no actionable issue/)
  assert.match(await s.tool('jira', 'jira_create_issue', { title: 'greeting', description: 'greeting', acceptance: 'greeting' }), /not been approved/)
  ok(await s.tool('jira', 'needs_info_confirm', { text: '请说明需要修复什么、当前表现和预期结果。' }))
  ok(await s.tool('main', 'needs_info_confirm', { text: '请说明需要修复什么、当前表现和预期结果。' }))
  ok(await s.tool('slack', 'slack_reply', { purpose: 'question', text: '请说明需要修复什么、当前表现和预期结果。' }))
  ok(await s.tool('main', 'task_close', { outcome: 'needs_info' }))
  const task = await r.inState(s.id, 'needs_info')
  assert.equal(task.jira.key, null)
  assert.equal(existsSync(join(r.config.dataDir, 'fake', 'jira', 'issues.json')), false)
})

// What Claude Code does in step 4, done by hand: the one-line fix in the task's code directory.
async function fixTheBug(dir) {
  const file = join(dir, 'src', 'price.js')
  const before = await readFile(file, 'utf8')
  const after = before.replace('return price + (price * percent) / 100', 'return price - (price * percent) / 100')
  assert.notEqual(after, before, `the sample bug was not found in:\n${before}`)
  await writeFile(file, after)
}

test('ci 1 / normal: one @ goes through the eight steps with the fake Slack, Jira and GitLab, the CI passes at once, end reason completed', async (t) => {
  const r = await rig(t, { binding: { ciJobs: [TESTS] } })
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
  ok(await s.tool('coding', 'request_review', { summary: 'One line changed; the test passes.' }))
  ok(await s.tool('main', 'task_advance', { to: 'mr' }))

  // Step 5.
  assert.match(ok(await s.tool('pipeline', 'repo_diff')), /src\/price\.js/)
  assert.match(ok(await s.tool('pipeline', 'mr_open_draft', { title: 'DEMO-1 Fix applyDiscount', description: 'Subtract the discount.' })), /fake:\/\/gitlab\/group\/project\/mr\/1/)
  ok(await s.tool('main', 'task_advance', { to: 'ci' }))

  // Step 6 (CI): the system waits for the pipeline of the pushed commit; nobody can talk the step done.
  assert.match(await s.tool('main', 'task_advance', { to: 'writeback' }), /Cannot advance/)
  task = await r.poll(s.id, (current) => current.ci?.settled === true)
  assert.equal(task.ci.status, 'passed')
  assert.equal(task.ci.outcome, 'passed')
  assert.equal(task.ci.round, 0)
  assert.equal(task.ci.sha, task.mr.sha)
  assert.match((await r.notices()).at(-1), /CI 通过/)
  assert.ok(r.systemPosts().some(text => /CI outcome is in \(passed\)/.test(text) && /Advance to writeback/.test(text)), 'the Main bot is told once the CI step is settled')
  ok(await s.tool('main', 'task_advance', { to: 'writeback' }))

  // Step 7.
  ok(await s.tool('jira', 'jira_add_comment', { text: 'A Draft MR is open for review.' }))
  ok(await s.tool('slack', 'slack_reply', { purpose: 'result', text: 'Done: a Draft MR is open.' }))
  assert.match(await s.tool('slack', 'slack_reply', { purpose: 'result', text: 'again' }), /already sent/)
  ok(await s.tool('main', 'task_advance', { to: 'close' }))

  // Step 8.
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
  // The system posted the progress facts itself: the Jira key, the MR link, then the CI outcome.
  assert.deepEqual((await r.replies()).map(reply => reply.purpose), ['ack', 'system', 'system', 'system', 'result'])
  const progress = await r.notices()
  assert.match(progress[0], /Jira 单已建好：DEMO-1/)
  assert.match(progress[1], /Draft MR 已开：fake:\/\/gitlab\/group\/project\/mr\/1/)
  assert.match(progress[2], /CI 通过/)
  assert.equal(task.notified.jira_created && task.notified.mr_opened, true)
  assert.equal(task.endReason, 'completed')
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
  r.botlayer.reviewer = () => ({ text: 'not pass\n- src/price.js: the rounding is still wrong', stopReason: 'completed' })
  assert.match(ok(await s.tool('coding', 'request_review', { summary: 'Changed the rounding.' })), /: not pass\./)
  assert.match(await s.tool('main', 'task_advance', { to: 'mr' }), /Cannot advance/)
  assert.doesNotMatch(await s.tool('pipeline', 'mr_open_draft', { title: 'x', description: 'x' }), /fake:\/\/gitlab/)
  ok(await s.tool('main', 'task_close', { outcome: 'failed', note: 'The review did not pass after three rounds.' }))

  const ended = await r.inState(s.id, 'failed')
  assert.equal(ended.mr?.url, undefined)
  assert.equal(existsSync(join(r.config.dataDir, 'fake', 'gitlab', 'mrs.json')), false, 'no MR was recorded')
  assert.match(r.git(r.made.localRepo, 'branch', '--list', 'ai/DEMO-1'), /ai\/DEMO-1/, 'the branch is kept')
  // The system told the person in the original discussion.
  const sent = await r.replies()
  assert.deepEqual(sent.map(reply => reply.purpose), ['ack', 'system', 'system']) // the Jira key, then the failure
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
  assert.deepEqual((await r.replies()).map(reply => reply.purpose), ['ack', 'system', 'question']) // the system posted the Jira key; no resubmit notice with mentions on

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

// ---------------------------------------------------------------------------------------------
// The CI loop (spec 7, section 5). Same style: the test plays the five bots by calling their tools; the monitor
// polls a simulated pipeline (binding.ciJobs) and the clock is moved by r.poll / r.advanceClock.
// ---------------------------------------------------------------------------------------------

// Steps 1 to 6 up to the point where the system starts waiting for the pipeline of the first MR commit.
async function toCi(r, s) {
  const task = await throughPrepare(r, s)
  await fixTheBug(task.repo.dir)
  ok(await s.tool('coding', 'request_review', { summary: 'One line changed; the test passes.' }))
  ok(await s.tool('main', 'task_advance', { to: 'mr' }))
  ok(await s.tool('pipeline', 'mr_open_draft', { title: 'DEMO-1 Fix applyDiscount', description: 'Subtract the discount.', commit_message: 'fix(price): subtract the discount instead of adding it' }))
  ok(await s.tool('main', 'task_advance', { to: 'ci' }))
  return r.app.store.getTask(s.id)
}

// Step 7 and 8 once the CI step is settled.
async function finish(r, s, endReason) {
  ok(await s.tool('main', 'task_advance', { to: 'writeback' }))
  ok(await s.tool('jira', 'jira_add_comment', { text: 'A Draft MR is open; see the CI outcome.' }))
  ok(await s.tool('slack', 'slack_reply', { purpose: 'result', text: 'Draft MR is open; CI outcome stated.' }))
  ok(await s.tool('main', 'task_advance', { to: 'close' }))
  ok(await s.tool('main', 'task_close', { outcome: 'done' }))
  const task = await r.inState(s.id, 'done')
  assert.equal(task.endReason, endReason)
  assert.equal(r.botlayer.bots.size, 0)
  assert.equal(r.botlayer.groups.size, 0)
  assert.deepEqual(r.warnings, [])
  return task
}

const failedRound = (round) => (task) => task.ci?.status === 'failed' && task.ci.round === round && !task.ci.settled
const commitsOnBranch = (r) => r.git(r.made.remote, 'log', '--reverse', '--format=%H %s', `${r.made.defaultBranch}..ai/DEMO-1`).trim().split('\n').filter(Boolean).map(line => ({ sha: line.slice(0, 40), subject: line.slice(41) }))
const removeBugComment = async (dir) => {
  const file = join(dir, 'src', 'price.js')
  const before = await readFile(file, 'utf8')
  const after = before.split('\n').filter(line => !line.includes('BUG')).join('\n')
  assert.notEqual(after, before)
  await writeFile(file, after)
}
// A change that does not fix the lint job: one more file per round.
const otherChange = (dir, n) => writeFile(join(dir, `notes-${n}.txt`), `attempt ${n}\n`)

test('ci 2: fail, read the log, fix, review, mr_push_fix, pass; two commits on the branch, appended, no force push', async (t) => {
  const r = await rig(t, { binding: { ciJobs: [TESTS, LINT] } })
  const s = await r.start('applyDiscount gives the wrong price')
  const opened = await toCi(r, s)
  const first = commitsOnBranch(r)
  assert.equal(first.length, 1)
  assert.equal(first[0].sha, opened.mr.sha)

  // Round 1 fails (after the one automatic re-run); the system says so and tells the Main bot.
  let task = await r.poll(s.id, failedRound(0))
  assert.deepEqual(task.ci.failedJobs.map(job => job.name), ['lint'])
  assert.equal(task.ci.retried, true)
  assert.equal(task.review, null, 'the review of the first change is cleared')
  assert.match((await r.notices()).at(-1), /CI 第 1 轮失败：lint/)
  assert.match(r.systemPosts().at(-1), /CI failed.*round 1 of 3.*You lead this round/, 'a failed round goes to the Pipeline bot, which leads it')
  assert.equal(r.systemPosts().filter(text => /CI outcome is in/.test(text)).length, 0, 'the Main bot is not told before the step is settled')

  // The Pipeline bot reads the log; a job that is not listed is refused. The summary is its answer.
  assert.match(await s.tool('pipeline', 'ci_read_log', { job: 'nope' }), /tool failed/)
  assert.match(await s.tool('pipeline', 'ci_read_log', { job: 'lint' }), /remove the stale BUG comment/)
  assert.equal((await r.app.store.getTask(s.id)).ci.logRead, true)
  await s.roundEnd('pipeline', 'lint failed: src/price.js line 5 still has the stale BUG comment.')
  task = await r.app.store.getTask(s.id)
  assert.match(task.stepResults.ci.pipeline.text, /stale BUG comment/)
  assert.match(await s.tool('coding', 'task_read'), /lint/)

  // Pushing without this round's review is refused; nothing was pushed.
  assert.match(await s.tool('pipeline', 'mr_push_fix', { commit_message: 'fix(lint): remove the stale BUG comment' }), /tool failed|review has not passed/)
  assert.equal(commitsOnBranch(r).length, 1)

  // Coding fixes in the same code directory, the review passes, the fix is pushed as a new commit.
  await removeBugComment(task.repo.dir)
  ok(await s.tool('coding', 'request_review', { summary: 'Only the comment line removed.' }))
  assert.match(await s.tool('pipeline', 'mr_push_fix', { commit_message: 'Remove the comment.' }), /tool failed/, 'the commit message must be a Conventional Commit line')
  assert.match(ok(await s.tool('pipeline', 'mr_push_fix', { commit_message: 'fix(lint): remove the stale BUG comment' })), /round 1 of 3/)
  task = await r.app.store.getTask(s.id)
  assert.equal(task.ci.status, 'pending')
  assert.equal(task.ci.round, 1)
  assert.notEqual(task.ci.sha, opened.mr.sha)
  assert.equal(task.mr.sha, task.ci.sha)

  // The second pipeline passes.
  task = await r.poll(s.id, (current) => current.ci?.settled === true)
  assert.equal(task.ci.outcome, 'passed')
  assert.equal(task.ci.round, 1)
  assert.match((await r.notices()).at(-1), /CI 通过（修复 1 轮后）/)

  // Exactly two commits on the remote branch; the second was appended to the first (nothing amended or forced).
  const commits = commitsOnBranch(r)
  assert.equal(commits.length, 2)
  assert.equal(commits[0].sha, opened.mr.sha, 'the first commit is still the one that opened the MR')
  assert.equal(commits[1].sha, task.ci.sha)
  assert.equal(commits[1].subject, 'DEMO-1: fix(lint): remove the stale BUG comment')
  assert.equal(r.git(r.made.remote, 'rev-parse', 'ai/DEMO-1').trim(), task.ci.sha)
  assert.equal(Object.values(await r.fake('gitlab/mrs.json')).length, 1)
  assert.equal((Object.values(await r.fake('gitlab/mrs.json'))[0] as any).headSha, task.ci.sha)
  await finish(r, s, 'completed')
})

test('ci 3: a flaky job fails once, the system re-runs it and it passes; no round is used', async (t) => {
  const r = await rig(t, { binding: { ciJobs: [TESTS, { name: 'e2e', command: 'true', flaky: true }] } })
  const s = await r.start('applyDiscount gives the wrong price')
  await toCi(r, s)
  const task = await r.poll(s.id, (current) => current.ci?.settled === true)
  assert.equal(task.ci.outcome, 'passed')
  assert.equal(task.ci.round, 0)
  assert.equal(task.ci.retried, true)
  assert.equal((await r.fake('gitlab/pipelines.json')).pipelines.length, 1, 'no new commit, no new pipeline')
  assert.equal((await r.notices()).filter(text => /失败/.test(text)).length, 0, 'no failure notice for a flaky job')
  assert.equal(r.systemPosts().filter(text => /CI failed/.test(text)).length, 0, 'the Main bot is not troubled')
  assert.ok(r.systemPosts().some(text => /CI outcome is in \(passed\)/.test(text)))
  const records = await r.app.store.readRecords(s.id)
  assert.ok(records.some(record => record.type === 'ci' && /re-running/.test(record.text)), 'the re-run is recorded')
  await finish(r, s, 'completed')
})

test('ci 4: a failed job that is allowed to fail does not count', async (t) => {
  const r = await rig(t, { binding: { ciJobs: [TESTS, { name: 'coverage-report', command: 'echo "report upload failed"; exit 1', allowFailure: true }] } })
  const s = await r.start('applyDiscount gives the wrong price')
  await toCi(r, s)
  const task = await r.poll(s.id, (current) => current.ci?.settled === true)
  assert.equal(task.ci.outcome, 'passed')
  assert.equal(task.ci.retried, false, 'nothing counted as failed, so nothing was re-run')
  assert.deepEqual(task.ci.failedJobs ?? [], [])
  await finish(r, s, 'completed')
})

test('ci 5: three fix rounds that do not help end as completed_ci_failed; a fourth mr_push_fix is refused', async (t) => {
  const r = await rig(t, { binding: { ciJobs: [TESTS, LINT] } })
  const s = await r.start('applyDiscount gives the wrong price')
  await toCi(r, s)
  let task
  for (let round = 0; round < 3; round++) {
    task = await r.poll(s.id, failedRound(round))
    ok(await s.tool('pipeline', 'ci_read_log', { job: 'lint' }).then(text => text.startsWith('Log of') ? 'ok' : text))
    await otherChange(task.repo.dir, round + 1)
    ok(await s.tool('coding', 'request_review', { summary: 'A change that does not touch the comment.' }))
    assert.match(ok(await s.tool('pipeline', 'mr_push_fix', { commit_message: `fix(lint): attempt ${round + 1}` })), new RegExp(`round ${round + 1} of 3`))
  }
  // The pipeline of the third fix still fails: the loop is settled by the system.
  task = await r.poll(s.id, (current) => current.ci?.settled === true)
  assert.equal(task.ci.outcome, 'rounds_exhausted')
  assert.equal(task.ci.round, 3)
  assert.match((await r.notices()).at(-1), /修了 3 轮后仍未通过.*lint/)
  assert.ok(r.systemPosts().at(-1).includes('Advance to writeback'))
  await r.app.monitor.tick()
  assert.equal(r.systemPosts().filter(text => /CI outcome is in \(rounds_exhausted\)/.test(text)).length, 1, 'the Main bot is told once')

  // A fourth push is refused even with a passing review and a change.
  await otherChange(task.repo.dir, 4)
  ok(await s.tool('coding', 'request_review', { summary: 'again' }))
  assert.match(await s.tool('pipeline', 'mr_push_fix', { commit_message: 'fix(lint): attempt 4' }), /tool failed/)
  assert.equal(commitsOnBranch(r).length, 4, 'the first commit and three fixes, no fourth')
  assert.equal((await r.app.store.getTask(s.id)).ci.round, 3)
  await finish(r, s, 'completed_ci_failed')
})

test('ci 6: ci_stop needs a failed CI and a log read; not_fixable needs the Coding bot\'s cannot_fix', async (t) => {
  const r = await rig(t, { binding: { ciJobs: [TESTS, LINT] } })
  const s = await r.start('applyDiscount gives the wrong price')
  const task0 = await throughPrepare(r, s)
  // cannot_fix is a verdict of step ci only.
  assert.match(await s.tool('coding', 'review_report', { verdict: 'cannot_fix', comments: 'x' }), /belongs to step ci/)
  await fixTheBug(task0.repo.dir)
  ok(await s.tool('coding', 'request_review', { summary: 'ok' }))
  ok(await s.tool('main', 'task_advance', { to: 'mr' }))
  ok(await s.tool('pipeline', 'mr_open_draft', { title: 'DEMO-1 Fix applyDiscount', description: 'Subtract the discount.' }))
  ok(await s.tool('main', 'task_advance', { to: 'ci' }))

  // While the system waits for the pipeline nobody can stop the loop.
  assert.match(await s.tool('pipeline', 'ci_stop', { reason: 'not_locatable', note: 'x' }), /tool failed|has not failed/)
  await r.poll(s.id, failedRound(0))
  // Failed but no log read yet.
  assert.match(await s.tool('pipeline', 'ci_stop', { reason: 'not_locatable', note: 'The log is empty.' }), /no log of this round was read/)
  assert.match(await s.tool('pipeline', 'ci_read_log', { job: 'lint' }), /stale BUG comment/)
  // Bad reason, empty note, and not_fixable that the Coding bot did not record.
  assert.match(await s.tool('pipeline', 'ci_stop', { reason: 'give_up', note: 'x' }), /tool failed/)
  assert.match(await s.tool('pipeline', 'ci_stop', { reason: 'out_of_scope', note: '  ' }), /tool failed|note/)
  assert.match(await s.tool('pipeline', 'ci_stop', { reason: 'not_fixable', note: 'Nobody can fix it.' }), /must come from the Coding bot/)
  assert.notEqual((await r.app.store.getTask(s.id)).ci.settled, true)
  // The Coding bot records that it cannot fix it; now the Main bot may stop.
  ok(await s.tool('coding', 'review_report', { verdict: 'cannot_fix', comments: 'The lint rule comes from a shared config outside this repository.' }))
  assert.match(await s.tool('pipeline', 'mr_push_fix', { commit_message: 'fix(lint): x' }), /tool failed|review has not passed/, 'cannot_fix is not a pass')
  ok(await s.tool('pipeline', 'ci_stop', { reason: 'not_fixable', note: 'The Coding bot recorded that the lint rule lives outside this repository.' }))
  const task = await r.app.store.getTask(s.id)
  assert.equal(task.ci.outcome, 'not_fixable')
  assert.equal(task.ci.settled, true)
  assert.match(task.ci.note, /outside this repository/)
  // The system then tells the Main bot, once, that the step is settled.
  await r.app.monitor.tick()
  await r.app.monitor.tick()
  assert.equal(r.systemPosts().filter(text => /CI outcome is in \(not_fixable\)/.test(text)).length, 1)
  // A second stop after it ended is refused.
  assert.match(await s.tool('pipeline', 'ci_stop', { reason: 'out_of_scope', note: 'again' }), /already ended/)
  await finish(r, s, 'completed_ci_stopped')
})

test('ci 6b: after a read log the Main bot can stop as out_of_scope', async (t) => {
  const r = await rig(t, { binding: { ciJobs: [TESTS, LINT] } })
  const s = await r.start('applyDiscount gives the wrong price')
  await toCi(r, s)
  await r.poll(s.id, failedRound(0))
  ok(await s.tool('pipeline', 'ci_read_log', { job: 'lint' }).then(text => text.startsWith('Log of') ? 'ok' : text))
  ok(await s.tool('pipeline', 'ci_stop', { reason: 'out_of_scope', note: 'The BUG comment belongs to another ticket.' }))
  assert.equal((await r.app.store.getTask(s.id)).ci.outcome, 'out_of_scope')
  await finish(r, s, 'completed_ci_stopped')
})

test('ci 7: no pipeline appears within ciWaitMinutes: no_pipeline, completed_no_ci', async (t) => {
  const r = await rig(t, { binding: { ciNone: true } })
  const s = await r.start('applyDiscount gives the wrong price')
  await toCi(r, s)
  let task = await r.poll(s.id, (current) => current.ci?.status === 'pending', { max: 3 })
  assert.notEqual(task.ci.settled, true)
  assert.equal((await r.fake('gitlab/pipelines.json').catch(() => ({ pipelines: [] }))).pipelines.length, 0)
  // Waiting is not a reason to end the task: 31 minutes later the wait is over, not the task.
  r.advanceClock(31)
  await r.app.monitor.tick()
  task = await r.app.store.getTask(s.id)
  assert.equal(task.state, 'running')
  assert.equal(task.ci.settled, true)
  assert.equal(task.ci.outcome, 'no_pipeline')
  assert.match((await r.notices()).at(-1), /没有触发 pipeline/)
  assert.match(r.systemPosts().at(-1), /CI outcome is in \(no_pipeline\)/)
  await finish(r, s, 'completed_no_ci')
})

test('ci 8: someone pushes to the branch during the fix: mr_push_fix is rejected, branch_changed, their commit stays', async (t) => {
  const r = await rig(t, { binding: { ciJobs: [TESTS, LINT] } })
  const s = await r.start('applyDiscount gives the wrong price')
  const opened = await toCi(r, s)
  let task = await r.poll(s.id, failedRound(0))
  ok(await s.tool('pipeline', 'ci_read_log', { job: 'lint' }).then(text => text.startsWith('Log of') ? 'ok' : text))

  // A person pushes a commit to ai/DEMO-1 in the meantime.
  const other = await mkdtemp(join(tmpdir(), 'chat-to-fix-other-'))
  r.git(other, 'clone', '--quiet', '--branch', 'ai/DEMO-1', r.made.remote, 'clone')
  const clone = join(other, 'clone')
  await writeFile(join(clone, 'HUMAN.txt'), 'a person was here\n')
  r.git(clone, 'add', '-A')
  r.git(clone, '-c', 'user.name=Human', '-c', 'user.email=human@example.com', 'commit', '--quiet', '-m', 'docs: a note from a person')
  r.git(clone, 'push', '--quiet', 'origin', 'ai/DEMO-1')
  const humanSha = r.git(clone, 'rev-parse', 'HEAD').trim()

  await removeBugComment(task.repo.dir)
  ok(await s.tool('coding', 'request_review', { summary: 'ok' }))
  const answer = await s.tool('pipeline', 'mr_push_fix', { commit_message: 'fix(lint): remove the stale BUG comment' })
  assert.match(answer, /rejected/)
  task = await r.app.store.getTask(s.id)
  assert.equal(task.ci.settled, true)
  assert.equal(task.ci.outcome, 'branch_changed')
  assert.equal(task.ci.round, 0, 'no fix commit was pushed')
  assert.equal(r.git(r.made.remote, 'rev-parse', 'ai/DEMO-1').trim(), humanSha, 'the person\'s commit is still the head of the remote branch')
  assert.deepEqual(commitsOnBranch(r).map(commit => commit.sha).slice(0, 1), [opened.mr.sha])
  assert.equal(commitsOnBranch(r).length, 2)
  await finish(r, s, 'completed_ci_stopped')
})

test('ci 9: a new @ after missing information reruns the task; opening the MR again appends a commit, no amend, no force push', async (t) => {
  const r = await rig(t, { binding: { ciNone: true } })
  const s = await r.start('the price is wrong somewhere')
  const opened = await toCi(r, s)
  // The first run ends in needs_info after the MR was opened.
  ok(await s.tool('coding', 'needs_info_confirm', { text: 'Which discount does the person mean?' }))
  ok(await s.tool('main', 'needs_info_confirm', { text: 'Which discount does the person mean?' }))
  ok(await s.tool('slack', 'slack_reply', { purpose: 'question', text: 'Which discount?' }))
  ok(await s.tool('main', 'task_close', { outcome: 'needs_info' }))
  await r.inState(s.id, 'needs_info')
  const firstHead = r.git(r.made.remote, 'rev-parse', 'ai/DEMO-1').trim()
  assert.equal(firstHead, opened.mr.sha)

  // The answer comes: a second run on the same task, the same directory and the same MR.
  const again = await r.mention('It is applyDiscount with 100 and 10, and the label is wrong too.', s.threadTs)
  assert.equal(again.status, 202)
  const rerun = await r.inState(s.id, 'running')
  assert.equal(rerun.runs.length, 2)
  const run = rerun.runs.at(-1)
  const tool = (role, name, args = {}) => r.app.tools.call(name, run.bots[role], args)
  ok(await tool('slack', 'slack_read_thread'))
  await r.app.recorder.flush()
  r.botlayer.emit.roundEnd({ sessionId: run.bots.slack, botId: run.bots.slack, groupId: run.groupId, text: 'Summary: the discount and the label are wrong.', failed: false, at: new Date().toISOString() })
  await r.app.recorder.flush()
  ok(await tool('main', 'task_advance', { to: 'issue' }))
  ok(await tool('jira', 'jira_create_issue', { title: 'x', description: 'x', acceptance: 'x' }))
  ok(await tool('main', 'task_advance', { to: 'prepare' }))
  ok(await tool('pipeline', 'repo_prepare'))
  ok(await tool('main', 'task_advance', { to: 'code' }))
  const task = await r.app.store.getTask(s.id)
  assert.equal(task.repo.dir, rerun.repo.dir, 'the same code directory')
  await writeFile(join(task.repo.dir, 'src', 'greeting.js'), 'export function greet(name) {\n  return `Hello, ${name}.`\n}\n')
  ok(await tool('coding', 'request_review', { summary: 'ok' }))
  ok(await tool('main', 'task_advance', { to: 'mr' }))
  assert.match(ok(await tool('pipeline', 'mr_open_draft', { title: 'DEMO-1 Fix applyDiscount and the greeting', description: 'More.', commit_message: 'fix(greeting): end the greeting with a full stop' })), /MR/)

  const commits = commitsOnBranch(r)
  assert.equal(commits.length, 2, 'one more commit on the branch')
  assert.equal(commits[0].sha, opened.mr.sha, 'the first commit was not amended')
  assert.equal(commits[1].subject, 'DEMO-1: fix(greeting): end the greeting with a full stop')
  assert.equal(r.git(r.made.remote, 'merge-base', commits[0].sha, commits[1].sha).trim(), commits[0].sha)
  assert.equal(Object.values(await r.fake('gitlab/mrs.json')).length, 1, 'still one MR')
  assert.equal((await r.app.store.getTask(s.id)).mr.sha, commits[1].sha)
})

test('a /fix opens the thread and the task runs: the server posts the opening message, the Slack bot reads it, later @ finds the task', async (t) => {
  const r = await rig(t)
  const res = await fetch(`http://127.0.0.1:${r.app.http.port}/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-to-fix-token': 'tok' },
    body: JSON.stringify({ source: 'slash', eventId: 'slash:trigger-1', channel: 'C1', user: { id: 'U-ANN', name: 'ann' }, text: 'applyDiscount gives the wrong price' }),
  })
  const body: any = await res.json()
  assert.equal(res.status, 202, JSON.stringify(body))
  assert.deepEqual(Object.keys(body).sort(), ['permalink', 'taskId'])
  const task = await r.inState(body.taskId, 'running')
  // The task lives in the new discussion: threadTs = messageTs = the opening message.
  assert.equal(task.origin.threadTs, task.origin.messageTs)
  assert.equal(body.permalink, `fake://slack/C1/${task.origin.threadTs}`)
  assert.equal(task.origin.permalink, body.permalink)
  assert.equal(task.origin.text, 'applyDiscount gives the wrong price')
  assert.equal(task.origin.user.id, 'U-ANN')
  assert.equal((await r.app.store.findByThread('C1', task.origin.threadTs)).id, task.id)

  // Step 1 (fetch): the Slack bot reads the opening message.
  const run = task.runs.at(-1)
  r.botlayer.setQuiet(run.groupId, false)
  const tool = (role, name, args = {}) => r.app.tools.call(name, run.bots[role], args)
  const thread = ok(await tool('slack', 'slack_read_thread'))
  assert.match(thread, /<@U-ANN> 用 \/fix 提了一个修复请求/)
  assert.match(thread, /> applyDiscount gives the wrong price/)
  // The Main bot got the request text as its material.
  assert.ok(r.botlayer.posts.some(post => post.text.includes('applyDiscount gives the wrong price')))
  // The ack goes into that discussion.
  ok(await tool('slack', 'slack_reply', { purpose: 'ack', text: 'Received. Working on it.' }))
  const [reply] = await r.replies()
  assert.equal(reply.threadTs, task.origin.threadTs)

  // A repeated command (same trigger) and an @ in the thread do not start a second task.
  const again = await fetch(`http://127.0.0.1:${r.app.http.port}/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-to-fix-token': 'tok' },
    body: JSON.stringify({ source: 'slash', eventId: 'slash:trigger-1', channel: 'C1', user: { id: 'U-ANN' }, text: 'applyDiscount gives the wrong price' }),
  })
  assert.equal(again.status, 200)
  assert.equal(((await again.json()) as any).duplicate, true)
  const mentioned = await r.mention('It is the discount, 100 and 10.', task.origin.threadTs)
  assert.equal(mentioned.status, 200)
  assert.equal(mentioned.body.taskId, task.id)
  assert.equal(mentioned.body.inProgress, true)
  assert.equal((await r.app.store.listTasks({})).length, 1)
  assert.deepEqual(r.warnings, [])
})
