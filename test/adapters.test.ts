import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdapters } from '../src/adapters/index.ts'
import { runGit } from '../src/adapters/git.ts'
import { createHttp } from '../src/task/http.ts'
import { createTestRepo } from '../scripts/make-test-repo.ts'
import { sendFakeEvent } from '../scripts/fake-event.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let tmp, cfg, adapters, repoInfo, binding, counter = 0

// A fresh configuration (own data and worktree folders) for one test.
async function setup(overrides = {}) {
  const dir = await mkdtemp(join(tmp, 'case-'))
  const made = await createTestRepo({ dir: join(dir, 'repo') })
  const b = { channel: 'C1', repo: 'group/project', localRepo: made.localRepo, remote: made.remote, defaultBranch: 'master', jiraProject: 'DEMO', issueType: 'Bug', labels: ['chat-to-fix'] }
  const config = {
    dataDir: join(dir, 'data'), worktreesDir: join(dir, 'worktrees'),
    adapters: { slack: 'fake', jira: 'fake', gitlab: 'fake' }, bindings: [b],
    commitAuthor: { name: 'chat-to-fix', email: 'chat-to-fix@example.com' }, ...overrides,
  }
  return { config, adapters: createAdapters(config) as any, binding: b, made, dir }
}

before(async () => { tmp = await mkdtemp(join(tmpdir(), 'chat-to-fix-adapters-')) })
after(async () => { await rm(tmp, { recursive: true, force: true }) })

const git = (args, cwd?) => runGit(args, { cwd, author: { name: 'x', email: 'x@example.com' } }).then((r) => r.stdout)
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))

test('real adapters are refused at creation, per adapter', async () => {
  const { config } = await setup()
  for (const [name, key] of [['slack', 'slack'], ['jira', 'jira'], ['gitlab', 'gitlab']]) {
    const bad = { ...config, adapters: { ...config.adapters, [name]: 'real' } }
    assert.throws(() => createAdapters(bad), (e: any) => e.code === 'not_implemented' && /not implemented yet: waiting for the hookup design/.test(e.message) && e.message.includes(`adapters.${key}`))
  }
  const all = createAdapters(config)
  assert.deepEqual(Object.keys(all).sort(), ['jira', 'repo', 'slack'])
})

test('slack: readThread and reply', async () => {
  const { config, adapters: a } = await setup()
  const origin = { channel: 'C1', threadTs: '100.1' }
  await assert.rejects(a.slack.readThread(origin), (e: any) => e.code === 'thread_not_found' && e.retryable === false)
  await mkdir(join(config.dataDir, 'fake/slack/threads'), { recursive: true })
  await writeFile(join(config.dataDir, 'fake/slack/threads/C1-100.1.json'), JSON.stringify([
    { user: { id: 'U1', name: 'ann' }, at: '2026-11-12T01:00:00Z', text: 'It is broken', files: [{ name: 'a.png', url: 'u' }] },
    { user: { id: 'U2' }, text: 'me too' },
  ]))
  const messages = await a.slack.readThread(origin)
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0], { user: { id: 'U1', name: 'ann' }, at: '2026-11-12T01:00:00Z', text: 'It is broken', files: [{ name: 'a.png', url: 'u' }] })
  assert.deepEqual(messages[1].files, [])

  const id1 = await a.slack.reply(origin, 'ack', 'received')
  const id2 = await a.slack.reply(origin, 'result', 'done')
  assert.equal(typeof id1, 'string')
  assert.notEqual(id1, id2)
  const lines: any[] = (await readFile(join(config.dataDir, 'fake/slack/replies.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse as any)
  assert.deepEqual(lines.map((l) => [l.purpose, l.text, l.channel, l.threadTs]), [['ack', 'received', 'C1', '100.1'], ['result', 'done', 'C1', '100.1']])
  assert.ok(lines[0].at)
  await assert.rejects(a.slack.reply(origin, 'shout', 'x'), (e: any) => e.code === 'bad_purpose')
  await assert.rejects(a.slack.reply({ channel: '../x', threadTs: '1' }, 'ack', 'x'), (e: any) => e.code === 'bad_origin')
  await assert.rejects(a.slack.readThread({ channel: 'C1', threadTs: '../../etc' }), (e: any) => e.code === 'bad_origin')
})

test('jira: create, get, comment, transition, keys and errors', async () => {
  const { config, adapters: a, binding: b } = await setup()
  const one = await a.jira.createIssue(b, { title: 'Login broken', description: 'desc', acceptance: 'works', permalink: 'https://s/p1' })
  assert.deepEqual(one, { key: 'DEMO-1', url: 'fake://jira/DEMO-1' })
  const two = await a.jira.createIssue(b, { title: 'Second', description: '', acceptance: '', permalink: null })
  assert.equal(two.key, 'DEMO-2')
  assert.equal((await a.jira.createIssue({ ...b, jiraProject: 'OTHER' }, { title: 't' })).key, 'OTHER-1')

  const issue = await a.jira.getIssue('DEMO-1')
  assert.equal(issue.key, 'DEMO-1')
  assert.equal(issue.title, 'Login broken')
  assert.equal(issue.description, 'desc')
  assert.equal(issue.status, 'To Do')
  assert.deepEqual(issue.comments, [])
  const stored = (await json(join(config.dataDir, 'fake/jira/issues.json')))['DEMO-1']
  assert.deepEqual([stored.acceptance, stored.permalink, stored.labels, stored.type], ['works', 'https://s/p1', ['chat-to-fix'], 'Bug'])

  assert.equal(await a.jira.addComment('DEMO-1', 'MR is open'), undefined)
  assert.equal(await a.jira.transition('DEMO-1', 'In Review'), undefined)
  const after = await a.jira.getIssue('DEMO-1')
  assert.equal(after.status, 'In Review')
  assert.equal(after.comments.length, 1)
  assert.equal(after.comments[0].text, 'MR is open')

  await assert.rejects(a.jira.getIssue('DEMO-99'), (e: any) => e.code === 'issue_not_found' && e.retryable === false)
  await assert.rejects(a.jira.addComment('DEMO-99', 'x'), (e: any) => e.code === 'issue_not_found')
  await assert.rejects(a.jira.transition('DEMO-99', 'x'), (e: any) => e.code === 'issue_not_found')
})

test('concurrent writes to the fake files lose no entry', async () => {
  const { config, adapters: a, binding: b } = await setup()
  const created = await Promise.all(Array.from({ length: 25 }, (_, i) => a.jira.createIssue(b, { title: `t${i}` })))
  assert.equal(new Set(created.map((c) => c.key)).size, 25)
  await Promise.all(Array.from({ length: 25 }, (_, i) => a.jira.addComment('DEMO-1', `c${i}`)))
  assert.equal((await a.jira.getIssue('DEMO-1')).comments.length, 25)
  const issues = await json(join(config.dataDir, 'fake/jira/issues.json'))
  assert.equal(Object.keys(issues).length, 25)
  const origin = { channel: 'C1', threadTs: '1.1' }
  await Promise.all(Array.from({ length: 40 }, (_, i) => a.slack.reply(origin, 'ack', `r${i}`)))
  const lines: any[] = (await readFile(join(config.dataDir, 'fake/slack/replies.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse as any)
  assert.equal(lines.length, 40)
  assert.equal(new Set(lines.map((l) => l.id)).size, 40)
  assert.deepEqual((await readdir(join(config.dataDir, 'fake/jira'))).filter((f) => f.endsWith('.tmp')), [])
})

test('make-test-repo: the sample repository fails its test because of the bug', async () => {
  const dir = await mkdtemp(join(tmp, 'mk-'))
  const made = await createTestRepo({ dir })
  assert.ok(existsSync(join(made.localRepo, 'test.sh')))
  const failing = await new Promise<any>((resolve) => execFile('sh', ['test.sh'], { cwd: made.localRepo, env: { PATH: process.env.PATH } }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })))
  assert.equal(failing.code, 1)
  assert.match(failing.stdout, /FAIL applyDiscount\(100, 10\): expected 90, got 110/)
  assert.equal((await git(['rev-parse', 'master'], made.remote)).trim(), made.commit)
  // The script prints the two paths for a binding.
  const printed = await new Promise<any>((resolve, reject) => execFile(process.execPath, [join(root, 'scripts/make-test-repo.ts'), join(dir, 'viaScript')], (e, out) => (e ? reject(e) : resolve(out))))
  assert.match(printed, /"localRepo": ".*viaScript\/project"/)
  assert.match(printed, /"remote": ".*viaScript\/project\.git"/)
})

test('repo: prepare, diff with a new file, readFile, log, openDraftMR twice, cleanup keeps the branch', async () => {
  const { config, adapters: a, binding: b, made } = await setup()
  const prepared = await a.repo.prepare(b, 'DEMO-7', 12)
  assert.equal(prepared.dir, join(config.worktreesDir, 'T-12'))
  assert.equal(prepared.branch, 'ai/DEMO-7')
  assert.equal(prepared.base, made.commit)
  assert.equal((await git(['rev-parse', '--abbrev-ref', 'HEAD'], prepared.dir)).trim(), 'ai/DEMO-7')
  // Called again: the same directory.
  assert.deepEqual(await a.repo.prepare(b, 'DEMO-7', 12), prepared)

  // Nothing changed yet.
  const none = await a.repo.diff(prepared.dir, prepared.base)
  assert.deepEqual([none.files, none.totalFiles, none.totalLines, none.patch], [[], 0, 0, ''])

  // A modified file and a brand-new file (not registered with git) both count.
  const price = join(prepared.dir, 'src/price.js')
  await writeFile(price, (await readFile(price, 'utf8')).replace('price + (price', 'price - (price'))
  await writeFile(join(prepared.dir, 'src/new-file.js'), 'export const one = 1\nexport const two = 2\n')
  const d = await a.repo.diff(prepared.dir, prepared.base)
  assert.deepEqual(d.files.map((f) => f.path).sort(), ['src/new-file.js', 'src/price.js'])
  assert.deepEqual(d.files.find((f) => f.path === 'src/new-file.js'), { path: 'src/new-file.js', added: 2, removed: 0 })
  assert.deepEqual(d.files.find((f) => f.path === 'src/price.js'), { path: 'src/price.js', added: 1, removed: 1 })
  assert.equal(d.totalFiles, 2)
  assert.equal(d.totalLines, 4)
  assert.match(d.patch, /\+export const two = 2/)
  assert.match(d.patch, /\+  return price - \(price/)

  // readFile: working tree and a ref.
  assert.match(await a.repo.readFile(prepared.dir, 'src/new-file.js'), /two = 2/)
  assert.match(await a.repo.readFile(prepared.dir, 'src/price.js', 'master'), /price \+ \(price/)
  assert.match(await a.repo.readFile(prepared.dir, 'src/price.js'), /price - \(price/)
  await assert.rejects(a.repo.readFile(prepared.dir, 'nope.js'), (e: any) => e.code === 'file_not_found')
  await assert.rejects(a.repo.readFile(prepared.dir, 'nope.js', 'master'), (e: any) => e.code === 'git_failed')

  // log
  const commits = await a.repo.log(prepared.dir, undefined, 5)
  assert.equal(commits.length, 1)
  assert.deepEqual(Object.keys(commits[0]), ['sha', 'author', 'date', 'subject'])
  assert.equal(commits[0].subject, 'Initial sample shop')
  assert.equal((await a.repo.log(prepared.dir, 'src/price.js')).length, 1)
  assert.equal((await a.repo.log(prepared.dir, 'src/greeting.js', 500)).length, 1)

  // openDraftMR
  const mrs = join(config.dataDir, 'fake/gitlab/mrs.json')
  const first = await a.repo.openDraftMR(b, prepared.dir, 'ai/DEMO-7', { title: 'Fix discount', description: 'Subtract it', jiraKey: 'DEMO-7' })
  assert.deepEqual(first, { url: 'fake://gitlab/group/project/mr/1' })
  const entries = await json(mrs)
  assert.deepEqual(Object.keys(entries), ['ai/DEMO-7'])
  assert.equal(entries['ai/DEMO-7'].title, 'Fix discount')
  assert.equal(entries['ai/DEMO-7'].draft, true)
  const pushed1 = (await git(['rev-parse', 'ai/DEMO-7'], made.remote)).trim()
  assert.equal((await git(['rev-list', '--count', 'master..ai/DEMO-7'], made.remote)).trim(), '1')
  const commit = await git(['log', '-1', '--format=%an|%ae|%cn|%ce|%s|%b', 'ai/DEMO-7'], made.remote)
  assert.match(commit, /^chat-to-fix\|chat-to-fix@example\.com\|chat-to-fix\|chat-to-fix@example\.com\|Fix discount\|Subtract it/)
  assert.match(await git(['show', 'ai/DEMO-7:src/new-file.js'], made.remote), /one = 1/)
  assert.deepEqual(await a.repo.getMR(b, 'ai/DEMO-7'), { state: 'opened', pipeline: 'none', url: first.url, draft: true, title: 'Fix discount' })
  await assert.rejects(a.repo.getMR(b, 'ai/NOPE-1'), (e: any) => e.code === 'mr_not_found')

  // second call with a further change: same url, still one entry, commit amended and pushed
  await writeFile(join(prepared.dir, 'src/more.js'), 'export default 3\n')
  const second = await a.repo.openDraftMR(b, prepared.dir, 'ai/DEMO-7', { title: 'Fix discount (v2)', description: 'More', jiraKey: 'DEMO-7' })
  assert.deepEqual(second, first)
  assert.equal(Object.keys(await json(mrs)).length, 1)
  assert.equal((await json(mrs))['ai/DEMO-7'].title, 'Fix discount (v2)')
  const pushed2 = (await git(['rev-parse', 'ai/DEMO-7'], made.remote)).trim()
  assert.notEqual(pushed2, pushed1)
  assert.equal((await git(['rev-list', '--count', 'master..ai/DEMO-7'], made.remote)).trim(), '1')
  assert.match(await git(['show', 'ai/DEMO-7:src/more.js'], made.remote), /default 3/)
  // third call without changes: same url, nothing breaks
  assert.deepEqual(await a.repo.openDraftMR(b, prepared.dir, 'ai/DEMO-7', { title: 'Fix discount (v2)', jiraKey: 'DEMO-7' }), first)
  assert.equal((await git(['rev-parse', 'ai/DEMO-7'], made.remote)).trim(), pushed2)
  // a commit made by someone else in between: an additional commit is pushed, not an amend of theirs
  await writeFile(join(prepared.dir, 'x.txt'), 'x')
  await git(['add', '-A'], prepared.dir)
  await git(['commit', '-q', '-m', 'manual'], prepared.dir)
  await writeFile(join(prepared.dir, 'y.txt'), 'y')
  await a.repo.openDraftMR(b, prepared.dir, 'ai/DEMO-7', { title: 'again', jiraKey: 'DEMO-7' })
  assert.equal((await git(['rev-list', '--count', 'master..ai/DEMO-7'], made.remote)).trim(), '3')
  // wrong branch
  await assert.rejects(a.repo.openDraftMR(b, prepared.dir, 'ai/OTHER-1', { title: 't' }), (e: any) => e.code === 'wrong_branch')

  // cleanup removes the directory and keeps the branch (locally and on the remote)
  await a.repo.cleanup(prepared.dir)
  assert.equal(existsSync(prepared.dir), false)
  assert.match(await git(['branch', '--list', 'ai/DEMO-7'], made.localRepo), /ai\/DEMO-7/)
  assert.ok((await git(['rev-parse', 'ai/DEMO-7'], made.remote)).trim())
  assert.equal(existsSync(join(made.localRepo, '.git/worktrees/T-12')), false)
  await a.repo.cleanup(prepared.dir) // already gone: nothing happens

  // preparing again continues on the kept branch
  const again = await a.repo.prepare(b, 'DEMO-7', 12)
  assert.equal(again.branch, 'ai/DEMO-7')
  assert.ok(existsSync(join(again.dir, 'src/more.js')))
  assert.equal(again.base, made.commit)
})

test('repo.prepare starts from the latest commit of the default branch on the remote', async () => {
  const { adapters: a, binding: b, made, dir } = await setup()
  // Someone else pushes a commit to the remote default branch.
  const other = join(dir, 'other')
  await git(['clone', '-q', made.remote, other])
  await writeFile(join(other, 'later.txt'), 'later')
  await git(['add', '-A'], other)
  await git(['commit', '-q', '-m', 'later'], other)
  await git(['push', '-q', 'origin', 'master'], other)
  const latest = (await git(['rev-parse', 'HEAD'], other)).trim()
  const prepared = await a.repo.prepare(b, 'DEMO-8', 'T-13')
  assert.equal(prepared.base, latest)
  assert.ok(existsSync(join(prepared.dir, 'later.txt')))
})

test('repo: a binding copied into the task (without localRepo) is completed from the configuration', async () => {
  const { adapters: a, binding: b } = await setup()
  const { localRepo, remote, ...stored } = b
  const prepared = await a.repo.prepare(stored, 'DEMO-9', 14)
  await writeFile(join(prepared.dir, 'f.txt'), 'f')
  assert.match((await a.repo.openDraftMR(stored, prepared.dir, prepared.branch, { title: 't' })).url, /^fake:\/\/gitlab\/group\/project\/mr\/1$/)
})

test('repo.readFile refuses paths that escape the repository', async () => {
  const { adapters: a, binding: b, dir } = await setup()
  const p = await a.repo.prepare(b, 'DEMO-10', 15)
  const secret = join(dir, 'secret.txt')
  await writeFile(secret, 'TOP SECRET')
  await symlink(secret, join(p.dir, 'link-to-file'))
  await symlink(dir, join(p.dir, 'link-to-dir'))
  await symlink('../../secret.txt', join(p.dir, 'rel-link'))
  const refused = async (path, ref, code) => assert.rejects(a.repo.readFile(p.dir, path, ref), (e: any) => e.code === code && e.retryable === false && !String(e.message).includes('TOP SECRET'), `${path} ${ref ?? ''}`)
  await refused(secret, undefined, 'path_escape') // absolute
  await refused('/etc/passwd', undefined, 'path_escape')
  await refused('../secret.txt', undefined, 'path_escape')
  await refused('src/../../secret.txt', undefined, 'path_escape')
  await refused('..\\secret.txt', undefined, 'path_escape')
  await refused('link-to-file', undefined, 'path_escape')
  await refused('rel-link', undefined, 'path_escape')
  await refused('link-to-dir/secret.txt', undefined, 'path_escape')
  await refused('.git/config', undefined, 'path_escape')
  await refused('.git', undefined, 'path_escape')
  await refused('', undefined, 'bad_path')
  await refused('a\0b', undefined, 'bad_path')
  await refused('../secret.txt', 'master', 'path_escape')
  await refused('/etc/passwd', 'master', 'path_escape')
  await refused('README.md', '--output=x', 'bad_ref')
  await refused('README.md', 'master:foo', 'bad_ref')
  // A symlink committed to a ref is shown as its target text, never followed.
  await git(['add', '-A'], p.dir)
  await git(['commit', '-q', '-m', 'links'], p.dir)
  assert.equal(await a.repo.readFile(p.dir, 'link-to-file', 'HEAD'), secret)
  // log with an escaping path
  await assert.rejects(a.repo.log(p.dir, '../secret.txt'), (e: any) => e.code === 'path_escape')
  // a directory outside the worktrees folder is refused by every function
  for (const call of [() => a.repo.readFile(dir, 'secret.txt'), () => a.repo.diff(dir, 'master'), () => a.repo.log(dir), () => a.repo.cleanup(dir), () => a.repo.readFile(join(p.dir, '..'), 'x')]) {
    await assert.rejects(call(), (e: any) => e.code === 'bad_dir')
  }
  await assert.rejects(a.repo.diff(p.dir, '--output=/tmp/x'), (e: any) => e.code === 'bad_ref')
  assert.ok(existsSync(secret))
})

test('git runs with a minimal environment: global config and hooks do not leak in', async () => {
  const { adapters: a, binding: b, made, dir } = await setup()
  // A hook in the repository would run on commit if hooks were not switched off.
  await mkdir(join(made.localRepo, '.git/hooks'), { recursive: true })
  const marker = join(dir, 'hook-ran')
  await writeFile(join(made.localRepo, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 })
  const p = await a.repo.prepare(b, 'DEMO-11', 16)
  await writeFile(join(p.dir, 'z.txt'), 'z')
  await a.repo.openDraftMR(b, p.dir, p.branch, { title: 'no hooks' })
  assert.equal(existsSync(marker), false)
  // The author is the configured one even when HOME has a global config with another identity.
  const home = await mkdtemp(join(tmp, 'home-'))
  await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Somebody Else\n\temail = else@example.com\n')
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    await writeFile(join(p.dir, 'w.txt'), 'w')
    await a.repo.openDraftMR(b, p.dir, p.branch, { title: 'identity' })
  } finally { process.env.HOME = previous }
  assert.match(await git(['log', '-1', '--format=%an %ae %cn', p.branch], made.remote), /^chat-to-fix chat-to-fix@example\.com chat-to-fix/)
})

test('repo.openDraftMR refuses an empty branch', async () => {
  const { adapters: a, binding: b } = await setup()
  const p = await a.repo.prepare(b, 'DEMO-12', 17)
  await assert.rejects(a.repo.openDraftMR(b, p.dir, p.branch, { title: 't' }), (e: any) => e.code === 'nothing_to_commit')
  await assert.rejects(a.repo.openDraftMR(b, p.dir, p.branch, {}), (e: any) => e.code === 'bad_title')
})

test('repo.prepare reports bad arguments with an error code', async () => {
  const { adapters: a, binding: b } = await setup()
  await assert.rejects(a.repo.prepare(b, 'not a key', 1), (e: any) => e.code === 'bad_key')
  await assert.rejects(a.repo.prepare(b, 'DEMO-1', 'x; rm -rf /'), (e: any) => e.code === 'bad_task_no')
  await assert.rejects(a.repo.prepare({ ...b, localRepo: '/nonexistent/repo' }, 'DEMO-1', 1), (e: any) => e.code === 'bad_binding')
  await assert.rejects(a.repo.prepare({ ...b, remote: '/nonexistent/remote.git' }, 'DEMO-1', 1), (e: any) => e.code === 'git_failed' && e.retryable === true)
})

// --- fake-event script, against a real listener ---------------------------------------------------

async function listener() {
  const tasks = new Map(), events = new Map(), threads = new Map()
  const store = {
    knownEvent: (id) => events.get(id),
    async createTask(origin, b) { const t = { id: `T-${tasks.size + 1}`, state: 'queued', origin, binding: b }; tasks.set(t.id, t); events.set(origin.eventId, t.id); threads.set(`${origin.channel}/${origin.threadTs}`, t.id); return t },
    async getTask(id) { return tasks.get(id) },
    async findByThread(c, t) { return tasks.get(threads.get(`${c}/${t}`)) },
    async patchTask() {}, async listTasks() { return [] }, async readRecords() { return [] },
  }
  const queue = { enqueue: async () => ({ position: 1 }), full: async () => false }
  const config = { httpPort: 0, bindings: [{ channel: 'C1', repo: 'g/p', jiraProject: 'DEMO' }], limits: {} }
  const http = createHttp({ config, token: 'tok', store, queue, runner: {}, notify: async () => {} })
  await http.listen()
  return { http, tasks, url: `http://127.0.0.1:${http.port}` }
}

test('fake-event: writes the discussion file and posts the event (function and command line)', async () => {
  const { config, adapters: a } = await setup()
  const l = await listener()
  try {
    const sent = await (sendFakeEvent as any)({ channel: 'C1', text: 'The button does nothing', dataDir: config.dataDir, url: l.url, token: 'tok' })
    assert.equal(sent.status, 202)
    assert.equal(sent.body.state, 'queued')
    assert.equal(l.tasks.get(sent.body.taskId).origin.text, 'The button does nothing')
    assert.equal(sent.threadTs, sent.messageTs)
    const thread = await a.slack.readThread({ channel: 'C1', threadTs: sent.threadTs })
    assert.equal(thread.length, 1)
    assert.equal(thread[0].text, 'The button does nothing')

    // Continue the discussion: same thread, a second message, the task of the thread is found again.
    const more = await (sendFakeEvent as any)({ channel: 'C1', text: 'It is the login page', threadTs: sent.threadTs, dataDir: config.dataDir, url: l.url, token: 'tok' })
    assert.equal(more.threadTs, sent.threadTs)
    assert.notEqual(more.messageTs, sent.messageTs)
    assert.equal(more.body.inProgress, true)
    assert.equal((await a.slack.readThread({ channel: 'C1', threadTs: sent.threadTs })).map((m) => m.text).join('|'), 'The button does nothing|It is the login page')

    // Wrong token and unbound channel are reported, not hidden.
    assert.equal((await (sendFakeEvent as any)({ channel: 'C1', text: 'x', dataDir: config.dataDir, url: l.url, token: 'bad' })).status, 401)
    assert.equal((await (sendFakeEvent as any)({ channel: 'C9', text: 'x', dataDir: config.dataDir, url: l.url, token: 'tok' })).status, 422)
    await assert.rejects((sendFakeEvent as any)({ channel: 'C1', dataDir: config.dataDir, url: l.url, token: 'tok' }), /missing: text/)

    // The command line, with URL and token from the environment.
    const out = await new Promise<any>((resolve, reject) => execFile(process.execPath, [join(root, 'scripts/fake-event.ts'), '--channel', 'C1', '--text', 'From the command line', '--data-dir', config.dataDir], { env: { PATH: process.env.PATH, CHAT_TO_FIX_URL: l.url, CHAT_TO_FIX_HTTP_TOKEN: 'tok' } }, (e, stdout) => (e ? reject(e) : resolve(stdout))))
    const printed = JSON.parse(out)
    assert.equal(printed.status, 202)
    assert.equal(printed.response.state, 'queued')
    assert.equal((await a.slack.readThread({ channel: 'C1', threadTs: printed.threadTs }))[0].text, 'From the command line')
  } finally { await l.http.close() }
})
