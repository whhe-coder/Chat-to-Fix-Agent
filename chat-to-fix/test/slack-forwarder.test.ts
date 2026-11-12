// The Slack event forwarder (scripts/slack-forwarder.ts): the pure conversion, and the Socket Mode
// loop against a local stub of the Slack API, a minimal local WebSocket server (RFC 6455 text frames,
// written here because node has no built-in WS server) and a stub of the control interface.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { sendFakeSlash } from '../scripts/fake-event.ts'
import { appMentionToEvent, createForwarder, slashCommandToEvent, slashFeedback } from '../scripts/slack-forwarder.ts'

const APP_TOKEN = 'xapp-1-secret-app-token'
const BOT_TOKEN = 'xoxb-secret-bot-token'
const CONTROL_TOKEN = 'control-secret-token'
const servers = []
const sockets = new Set<any>()
after(() => { for (const s of sockets) s.destroy(); for (const s of servers) { s.closeAllConnections?.(); s.close() } })

const until = async (check, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise((r) => setTimeout(r, 5)) }
  throw new Error('timed out waiting for a condition')
}

// ---- stubs ----
async function listen(server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  servers.push(server)
  return (server.address() as any).port
}

async function httpStub(handler) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const raw = Buffer.concat(chunks).toString('utf8')
      const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, json: raw.startsWith('{') ? JSON.parse(raw) : undefined }
      requests.push(record)
      handler(record, res, requests.length)
    })
  })
  const port = await listen(server)
  return { origin: `http://127.0.0.1:${port}`, requests, port }
}
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }

function frame(text) {
  const payload = Buffer.from(text)
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length])
    : payload.length < 65536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b })()])
  return Buffer.concat([header, payload])
}

// A WebSocket server: every connection becomes { send(obj), received[], close(), kill() }.
async function wsServer() {
  const connections = []
  const server = createServer()
  server.on('upgrade', (req, socket) => {
    sockets.add(socket)
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const conn: any = {
      received: [], closed: false,
      send: (obj) => socket.write(frame(JSON.stringify(obj))),
      close: () => { socket.write(Buffer.from([0x88, 0x00])); socket.end() },
      kill: () => socket.destroy(),
    }
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4 }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
        const masked = (buffer[1] & 0x80) !== 0
        if (buffer.length < offset + (masked ? 4 : 0) + length) return
        const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
        const start = offset + (masked ? 4 : 0)
        const payload = Buffer.from(buffer.subarray(start, start + length))
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
        const opcode = buffer[0] & 0x0f
        buffer = buffer.subarray(start + length)
        if (opcode === 1) conn.received.push(JSON.parse(payload.toString('utf8')))
        else if (opcode === 8) { conn.closed = true; try { socket.write(Buffer.from([0x88, 0x00])); socket.end() } catch {} }
      }
    })
    socket.on('close', () => { conn.closed = true; sockets.delete(socket) })
    socket.on('error', () => {})
    connections.push(conn)
  })
  const port = await listen(server)
  return { url: `ws://127.0.0.1:${port}/link`, connections }
}

const mention = (n, event: any = {}, extra: any = {}) => ({
  type: 'events_api', envelope_id: `env-${n}`, accepts_response_payload: false,
  payload: {
    type: 'event_callback', event_id: `Ev${n}`, team_id: 'T1', authorizations: [{ user_id: 'UBOT', is_bot: true }],
    event: { type: 'app_mention', user: 'U1', text: '<@UBOT> the login button does nothing', ts: '1731377400.000100', channel: 'C0123ABC', ...event },
    ...extra,
  },
})

// ---- the pure conversion ----
test('appMentionToEvent: the /events body of an app_mention', () => {
  const r: any = appMentionToEvent(mention(1).payload)
  assert.equal(r.ok, true)
  assert.deepEqual(r.body, {
    eventId: 'Ev1', channel: 'C0123ABC', threadTs: '1731377400.000100', messageTs: '1731377400.000100',
    user: { id: 'U1' }, text: 'the login button does nothing', files: [],
  })
})

test('appMentionToEvent: thread, entities, files, bare mention', () => {
  const inThread: any = appMentionToEvent(mention(2, {
    ts: '1731377500.000200', thread_ts: '1731377400.000100', text: '<@UBOT>, check &lt;b&gt; &amp; <@UOTHER> too',
    files: [{ name: 'shot.png', permalink: 'https://slack/f/1', url_private: 'https://slack/private/1' }, { title: 'log', url_private: 'https://slack/private/2' }],
  }).payload)
  assert.equal(inThread.body.threadTs, '1731377400.000100')
  assert.equal(inThread.body.messageTs, '1731377500.000200')
  assert.equal(inThread.body.text, 'check <b> & <@UOTHER> too')
  assert.deepEqual(inThread.body.files, [{ name: 'shot.png', url: 'https://slack/f/1' }, { name: 'log', url: 'https://slack/private/2' }])
  // a mention of someone else is not cut; only the bot's own leading mention is
  const other: any = appMentionToEvent(mention(3, { text: '<@UOTHER> look <@UBOT>' }).payload)
  assert.equal(other.body.text, '<@UOTHER> look <@UBOT>')
  // a bare @ keeps the mention so that /events gets a non-empty text
  const bare: any = appMentionToEvent(mention(4, { text: '<@UBOT>', thread_ts: '1.1' }).payload)
  assert.equal(bare.ok, true)
  assert.equal(bare.body.text, '<@UBOT>')
  // without authorizations the first leading mention is cut
  const noAuth: any = appMentionToEvent({ ...mention(5).payload, authorizations: undefined })
  assert.equal(noAuth.body.text, 'the login button does nothing')
})

test('appMentionToEvent: bots, edits, our own messages and other events are ignored', () => {
  const skip = (event, extra?) => (appMentionToEvent(mention(9, event, extra).payload) as any)
  assert.match(skip({ bot_id: 'B1' }).reason, /bot_message/)
  assert.match(skip({ subtype: 'bot_message' }).reason, /bot_message/)
  assert.match(skip({ subtype: 'message_changed' }).reason, /message_changed/)
  assert.match(skip({ edited: { user: 'U1', ts: '1.1' } }).reason, /edited/)
  assert.match(skip({ user: 'UBOT' }).reason, /own_message/)
  assert.match(skip({ type: 'message' }).reason, /not_app_mention/)
  assert.match(skip({ channel: undefined }).reason, /incomplete_event/)
  assert.match(skip({}, { event_id: undefined }).reason, /no_event_id/)
  assert.equal((appMentionToEvent({}) as any).reason, 'no_event')
  assert.equal(skip({ subtype: 'file_share' }).ok, true) // a mention with an upload is a normal @
})

// ---- the loop ----
function setup(extra: any = {}) {
  return (async () => {
    const ws = await wsServer()
    const slack = await httpStub((req, res) => {
      if (req.path === '/api/apps.connections.open') {
        if (req.headers.authorization !== `Bearer ${APP_TOKEN}`) return json(res, { ok: false, error: 'invalid_auth' })
        return json(res, { ok: true, url: ws.url })
      }
      if (req.headers.authorization !== `Bearer ${BOT_TOKEN}`) return json(res, { ok: false, error: 'invalid_auth' })
      if (req.path === '/api/chat.getPermalink') return json(res, { ok: true, permalink: `https://example.slack.com/archives/${req.query.channel}/p${req.query.message_ts.replace('.', '')}` })
      if (req.path === '/api/users.info') return json(res, { ok: true, user: { profile: { display_name: 'ann' } } })
      json(res, { ok: false, error: 'unknown_method' })
    })
    const control = await httpStub((req, res) => json(res, { taskId: `t${req.path.length}`, state: 'queued' }, 202))
    const logs = []
    const forwarder = createForwarder({
      appToken: APP_TOKEN, botToken: BOT_TOKEN, url: control.origin, token: CONTROL_TOKEN, apiBase: `${slack.origin}/api`,
      log: (m) => logs.push(m), minBackoffMs: 10, maxBackoffMs: 40, disconnectDelayMs: 10, postRetryMs: 5, helloTimeoutMs: 2000, ...extra,
    })
    return { ws, slack, control, forwarder, logs }
  })()
}

test('the loop: hello, ack every envelope, deliver app_mentions, reconnect on disconnect and on a dropped socket', async () => {
  const { ws, slack, control, forwarder, logs } = await setup()
  const done = forwarder.run()

  const c1 = await until(() => ws.connections[0])
  c1.send({ type: 'hello', num_connections: 1 })
  c1.send(mention('A', {}, { retry_attempt: 0 }))
  c1.send(mention('B', { bot_id: 'B1' })) // a bot message: acknowledged, not delivered
  c1.send({ type: 'slash_commands', envelope_id: 'env-S', payload: {} }) // other envelope types: acknowledged only
  await until(() => c1.received.length === 3)
  assert.deepEqual(c1.received, [{ envelope_id: 'env-A' }, { envelope_id: 'env-B' }, { envelope_id: 'env-S' }])
  await until(() => control.requests.length === 1)
  const post = control.requests[0]
  assert.equal(post.method, 'POST')
  assert.equal(post.path, '/events')
  assert.equal(post.headers['x-chat-to-fix-token'], CONTROL_TOKEN)
  assert.deepEqual(post.json, {
    eventId: 'EvA', channel: 'C0123ABC', threadTs: '1731377400.000100', messageTs: '1731377400.000100',
    user: { id: 'U1', name: 'ann' }, text: 'the login button does nothing', files: [],
    permalink: 'https://example.slack.com/archives/C0123ABC/p1731377400000100',
  })

  // Slack asks for a reconnect
  c1.send({ type: 'disconnect', reason: 'refresh_requested' })
  const c2 = await until(() => ws.connections[1])
  c2.send({ type: 'hello' })
  c2.send(mention('C'))
  await until(() => control.requests.length === 2)
  assert.equal(control.requests[1].json.eventId, 'EvC')

  // the socket drops without a word
  c2.kill()
  const c3 = await until(() => ws.connections[2])
  c3.send({ type: 'hello' })
  c3.send(mention('D'))
  await until(() => control.requests.length === 3)
  assert.equal(slack.requests.filter((r) => r.path === '/api/apps.connections.open').length, 3)
  // names are cached: users.info was asked once for U1 over three events
  assert.equal(slack.requests.filter((r) => r.path === '/api/users.info').length, 1)

  await forwarder.stop()
  await done
  const everything = logs.join('\n')
  for (const secret of [APP_TOKEN, BOT_TOKEN, CONTROL_TOKEN]) assert.ok(!everything.includes(secret), 'no token in the log')
  assert.ok(!everything.includes('login button'), 'no message text in the log')
})

test('delivery: retried on 5xx, final on 4xx, dropped when the control interface is down', async () => {
  const slack = await httpStub((req, res) => json(res, { ok: true, url: 'ws://127.0.0.1:1/' }))
  const answers = [503, 202, 422, 429, 200]
  const control = await httpStub((req, res, n) => json(res, answers[n - 1] === 422 ? { error: 'channel_not_bound' } : answers[n - 1] === 429 ? { error: 'queue_full' } : { taskId: 't1' }, answers[n - 1]))
  const logs = []
  const options = { appToken: APP_TOKEN, url: control.origin, token: CONTROL_TOKEN, apiBase: `${slack.origin}/api`, log: (m) => logs.push(m), postRetryMs: 2 }
  const forwarder = createForwarder(options)
  const first: any = await forwarder.handleEnvelope(mention(1))
  assert.equal(first.status, 202) // the 503 was retried
  assert.equal(control.requests.length, 2)
  assert.equal(((await forwarder.handleEnvelope(mention(2))) as any).status, 422)
  assert.equal(((await forwarder.handleEnvelope(mention(3))) as any).status, 429)
  assert.equal(control.requests.length, 4) // 4xx is final: no retry
  assert.equal(await forwarder.handleEnvelope(mention(4, { bot_id: 'B' })), undefined)
  assert.ok(logs.some((l) => /channel_not_bound/.test(l)) && logs.some((l) => /queue_full/.test(l)))
  // no bot token: no permalink and no name are added
  assert.equal(slack.requests.length, 0)
  assert.equal('permalink' in control.requests[3].json, false)

  const down = createForwarder({ ...options, url: 'http://127.0.0.1:1', postAttempts: 2 })
  assert.equal(await down.handleEnvelope(mention(5)), undefined)
  assert.ok(logs.some((l) => /unreachable/.test(l) && !l.includes(CONTROL_TOKEN)))
})

test('a bad app token stops the loop with an error that holds no token', async () => {
  const slack = await httpStub((req, res) => json(res, { ok: false, error: 'invalid_auth' }))
  const forwarder = createForwarder({ appToken: APP_TOKEN, url: 'http://127.0.0.1:1', token: CONTROL_TOKEN, apiBase: `${slack.origin}/api`, log: () => {}, minBackoffMs: 5 })
  await assert.rejects(forwarder.run(), (e: any) => e.fatal === true && /invalid_auth/.test(e.message) && !e.message.includes(APP_TOKEN))
  assert.equal(slack.requests.length, 1)
})

test('a failing apps.connections.open is retried with backoff; a rate limit waits for Retry-After', async () => {
  let n = 0
  const ws = await wsServer()
  const slack = await httpStub((req, res) => {
    n++
    if (n === 1) return json(res, { ok: false, error: 'service_unavailable' })
    if (n === 2) { res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"ratelimited"}') }
    json(res, { ok: true, url: ws.url })
  })
  const logs = []
  const forwarder = createForwarder({ appToken: APP_TOKEN, url: 'http://127.0.0.1:1', token: CONTROL_TOKEN, apiBase: `${slack.origin}/api`, log: (m) => logs.push(m), minBackoffMs: 5, maxBackoffMs: 10 })
  const done = forwarder.run()
  await until(() => ws.connections.length === 1)
  assert.equal(slack.requests.length, 3)
  assert.ok(logs.some((l) => /service_unavailable/.test(l)) && logs.some((l) => /rate limited/.test(l)))
  await forwarder.stop()
  await done
})

// ---- the same logic with an injected socket ----
class FakeSocket {
  static instances = []
  listeners: any = {}
  sent = []
  closed = false
  url: string
  constructor(url) { this.url = url; FakeSocket.instances.push(this) }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  emit(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn(event) }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { if (!this.closed) { this.closed = true; setTimeout(() => this.emit('close'), 0) } }
}

test('injected socket: the ack is sent before the event is handled; a silent connection is dropped and redone', async () => {
  FakeSocket.instances = []
  const slack = await httpStub((req, res) => json(res, { ok: true, url: 'ws://fake/link' }))
  const control = await httpStub((req, res) => json(res, { taskId: 't1' }, 202))
  const forwarder = createForwarder({
    appToken: APP_TOKEN, url: control.origin, token: CONTROL_TOKEN, apiBase: `${slack.origin}/api`, log: () => {},
    WebSocketImpl: FakeSocket, minBackoffMs: 5, maxBackoffMs: 10, helloTimeoutMs: 40,
  })
  const done = forwarder.run()
  const s1: any = await until(() => FakeSocket.instances[0])
  // no hello: after helloTimeoutMs the socket is closed and a new one is opened
  const s2: any = await until(() => FakeSocket.instances[1])
  assert.equal(s1.closed, true)
  s2.emit('message', { data: JSON.stringify({ type: 'hello' }) })
  s2.emit('message', { data: 'not json' }) // ignored
  s2.emit('message', { data: JSON.stringify(mention('X')) })
  assert.deepEqual(s2.sent, [{ envelope_id: 'env-X' }]) // acknowledged synchronously
  await until(() => control.requests.length === 1)
  s2.emit('message', { data: JSON.stringify({ type: 'disconnect', reason: 'warning' }) })
  assert.equal(s2.closed, true)
  await until(() => FakeSocket.instances[2])
  await forwarder.stop()
  await done
  assert.equal(FakeSocket.instances[2].closed, true)
})


// ---- the slash command /fix ----
const slashPayload = (extra: any = {}) => ({
  command: '/fix', text: 'login page: the "forgot password" link does nothing', channel_id: 'C0123ABC', channel_name: 'dev-team',
  user_id: 'U1', user_name: 'ann', team_id: 'T1', trigger_id: 'trig.1', response_url: 'https://hooks.slack.test/commands/T1/secretpath/xyz',
  api_app_id: 'A1', ...extra,
})
const slashEnvelope = (n, extra: any = {}) => ({ type: 'slash_commands', envelope_id: `env-s${n}`, accepts_response_payload: true, payload: slashPayload({ trigger_id: `trig.${n}`, ...extra }) })

test('slashCommandToEvent: the /events body of a slash command', () => {
  const r: any = slashCommandToEvent(slashPayload())
  assert.equal(r.ok, true)
  assert.deepEqual(r.body, {
    source: 'slash', eventId: 'slash:trig.1', channel: 'C0123ABC', user: { id: 'U1', name: 'ann' },
    text: 'login page: the "forgot password" link does nothing',
  })
  // no threadTs and no responseUrl: the forwarder keeps response_url to itself
  assert.ok(!('threadTs' in r.body) && !('responseUrl' in r.body) && !JSON.stringify(r.body).includes('hooks.slack'))
  // escaped entities are unescaped, links and mentions stay; the name is left out when Slack gave none; a private channel is fine
  const escaped: any = slashCommandToEvent(slashPayload({ text: '  fix &lt;b&gt; &amp; ask <@U9|bob>  ', user_name: undefined, channel_id: 'G0PRIVATE', channel_name: 'privategroup' }))
  assert.equal(escaped.ok, true)
  assert.equal(escaped.body.text, 'fix <b> & ask <@U9|bob>')
  assert.deepEqual(escaped.body.user, { id: 'U1' })
  assert.equal(escaped.body.channel, 'G0PRIVATE')
  // a configured command name, with or without the slash
  assert.equal((slashCommandToEvent(slashPayload({ command: '/repair' }), { command: '/repair' }) as any).ok, true)
  assert.equal((slashCommandToEvent(slashPayload({ command: '/repair' }), { command: 'repair' }) as any).ok, true)
})

test('slashCommandToEvent: wrong command, empty text, DMs and other non-channel contexts', () => {
  const wrong: any = slashCommandToEvent(slashPayload({ command: '/other' }))
  assert.equal(wrong.ok, false)
  assert.match(wrong.reason, /wrong_command/)
  assert.equal(wrong.message, undefined) // ignored, nothing to tell the user
  assert.match((slashCommandToEvent(slashPayload(), { command: '/repair' }) as any).reason, /wrong_command/)
  assert.equal((slashCommandToEvent({}) as any).ok, false)
  assert.equal((slashCommandToEvent(undefined) as any).ok, false)

  for (const text of ['', '   ', undefined]) {
    const empty: any = slashCommandToEvent(slashPayload({ text }))
    assert.equal(empty.ok, false)
    assert.equal(empty.reason, 'empty_text')
    assert.match(empty.message, /用法：\/fix /)
  }
  assert.equal((slashCommandToEvent(slashPayload({ text: '' }), { command: '/repair' }) as any).message, undefined) // a /fix payload is not ours when the command is /repair
  assert.match((slashCommandToEvent(slashPayload({ command: '/repair', text: '' }), { command: '/repair' }) as any).message, /用法：\/repair /)

  const dm: any = slashCommandToEvent(slashPayload({ channel_id: 'D0DM', channel_name: 'directmessage' }))
  assert.equal(dm.ok, false)
  assert.equal(dm.reason, 'dm')
  assert.match(dm.message, /请在绑定的频道里用 \/fix/)
  assert.equal((slashCommandToEvent(slashPayload({ channel_id: 'D0DM', channel_name: undefined })) as any).reason, 'dm')
  assert.equal((slashCommandToEvent(slashPayload({ channel_id: 'G0MPIM', channel_name: 'mpdm-a--b-1' })) as any).reason, 'not_a_channel')
  assert.match((slashCommandToEvent(slashPayload({ channel_id: 'X0' })) as any).message, /请在绑定的频道里用 \/fix/)
  for (const gone of ['channel_id', 'user_id', 'trigger_id']) assert.equal((slashCommandToEvent(slashPayload({ [gone]: undefined })) as any).reason, 'incomplete_command')
})

test('slashFeedback: every answer of /events has its ephemeral text', () => {
  assert.equal(slashFeedback({ status: 202, body: { taskId: 'T-12', permalink: 'https://example.slack.com/archives/C1/p1' } }), '已建任务 T-12：https://example.slack.com/archives/C1/p1')
  assert.equal(slashFeedback({ status: 202, body: { taskId: 'T-12' } }), '已建任务 T-12')
  assert.match(slashFeedback({ status: 200, body: { taskId: 'T-12', duplicate: true } }), /^已建任务 T-12/)
  assert.equal(slashFeedback({ status: 422, body: { error: 'channel_not_bound' } }), '这个频道没有接入 Chat-to-Fix，请在绑定的频道里用 /fix。')
  assert.equal(slashFeedback({ status: 429, body: { error: 'queue_full' } }), '修复队列已满，请稍后再试。')
  assert.equal(slashFeedback({ status: 502, body: { error: 'not_in_channel' } }), '机器人不在这个频道，请先邀请它。')
  assert.match(slashFeedback({ status: 502, body: { error: 'channel_not_found' } }), /开头消息（channel_not_found）/)
  assert.match(slashFeedback({ status: 502, body: { error: 'bad<script> code' } }), /（badscriptcode）/)
  assert.equal(slashFeedback(undefined), '服务暂时不可用，请稍后再试。')
  assert.equal(slashFeedback({ status: 503, body: {} }), '服务暂时不可用，请稍后再试。')
  assert.match(slashFeedback({ status: 401, body: { error: 'unauthorized' } }), /HTTP 401/)
})

// A stub of Slack's response_url plus a control interface that answers with a chosen status.
async function slashSetup(extra: any = {}) {
  const hooks = await httpStub((req, res) => { res.writeHead(200); res.end('ok') })
  const answers: any[] = []
  const control = await httpStub((req, res) => {
    const [status, body] = answers.shift() ?? [202, { taskId: 'T-1', permalink: 'https://example.slack.com/archives/C0123ABC/p1731377400000100' }]
    json(res, body, status)
  })
  const logs = []
  const forwarder = createForwarder({
    appToken: APP_TOKEN, botToken: BOT_TOKEN, url: control.origin, token: CONTROL_TOKEN, apiBase: 'http://127.0.0.1:1/api',
    log: (m) => logs.push(m), postRetryMs: 2, postAttempts: 3, ...extra,
  })
  const responseUrl = `${hooks.origin}/commands/T1/secretpath/xyz`
  return { hooks, control, answers, logs, forwarder, responseUrl }
}

test('slash: each answer of /events becomes one ephemeral message to response_url, once, never logged', async () => {
  const { hooks, control, answers, logs, forwarder, responseUrl } = await slashSetup()
  const cases: [number, any, RegExp][] = [
    [202, { taskId: 'T-7', permalink: 'https://example.slack.com/archives/C0123ABC/p1' }, /^已建任务 T-7：https:\/\/example\.slack\.com\/archives\/C0123ABC\/p1$/],
    [422, { error: 'channel_not_bound' }, /^这个频道没有接入 Chat-to-Fix，请在绑定的频道里用 \/fix。$/],
    [429, { error: 'queue_full' }, /^修复队列已满，请稍后再试。$/],
    [502, { error: 'not_in_channel' }, /^机器人不在这个频道，请先邀请它。$/],
    [200, { taskId: 'T-7', state: 'queued', duplicate: true }, /^已建任务 T-7/],
  ]
  for (const [i, [status, body, expected]] of cases.entries()) {
    answers.push([status, body])
    const result: any = await forwarder.handleEnvelope(slashEnvelope(i + 1, { response_url: responseUrl }))
    assert.equal(result.status, status)
    assert.equal(result.sent, true)
    assert.equal(hooks.requests.length, i + 1) // exactly one message per command
    const message = hooks.requests[i]
    assert.equal(message.method, 'POST')
    assert.equal(message.path, '/commands/T1/secretpath/xyz')
    assert.equal(message.headers.authorization, undefined)
    assert.equal(message.json.response_type, 'ephemeral')
    assert.match(message.json.text, expected)
    assert.deepEqual(Object.keys(message.json).sort(), ['response_type', 'text'])
  }
  // 502 with an adapter code is an answer, not retried; one POST per command in total
  assert.equal(control.requests.length, 5)
  const sent = control.requests[0]
  assert.equal(sent.path, '/events')
  assert.equal(sent.headers['x-chat-to-fix-token'], CONTROL_TOKEN)
  assert.deepEqual(sent.json, { source: 'slash', eventId: 'slash:trig.1', channel: 'C0123ABC', user: { id: 'U1', name: 'ann' }, text: 'login page: the "forgot password" link does nothing' })
  const everything = logs.join('\n')
  for (const secret of [APP_TOKEN, BOT_TOKEN, CONTROL_TOKEN, 'secretpath', 'hooks.slack', responseUrl, 'forgot password']) assert.ok(!everything.includes(secret), `the log holds ${secret}`)
})

test('slash: a 5xx without a code is retried; an unreachable service and a failing response_url are survived', async () => {
  const { hooks, control, answers, logs, forwarder, responseUrl } = await slashSetup()
  answers.push([503, {}], [202, { taskId: 'T-2' }])
  const retried: any = await forwarder.handleEnvelope(slashEnvelope(1, { response_url: responseUrl }))
  assert.equal(retried.status, 202)
  assert.equal(control.requests.length, 2)
  assert.equal(hooks.requests[0].json.text, '已建任务 T-2')

  const down = createForwarder({ appToken: APP_TOKEN, url: 'http://127.0.0.1:1', token: CONTROL_TOKEN, log: (m) => logs.push(m), postRetryMs: 2, postAttempts: 2 })
  const unreachable: any = await down.handleEnvelope(slashEnvelope(2, { response_url: responseUrl }))
  assert.equal(unreachable.status, undefined)
  assert.equal(unreachable.sent, true)
  assert.equal(hooks.requests[1].json.text, '服务暂时不可用，请稍后再试。')

  // a response_url that refuses or cannot be reached: logged without the URL, no retry, no throw
  const refusing = await httpStub((req, res) => { res.writeHead(404); res.end('no_service') })
  const refused: any = await forwarder.handleEnvelope(slashEnvelope(3, { response_url: `${refusing.origin}/commands/secretpath` }))
  assert.equal(refused.sent, false)
  assert.equal(refusing.requests.length, 1)
  const dead: any = await forwarder.handleEnvelope(slashEnvelope(4, { response_url: 'http://127.0.0.1:1/commands/secretpath' }))
  assert.equal(dead.sent, false)
  const none: any = await forwarder.handleEnvelope(slashEnvelope(5, { response_url: undefined }))
  assert.equal(none.sent, false)
  const everything = logs.join('\n')
  assert.ok(/HTTP 404/.test(everything) && /could not be sent/.test(everything))
  assert.ok(!everything.includes('secretpath') && !everything.includes(refusing.origin) && !everything.includes('127.0.0.1:1'))
})

test('slash: a redelivered envelope (same trigger_id) answers only once; wrong command, empty text and DMs never reach /events', async () => {
  const { hooks, control, logs, forwarder, responseUrl } = await slashSetup()
  assert.ok(await forwarder.handleEnvelope(slashEnvelope(1, { response_url: responseUrl })))
  assert.equal(await forwarder.handleEnvelope(slashEnvelope(1, { response_url: responseUrl })), undefined)
  assert.equal(control.requests.length, 1)
  assert.equal(hooks.requests.length, 1)
  for (const extra of [{ command: '/other' }, { text: '  ' }, { channel_id: 'D1', channel_name: 'directmessage' }]) {
    assert.equal(await forwarder.handleEnvelope(slashEnvelope(9, { ...extra, response_url: responseUrl })), undefined)
  }
  assert.equal(control.requests.length, 1)
  assert.equal(hooks.requests.length, 1) // the immediate texts travel in the acknowledgement, not through response_url
  assert.ok(logs.some((l) => /already handled/.test(l)) && logs.some((l) => /empty_text/.test(l)) && logs.some((l) => /wrong_command/.test(l)) && logs.some((l) => /ignored a slash command: dm/.test(l)))
})

test('slash: the acknowledgement comes first, with a usage text for empty text and DMs; app_mention keeps working', async () => {
  FakeSocket.instances = []
  const { hooks, control, logs } = await slashSetup()
  const slack = await httpStub((req, res) => json(res, { ok: true, url: 'ws://fake/link' }))
  const forwarder = createForwarder({
    appToken: APP_TOKEN, url: control.origin, token: CONTROL_TOKEN, apiBase: `${slack.origin}/api`, log: (m) => logs.push(m),
    WebSocketImpl: FakeSocket, minBackoffMs: 5, maxBackoffMs: 10, helloTimeoutMs: 2000, postRetryMs: 2,
  })
  const done = forwarder.run()
  const socket: any = await until(() => FakeSocket.instances[0])
  socket.emit('message', { data: JSON.stringify({ type: 'hello' }) })
  const responseUrl = `${hooks.origin}/commands/T1/secretpath/xyz`
  const emit = (envelope) => socket.emit('message', { data: JSON.stringify(envelope) })

  // a valid command: the plain acknowledgement is already sent when emit returns, /events and response_url come after
  emit(slashEnvelope(1, { response_url: responseUrl }))
  assert.deepEqual(socket.sent, [{ envelope_id: 'env-s1' }])
  assert.equal(control.requests.length, 0)
  await until(() => hooks.requests.length === 1)
  assert.equal(control.requests.length, 1)
  assert.equal(hooks.requests[0].json.text, '已建任务 T-1：https://example.slack.com/archives/C0123ABC/p1731377400000100')

  // empty text and a DM: the usage text is in the acknowledgement; nothing else happens
  emit(slashEnvelope(2, { text: '', response_url: responseUrl }))
  emit(slashEnvelope(3, { channel_id: 'D0DM', channel_name: 'directmessage', response_url: responseUrl }))
  emit(slashEnvelope(4, { command: '/other', response_url: responseUrl }))
  assert.equal(socket.sent[1].envelope_id, 'env-s2')
  assert.equal(socket.sent[1].payload.response_type, 'ephemeral')
  assert.match(socket.sent[1].payload.text, /用法：\/fix /)
  assert.equal(socket.sent[2].envelope_id, 'env-s3')
  assert.match(socket.sent[2].payload.text, /请在绑定的频道里用 \/fix/)
  assert.deepEqual(socket.sent[3], { envelope_id: 'env-s4' })

  // an app_mention (the follow-up path in a thread) is handled as before, after a slash command
  emit(mention('M', { thread_ts: '1731377000.000900', text: '<@UBOT> here is the answer' }))
  await until(() => control.requests.length === 2)
  assert.equal(control.requests[1].json.eventId, 'EvM')
  assert.equal(control.requests[1].json.threadTs, '1731377000.000900')
  assert.equal(hooks.requests.length, 1)
  assert.equal(control.requests.length, 2)

  await forwarder.stop()
  await done
  const everything = logs.join('\n')
  for (const secret of [APP_TOKEN, CONTROL_TOKEN, 'secretpath', responseUrl]) assert.ok(!everything.includes(secret), `the log holds ${secret}`)
})

test('slash: a custom command name is the one that is handled', async () => {
  const { hooks, control, forwarder: _unused, responseUrl } = await slashSetup()
  const forwarder = createForwarder({ appToken: APP_TOKEN, url: control.origin, token: CONTROL_TOKEN, log: () => {}, slashCommand: '/repair', postRetryMs: 2 })
  assert.equal(await forwarder.handleEnvelope(slashEnvelope(1, { response_url: responseUrl })), undefined) // /fix is not ours now
  const r: any = await forwarder.handleEnvelope(slashEnvelope(2, { command: '/repair', response_url: responseUrl }))
  assert.equal(r.status, 202)
  assert.equal(hooks.requests.length, 1)
})

test('fake-event --slash: posts the slash body to /events and prints the result with the ephemeral text', async () => {
  const control = await httpStub((req, res) => json(res, { taskId: 'T-3', permalink: 'fake://slack/C1/1.1' }, 202))
  const r: any = await sendFakeSlash({ channel: 'C1', text: 'From the fake', url: control.origin, token: CONTROL_TOKEN })
  assert.equal(r.ok, true)
  assert.equal(r.status, 202)
  assert.equal(r.ephemeral, '已建任务 T-3：fake://slack/C1/1.1')
  const sent = control.requests[0]
  assert.equal(sent.path, '/events')
  assert.equal(sent.headers['x-chat-to-fix-token'], CONTROL_TOKEN)
  assert.equal(sent.json.source, 'slash')
  assert.match(sent.json.eventId, /^slash:fake\./)
  assert.deepEqual({ channel: sent.json.channel, text: sent.json.text, user: sent.json.user }, { channel: 'C1', text: 'From the fake', user: { id: 'U-FAKE', name: 'tester' } })
  assert.ok(!('threadTs' in sent.json))
  // empty text and a DM never reach /events
  const empty: any = await sendFakeSlash({ channel: 'C1', text: ' ', url: control.origin, token: CONTROL_TOKEN })
  assert.equal(empty.ok, false)
  assert.match(empty.ephemeral, /用法/)
  assert.equal((await sendFakeSlash({ channel: 'D1', text: 'x', url: control.origin, token: CONTROL_TOKEN }) as any).ok, false)
  assert.equal(control.requests.length, 1)

  const root = new URL('..', import.meta.url).pathname
  const out: string = await new Promise((resolve, reject) => execFile(process.execPath, [`${root}scripts/fake-event.ts`, '--slash', '--channel', 'C1', '--text', 'From the command line'], { env: { PATH: process.env.PATH, CHAT_TO_FIX_URL: control.origin, CHAT_TO_FIX_HTTP_TOKEN: CONTROL_TOKEN } }, (e, stdout) => (e ? reject(e) : resolve(stdout))))
  const printed = JSON.parse(out)
  assert.equal(printed.status, 202)
  assert.equal(printed.response.taskId, 'T-3')
  assert.equal(printed.ephemeral, '已建任务 T-3：fake://slack/C1/1.1')
  assert.equal(control.requests[1].json.text, 'From the command line')
})
