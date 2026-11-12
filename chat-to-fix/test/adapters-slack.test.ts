// The real Slack adapter against a local stub of the Slack Web API (node:http on 127.0.0.1).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createOutboxSlack, createRealSlack, createSlackAdapter, commandDiscussion } from '../src/adapters/slack.ts'
import { neutralizeBroadcasts, retryAfterMs } from '../src/adapters/slack-http.ts'

const TOKEN = 'xoxb-test-secret-token-123'
const ORIGIN = { channel: 'C0123ABC', threadTs: '1731377400.000100', eventId: 'Ev1', messageTs: '1731377400.000100', user: { id: 'U1' }, text: 'x' }
const servers = []

// handler(request, { url, body }, response); `requests` records every request.
async function stub(handler) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const raw = Buffer.concat(chunks).toString('utf8')
      const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, raw, json: raw ? JSON.parse(raw) : undefined }
      requests.push(record)
      handler(record, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  servers.push(server)
  return { base: `http://127.0.0.1:${(server.address() as any).port}/api`, requests, server }
}
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close() } })

const send = (res, data, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)) }

function make(base, extra: any = {}) {
  const sleeps = []
  const warnings = []
  const slack: any = createRealSlack({ slack: { apiBase: base } }, {
    env: { CHAT_TO_FIX_SLACK_TOKEN: TOKEN }, warn: (...a) => warnings.push(a.join(' ')),
    sleep: async (ms) => { sleeps.push(ms) }, retryDelayMs: 1, ...extra,
  })
  return { slack, sleeps, warnings }
}

test('createRealSlack needs the bot token; the factory chooses it by config', () => {
  assert.throws(() => createRealSlack({}, { env: {} }), (e: any) => e.code === 'missing_token' && !e.message.includes('xoxb'))
  const slack: any = createSlackAdapter({ adapters: { slack: 'real' } }, { env: { CHAT_TO_FIX_SLACK_TOKEN: TOKEN } })
  assert.equal(typeof slack.readThread, 'function')
  assert.equal(typeof slack.reply, 'function')
})

test('slash command mode reads the submitted text without a history scope', async () => {
  const { base, requests } = await stub((_req, res) => send(res, { ok: false, error: 'missing_scope' }))
  const slack: any = createRealSlack({ slack: { apiBase: base, inputMode: 'command' } }, { env: { CHAT_TO_FIX_SLACK_TOKEN: TOKEN } })
  assert.deepEqual(await slack.readThread({ ...ORIGIN, user: { id: 'U1', name: 'Ann' }, text: 'Fix checkout' }), [{
    user: { id: 'U1', name: 'Ann' }, at: new Date(Number(ORIGIN.messageTs) * 1000).toISOString(), text: 'Fix checkout', files: [],
  }])
  assert.equal(requests.length, 0)
})

test('readThread: pages, names, mentions, entities, files; names are cached', async () => {
  const { base, requests } = await stub((req, res) => {
    if (req.path === '/api/conversations.replies') {
      if (req.query.cursor === undefined) {
        return send(res, {
          ok: true, has_more: true, response_metadata: { next_cursor: 'CUR2' },
          messages: [{ type: 'message', user: 'U1', ts: '1731377400.000100', text: '<@UBOT> login &amp; logout <b> is broken &lt;ok&gt;', files: [{ name: 'a.png', permalink: 'https://x/a' }, { mode: 'tombstone' }] }],
        })
      }
      return send(res, {
        ok: true, has_more: false, response_metadata: { next_cursor: '' },
        messages: [
          { user: 'U2', ts: '1731377460.000200', text: 'me too, cc <@U1> in <#C9|dev>' },
          { bot_id: 'B7', username: 'ci-bot', ts: '1731377520.000300', text: 'build red' },
        ],
      })
    }
    if (req.path === '/api/users.info') {
      const names = { U1: { profile: { display_name: 'ann', real_name: 'Ann A' } }, U2: { profile: { display_name: '', real_name: 'Bob B' } }, UBOT: { name: 'fixbot' } }
      return send(res, { ok: true, user: names[req.query.user] })
    }
    send(res, { ok: false, error: 'unknown_method' })
  })
  const { slack } = make(base)
  const messages = await slack.readThread(ORIGIN)
  assert.equal(messages.length, 3)
  assert.deepEqual(messages[0], {
    user: { id: 'U1', name: 'ann' }, at: new Date(1731377400.0001 * 1000).toISOString(),
    text: '@fixbot login & logout <b> is broken <ok>', files: [{ name: 'a.png', url: 'https://x/a' }],
  })
  assert.equal(messages[1].user.name, 'Bob B')
  assert.equal(messages[1].text, 'me too, cc @ann in #dev')
  assert.deepEqual(messages[2].user, { id: 'B7', name: 'ci-bot' })
  assert.deepEqual(messages[2].files, [])

  const replies = requests.filter((r) => r.path === '/api/conversations.replies')
  assert.equal(replies.length, 2)
  assert.equal(replies[0].method, 'GET')
  assert.deepEqual(replies[0].query, { channel: 'C0123ABC', ts: '1731377400.000100', limit: '200' })
  assert.equal(replies[1].query.cursor, 'CUR2')
  assert.equal(replies[0].headers.authorization, `Bearer ${TOKEN}`)
  const lookups = requests.filter((r) => r.path === '/api/users.info').length
  assert.equal(lookups, 3) // U1, U2, UBOT: one each

  await slack.readThread(ORIGIN) // second read: the replies again, no new users.info
  assert.equal(requests.filter((r) => r.path === '/api/users.info').length, lookups)
})

test('readThread: without users:read the names degrade to ids, and users.info is not called again', async () => {
  const { base, requests } = await stub((req, res) => {
    if (req.path === '/api/conversations.replies') return send(res, { ok: true, messages: [{ user: 'U1', ts: '1.1', text: 'hi <@U2>' }, { user: 'U3', ts: '2.2', text: 'yo' }] })
    send(res, { ok: false, error: 'missing_scope', needed: 'users:read' })
  })
  const { slack, warnings } = make(base)
  const messages = await slack.readThread(ORIGIN)
  assert.deepEqual(messages.map((m) => m.user), [{ id: 'U1', name: 'U1' }, { id: 'U3', name: 'U3' }])
  assert.equal(messages[0].text, 'hi @U2')
  assert.equal(warnings.length, 1)
  assert.ok(!warnings[0].includes(TOKEN))
  const first = requests.filter((r) => r.path === '/api/users.info').length
  await slack.readThread(ORIGIN)
  assert.equal(requests.filter((r) => r.path === '/api/users.info').length, first)
})

test('readThread: bad origin, empty answer, Slack errors map to adapter codes without the token', async () => {
  const { base } = await stub((req, res) => {
    const channel = req.query.channel
    if (channel === 'CEMPTY') return send(res, { ok: true, messages: [] })
    const error = { CNOTIN: 'not_in_channel', CNONE: 'channel_not_found', CAUTH: 'invalid_auth', CTHREAD: 'thread_not_found', CSCOPE: 'missing_scope', CWEIRD: 'something_new' }[channel]
    send(res, { ok: false, error, needed: 'channels:history,groups:history', provided: 'chat:write' })
  })
  const { slack } = make(base)
  const expectations: [string, string, RegExp][] = [
    ['CNOTIN', 'not_in_channel', /invite/], ['CNONE', 'channel_not_found', /channel/], ['CAUTH', 'invalid_auth', /token/],
    ['CTHREAD', 'thread_not_found', /discussion/], ['CSCOPE', 'missing_scope', /needed: channels:history,groups:history/],
    ['CWEIRD', 'slack_error', /something_new/], ['CEMPTY', 'thread_not_found', /no discussion/],
  ]
  for (const [channel, code, pattern] of expectations) {
    await assert.rejects(slack.readThread({ ...ORIGIN, channel }), (e: any) => {
      assert.equal(e.name, 'AdapterError')
      assert.equal(e.code, code, channel)
      assert.equal(e.retryable, false)
      assert.match(e.message, pattern)
      assert.ok(!e.message.includes(TOKEN))
      return true
    })
  }
  for (const bad of [undefined, {}, { channel: 'C1' }, { channel: 'C1', threadTs: 'abc' }, { channel: '../x', threadTs: '1.1' }, { channel: 'C1', threadTs: '1.1/..' }]) {
    await assert.rejects(slack.readThread(bad), (e: any) => e.code === 'bad_origin')
  }
})

test('reads are retried: 429 with Retry-After, 5xx, transient Slack errors, non-JSON', async () => {
  let n = 0
  const { base, requests } = await stub((req, res) => {
    n++
    if (n === 1) return send(res, { ok: false, error: 'ratelimited' }, 429, { 'retry-after': '2' })
    if (n === 2) return send(res, { error: 'boom' }, 502)
    if (n === 3) return send(res, { ok: false, error: 'internal_error' })
    send(res, { ok: true, messages: [{ user: 'U1', ts: '1.1', text: 'ok' }] })
  })
  const { slack, sleeps } = make(base, { requestTimeoutMs: 2000 })
  // users.info shares the stub: answer it with scope errors to keep the count of replies calls simple
  const messages = await slack.readThread(ORIGIN).catch((e) => e)
  // 3 attempts per call are allowed: attempt 1 = 429, 2 = 502, 3 = internal_error (last: raised)
  assert.equal(messages.code, 'slack_unavailable')
  assert.equal(requests.length, 3)
  assert.equal(sleeps[0], 2000) // Retry-After honoured
  assert.equal(sleeps.length, 2)

  // a fresh call succeeds on its 2nd attempt after a 500
  n = 2
  const ok = await slack.readThread(ORIGIN)
  assert.equal(ok[0].text, 'ok')
})

test('a read gives up on a persistent 429 and on a hang, within its budget', async () => {
  const { base } = await stub((req, res) => { if (req.path.endsWith('conversations.replies') && req.query.channel === 'CHANG') return; send(res, { ok: false, error: 'ratelimited' }, 429, { 'retry-after': '120' }) })
  const { slack } = make(base, { requestTimeoutMs: 150, readBudgetMs: 600 })
  await assert.rejects(slack.readThread(ORIGIN), (e: any) => e.code === 'rate_limited' && /Retry-After 120 s/.test(e.message) && e.retryable === false)
  const started = Date.now()
  await assert.rejects(slack.readThread({ ...ORIGIN, channel: 'CHANG' }), (e: any) => e.code === 'slack_timeout')
  assert.ok(Date.now() - started < 1500, 'bounded by the budget')
})

test('reply posts into the thread, neutralises broadcasts, returns the message id', async () => {
  const { base, requests } = await stub((req, res) => send(res, { ok: true, channel: req.json.channel, ts: '1731377999.000400' }))
  const { slack } = make(base)
  const id = await slack.reply(ORIGIN, 'result', 'Done <!channel> <!here|here> <!everyone> <!subteam^S123|@devs> @channel @here, @everyone <!date^1> see <@U1> https://x/mr/1')
  assert.equal(id, '1731377999.000400')
  assert.equal(requests.length, 1)
  const r = requests[0]
  assert.equal(r.method, 'POST')
  assert.equal(r.path, '/api/chat.postMessage')
  assert.equal(r.headers.authorization, `Bearer ${TOKEN}`)
  assert.match(r.headers['content-type'], /application\/json/)
  assert.equal(r.json.channel, 'C0123ABC')
  assert.equal(r.json.thread_ts, '1731377400.000100')
  assert.equal(r.json.unfurl_links, false)
  assert.equal(r.json.parse, 'none')
  assert.ok(!/<!(channel|here|everyone|subteam)/.test(r.json.text))
  assert.ok(!/(^|[^\w])@(channel|here|everyone)\b/.test(r.json.text))
  assert.match(r.json.text, /<@U1> https:\/\/x\/mr\/1/) // a single mention and links are kept
  assert.ok(!r.raw.includes(TOKEN))
  for (const purpose of ['ack', 'question', 'system']) assert.equal(await slack.reply(ORIGIN, purpose, 'x'), '1731377999.000400')
  const long = await slack.reply(ORIGIN, 'result', 'y'.repeat(9000))
  assert.equal(long, '1731377999.000400')
  assert.equal(requests.at(-1).json.text.length, 4000)
})

test('reply: argument errors are raised before any request', async () => {
  const { base, requests } = await stub((req, res) => send(res, { ok: true, ts: '1.1' }))
  const { slack } = make(base)
  await assert.rejects(slack.reply(ORIGIN, 'nonsense', 'x'), (e: any) => e.code === 'bad_purpose')
  await assert.rejects(slack.reply(ORIGIN, 'ack', '   '), (e: any) => e.code === 'bad_text')
  await assert.rejects(slack.reply(ORIGIN, 'ack', undefined), (e: any) => e.code === 'bad_text')
  await assert.rejects(slack.reply({ channel: 'C1' }, 'ack', 'x'), (e: any) => e.code === 'bad_origin')
  assert.equal(requests.length, 0)
})

test('reply is never retried: ok:false, 429, 500, timeout each cost exactly one request', async () => {
  const channels = { CNOTIN: ['not_in_channel', 'not_in_channel'], CARCH: ['is_archived', 'channel_archived'], CLONG: ['msg_too_long', 'message_too_long'], CAUTH: ['token_revoked', 'invalid_auth'] }
  const { base, requests } = await stub((req, res) => {
    const c = req.json.channel
    if (channels[c]) return send(res, { ok: false, error: channels[c][0] })
    if (c === 'C429') return send(res, { ok: false, error: 'ratelimited' }, 429, { 'retry-after': '1' })
    if (c === 'C500') return send(res, {}, 500)
    if (c === 'CNOID') return send(res, { ok: true })
    // CSLOW: never answers
  })
  const { slack, sleeps } = make(base, { requestTimeoutMs: 150 })
  for (const [channel, [, code]] of Object.entries(channels)) {
    const before = requests.length
    await assert.rejects(slack.reply({ ...ORIGIN, channel }, 'ack', 'x'), (e: any) => e.code === code && e.retryable === false && !e.message.includes(TOKEN))
    assert.equal(requests.length, before + 1)
  }
  for (const [channel, code] of [['C429', 'rate_limited'], ['C500', 'slack_unavailable'], ['CSLOW', 'slack_timeout'], ['CNOID', 'slack_bad_response']]) {
    const before = requests.length
    await assert.rejects(slack.reply({ ...ORIGIN, channel }, 'ack', 'x'), (e: any) => e.code === code && e.retryable === false)
    assert.equal(requests.length, before + 1, channel)
  }
  assert.deepEqual(sleeps, [])
})

test('an unreachable Slack: reads give up quietly, a write is retryable (nothing was sent)', async () => {
  const { base, server } = await stub((req, res) => send(res, { ok: true, ts: '1.1' }))
  const closed = new Promise((resolve) => server.close(resolve))
  server.closeAllConnections()
  await closed
  const { slack } = make(base, { requestTimeoutMs: 500 })
  await assert.rejects(slack.readThread(ORIGIN), (e: any) => e.code === 'slack_unreachable' && e.retryable === false && /ECONNREFUSED/.test(e.message))
  await assert.rejects(slack.reply(ORIGIN, 'ack', 'x'), (e: any) => e.code === 'slack_unreachable' && e.retryable === true && !e.message.includes(TOKEN))
})

test('neutralizeBroadcasts and retryAfterMs', () => {
  assert.equal(neutralizeBroadcasts('a <!channel> b'), 'a @​channel b')
  assert.equal(neutralizeBroadcasts('<!EVERYONE|everyone>'), '@​everyone')
  assert.equal(neutralizeBroadcasts('<!subteam^S1>'), '@​usergroup')
  assert.equal(neutralizeBroadcasts('ping @Here now, (@channel)'), 'ping @​Here now, (@​channel)')
  assert.equal(neutralizeBroadcasts('keep <@U1> and user@here.example'), 'keep <@U1> and user@here.example')
  assert.equal(neutralizeBroadcasts('<!date^1|x>'), '&lt;!date^1|x>')
  assert.equal(retryAfterMs('3'), 3000)
  assert.equal(retryAfterMs(null), 1000)
  assert.equal(retryAfterMs('soon'), 1000)
})

test('startThread posts without thread_ts, neutralises broadcasts, fetches the permalink', async () => {
  const { base, requests } = await stub((req, res) => {
    if (req.path === '/api/chat.postMessage') return send(res, { ok: true, channel: req.json.channel, ts: '1731378000.000500' })
    if (req.path === '/api/chat.getPermalink') return send(res, { ok: true, channel: req.query.channel, permalink: `https://x.slack.com/archives/${req.query.channel}/p1731378000000500` })
    send(res, { ok: false, error: 'unknown_method' })
  })
  const { slack } = make(base)
  const out = await slack.startThread('C0123ABC', '<@U1> 用 /fix 提了一个修复请求：\n> hi <!channel> @here\n进度会回在这条消息的讨论串里。')
  assert.deepEqual(out, { ts: '1731378000.000500', permalink: 'https://x.slack.com/archives/C0123ABC/p1731378000000500' })
  const post = requests[0]
  assert.equal(post.path, '/api/chat.postMessage')
  assert.equal(post.method, 'POST')
  assert.equal(post.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(post.json.channel, 'C0123ABC')
  assert.equal('thread_ts' in post.json, false)
  assert.equal(post.json.parse, 'none')
  assert.ok(!/<!channel>|(^|[^\w])@here\b/.test(post.json.text))
  assert.match(post.json.text, /^<@U1> 用 \/fix/) // the requester mention is kept
  assert.equal(requests[1].path, '/api/chat.getPermalink')
  assert.deepEqual(requests[1].query, { channel: 'C0123ABC', message_ts: '1731378000.000500' })
  assert.ok(requests.every((r) => !r.raw.includes(TOKEN) && !r.path.includes(TOKEN)))
  const long = await slack.startThread('C0123ABC', 'y'.repeat(9000))
  assert.equal(long.ts, '1731378000.000500')
  assert.equal(requests.filter((r) => r.path === '/api/chat.postMessage').at(-1).json.text.length, 4000)
})

test('startThread: the permalink is best effort; the post is sent once and its errors keep the Slack code', async () => {
  const { base, requests } = await stub((req, res) => {
    if (req.path === '/api/chat.getPermalink') return send(res, { ok: false, error: 'message_not_found' })
    send(res, { ok: true, ts: '1.1' })
  })
  const { slack, warnings } = make(base)
  assert.deepEqual(await slack.startThread('C1', 'x'), { ts: '1.1', permalink: null })
  assert.equal(warnings.length, 1)
  assert.ok(!warnings[0].includes(TOKEN))

  // not_in_channel is what a missing invite looks like: raised with its code, one attempt only
  const denied = await stub((req, res) => send(res, { ok: false, error: 'not_in_channel' }))
  const d = make(denied.base)
  await assert.rejects(d.slack.startThread('C1', 'x'), (e: any) => e.code === 'not_in_channel' && !e.message.includes(TOKEN))
  assert.equal(denied.requests.length, 1)
  // 5xx on the post is not repeated (a repeat could open two discussions)
  const down = await stub((req, res) => send(res, { error: 'boom' }, 502))
  await assert.rejects(make(down.base).slack.startThread('C1', 'x'), (e: any) => e.code === 'slack_unavailable')
  assert.equal(down.requests.length, 1)
  // no ts in the answer
  const odd = await stub((req, res) => send(res, { ok: true }))
  await assert.rejects(make(odd.base).slack.startThread('C1', 'x'), (e: any) => e.code === 'slack_bad_response')
  assert.equal(odd.requests.length, 1)
  assert.ok(requests.length >= 2)
})

test('startThread rejects a bad channel or empty text before any request', async () => {
  const { base, requests } = await stub((req, res) => send(res, { ok: true, ts: '1.1' }))
  const { slack } = make(base)
  for (const channel of [undefined, '', '../x', 'C1/..', 'C 1']) await assert.rejects(slack.startThread(channel, 'x'), (e: any) => e.code === 'bad_origin')
  for (const text of [undefined, '', '   ']) await assert.rejects(slack.startThread('C1', text), (e: any) => e.code === 'bad_text')
  assert.equal(requests.length, 0)
})

// ---- the outbox adapter (adapters.slack "outbox") ----

const outboxRig = () => {
  const appended = []
  const outbox = { append: async (m) => { appended.push(m); return { ...m, seq: appended.length } } }
  return { appended, slack: createOutboxSlack({}, { outbox }) as any }
}

test('outbox adapter: createSlackAdapter picks it, needs the shared outbox and no token', () => {
  const { appended } = outboxRig()
  const given = createSlackAdapter({ adapters: { slack: 'outbox' } }, { env: {}, outbox: { append: async () => ({ seq: 1 }) } } as any)
  assert.deepEqual(Object.keys(given).sort(), ['readThread', 'reply', 'startThread'])
  assert.throws(() => createSlackAdapter({ adapters: { slack: 'outbox' } }, { env: {} } as any), (e: any) => e.name === 'AdapterError' && e.code === 'no_outbox')
  assert.equal(appended.length, 0)
})

test('outbox adapter: readThread is the discussion the task holds (earlier, the /fix text, follow-ups)', async () => {
  const { slack } = outboxRig()
  const origin = {
    ...ORIGIN, text: 'button typo', user: { id: 'U1', name: 'alice' },
    followUps: [{ user: { id: 'U1' }, text: 'it says Add to crat', messageTs: '1731377500.000200', files: [] }],
  }
  const thread = await slack.readThread(origin)
  assert.deepEqual(thread.map((m) => m.text), ['button typo', 'it says Add to crat'])
  assert.equal(thread[0].user.name, 'alice')
  assert.deepEqual(thread, commandDiscussion(origin))
  for (const threadTs of ['../x', 'a b', '', undefined]) await assert.rejects(slack.readThread({ ...origin, threadTs }), (e: any) => e.code === 'bad_origin')
  // the outbox does not call Slack: any safe id is a key (the mock Slack Bot uses C-MOCK-FIX)
  assert.equal((await slack.readThread({ ...origin, channel: 'C-MOCK-FIX' })).length, 2)
})

test('outbox adapter: reply appends to the outbox with purpose and kind, neutralises broadcasts, cuts at 4000', async () => {
  const { slack, appended } = outboxRig()
  const id = await slack.reply(ORIGIN, 'system', 'hello <!channel> and @here', 'resumed')
  assert.equal(id, 'outbox:1')
  assert.deepEqual(appended[0], { channel: ORIGIN.channel, threadTs: ORIGIN.threadTs, purpose: 'system', kind: 'resumed', text: neutralizeBroadcasts('hello <!channel> and @here') })
  assert.doesNotMatch(appended[0].text, /<!channel>|@here/)
  await slack.reply(ORIGIN, 'result', 'x'.repeat(5000), 'ignored for a non-system purpose')
  assert.equal(appended[1].text.length, 4000); assert.equal(appended[1].kind, null); assert.equal(appended[1].purpose, 'result')
  await slack.reply(ORIGIN, 'system', 'no kind given')
  assert.equal(appended[2].kind, null)
  await assert.rejects(slack.reply(ORIGIN, 'bogus', 'x'), (e: any) => e.code === 'bad_purpose')
  await assert.rejects(slack.reply(ORIGIN, 'ack', '  '), (e: any) => e.code === 'bad_text')
  await assert.rejects(slack.reply({ channel: 'C1' }, 'ack', 'x'), (e: any) => e.code === 'bad_origin')
  assert.equal(appended.length, 3)
})

test('outbox adapter: startThread is not supported (the Slack Bot posts the task message)', async () => {
  const { slack } = outboxRig()
  await assert.rejects(slack.startThread('C0123ABC', 'x'), (e: any) => e.name === 'AdapterError' && e.code === 'not_supported')
})
