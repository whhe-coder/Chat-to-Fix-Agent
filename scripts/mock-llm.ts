// A minimal Anthropic-Messages mock for the smoke run (scripts/smoke.ts): every request is
// answered with one fixed text, streamed the way the real API streams it, and logged as one JSON
// line with what the smoke run checks: the session the request belongs to, the tool names offered,
// the system prompt's first characters and the last user message. No tool calls, no state.
// Smaller than bot/dev/mock-llm.mjs, which scripts the whole DS Bot team.
//
//   MOCK_LOG=<file> MOCK_REPLY=<text> node scripts/mock-llm.ts     (MOCK_PORT, default 0 = any)
//
// It also serves as the HTTP(S) proxy of the smoke run, refusing and logging every request for
// another host (`proxyRequest` / `proxyConnect` log lines).
// Listens on 127.0.0.1 only and prints "mock-llm: listening on 127.0.0.1:<port>" when ready.
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const PORT = Number(process.env.MOCK_PORT ?? 0)
const LOG = process.env.MOCK_LOG
if (!LOG) { console.error('mock-llm: set MOCK_LOG'); process.exit(2) }
mkdirSync(dirname(LOG), { recursive: true })
const REPLY = process.env.MOCK_REPLY ?? 'MOCK-REPLY: received.'
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 100)
let seq = 0

const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((b) => (b?.type === 'text' ? b.text : b?.type === 'tool_result' ? textOf(b.content) : '')).join('\n') : ''
const sse = (res, data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
const log = (entry) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n')

const server = createServer((req, res) => {
  // Used as HTTP(S)_PROXY by the smoke run: any request for another host arrives here as an
  // absolute URL (http) or a CONNECT (https); it is logged and refused, so nothing leaves.
  if (/^https?:\/\//i.test(req.url)) {
    log({ id: ++seq, proxyRequest: `${req.method} ${req.url.replace(/\?.*$/, '')}` })
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('mock-llm: outward request refused')
    return
  }
  const path = req.url.split('?')[0]
  if (req.method === 'GET' && path.endsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ type: 'model', id: 'mock-model', display_name: 'Mock' }], has_more: false }))
    return
  }
  if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
    log({ id: ++seq, unexpected: `${req.method} ${req.url}` })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `no route ${req.method} ${req.url}` } }))
    return
  }
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    const id = ++seq
    let body
    try { body = JSON.parse(raw) } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad json' } }))
      return
    }
    const system = Array.isArray(body.system) ? body.system.map((b) => b.text ?? '').join('\n') : String(body.system ?? '')
    const messages = body.messages ?? []
    log({
      id,
      model: body.model,
      stream: body.stream === true,
      session: req.headers['x-deepseek-harness-session-id'] ?? null,
      // Header names only (never values): shows which attribution headers the adapter sends.
      headers: Object.keys(req.headers).filter((h) => !/^(authorization|x-api-key|cookie)$/i.test(h)).sort(),
      toolNames: (body.tools ?? []).map((t) => t.name ?? t.type),
      system: system.slice(0, 200),
      messages: messages.length,
      allUserText: messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n----\n').slice(-4000),
      last: textOf(messages.at(-1)?.content).slice(0, 2000),
      reply: REPLY,
    })
    const usage = { input_tokens: Math.ceil(raw.length / 4), output_tokens: 0 }
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: `mock-${id}`, type: 'message', role: 'assistant', model: body.model ?? 'mock', content: [{ type: 'text', text: REPLY }], stop_reason: 'end_turn', stop_sequence: null, usage: { ...usage, output_tokens: 10 } }))
      return
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      sse(res, { type: 'message_start', message: { id: `mock-${id}`, type: 'message', role: 'assistant', model: body.model ?? 'mock', content: [], stop_reason: null, stop_sequence: null, usage } })
      sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } })
      sse(res, { type: 'content_block_stop', index: 0 })
      sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
      sse(res, { type: 'message_stop' })
      res.end()
    }, DELAY)
  })
})

server.on('connect', (req, socket) => {
  log({ id: ++seq, proxyConnect: req.url })
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
})
server.listen(PORT, '127.0.0.1', () => console.log(`mock-llm: listening on 127.0.0.1:${server.address().port}`))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)))
