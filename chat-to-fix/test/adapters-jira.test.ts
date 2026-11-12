// The real Jira adapter against a local stub server (node:http on 127.0.0.1); no real Jira host is used.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createJiraAdapter, createRealJira } from '../src/adapters/jira.ts'
import { retryAfterMs } from '../src/adapters/jira-http.ts'

const TOKEN = 'tok-SECRET-12345'
const servers = []
after(async () => { await Promise.all(servers.map((s) => new Promise((resolve) => { s.closeAllConnections(); s.close(resolve) }))) })

/** Starts a stub; `handler(req, body, res, n)` answers, `n` counts the requests so far (1-based). */
async function stub(handler) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const entry = { method: req.method, url: req.url, headers: req.headers, body: raw === '' ? undefined : JSON.parse(raw) }
      requests.push(entry)
      handler(entry, res, requests.length)
    })
  })
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  return { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, requests }
}

const send = (res, status, body?, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

const binding = { channel: 'C1', repo: 'g/p', jiraProject: 'DEMO', issueType: 'Task', labels: ['chat-to-fix'] }
const env = { CHAT_TO_FIX_JIRA_TOKEN: TOKEN }

function adapter(baseUrl, { jira = {}, config = {}, options = {} }: any = {}) {
  return createRealJira({ jira: { baseUrl, ...jira }, jiraTransitions: ['In Review'], ...config }, { env, ...options }) as any
}

test('createJiraAdapter picks the real implementation; bad setup fails at creation, without the token in the message', () => {
  const config = { adapters: { jira: 'real' }, jira: { baseUrl: 'https://jira.example.com/' } }
  assert.equal(typeof (createJiraAdapter(config, { env }) as any).createIssue, 'function')
  assert.throws(() => createJiraAdapter(config, { env: {} }), (e: any) => e.code === 'bad_config' && /CHAT_TO_FIX_JIRA_TOKEN/.test(e.message))
  assert.throws(() => createJiraAdapter({ adapters: { jira: 'real' } }, { env }), (e: any) => e.code === 'bad_config' && /baseUrl/.test(e.message))
  assert.throws(() => createJiraAdapter({ adapters: { jira: 'real' }, jira: { baseUrl: 'ftp://x' } }, { env }), (e: any) => e.code === 'bad_config')
  assert.throws(() => createJiraAdapter({ adapters: { jira: 'real' }, jira: { baseUrl: `https://me:${TOKEN}@jira.example.com` } }, { env }), (e: any) => e.code === 'bad_config' && !e.message.includes(TOKEN))
})

test('retryAfterMs reads seconds and dates', () => {
  assert.equal(retryAfterMs('3'), 3000)
  assert.equal(retryAfterMs('0'), 0)
  assert.equal(retryAfterMs(undefined), undefined)
  assert.equal(retryAfterMs('soon'), undefined)
  assert.equal(retryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', Date.parse('Thu, 01 Jan 2026 00:00:00 GMT')), 10_000)
})

test('createIssue: payload, merged fields, Basic auth, key and browse URL', async () => {
  const s = await stub((req, res) => send(res, 201, { id: '10001', key: 'DEMO-7', self: 'x' }))
  const a = adapter(`${s.baseUrl}/`, { jira: { email: 'bot@example.com', fields: { customfield_10010: { value: 'Bug' }, labels: ['from-config'] } } })
  const out = await a.createIssue({ ...binding, jiraFields: { customfield_10010: { value: 'Task' }, priority: { name: 'High' } } },
    { title: 'Login  broken', description: 'It fails.\n\nSlack discussion: https://s/p1', acceptance: 'Login works', permalink: 'https://s/p1' })
  assert.deepEqual(out, { key: 'DEMO-7', url: `${s.baseUrl}/browse/DEMO-7` })
  assert.equal(s.requests.length, 1)
  const [req] = s.requests
  assert.equal(req.method, 'POST')
  assert.equal(req.url, '/rest/api/2/issue')
  assert.equal(req.headers.authorization, `Basic ${Buffer.from(`bot@example.com:${TOKEN}`).toString('base64')}`)
  assert.deepEqual(req.body, { fields: {
    project: { key: 'DEMO' }, issuetype: { name: 'Task' }, summary: 'Login broken',
    description: 'It fails.\n\nSlack discussion: https://s/p1\n\nAcceptance criteria:\nLogin works',
    labels: ['from-config'],
    customfield_10010: { value: 'Task' }, priority: { name: 'High' },
  } })
})

test('createIssue: labels from the binding, issue type id, Bearer auth, email from the environment', async () => {
  const s = await stub((req, res) => send(res, 201, { key: 'DEMO-8' }))
  const a = adapter(s.baseUrl)
  await a.createIssue({ ...binding, issueType: '10002' }, { title: 't' })
  assert.equal(s.requests[0].headers.authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(s.requests[0].body.fields, { project: { key: 'DEMO' }, issuetype: { id: '10002' }, summary: 't', description: '', labels: ['chat-to-fix'] })
  const viaEnv = createRealJira({ jira: { baseUrl: s.baseUrl } }, { env: { ...env, CHAT_TO_FIX_JIRA_EMAIL: 'env@example.com' } }) as any
  await viaEnv.createIssue({ jiraProject: 'DEMO' }, { title: 't' })
  assert.equal(s.requests[1].headers.authorization, `Basic ${Buffer.from(`env@example.com:${TOKEN}`).toString('base64')}`)
  assert.equal(s.requests[1].body.fields.issuetype.name, 'Bug')
  assert.equal('labels' in s.requests[1].body.fields, false)
})

test('input checks match the fake and send nothing', async () => {
  const s = await stub((req, res) => send(res, 500))
  const a = adapter(s.baseUrl)
  await assert.rejects(a.createIssue({}, { title: 't' }), (e: any) => e.code === 'bad_binding')
  await assert.rejects(a.createIssue(binding, { title: ' ' }), (e: any) => e.code === 'bad_title')
  await assert.rejects(a.getIssue(''), (e: any) => e.code === 'bad_key')
  await assert.rejects(a.getIssue('../../x'), (e: any) => e.code === 'bad_key')
  await assert.rejects(a.addComment('DEMO-1', ' '), (e: any) => e.code === 'bad_text')
  await assert.rejects(a.transition('DEMO-1', ''), (e: any) => e.code === 'bad_status')
  await assert.rejects(a.transition('DEMO-1', 'Done'), (e: any) => e.code === 'status_not_allowed')
  assert.equal(s.requests.length, 0)
})

test('getIssue: maps the fields, comments (with paging) and a missing issue', async () => {
  const comment = (n) => ({ id: String(n), created: `2026-11-12T01:0${n}:00.000+0000`, author: { accountId: `acc${n}`, displayName: `User ${n}` }, body: `c${n}` })
  const s = await stub((req, res) => {
    if (req.url.startsWith('/rest/api/2/issue/DEMO-1/comment')) return send(res, 200, { startAt: 1, total: 3, comments: [comment(2), comment(3)] })
    if (req.url.startsWith('/rest/api/2/issue/DEMO-1?')) {
      return send(res, 200, { key: 'DEMO-1', fields: {
        summary: 'Login broken', description: 'It fails', status: { name: 'To Do' }, issuetype: { name: 'Bug' }, project: { key: 'DEMO' },
        labels: ['a'], created: '2026-11-12T00:00:00.000+0000', comment: { total: 3, comments: [comment(1)] },
      } })
    }
    send(res, 404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} })
  })
  const a = adapter(s.baseUrl)
  const issue = await a.getIssue('DEMO-1')
  assert.equal(issue.key, 'DEMO-1')
  assert.equal(issue.url, `${s.baseUrl}/browse/DEMO-1`)
  assert.equal(issue.title, 'Login broken')
  assert.equal(issue.description, 'It fails')
  assert.equal(issue.status, 'To Do')
  assert.deepEqual([issue.project, issue.type, issue.labels], ['DEMO', 'Bug', ['a']])
  assert.deepEqual(issue.comments.map((c) => [c.id, c.author.name, c.text]), [['1', 'User 1', 'c1'], ['2', 'User 2', 'c2'], ['3', 'User 3', 'c3']])
  assert.equal(issue.comments[0].at, '2026-11-12T01:01:00.000+0000')
  assert.match(s.requests[1].url, /startAt=1/)
  await assert.rejects(a.getIssue('DEMO-9'), (e: any) => e.code === 'issue_not_found' && e.retryable === false)
})

test('addComment posts the text; a missing issue is issue_not_found', async () => {
  const s = await stub((req, res) => (req.url.includes('DEMO-1') ? send(res, 201, { id: '5' }) : send(res, 404, { errorMessages: ['nope'] })))
  const a = adapter(s.baseUrl)
  assert.equal(await a.addComment('DEMO-1', 'MR is open'), undefined)
  assert.deepEqual([s.requests[0].method, s.requests[0].url, s.requests[0].body], ['POST', '/rest/api/2/issue/DEMO-1/comment', { body: 'MR is open' }])
  await assert.rejects(a.addComment('DEMO-2', 'x'), (e: any) => e.code === 'issue_not_found' && e.retryable === false)
})

test('transition: finds the id by target status name, handles not available and already there', async () => {
  let status = 'In Progress'
  const s = await stub((req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/transitions')) {
      // Once in review, the workflow offers no transition to review any more.
      return send(res, 200, { transitions: [...(status === 'In Review' ? [] : [{ id: '11', name: 'Send to review', to: { name: 'In Review' } }]), { id: '21', name: 'Done', to: { name: 'Done' } }] })
    }
    if (req.method === 'POST' && req.url.endsWith('/transitions')) { status = 'In Review'; return send(res, 204) }
    if (req.url.includes('?fields=status')) return send(res, 200, { fields: { status: { name: status } } })
    send(res, 404, {})
  })
  const a = adapter(s.baseUrl, { config: { jiraTransitions: ['In Review', 'Blocked'] } })
  assert.equal(await a.transition('DEMO-1', 'in review'), undefined)
  const posts = () => s.requests.filter((r) => r.method === 'POST')
  assert.deepEqual([posts()[0].url, posts()[0].body], ['/rest/api/2/issue/DEMO-1/transitions', { transition: { id: '11' } }])
  // Already in the target status: success without a second POST.
  assert.equal(await a.transition('DEMO-1', 'In Review'), undefined)
  assert.equal(posts().length, 1)
  // Not reachable from here and not the current status.
  await assert.rejects(a.transition('DEMO-1', 'Blocked'), (e: any) => e.code === 'transition_not_available' && /Done/.test(e.message) && e.retryable === false)
  assert.equal(posts().length, 1)
})

test('auth failure: 401 and 403 are explicit, not retryable, and never show the token', async () => {
  const s = await stub((req, res) => send(res, req.url.includes('DEMO-403') ? 403 : 401, { message: `bad token ${TOKEN}`, errorMessages: [`Basic ${Buffer.from(`bot@example.com:${TOKEN}`).toString('base64')}`] }))
  const a = adapter(s.baseUrl, { jira: { email: 'bot@example.com' } })
  for (const call of [() => a.createIssue(binding, { title: 't' }), () => a.getIssue('DEMO-1'), () => a.addComment('DEMO-1', 'x'), () => a.transition('DEMO-1', 'In Review')]) {
    await assert.rejects(call(), (e: any) => {
      assert.equal(e.code, 'auth_failed')
      assert.equal(e.retryable, false)
      assert.ok(!JSON.stringify([e.message, e.code, e.stack]).includes(TOKEN))
      assert.ok(!e.message.includes(Buffer.from(`bot@example.com:${TOKEN}`).toString('base64')))
      return true
    })
  }
  await assert.rejects(a.getIssue('DEMO-403'), (e: any) => e.code === 'forbidden' && !e.message.includes(TOKEN))
  // 401 on GET is final: not retried.
  assert.equal(s.requests.filter((r) => r.method === 'GET').length, 3)
})

test('validation error from Jira (400): errors and errorMessages reach the message; not retryable', async () => {
  const s = await stub((req, res) => send(res, 400, { errorMessages: ['Issue type is invalid.'], errors: { customfield_10010: 'Work type is required.', summary: 'too long' } }))
  const a = adapter(s.baseUrl)
  await assert.rejects(a.createIssue(binding, { title: 't' }), (e: any) => {
    assert.equal(e.code, 'jira_rejected')
    assert.equal(e.retryable, false)
    assert.match(e.message, /Issue type is invalid\./)
    assert.match(e.message, /customfield_10010: Work type is required\./)
    assert.match(e.message, /summary: too long/)
    return true
  })
  assert.equal(s.requests.length, 1)
})

test('429 then success on GET: Retry-After is honoured and the read succeeds', async () => {
  const s = await stub((req, res, n) => (n === 1
    ? send(res, 429, { message: 'slow down' }, { 'Retry-After': '2' })
    : send(res, 200, { key: 'DEMO-1', fields: { summary: 's', status: { name: 'To Do' }, comment: { total: 0, comments: [] } } })))
  const waits = []
  const a = adapter(s.baseUrl, { options: { sleep: async (ms) => { waits.push(ms) } } })
  const issue = await a.getIssue('DEMO-1')
  assert.equal(issue.title, 's')
  assert.deepEqual(waits, [2000])
  assert.equal(s.requests.length, 2)
})

test('GET: 5xx is retried a limited number of times; a Retry-After beyond the cap is not waited for', async () => {
  const s = await stub((req, res) => send(res, 503, { errorMessages: ['down'] }))
  const waits = []
  const a = adapter(s.baseUrl, { options: { sleep: async (ms) => { waits.push(ms) }, maxRetries: 2 } })
  await assert.rejects(a.getIssue('DEMO-1'), (e: any) => e.code === 'jira_unavailable' && e.retryable === false && /down/.test(e.message))
  assert.equal(s.requests.length, 3)
  assert.equal(waits.length, 2)

  const slow = await stub((req, res) => send(res, 429, {}, { 'Retry-After': '120' }))
  const b = adapter(slow.baseUrl, { options: { sleep: async () => { throw new Error('must not wait') } } })
  await assert.rejects(b.getIssue('DEMO-1'), (e: any) => e.code === 'rate_limited' && /120s/.test(e.message))
  assert.equal(slow.requests.length, 1)
})

test('writes are never retried: 429 and 5xx on create, comment and transition leave one request and retryable false', async () => {
  let mode = 429
  const s = await stub((req, res) => {
    if (req.method === 'GET') return send(res, 200, { transitions: [{ id: '11', to: { name: 'In Review' } }] })
    send(res, mode, { errorMessages: ['x'] }, { 'Retry-After': '0' })
  })
  const a = adapter(s.baseUrl, { options: { sleep: async () => { throw new Error('must not wait') } } })
  for (mode of [429, 502]) {
    const code = mode === 429 ? 'rate_limited' : 'jira_unavailable'
    s.requests.length = 0
    await assert.rejects(a.createIssue(binding, { title: 't' }), (e: any) => e.code === code && e.retryable === false)
    await assert.rejects(a.addComment('DEMO-1', 'x'), (e: any) => e.code === code && e.retryable === false)
    await assert.rejects(a.transition('DEMO-1', 'In Review'), (e: any) => e.code === code && e.retryable === false)
    assert.deepEqual(s.requests.map((r) => r.method), ['POST', 'POST', 'GET', 'POST'])
  }
})

test('timeout: a slow Jira ends the request in time; a write is not retryable, a read is', async () => {
  const s = await stub(() => { /* never answers */ })
  const a = adapter(s.baseUrl, { options: { timeoutMs: 150 } })
  const started = Date.now()
  await assert.rejects(a.createIssue(binding, { title: 't' }), (e: any) => e.code === 'timeout' && e.retryable === false && /may or may not/.test(e.message))
  await assert.rejects(a.getIssue('DEMO-1'), (e: any) => e.code === 'timeout' && e.retryable === true)
  assert.ok(Date.now() - started < 5000)
})

test('unreachable Jira, a redirect and a non-JSON success are reported plainly', async () => {
  const dead = await stub((req, res) => send(res, 200, {}))
  const closed = dead.baseUrl
  for (const server of servers) { server.closeAllConnections(); server.close() }
  await assert.rejects(adapter(closed).getIssue('DEMO-1'), (e: any) => e.code === 'network_error' && e.retryable === true && !e.message.includes(TOKEN))
  await assert.rejects(adapter(closed).addComment('DEMO-1', 'x'), (e: any) => e.code === 'network_error' && e.retryable === false)

  const s = await stub((req, res) => (req.url.endsWith('/issue') ? (res.writeHead(200, { 'Content-Type': 'text/html' }), res.end('<html>sign in</html>')) : (res.writeHead(302, { Location: 'https://sso.example.com/login' }), res.end())))
  const a = adapter(s.baseUrl)
  await assert.rejects(a.createIssue(binding, { title: 't' }), (e: any) => e.code === 'bad_response' && e.retryable === false)
  await assert.rejects(a.getIssue('DEMO-1'), (e: any) => e.code === 'bad_config' && /redirect/.test(e.message))
})
