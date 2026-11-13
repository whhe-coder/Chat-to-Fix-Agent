// The CI half of the repository adapter (spec 7, 4.5 and section 5 "adapters"):
//  - the real GitLab implementation (core/adapters/gitlab-http.ts) against a local node:http stub,
//  - pushFix / push_rejected on real git,
//  - the simulated CI of the fake GitLab (core/adapters/fake/ci.ts).
// No real GitLab host is used.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepoAdapter } from '../core/adapters/repo.ts'
import { cleanJobLog, createRealGitlab } from '../core/adapters/gitlab-http.ts'
import { runGit } from '../core/adapters/git.ts'
import { createTestRepo } from '../scripts/make-test-repo.ts'

const TOKEN = 'glpat-SECRET-TOKEN-0123456789'
const binding = { channel: 'C1', repo: 'group/sub/project', defaultBranch: 'main', jiraProject: 'DEMO' }
let tmp

before(async () => { tmp = await mkdtemp(join(tmpdir(), 'chat-to-fix-ci-')) })
after(async () => { await rm(tmp, { recursive: true, force: true }) })

/** A stub GitLab: `script(request)` answers each request; every request is recorded. */
async function stub(script) {
  const requests: any[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const url = new URL(req.url!, 'http://x')
      const request = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers }
      requests.push(request)
      const answer = (await script(request, requests.length)) ?? { status: 500, body: { message: 'no script' } }
      res.writeHead(answer.status, { 'content-type': answer.raw === undefined ? 'application/json' : 'text/plain', ...(answer.headers ?? {}) })
      res.end(answer.raw ?? JSON.stringify(answer.body ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
  return { baseUrl, requests, close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) } }
}
const real = (baseUrl, config: any = {}) => createRealGitlab({ gitlab: { baseUrl }, ...config }, { env: { CHAT_TO_FIX_GITLAB_TOKEN: TOKEN }, warn() {}, backoffMs: 1 } as any) as any

const P = '/api/v4/projects/group%2Fsub%2Fproject'
const MR_SHA = 'sha-current'
const mrBody = (over = {}) => ({ iid: 7, project_id: 11, sha: MR_SHA, head_pipeline: null, ...over })
const pipe = (id, over: any = {}) => ({ id, sha: MR_SHA, source: 'merge_request_event', status: 'success', project_id: 11, web_url: `http://gitlab.test/p/-/pipelines/${id}`, ...over })
const job = (id, name, status, over: any = {}) => ({ id, name, status, allow_failure: false, web_url: `http://gitlab.test/p/-/jobs/${id}`, ...over })

/** A routing stub: `routes` maps "METHOD /path-after-api/v4" (query ignored) to a body, status or function. */
async function routed(routes) {
  return stub((r) => {
    const key = `${r.method} ${r.path.replace('/api/v4', '')}`
    const route = routes[key]
    if (route === undefined) return { status: 404, body: { message: `404 Not found: ${key}` } }
    const value = typeof route === 'function' ? route(r) : route
    return value?.http !== undefined ? { status: value.http, headers: value.headers, body: value.body, raw: value.raw } : { status: 200, body: value }
  })
}

// ---------- real GitLab: getChecks ----------

test('getChecks: the pipeline of the MR current sha counts; an old head_pipeline of an earlier commit does not', async () => {
  const s = await routed({
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7`]: mrBody({ head_pipeline: pipe(5, { sha: 'sha-OLD', status: 'failed' }) }),
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7/pipelines`]: [pipe(5, { sha: 'sha-OLD', status: 'failed' })],
  })
  try {
    // the new commit has no pipeline yet: pending, nothing else is read
    assert.deepEqual(await real(s.baseUrl).getChecks(binding, 7), { status: 'pending', sha: MR_SHA, pipelineUrl: null, failedJobs: [] })
    assert.ok(s.requests.every((r) => r.method === 'GET'))
    assert.equal(s.requests[0].headers['private-token'], TOKEN)
    assert.equal(s.requests.some((r) => r.path.endsWith('/pipelines/5')), false)
  } finally { await s.close() }
})

test('getChecks: a Smartcat push pipeline cannot pass MR CI before its unit-test pipeline appears', async () => {
  const push = pipe(94, { source: 'push', status: 'skipped' })
  const mrPipeline = pipe(96, { status: 'running' })
  const routes: any = {
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7`]: mrBody({ head_pipeline: push }),
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7/pipelines`]: [push],
    [`GET /projects/group%2Fsub%2Fproject/pipelines/94`]: push,
    [`GET /projects/11/pipelines/94/trigger_jobs`]: [],
    [`GET /projects/11/pipelines/94/jobs`]: [job(1, 'sync all translations to smartcat', 'manual', { allow_failure: true })],
    [`GET /projects/group%2Fsub%2Fproject/pipelines/96`]: mrPipeline,
    [`GET /projects/11/pipelines/96/trigger_jobs`]: [],
    [`GET /projects/11/pipelines/96/jobs`]: [job(2, 'unit-test', 'running')],
  }
  const s = await routed(routes)
  try {
    assert.deepEqual(await real(s.baseUrl).getChecks(binding, 7), { status: 'pending', sha: MR_SHA, pipelineUrl: null, failedJobs: [] })
    assert.equal(s.requests.some((r) => r.path.endsWith('/pipelines/94')), false)

    routes[`GET /projects/group%2Fsub%2Fproject/merge_requests/7/pipelines`] = [mrPipeline, push]
    routes[`GET /projects/group%2Fsub%2Fproject/pipelines/96`] = pipe(96, { source: 'push' })
    assert.deepEqual(await real(s.baseUrl).getChecks(binding, 7), { status: 'pending', sha: MR_SHA, pipelineUrl: null, failedJobs: [] })
    routes[`GET /projects/group%2Fsub%2Fproject/pipelines/96`] = mrPipeline
    assert.deepEqual(await real(s.baseUrl).getChecks(binding, 7), { status: 'pending', sha: MR_SHA, pipelineUrl: mrPipeline.web_url, failedJobs: [] })
    routes[`GET /projects/group%2Fsub%2Fproject/pipelines/96`] = pipe(96)
    routes[`GET /projects/11/pipelines/96/jobs`] = [job(2, 'unit-test', 'success')]
    assert.deepEqual(await real(s.baseUrl).getChecks(binding, 7), { status: 'passed', sha: MR_SHA, pipelineUrl: mrPipeline.web_url, failedJobs: [] })
  } finally { await s.close() }
})

test('getChecks: several pipelines for the sha -> the highest id, and its url is recorded; passed when nothing counts', async () => {
  const s = await routed({
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7`]: mrBody({ head_pipeline: pipe(8) }),
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7/pipelines`]: [pipe(8), pipe(12, { source: 'merge_request_event' }), pipe(20, { source: 'push' }), pipe(30, { sha: 'sha-OLD' })],
    [`GET /projects/group%2Fsub%2Fproject/pipelines/12`]: pipe(12),
    [`GET /projects/11/pipelines/12/trigger_jobs`]: [],
    [`GET /projects/11/pipelines/12/jobs`]: [job(1, 'build', 'success'), job(2, 'lint', 'failed', { allow_failure: true }), job(3, 'docs', 'skipped')],
  })
  try {
    const out = await real(s.baseUrl).getChecks(binding, '7')
    assert.deepEqual(out, { status: 'passed', sha: MR_SHA, pipelineUrl: 'http://gitlab.test/p/-/pipelines/12', failedJobs: [] })
  } finally { await s.close() }
})

test('getChecks: a failed job counts, allow_failure does not, a cancelled job counts; running means pending', async () => {
  const routes: any = {
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7`]: mrBody(),
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7/pipelines`]: [pipe(12)],
    [`GET /projects/group%2Fsub%2Fproject/pipelines/12`]: pipe(12, { status: 'failed' }),
    [`GET /projects/11/pipelines/12/trigger_jobs`]: [],
    [`GET /projects/11/pipelines/12/jobs`]: [job(1, 'unit', 'failed'), job(2, 'lint', 'failed', { allow_failure: true }), job(3, 'e2e', 'canceled'), job(4, 'ok', 'success')],
  }
  const s = await routed(routes)
  try {
    const out = await real(s.baseUrl).getChecks(binding, 7)
    assert.equal(out.status, 'failed')
    assert.deepEqual(out.failedJobs, [
      { id: 1, name: 'unit', url: 'http://gitlab.test/p/-/jobs/1', pipelineId: 12, projectId: 11 },
      { id: 3, name: 'e2e', url: 'http://gitlab.test/p/-/jobs/3', pipelineId: 12, projectId: 11 },
    ])
    // a running pipeline is pending even if a job already failed
    routes[`GET /projects/group%2Fsub%2Fproject/pipelines/12`] = pipe(12, { status: 'running' })
    assert.deepEqual(await real(s.baseUrl).getChecks(binding, 7), { status: 'pending', sha: MR_SHA, pipelineUrl: 'http://gitlab.test/p/-/pipelines/12', failedJobs: [] })
  } finally { await s.close() }
})

test('getChecks: allow_failure work (jobs, trigger jobs, their downstream pipelines) is not waited for and never fails the round', async () => {
  const routes: any = {
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7`]: mrBody(),
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7/pipelines`]: [pipe(12)],
    [`GET /projects/group%2Fsub%2Fproject/pipelines/12`]: pipe(12, { status: 'running' }),
    [`GET /projects/11/pipelines/12/trigger_jobs`]: [{ id: 50, name: 'e2e-remote-persona-pipeline', status: 'pending', allow_failure: true, web_url: 'http://gitlab.test/p/-/jobs/50', downstream_pipeline: { id: 99, project_id: 77, sha: 'down-sha', status: 'pending' } }],
    [`GET /projects/11/pipelines/12/jobs`]: [job(1, 'commitlint', 'failed'), job(2, 'build', 'success'), job(3, 'soft', 'running', { allow_failure: true })],
  }
  const s = await routed(routes)
  try {
    // a counting job failed, an allow_failure downstream and job are still going: failed now
    const failed = await real(s.baseUrl).getChecks(binding, 7)
    assert.equal(failed.status, 'failed')
    assert.deepEqual(failed.failedJobs.map((j) => j.name), ['commitlint'])
    assert.equal(s.requests.some((r) => r.path.includes('/projects/77/')), false, 'the allow_failure downstream is not even read')

    // all counting jobs passed, allow_failure work still going: passed now
    routes[`GET /projects/11/pipelines/12/jobs`] = [job(1, 'commitlint', 'success'), job(2, 'build', 'success'), job(3, 'soft', 'running', { allow_failure: true })]
    assert.equal((await real(s.baseUrl).getChecks(binding, 7)).status, 'passed')

    // an allow_failure job that failed does not fail the round
    routes[`GET /projects/11/pipelines/12/jobs`] = [job(1, 'commitlint', 'success'), job(3, 'soft', 'failed', { allow_failure: true })]
    routes[`GET /projects/11/pipelines/12/trigger_jobs`] = [{ id: 50, name: 'persona', status: 'failed', allow_failure: true, downstream_pipeline: { id: 99, project_id: 77, sha: 'down-sha', status: 'failed' } }]
    routes[`GET /projects/group%2Fsub%2Fproject/pipelines/12`] = pipe(12, { status: 'success' })
    assert.equal((await real(s.baseUrl).getChecks(binding, 7)).status, 'passed')

    // a counting job (or trigger job) still going keeps the round pending, also next to a failed one
    routes[`GET /projects/group%2Fsub%2Fproject/pipelines/12`] = pipe(12, { status: 'running' })
    routes[`GET /projects/11/pipelines/12/trigger_jobs`] = []
    routes[`GET /projects/11/pipelines/12/jobs`] = [job(1, 'commitlint', 'failed'), job(2, 'unit', 'running')]
    assert.equal((await real(s.baseUrl).getChecks(binding, 7)).status, 'pending')
    // after the retry: the re-run counting job is waited for, the allow_failure one is not
    routes[`GET /projects/11/pipelines/12/jobs`] = [job(5, 'commitlint', 'running'), job(3, 'soft', 'running', { allow_failure: true })]
    assert.equal((await real(s.baseUrl).getChecks(binding, 7)).status, 'pending')
    // an active pipeline without any job yet: pending
    routes[`GET /projects/11/pipelines/12/jobs`] = []
    assert.equal((await real(s.baseUrl).getChecks(binding, 7)).status, 'pending')
  } finally { await s.close() }
})

test('getChecks: a downstream pipeline is read with its OWN project id; its failures count; an unreadable one counts as failed', async () => {
  const routes: any = {
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7`]: mrBody(),
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7/pipelines`]: [pipe(12)],
    [`GET /projects/group%2Fsub%2Fproject/pipelines/12`]: pipe(12),
    [`GET /projects/11/pipelines/12/trigger_jobs`]: [{ id: 50, name: 'deploy-check', status: 'failed', web_url: 'http://gitlab.test/p/-/jobs/50', downstream_pipeline: { id: 99, project_id: 77, sha: 'down-sha', status: 'failed', web_url: 'http://gitlab.test/other/-/pipelines/99' } }],
    [`GET /projects/11/pipelines/12/jobs`]: [job(1, 'build', 'success')],
    [`GET /projects/77/pipelines/99`]: pipe(99, { sha: 'down-sha', project_id: 77, status: 'failed' }),
    [`GET /projects/77/pipelines/99/trigger_jobs`]: [],
    [`GET /projects/77/pipelines/99/jobs`]: [job(300, 'integration', 'failed', { web_url: 'http://gitlab.test/other/-/jobs/300' }), job(301, 'flaky-lint', 'failed', { allow_failure: true })],
  }
  const s = await routed(routes)
  try {
    const out = await real(s.baseUrl).getChecks(binding, 7)
    assert.equal(out.status, 'failed')
    // only the downstream job counts: the trigger job itself is not added twice; the job keeps the downstream project id
    assert.deepEqual(out.failedJobs, [{ id: 300, name: 'integration', url: 'http://gitlab.test/other/-/jobs/300', pipelineId: 99, projectId: 77 }])
    assert.ok(s.requests.some((r) => r.path === '/api/v4/projects/77/pipelines/99/jobs'), 'read with project 77, not the parent project')
    assert.equal(s.requests.some((r) => r.path.includes('/projects/11/pipelines/99')), false)

    // downstream passes: passed (the failed trigger job is represented by its pipeline)
    routes[`GET /projects/77/pipelines/99`] = pipe(99, { sha: 'down-sha', project_id: 77, status: 'success' })
    routes[`GET /projects/77/pipelines/99/jobs`] = [job(300, 'integration', 'success')]
    assert.equal((await real(s.baseUrl).getChecks(binding, 7)).status, 'passed')

    // downstream still running: pending
    routes[`GET /projects/77/pipelines/99`] = pipe(99, { sha: 'down-sha', project_id: 77, status: 'running' })
    assert.equal((await real(s.baseUrl).getChecks(binding, 7)).status, 'pending')

    // trigger job and pipeline disagree on the commit (the downstream is being replaced): pending
    routes[`GET /projects/77/pipelines/99`] = pipe(99, { sha: 'another-sha', project_id: 77, status: 'success' })
    assert.equal((await real(s.baseUrl).getChecks(binding, 7)).status, 'pending')

    // unreadable downstream (403): failed, the job says so
    routes[`GET /projects/77/pipelines/99`] = { http: 403, body: { message: '403 Forbidden' } }
    const blocked = await real(s.baseUrl).getChecks(binding, 7)
    assert.equal(blocked.status, 'failed')
    assert.equal(blocked.failedJobs.length, 1)
    assert.match(blocked.failedJobs[0].name, /deploy-check.*downstream pipeline 99 of project 77 cannot be read.*access denied/)
    assert.deepEqual([blocked.failedJobs[0].id, blocked.failedJobs[0].pipelineId, blocked.failedJobs[0].projectId], [50, 12, 11])
  } finally { await s.close() }
})

test('getChecks: a trigger job without a downstream pipeline that failed counts as a failed job; a broken pipeline without jobs counts too', async () => {
  const routes: any = {
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7`]: mrBody(),
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7/pipelines`]: [pipe(12)],
    [`GET /projects/group%2Fsub%2Fproject/pipelines/12`]: pipe(12, { status: 'failed' }),
    [`GET /projects/11/pipelines/12/trigger_jobs`]: [{ id: 60, name: 'child', status: 'failed', downstream_pipeline: null }],
    [`GET /projects/11/pipelines/12/jobs`]: [],
  }
  const s = await routed(routes)
  try {
    const out = await real(s.baseUrl).getChecks(binding, 7)
    assert.deepEqual(out.failedJobs.map((j) => j.id), [60])
    routes[`GET /projects/11/pipelines/12/trigger_jobs`] = []
    const broken = await real(s.baseUrl).getChecks(binding, 7)
    assert.equal(broken.status, 'failed')
    assert.equal(broken.failedJobs[0].id, 'pipeline:12')
    // the placeholder is not a job: its log cannot be asked
    await assert.rejects(real(s.baseUrl).getJobLog(binding, broken.failedJobs[0]), (e: any) => e.code === 'bad_job')
  } finally { await s.close() }
})

test('getChecks: lists are followed over pages; a bad iid and GitLab errors are reported with codes', async () => {
  const routes: any = {
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7`]: mrBody(),
    [`GET /projects/group%2Fsub%2Fproject/merge_requests/7/pipelines`]: [pipe(12)],
    [`GET /projects/group%2Fsub%2Fproject/pipelines/12`]: pipe(12, { status: 'failed' }),
    [`GET /projects/11/pipelines/12/trigger_jobs`]: [],
    [`GET /projects/11/pipelines/12/jobs`]: (r) => (r.query.page === '1' ? { http: 200, headers: { 'x-next-page': '2' }, body: [job(1, 'a', 'success')] } : [job(2, 'b', 'failed')]),
  }
  const s = await routed(routes)
  try {
    assert.deepEqual((await real(s.baseUrl).getChecks(binding, 7)).failedJobs.map((j) => j.name), ['b'])
    await assert.rejects(real(s.baseUrl).getChecks(binding, 'abc'), (e: any) => e.code === 'bad_iid')
    await assert.rejects(real(s.baseUrl).getChecks(binding, 99), (e: any) => e.code === 'gitlab_not_found' && !e.message.includes(TOKEN))
  } finally { await s.close() }
})

// ---------- real GitLab: getJobLog, retryJobs ----------

test('getJobLog: the tail, without ANSI codes and section markers, from the job own project', async () => {
  const raw = 'section_start:1700000000:prepare_script\r\x1b[0K\x1b[36;1mPreparing\x1b[0;m\r\nline 1\r\nprogress 10%\rprogress 100%\r\n\x1b[31;1mERROR: Job failed: exit code 1\x1b[0;m\r\nsection_end:1700000009:prepare_script\r\x1b[0K\n'
  const s = await routed({ [`GET /projects/77/jobs/300/trace`]: { http: 200, raw } })
  try {
    const g = real(s.baseUrl, { limits: { ciLogMaxChars: 40 } })
    const full = await g.getJobLog(binding, { id: 300, projectId: 77 }, { maxChars: 10000 })
    assert.equal(full, 'Preparing\nline 1\nprogress 10%\nprogress 100%\nERROR: Job failed: exit code 1\n\n')
    assert.equal(s.requests[0].path, '/api/v4/projects/77/jobs/300/trace')
    // the tail
    assert.equal(await g.getJobLog(binding, { id: 300, projectId: 77 }, { maxChars: 12 }), ': exit code 1\n\n'.slice(-12))
    assert.equal((await g.getJobLog(binding, { id: 300, projectId: 77 })).length, 40, 'default length: limits.ciLogMaxChars')
    // without a projectId the binding project path is used (encoded)
    await assert.rejects(g.getJobLog(binding, { id: 300 }), (e: any) => e.code === 'gitlab_not_found')
    assert.equal(s.requests.at(-1).path, `${P}/jobs/300/trace`)
    await assert.rejects(g.getJobLog(binding, { id: 'x1' }), (e: any) => e.code === 'bad_job')
  } finally { await s.close() }
  assert.equal(cleanJobLog('a\x1b[1mb\x1b[0m\x1b]0;title\x07c', 100), 'abc')
  assert.equal(cleanJobLog('0123456789', 4), '6789')
  assert.equal(cleanJobLog(undefined), '')
})

test('retryJobs: one POST per job to the job own project, sent once, never repeated, errors not retryable', async () => {
  let n = 0
  const s = await stub((r) => {
    if (r.path.endsWith('/jobs/301/retry')) return { status: 500, body: { message: 'boom' } }
    n++
    return { status: 201, body: { id: 1000 + n } }
  })
  try {
    const g = real(s.baseUrl)
    assert.deepEqual(await g.retryJobs(binding, [{ id: 300, projectId: 77 }, { id: 302, projectId: 11 }]), { retried: [300, 302] })
    assert.deepEqual(s.requests.map((r) => `${r.method} ${r.path}`), ['POST /api/v4/projects/77/jobs/300/retry', 'POST /api/v4/projects/11/jobs/302/retry'])
    assert.deepEqual(await g.retryJobs(binding, []), { retried: [] })
    // a failing write: sent exactly once (a GET would have been tried again), not retryable, earlier retries are named
    s.requests.length = 0
    await assert.rejects(g.retryJobs(binding, [{ id: 300, projectId: 77 }, { id: 301, projectId: 77 }, { id: 303, projectId: 77 }]), (e: any) => e.code === 'gitlab_unavailable' && e.retryable === false && /already re-run.*300/.test(e.message))
    assert.deepEqual(s.requests.map((r) => r.path), ['/api/v4/projects/77/jobs/300/retry', '/api/v4/projects/77/jobs/301/retry'])
    await assert.rejects(g.retryJobs(binding, [{ id: 'pipeline:3' }]), (e: any) => e.code === 'bad_job')
  } finally { await s.close() }
})

// ---------- pushFix, openDraftMR and a remote that moved (real git, either GitLab half) ----------

async function gitSetup(extra: any = {}) {
  const dir = await mkdtemp(join(tmp, 'git-'))
  const made = await createTestRepo({ dir: join(dir, 'repo') })
  const b = { channel: 'C1', repo: 'group/project', localRepo: made.localRepo, remote: made.remote, defaultBranch: 'master', jiraProject: 'DEMO', ...extra }
  const config = {
    dataDir: join(dir, 'data'), worktreesDir: join(dir, 'worktrees'), adapters: { slack: 'fake', jira: 'fake', gitlab: 'fake' },
    bindings: [b], commitAuthor: { name: 'chat-to-fix', email: 'chat-to-fix@example.com' },
  }
  const repo = createRepoAdapter(config) as any
  return { repo, b, made, dir, config }
}
const git = (args, cwd?) => runGit(args, { cwd, author: { name: 'x', email: 'x@example.com' } }).then((r) => r.stdout)
const count = async (made, branch) => Number((await git(['rev-list', '--count', `master..${branch}`], made.remote)).trim())

test('pushFix appends exactly one commit and pushes normally; no change is nothing_to_commit', async () => {
  const { repo, b, made } = await gitSetup()
  const p = await repo.prepare(b, 'DEMO-1', 1)
  await writeFile(join(p.dir, 'a.txt'), 'a')
  const opened = await repo.openDraftMR(b, p.dir, p.branch, { title: 'Fix a', jiraKey: 'DEMO-1' })
  assert.equal(await count(made, p.branch), 1)
  // a fix round
  await writeFile(join(p.dir, 'b.txt'), 'b')
  const fix = await repo.pushFix(b, p.dir, p.branch, { message: 'fix(ci): make the unit test pass' })
  assert.deepEqual(Object.keys(fix), ['sha'])
  assert.equal((await git(['rev-parse', p.branch], made.remote)).trim(), fix.sha)
  assert.equal(await count(made, p.branch), 2)
  assert.equal((await git(['rev-parse', `${p.branch}~1`], made.remote)).trim(), opened.sha, 'the first commit is untouched (no amend)')
  assert.equal((await git(['log', '-1', '--format=%s|%b', p.branch], made.remote)).trim(), 'fix(ci): make the unit test pass|')
  // nothing changed: nothing_to_commit, and nothing was pushed
  await assert.rejects(repo.pushFix(b, p.dir, p.branch, { message: 'fix(ci): again' }), (e: any) => e.code === 'nothing_to_commit' && e.retryable === false)
  assert.equal(await count(made, p.branch), 2)
  // arguments
  await writeFile(join(p.dir, 'c.txt'), 'c')
  for (const bad of ['no type', 'fix: a\nb', undefined, '']) await assert.rejects(repo.pushFix(b, p.dir, p.branch, { message: bad }), (e: any) => e.code === 'bad_message', String(bad))
  await assert.rejects(repo.pushFix(b, p.dir, 'ai/OTHER-1', { message: 'fix: x' }), (e: any) => e.code === 'wrong_branch')
  assert.equal(await count(made, p.branch), 2)
})

test('pushFix: a clean tree with a commit the remote lacks pushes that commit (a network failure earlier), nothing else', async () => {
  const { repo, b, made } = await gitSetup()
  const p = await repo.prepare(b, 'DEMO-2', 2)
  await writeFile(join(p.dir, 'a.txt'), 'a')
  await repo.openDraftMR(b, p.dir, p.branch, { title: 'Fix a' })
  await writeFile(join(p.dir, 'b.txt'), 'b')
  await git(['add', '-A'], p.dir)
  await git(['commit', '-q', '-m', 'fix(ci): local only'], p.dir)
  const local = (await git(['rev-parse', 'HEAD'], p.dir)).trim()
  assert.equal(await count(made, p.branch), 1)
  assert.deepEqual(await repo.pushFix(b, p.dir, p.branch, { message: 'fix(ci): second try' }), { sha: local })
  assert.equal(await count(made, p.branch), 2)
})

test('pushFix and openDraftMR: the remote moved -> push_rejected; nothing is pulled, nothing is forced, their commit stays', async () => {
  const { repo, b, made, dir } = await gitSetup()
  const p = await repo.prepare(b, 'DEMO-3', 3)
  await writeFile(join(p.dir, 'a.txt'), 'a')
  await repo.openDraftMR(b, p.dir, p.branch, { title: 'Fix a' })
  // someone else pushes to the task branch
  const other = join(dir, 'other')
  await git(['clone', '-q', '--branch', p.branch, made.remote, other])
  await writeFile(join(other, 'theirs.txt'), 'theirs')
  await git(['add', '-A'], other)
  await git(['commit', '-q', '-m', 'their change'], other)
  await git(['push', '-q', 'origin', p.branch], other)
  const theirs = (await git(['rev-parse', 'HEAD'], other)).trim()

  await writeFile(join(p.dir, 'b.txt'), 'b')
  await assert.rejects(repo.pushFix(b, p.dir, p.branch, { message: 'fix(ci): mine' }), (e: any) => e.code === 'push_rejected' && e.retryable === false && !/force/i.test(e.message.replace(/forced/, '')))
  assert.equal((await git(['rev-parse', p.branch], made.remote)).trim(), theirs, 'their commit is still the head of the remote branch')
  // the local directory was not pulled either
  assert.equal(existsLocal(p.dir, 'theirs.txt'), false)

  // openDraftMR (step 5, a rerun) behaves the same
  await writeFile(join(p.dir, 'c.txt'), 'c')
  await assert.rejects(repo.openDraftMR(b, p.dir, p.branch, { title: 'Fix a again' }), (e: any) => e.code === 'push_rejected')
  assert.equal((await git(['rev-parse', p.branch], made.remote)).trim(), theirs)
})
const existsLocal = (dir, name) => existsSync(join(dir, name))

// ---------- the simulated CI ----------

/** A repository adapter on the fake GitLab with the given ciJobs; `fix()` makes the sample test pass. */
async function fakeSetup(extra: any = {}) {
  const s = await gitSetup(extra)
  const open = async (key = 'DEMO-1', no = 1) => {
    const p = await s.repo.prepare(s.b, key, no)
    await writeFile(join(p.dir, 'change.txt'), 'x')
    const opened = await s.repo.openDraftMR(s.b, p.dir, p.branch, { title: 'Fix', jiraKey: key })
    return { p, opened }
  }
  const settle = () => s.repo.ciIdle()
  return { ...s, open, settle }
}
const poll = async (fn, ok, ms = 3000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v) || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('fake CI: a push runs the ciJobs in a checkout of the pushed commit; the command output is the log; pass and fail', async () => {
  const { repo, b, open, settle, config } = await fakeSetup({
    ciJobs: [{ name: 'unit', command: 'sh test.sh' }, { name: 'sha', command: 'echo "at $CI_COMMIT_SHA on $CI_COMMIT_REF_NAME"; git rev-parse HEAD; test ! -e .git/chat-to-fix-marker' }],
  })
  const { p, opened } = await open()
  // before the jobs end the pipeline is pending (or already done on a fast machine): wait for it
  const checks = await poll(() => repo.getChecks(b, opened.iid), (c) => c.status !== 'pending')
  assert.equal(checks.status, 'failed', 'the sample repository has a bug: sh test.sh fails')
  assert.equal(checks.sha, opened.sha)
  assert.match(checks.pipelineUrl, /^fake:\/\/gitlab\/group\/project\/-\/pipelines\/\d+$/)
  assert.deepEqual(checks.failedJobs.map((j) => j.name), ['unit'])
  const failed = checks.failedJobs[0]
  assert.deepEqual(Object.keys(failed).sort(), ['id', 'name', 'pipelineId', 'projectId', 'url'])
  await settle()
  const log = await repo.getJobLog(b, failed)
  assert.match(log, /FAIL applyDiscount\(100, 10\): expected 90, got 110/)
  assert.match(log, /ERROR: Job failed: exit code 1/)
  assert.equal((await repo.getJobLog(b, failed, { maxChars: 20 })).length, 20)
  const shaJob = (await readJson(join(config.dataDir, 'fake/gitlab/pipelines.json'))).pipelines[0].jobs.find((j) => j.name === 'sha')
  assert.match(shaJob.log, new RegExp(`at ${opened.sha} on ai/DEMO-1\\n${opened.sha}\\n`), 'the job ran in a checkout of exactly the pushed commit')
  assert.equal(shaJob.status, 'success')

  // a fix round: a new commit, a new pipeline for the new head; the old pipeline no longer counts
  await writeFile(join(p.dir, 'src/price.js'), (await readFile(join(p.dir, 'src/price.js'), 'utf8')).replace('price + (price', 'price - (price'))
  const fix = await repo.pushFix(b, p.dir, p.branch, { message: 'fix(ci): subtract the discount' })
  const right = await repo.getChecks(b, opened.iid)
  assert.equal(right.sha, fix.sha)
  assert.notEqual(right.pipelineUrl, checks.pipelineUrl)
  assert.equal(right.status === 'pending' || right.status === 'passed', true, 'the failure of the old commit is not reported for the new one')
  assert.deepEqual(await poll(() => repo.getChecks(b, opened.iid), (c) => c.status !== 'pending'), { status: 'passed', sha: fix.sha, pipelineUrl: right.pipelineUrl, failedJobs: [] })
})
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

test('fake CI: delaySeconds keeps the pipeline pending; allowFailure does not count; a job over its timeout fails', async () => {
  const { repo, b, open } = await fakeSetup({
    ciJobs: [{ name: 'slow', command: 'echo done', delaySeconds: 0.6 }, { name: 'soft', command: 'exit 3', allowFailure: true }],
  })
  const { opened } = await open()
  const early = await repo.getChecks(b, opened.iid)
  assert.equal(early.status, 'pending')
  assert.deepEqual(early.failedJobs, [])
  const done = await poll(() => repo.getChecks(b, opened.iid), (c) => c.status !== 'pending', 5000)
  assert.equal(done.status, 'passed', 'the allow_failure job failed but does not count')
  assert.deepEqual(done.failedJobs, [])

  const t = await fakeSetup({ ciJobs: [{ name: 'hang', command: 'sleep 30', timeoutSeconds: 0.3 }] })
  const o = await t.open()
  const timed = await poll(() => t.repo.getChecks(t.b, o.opened.iid), (c) => c.status !== 'pending', 5000)
  assert.equal(timed.status, 'failed')
  assert.match(await t.repo.getJobLog(t.b, timed.failedJobs[0]), /timeout/)
})

test('fake CI: a flaky job fails the first time and passes after retryJobs (a new job id; the old one is replaced)', async () => {
  const { repo, b, open } = await fakeSetup({ ciJobs: [{ name: 'flaky-e2e', command: 'echo real run', flaky: true }, { name: 'steady', command: 'echo ok' }] })
  const { opened } = await open()
  const first = await poll(() => repo.getChecks(b, opened.iid), (c) => c.status !== 'pending')
  assert.equal(first.status, 'failed')
  assert.deepEqual(first.failedJobs.map((j) => j.name), ['flaky-e2e'])
  assert.match(await repo.getJobLog(b, first.failedJobs[0]), /Simulated flaky failure/)
  const retried = await repo.retryJobs(b, first.failedJobs)
  assert.deepEqual(retried, { retried: [first.failedJobs[0].id] })
  const again = await poll(() => repo.getChecks(b, opened.iid), (c) => c.status !== 'pending')
  assert.equal(again.status, 'passed')
  assert.equal(again.pipelineUrl, first.pipelineUrl, 'same pipeline, the job was re-run inside it')
  // a job that passed cannot be retried; an unknown one is not found
  await assert.rejects(repo.retryJobs(b, first.failedJobs), (e: any) => e.code === 'job_not_retryable' && e.retryable === false)
  await assert.rejects(repo.retryJobs(b, [{ id: 9999 }]), (e: any) => e.code === 'gitlab_not_found')
})

test('fake CI: an allow_failure job or downstream still running is not waited for; a failed counting job settles at once', async () => {
  const { repo, b, open } = await fakeSetup({
    ciJobs: [{ name: 'lint', command: 'exit 1' }, { name: 'e2e', command: 'echo ok', delaySeconds: 30, allowFailure: true, downstream: true }, { name: 'soft', command: 'echo ok', delaySeconds: 30, allowFailure: true }],
  })
  const { opened } = await open()
  const out = await poll(() => repo.getChecks(b, opened.iid), (c) => c.status !== 'pending', 5000)
  assert.equal(out.status, 'failed')
  assert.deepEqual(out.failedJobs.map((j) => j.name), ['lint'])
  const ok = await fakeSetup({ ciJobs: [{ name: 'unit', command: 'echo ok' }, { name: 'e2e', command: 'echo ok', delaySeconds: 30, allowFailure: true, downstream: true }] })
  const o = await ok.open()
  const passed = await poll(() => ok.repo.getChecks(ok.b, o.opened.iid), (c) => c.status !== 'pending', 5000)
  assert.equal(passed.status, 'passed')
})

test('fake CI: a deterministic failure stays failed after a retry', async () => {
  const { repo, b, open } = await fakeSetup({ ciJobs: [{ name: 'unit', command: 'sh test.sh' }] })
  const { opened } = await open()
  const first = await poll(() => repo.getChecks(b, opened.iid), (c) => c.status !== 'pending')
  await repo.retryJobs(b, first.failedJobs)
  const again = await poll(() => repo.getChecks(b, opened.iid), (c) => c.status !== 'pending')
  assert.equal(again.status, 'failed')
  assert.notEqual(again.failedJobs[0].id, first.failedJobs[0].id, 'the failure is the NEW job')
  assert.match(await repo.getJobLog(b, again.failedJobs[0]), /expected 90/)
})

test('fake CI: a downstream job lives in a downstream pipeline with its own project id; its failure counts', async () => {
  const { repo, b, open } = await fakeSetup({
    ciJobs: [{ name: 'build', command: 'echo build' }, { name: 'contract', command: 'echo broken; exit 1', downstream: true }, { name: 'contract-2', command: 'echo fine', downstream: true }, { name: 'other', command: 'echo other', downstream: 'second' }],
  })
  const { opened } = await open()
  const out = await poll(() => repo.getChecks(b, opened.iid), (c) => c.status !== 'pending')
  assert.equal(out.status, 'failed')
  assert.deepEqual(out.failedJobs.map((j) => j.name), ['contract'])
  const j = out.failedJobs[0]
  const main = out.pipelineUrl.match(/pipelines\/(\d+)$/)[1]
  assert.notEqual(String(j.pipelineId), main, 'the job belongs to the downstream pipeline')
  assert.notEqual(j.projectId, 1, 'the downstream pipeline has its own project id')
  assert.match(await repo.getJobLog(b, j), /broken/)
  // the retry goes to the downstream job too; it fails again (deterministic), still downstream
  await repo.retryJobs(b, out.failedJobs)
  const again = await poll(() => repo.getChecks(b, opened.iid), (c) => c.status !== 'pending')
  assert.equal(again.failedJobs[0].pipelineId, j.pipelineId)
})

test('fake CI: ciNone gives no pipeline; without ciJobs a pipeline with no job passes at once', async () => {
  const none = await fakeSetup({ ciNone: true, ciJobs: [{ name: 'unit', command: 'echo x' }] })
  const o = await none.open()
  assert.deepEqual(await none.repo.getChecks(none.b, o.opened.iid), { status: 'pending', sha: o.opened.sha, pipelineUrl: null, failedJobs: [] })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal((await none.repo.getChecks(none.b, o.opened.iid)).status, 'pending', 'still no pipeline')
  await assert.rejects(readFile(join(none.config.dataDir, 'fake/gitlab/pipelines.json'), 'utf8'), (e: any) => e.code === 'ENOENT')

  const bare = await fakeSetup()
  const q = await bare.open()
  const checks = await bare.repo.getChecks(bare.b, q.opened.iid)
  assert.deepEqual([checks.status, checks.sha, checks.failedJobs], ['passed', q.opened.sha, []])
  await assert.rejects(bare.repo.getChecks(bare.b, 999), (e: any) => e.code === 'mr_not_found')
})

test('fake CI: no second pipeline when the same commit is pushed again; a pipeline per new commit', async () => {
  const { repo, b, open, config } = await fakeSetup({ ciJobs: [{ name: 'unit', command: 'echo x' }] })
  const { p, opened } = await open()
  await repo.openDraftMR(b, p.dir, p.branch, { title: 'Fix' }) // nothing new to commit
  await writeFile(join(p.dir, 'more.txt'), 'm')
  await repo.pushFix(b, p.dir, p.branch, { message: 'fix(ci): more' })
  await repo.ciIdle()
  const db = await readJson(join(config.dataDir, 'fake/gitlab/pipelines.json'))
  assert.equal(db.pipelines.filter((x) => x.parentId === undefined).length, 2)
  assert.equal((await repo.getChecks(b, opened.iid)).status, 'passed')
})
