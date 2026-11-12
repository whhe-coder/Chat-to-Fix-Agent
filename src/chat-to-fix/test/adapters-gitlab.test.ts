// The real GitLab merge-request half (core/adapters/gitlab-http.ts) against a local node:http stub, and
// git authentication for https remotes (core/adapters/git.ts gitAuthEnv). No real GitLab host is used.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepoAdapter } from '../core/adapters/repo.ts'
import { createAdapters } from '../core/adapters/index.ts'
import { createRealGitlab, draftTitle, isDraftTitle, retryAfterMs } from '../core/adapters/gitlab-http.ts'
import { gitAuthEnv, gitEnv, runGit } from '../core/adapters/git.ts'
import { createTestRepo } from '../scripts/make-test-repo.ts'

const TOKEN = 'glpat-SECRET-TOKEN-0123456789'
const binding = { channel: 'C1', repo: 'group/sub/project', defaultBranch: 'main', jiraProject: 'DEMO' }
let tmp

before(async () => { tmp = await mkdtemp(join(tmpdir(), 'chat-to-fix-gitlab-')) })
after(async () => { await rm(tmp, { recursive: true, force: true }) })

/** A stub GitLab: `script(request)` answers each request; every request is recorded. */
async function stub(script) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url, 'http://x')
      const request = { method: req.method, path: url.pathname, rawPath: req.url.split('?')[0], query: Object.fromEntries(url.searchParams), headers: req.headers, body: text === '' ? undefined : JSON.parse(text) }
      requests.push(request)
      const answer = (await script(request, requests.length)) ?? { status: 500, body: { message: 'no script' } }
      if (answer.hang) return
      res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) })
      res.end(answer.raw ?? JSON.stringify(answer.body ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
  return { baseUrl, requests, close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) } }
}

const real = (baseUrl, extra: any = {}, config: any = {}) => createRealGitlab({ gitlab: { baseUrl }, ...config }, { env: { CHAT_TO_FIX_GITLAB_TOKEN: TOKEN }, warn() {}, backoffMs: 1, ...extra }) as any
const mr = (over = {}) => ({ iid: 7, web_url: 'http://gitlab.test/group/sub/project/-/merge_requests/7', sha: 'abc123', title: 'Draft: T', description: 'd', state: 'opened', draft: true, source_branch: 'ai/DEMO-1', target_branch: 'main', ...over })

test('creation needs the base url and the token; messages name the variable, never a value', () => {
  assert.throws(() => createRealGitlab({}, { env: { CHAT_TO_FIX_GITLAB_TOKEN: TOKEN } } as any), (e: any) => e.code === 'bad_config' && /gitlab\.baseUrl/.test(e.message) && !e.message.includes(TOKEN))
  assert.throws(() => createRealGitlab({ gitlab: { baseUrl: 'https://g.example.com' } }, { env: {} } as any), (e: any) => e.code === 'missing_credentials' && /CHAT_TO_FIX_GITLAB_TOKEN/.test(e.message) && e.retryable === false)
  assert.throws(() => createRealGitlab({ gitlab: { baseUrl: 'ftp://x' } }, { env: { CHAT_TO_FIX_GITLAB_TOKEN: TOKEN } } as any), (e: any) => e.code === 'bad_config' && !e.message.includes(TOKEN))
  // through the adapter factory
  const config = { dataDir: tmp, worktreesDir: tmp, adapters: { slack: 'fake', jira: 'fake', gitlab: 'real' }, gitlab: { baseUrl: 'https://g.example.com' }, commitAuthor: { name: 'a', email: 'a@example.com' } }
  assert.throws(() => createAdapters(config, { env: {}, warn() {} }), (e: any) => e.code === 'missing_credentials')
  assert.ok(createAdapters(config, { env: { CHAT_TO_FIX_GITLAB_TOKEN: TOKEN }, warn() {} }).repo.getMR)
})

test('draft title rules: one Draft prefix, any form GitLab accepts is kept as a single prefix', () => {
  assert.equal(draftTitle('Fix price'), 'Draft: Fix price')
  assert.equal(draftTitle('Draft: Fix price'), 'Draft: Fix price')
  assert.equal(draftTitle('[draft] Fix price'), 'Draft: Fix price')
  assert.equal(draftTitle('(Draft) Fix price'), 'Draft: Fix price')
  assert.equal(draftTitle('  Fix price  '), 'Draft: Fix price')
  assert.equal(isDraftTitle('draft: x') && isDraftTitle('[Draft] x') && isDraftTitle('(DRAFT) x'), true)
  assert.equal(isDraftTitle('Drafting x'), false)
  assert.equal(retryAfterMs('3'), 3000)
  assert.equal(retryAfterMs('Wed, 21 Oct 2026 07:28:05 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')), 5000)
  assert.equal(retryAfterMs('soon'), undefined)
  assert.equal(retryAfterMs(undefined), undefined)
})

test('find: lists open MRs of the source branch with the token header and the encoded project', async () => {
  const s = await stub((r) => ({ status: 200, body: [mr()] }))
  try {
    const found = await real(s.baseUrl + '/').find(binding, 'ai/DEMO-1')
    assert.deepEqual([found.url, found.headSha, found.iid], [mr().web_url, 'abc123', 7])
    const [q] = s.requests
    assert.equal(q.method, 'GET')
    assert.equal(q.rawPath, '/api/v4/projects/group%2Fsub%2Fproject/merge_requests')
    assert.deepEqual([q.query.source_branch, q.query.state], ['ai/DEMO-1', 'opened'])
    assert.equal(q.headers['private-token'], TOKEN)
    assert.equal(q.headers.authorization, undefined)
  } finally { await s.close() }
  const none = await stub(() => ({ status: 200, body: [] }))
  try { assert.equal(await real(none.baseUrl).find(binding, 'ai/DEMO-1'), undefined) } finally { await none.close() }
  // an MR of another source branch in the answer is not ours
  const other = await stub(() => ({ status: 200, body: [mr({ source_branch: 'someone/else' })] }))
  try { assert.equal(await real(other.baseUrl).find(binding, 'ai/DEMO-1'), undefined) } finally { await other.close() }
})

test('a base url with a path prefix is kept (GitLab under a sub path)', async () => {
  const s = await stub(() => ({ status: 200, body: [] }))
  try {
    await real(s.baseUrl + '/gitlab/').find(binding, 'ai/DEMO-1')
    assert.equal(s.requests[0].rawPath, '/gitlab/api/v4/projects/group%2Fsub%2Fproject/merge_requests')
  } finally { await s.close() }
})

test('upsertDraft: no open MR -> POST a Draft MR to the target branch; the answer gives the link', async () => {
  const s = await stub((r) => (r.method === 'GET' ? { status: 200, body: [] } : { status: 201, body: mr({ web_url: 'http://gitlab.test/mr/9' }) }))
  try {
    const out = await real(s.baseUrl).upsertDraft(binding, { branch: 'ai/DEMO-1', title: 'Fix price', description: 'Why\n\nJira: DEMO-1', jiraKey: 'DEMO-1', headSha: 'x' })
    assert.deepEqual(out, { url: 'http://gitlab.test/mr/9', iid: 7 })
    assert.deepEqual(s.requests.map((r) => r.method), ['GET', 'POST'])
    assert.equal(s.requests[1].rawPath, '/api/v4/projects/group%2Fsub%2Fproject/merge_requests')
    assert.deepEqual(s.requests[1].body, { source_branch: 'ai/DEMO-1', target_branch: 'main', title: 'Draft: Fix price', description: 'Why\n\nJira: DEMO-1' })
    assert.equal(s.requests[1].headers['content-type'], 'application/json')
  } finally { await s.close() }
})

test('upsertDraft: an open MR exists -> PUT title and description to it, same link', async () => {
  const s = await stub((r) => (r.method === 'GET' ? { status: 200, body: [mr()] } : { status: 200, body: mr() }))
  try {
    const out = await real(s.baseUrl).upsertDraft(binding, { branch: 'ai/DEMO-1', title: 'Draft: Better', description: 'More' })
    assert.deepEqual(out, { url: mr().web_url, iid: 7 })
    assert.deepEqual(s.requests.map((r) => `${r.method} ${r.path}`), ['GET /api/v4/projects/group%2Fsub%2Fproject/merge_requests', 'PUT /api/v4/projects/group%2Fsub%2Fproject/merge_requests/7'])
    assert.deepEqual(s.requests[1].body, { title: 'Draft: Better', description: 'More' })
  } finally { await s.close() }
})

test('upsertDraft leaves a non-Draft or differently targeted MR untouched', async () => {
  for (const existing of [mr({ draft: false, title: 'Ready' }), mr({ target_branch: 'other' })]) {
    const s = await stub(() => ({ status: 200, body: [existing] }))
    try {
      await assert.rejects(real(s.baseUrl).upsertDraft(binding, { branch: 'ai/DEMO-1', title: 'Fix price' }),
        (e: any) => e.code === 'mr_not_owned' && e.retryable === false)
      assert.deepEqual(s.requests.map((r) => r.method), ['GET'])
    } finally { await s.close() }
  }
})

test('upsertDraft: 409 on create (an MR appeared in between) -> find again and update it; no second create', async () => {
  let gets = 0
  const s = await stub((r) => {
    if (r.method === 'GET') return { status: 200, body: ++gets === 1 ? [] : [mr()] }
    if (r.method === 'POST') return { status: 409, body: { message: ['Another open merge request already exists for this source branch: !7'] } }
    return { status: 200, body: mr() }
  })
  try {
    assert.deepEqual(await real(s.baseUrl).upsertDraft(binding, { branch: 'ai/DEMO-1', title: 'T', description: 'd' }), { url: mr().web_url, iid: 7 })
    assert.deepEqual(s.requests.map((r) => r.method), ['GET', 'POST', 'GET', 'PUT'])
  } finally { await s.close() }
})

test('get: finds the newest MR of the branch, reads it alone for head_pipeline; none -> mr_not_found', async () => {
  const s = await stub((r) => {
    if (r.path.endsWith('/merge_requests')) return { status: 200, body: [mr({ iid: 8, state: 'merged' })] }
    return { status: 200, body: mr({ iid: 8, state: 'merged', head_pipeline: { status: 'success', web_url: 'http://gitlab.test/p/1' } }) }
  })
  try {
    const out = await real(s.baseUrl).get(binding, 'ai/DEMO-1')
    assert.deepEqual(out, { state: 'merged', pipeline: 'success', url: mr().web_url, draft: true, title: 'Draft: T', pipelineUrl: 'http://gitlab.test/p/1' })
    assert.equal(s.requests[0].query.state, undefined, 'any state, not only opened')
    assert.equal(s.requests[1].path, '/api/v4/projects/group%2Fsub%2Fproject/merge_requests/8')
  } finally { await s.close() }
  const noPipeline = await stub((r) => (r.path.endsWith('/merge_requests') ? { status: 200, body: [mr()] } : { status: 200, body: mr({ head_pipeline: null }) }))
  try { assert.equal((await real(noPipeline.baseUrl).get(binding, 'ai/DEMO-1')).pipeline, 'none') } finally { await noPipeline.close() }
  const empty = await stub(() => ({ status: 200, body: [] }))
  try { await assert.rejects(real(empty.baseUrl).get(binding, 'ai/DEMO-1'), (e: any) => e.code === 'mr_not_found' && e.retryable === false) } finally { await empty.close() }
})

test('status codes map to adapter error codes; messages carry GitLab text but never the token', async () => {
  const cases = [[401, 'gitlab_unauthorized'], [403, 'gitlab_forbidden'], [404, 'gitlab_not_found'], [400, 'gitlab_bad_request'], [422, 'gitlab_bad_request'], [302, 'gitlab_redirect']]
  for (const [status, code] of cases) {
    const s = await stub(() => ({ status: status as number, body: { message: `nope ${TOKEN}` }, headers: status === 302 ? { location: 'https://elsewhere.example.com/' } : {} }))
    try {
      await assert.rejects(real(s.baseUrl).find(binding, 'ai/DEMO-1'), (e: any) => e.name === 'AdapterError' && e.code === code && e.retryable === false && !e.message.includes(TOKEN) && !String(e.stack).includes(TOKEN), `${status}`)
      assert.equal(s.requests.length, 1, `${status} is not retried`)
    } finally { await s.close() }
  }
  // the redirect was not followed: the token header did not travel
  const target = await stub(() => ({ status: 200, body: [] }))
  const redirecting = await stub(() => ({ status: 301, body: {}, headers: { location: `${target.baseUrl}/api/v4/x` } }))
  try {
    await assert.rejects(real(redirecting.baseUrl).find(binding, 'ai/DEMO-1'), (e: any) => e.code === 'gitlab_redirect')
    assert.equal(target.requests.length, 0)
  } finally { await redirecting.close(); await target.close() }
  // a bad binding
  await assert.rejects(real('http://127.0.0.1:1').find({}, 'ai/X-1'), (e: any) => e.code === 'bad_binding')
})

test('GET: 429 with Retry-After and 5xx are retried inside the adapter, then succeed', async () => {
  const seen = []
  const s = await stub((r, n) => {
    seen.push(n)
    if (n === 1) return { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '0' } }
    if (n === 2) return { status: 503, body: { message: 'busy' } }
    return { status: 200, body: [mr()] }
  })
  try {
    assert.equal((await real(s.baseUrl).find(binding, 'ai/DEMO-1')).iid, 7)
    assert.equal(s.requests.length, 3)
  } finally { await s.close() }
})

test('GET: retries are limited; the final failure is not retryable (the adapter already retried)', async () => {
  const s = await stub(() => ({ status: 500, body: { message: 'boom' } }))
  try {
    await assert.rejects(real(s.baseUrl).find(binding, 'ai/DEMO-1'), (e: any) => e.code === 'gitlab_unavailable' && e.retryable === false && /boom/.test(e.message))
    assert.equal(s.requests.length, 3, 'one try and two retries')
  } finally { await s.close() }
  const limited = await stub(() => ({ status: 429, body: {}, headers: { 'retry-after': '120' } }))
  try {
    const started = Date.now()
    await assert.rejects(real(limited.baseUrl).find(binding, 'ai/DEMO-1'), (e: any) => e.code === 'gitlab_rate_limited' && /retry after 120s/.test(e.message))
    assert.equal(limited.requests.length, 1, 'a long Retry-After is reported, not waited for')
    assert.ok(Date.now() - started < 2000)
  } finally { await limited.close() }
})

test('GET: a request that hangs times out per request and is retried; unreachable host is reported without retry storms', async () => {
  const s = await stub((r, n) => (n === 1 ? { hang: true, status: 200 } : { status: 200, body: [] }))
  try {
    assert.equal(await real(s.baseUrl, { requestTimeoutMs: 150 }).find(binding, 'ai/DEMO-1'), undefined)
    assert.equal(s.requests.length, 2)
  } finally { await s.close() }
  const dead = await stub(() => ({ status: 200 }))
  const url = dead.baseUrl
  await dead.close()
  await assert.rejects(real(url, { retries: 1 }).find(binding, 'ai/DEMO-1'), (e: any) => e.code === 'gitlab_unreachable' && e.retryable === false && !e.message.includes(TOKEN))
  // the default per-request timeout is shorter than the tool layer's
  const defaults = real('http://127.0.0.1:1', {}, { toolTimeoutSeconds: 30 })
  assert.ok(defaults)
})

test('writes are never retried or marked retryable: 5xx, 429, a timeout and a dropped connection each send exactly one request', async () => {
  for (const answer of [{ status: 502, body: { message: 'bad gateway' } }, { status: 429, body: {}, headers: { 'retry-after': '0' } }, { hang: true, status: 200 }]) {
    const s = await stub((r) => (r.method === 'GET' ? { status: 200, body: [] } : answer))
    try {
      await assert.rejects(
        real(s.baseUrl, { requestTimeoutMs: 150 }).upsertDraft(binding, { branch: 'ai/DEMO-1', title: 'T', description: 'd' }),
        (e: any) => e.name === 'AdapterError' && e.retryable === false && !e.message.includes(TOKEN),
        JSON.stringify(answer),
      )
      assert.deepEqual(s.requests.map((r) => r.method), ['GET', 'POST'], JSON.stringify(answer))
    } finally { await s.close() }
  }
  // PUT as well
  const put = await stub((r) => (r.method === 'GET' ? { status: 200, body: [mr()] } : { status: 503, body: {} }))
  try {
    await assert.rejects(real(put.baseUrl).upsertDraft(binding, { branch: 'ai/DEMO-1', title: 'T', description: 'd' }), (e: any) => e.code === 'gitlab_unavailable' && e.retryable === false)
    assert.deepEqual(put.requests.map((r) => r.method), ['GET', 'PUT'])
  } finally { await put.close() }
})

test('an unreadable answer is an error, not a crash', async () => {
  const s = await stub(() => ({ status: 200, raw: '<html>login</html>' }))
  try { await assert.rejects(real(s.baseUrl).find(binding, 'ai/DEMO-1'), (e: any) => e.code === 'gitlab_bad_response') } finally { await s.close() }
})

// ---------- the repository adapter with the real merge-request half ----------

test('repo adapter with adapters.gitlab=real: commit, push to the git remote, MR through the API (file:// remote: no credential)', async () => {
  const dir = await mkdtemp(join(tmp, 'e2e-'))
  const made = await createTestRepo({ dir: join(dir, 'repo') })
  const s = await stub((r) => {
    if (r.method === 'GET') return { status: 200, body: [] }
    return { status: 201, body: mr({ web_url: 'http://gitlab.test/mr/1' }) }
  })
  try {
    const b = { ...binding, localRepo: made.localRepo, remote: made.remote, defaultBranch: 'master' }
    const config = {
      dataDir: join(dir, 'data'), worktreesDir: join(dir, 'worktrees'), adapters: { slack: 'fake', jira: 'fake', gitlab: 'real' },
      gitlab: { baseUrl: s.baseUrl }, bindings: [b], commitAuthor: { name: 'chat-to-fix', email: 'chat-to-fix@example.com' },
    }
    const repo = createRepoAdapter(config, { env: { CHAT_TO_FIX_GITLAB_TOKEN: TOKEN }, warn() {} }) as any
    const p = await repo.prepare(b, 'DEMO-1', 1)
    await writeFile(join(p.dir, 'x.txt'), 'x')
    const out = await repo.openDraftMR(b, p.dir, p.branch, { title: 'Fix x', description: 'because', jiraKey: 'DEMO-1', commitMessage: 'fix(x): add x' })
    const head = (await runGit(['rev-parse', p.branch], { cwd: made.remote })).stdout.trim()
    assert.deepEqual(out, { url: 'http://gitlab.test/mr/1', iid: 7, sha: head })
    assert.deepEqual(s.requests.map((r) => r.method), ['GET', 'GET', 'POST'])
    assert.equal(s.requests[2].body.title, 'Draft: Fix x')
    assert.equal(s.requests[2].body.target_branch, 'master')
    const subject = await runGit(['log', '-1', '--format=%s%n--%n%b', p.branch], { cwd: made.remote }).then((r) => r.stdout)
    assert.equal(subject.trim(), 'fix(x): add x\n--')
    // the same task again: the MR is found, the title and description are updated
    s.requests.length = 0
    await writeFile(join(p.dir, 'y.txt'), 'y')
    const mrs = [mr({ sha: 'whatever', target_branch: 'master' })]
    const s2 = await stub((r) => (r.method === 'GET' ? { status: 200, body: mrs } : { status: 200, body: mr() }))
    try {
      const repo2 = createRepoAdapter({ ...config, gitlab: { baseUrl: s2.baseUrl } }, { env: { CHAT_TO_FIX_GITLAB_TOKEN: TOKEN }, warn() {} }) as any
      const second = await repo2.openDraftMR(b, p.dir, p.branch, { title: 'Fix x', jiraKey: 'DEMO-1' })
      assert.deepEqual(second, { url: mr().web_url, iid: 7, sha: (await runGit(['rev-parse', p.branch], { cwd: made.remote })).stdout.trim() })
      assert.notEqual(second.sha, head)
      assert.deepEqual(s2.requests.map((r) => r.method), ['GET', 'GET', 'PUT'])
      assert.equal((await runGit(['rev-list', '--count', `master..${p.branch}`], { cwd: made.remote })).stdout.trim(), '2', 'a second call appends a commit: no amend, whatever head sha GitLab reports')
    } finally { await s2.close() }
    // getMR goes through the same backend
    const g = await stub((r) => (r.path.endsWith('/merge_requests') ? { status: 200, body: [mr()] } : { status: 200, body: mr({ head_pipeline: { status: 'running' } }) }))
    try {
      const repo3 = createRepoAdapter({ ...config, gitlab: { baseUrl: g.baseUrl } }, { env: { CHAT_TO_FIX_GITLAB_TOKEN: TOKEN }, warn() {} }) as any
      assert.equal((await repo3.getMR(b, p.branch)).pipeline, 'running')
    } finally { await g.close() }
  } finally { await s.close() }
})

// ---------- git authentication ----------

test('gitAuthEnv: https remote on the GitLab host gets a scoped extraHeader (Basic oauth2:<token>); nothing else does', () => {
  const auth = { baseUrl: 'https://gitlab.example.com', token: TOKEN }
  const got = gitAuthEnv(auth, 'https://gitlab.example.com/group/project.git')
  const value = Buffer.from(`oauth2:${TOKEN}`).toString('base64')
  assert.deepEqual(got.env, {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://gitlab.example.com/.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${value}`,
  })
  assert.deepEqual(got.secrets, [TOKEN, value])
  // base url with a path or trailing slash: scoped to the origin
  assert.equal(gitAuthEnv({ baseUrl: 'https://gitlab.example.com/gitlab/', token: TOKEN }, 'https://gitlab.example.com/gitlab/g/p.git').env.GIT_CONFIG_KEY_0, 'http.https://gitlab.example.com/.extraHeader')
  // no header for: file://, ssh, scp style, a local path, another host, another port, plain http, an empty remote, missing auth
  for (const remote of ['file:///tmp/x.git', 'ssh://git@gitlab.example.com/g/p.git', 'git@gitlab.example.com:g/p.git', '/tmp/x.git', 'https://evil.example.com/g/p.git', 'https://gitlab.example.com:8443/g/p.git', 'http://gitlab.example.com/g/p.git', '', undefined, 'origin']) {
    assert.deepEqual(gitAuthEnv(auth, remote), { env: {}, secrets: [] }, String(remote))
  }
  assert.deepEqual(gitAuthEnv(undefined, 'https://gitlab.example.com/g/p.git'), { env: {}, secrets: [] })
  assert.deepEqual(gitAuthEnv({ baseUrl: 'https://gitlab.example.com', token: '' }, 'https://gitlab.example.com/g/p.git'), { env: {}, secrets: [] })
  // the isolated environment stays isolated, and the credential lands only where it was passed
  assert.equal(gitEnv({ name: 'a', email: 'a@example.com' }).GIT_CONFIG_COUNT, undefined)
  const env = gitEnv({ name: 'a', email: 'a@example.com' }, got.env)
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(env.GIT_CONFIG_VALUE_0, got.env.GIT_CONFIG_VALUE_0)
  assert.ok(!Object.values(gitEnv({ name: 'a', email: 'a@example.com' })).some((v) => String(v).includes(TOKEN)))
})

test('git really sends the header from the environment, and a failed https command reports no token', async () => {
  // A stub "git server" that records the Authorization header and refuses.
  const s = await stub((r) => ({ status: 403, body: {} }))
  try {
    const got = gitAuthEnv({ baseUrl: 'https://gitlab.example.com', token: TOKEN }, 'https://gitlab.example.com/g/p.git')
    // same key/value form, pointed at the plain-http stub (gitAuthEnv itself only serves https)
    const credentials = { env: { ...got.env, GIT_CONFIG_KEY_0: `http.${s.baseUrl}/.extraHeader`, GIT_ALLOW_PROTOCOL: 'http' }, secrets: got.secrets }
    await assert.rejects(
      runGit(['ls-remote', `${s.baseUrl}/g/p.git`], { cwd: tmp, network: true, credentials }),
      (e: any) => e.code === 'git_failed' && e.retryable === true && !e.message.includes(TOKEN) && !e.message.includes(got.secrets[1]) && e.cause === undefined,
    )
    assert.ok(s.requests.length >= 1)
    assert.equal(s.requests[0].headers.authorization, `Basic ${Buffer.from(`oauth2:${TOKEN}`).toString('base64')}`)
    // without credentials no Authorization header is sent
    s.requests.length = 0
    await assert.rejects(runGit(['ls-remote', `${s.baseUrl}/g/p.git`], { cwd: tmp, network: true, credentials: { env: { GIT_ALLOW_PROTOCOL: 'http' }, secrets: [] } }), (e: any) => e.code === 'git_failed')
    assert.equal(s.requests[0].headers.authorization, undefined)
  } finally { await s.close() }
})

test('redaction in git errors: a token echoed by git is replaced', async () => {
  // `git <bad subcommand with the token in its name>` echoes the text on stderr
  await assert.rejects(
    runGit([`no-such-command-${TOKEN}`], { cwd: tmp, credentials: { env: {}, secrets: [TOKEN] } }),
    (e: any) => e.code === 'git_failed' && !e.message.includes(TOKEN) && /redacted/.test(e.message),
  )
})
