// The listener and control interface (work package B4, spec 3 sections 3.1, 4.1 and 4.7).
// Pattern taken from the reference code bot/src/host/local-agents/mcp.ts: a node:http server bound to
// 127.0.0.1 only, a token check on every request, and a chosen or random port (0 = random).
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { TASK_STATES } from './contracts.ts'
import { bindingOf } from '../config.ts'

const MAX_BODY = 1_000_000

class HttpError extends Error {
  declare status: any
  declare error: any
  constructor(status, error) { super(error); this.status = status; this.error = error }
}

const isText = (v) => typeof v === 'string' && v.trim() !== ''

function tokenOk(given, expected) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(request) {
  return new Promise<string>((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(new HttpError(413, 'body_too_large')); request.destroy() } else chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

const short = (t) => ({ id: t.id, state: t.state, step: t.step ?? null, jiraKey: t.jira?.key ?? null, mrUrl: t.mr?.url ?? null, totalUsd: t.usage?.totalUsd ?? 0, unpriced: t.usage?.unpriced === true })

export function createHttp({ config, token, store, queue, runner, notify }) {
  if (!isText(token)) throw new Error('createHttp: the token is required')

  async function postEvent(request) {
    let body
    try { body = JSON.parse(await readBody(request)) } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(400, 'invalid_json')
    }
    // 1. required fields
    const missing = ['eventId', 'channel', 'threadTs', 'messageTs', 'text'].filter((k) => !isText(body?.[k]))
    if (!isText(body?.user?.id)) missing.push('user.id')
    if (missing.length > 0) return [400, { error: `missing_fields: ${missing.join(', ')}` }]
    // 2. duplicate event
    const known = await store.knownEvent(body.eventId)
    if (known !== undefined) {
      const task = await store.getTask(known)
      return [200, { taskId: known, state: task?.state ?? null, duplicate: true }]
    }
    // 3. channel not bound
    const binding = bindingOf(config, body.channel)
    if (binding === undefined) {
      await notify({ id: null, origin: body }, 'channel_not_bound')
      return [422, { error: 'channel_not_bound' }]
    }
    const existing = await store.findByThread(body.channel, body.threadTs)
    // 4. a task of this discussion is queued or running
    if (existing !== undefined && (existing.state === 'queued' || existing.state === 'running')) {
      await notify(existing, 'in_progress')
      return [200, { taskId: existing.id, state: existing.state, inProgress: true }]
    }
    // 5. needs_info: queue the original task again
    if (existing !== undefined && existing.state === 'needs_info') {
      const { position } = await queue.enqueue(existing.id)
      return [202, { taskId: existing.id, state: 'queued', position, rerun: true }]
    }
    // 6. queue full
    if (await queue.full()) {
      await notify({ id: null, origin: body }, 'queue_full')
      return [429, { error: 'queue_full' }]
    }
    // 7. new task
    const task = await store.createTask(body, binding)
    const { position } = await queue.enqueue(task.id)
    return [202, { taskId: task.id, state: 'queued', position }]
  }

  async function getTask(id, url) {
    const task = await store.getTask(id)
    if (task === undefined) return [404, { error: 'task_not_found' }]
    if (url.searchParams.get('records') === '1') return [200, { ...task, records: await store.readRecords(id) }]
    return [200, task]
  }

  async function listTasks(url) {
    const state = url.searchParams.get('state')
    if (state !== null && !TASK_STATES.includes(state)) return [400, { error: 'invalid_state' }]
    const tasks = await store.listTasks(state === null ? {} : { state })
    return [200, { tasks: tasks.map(short) }]
  }

  async function stopTask(id) {
    const task = await store.getTask(id)
    if (task === undefined) return [404, { error: 'task_not_found' }]
    if (task.state === 'queued') {
      const next = await store.patchTask(id, { state: 'stopped', endReason: 'stopped' })
      await notify(next ?? task, 'stopped')
    } else if (task.state === 'running') {
      await runner.end(id, 'stopped', 'stopped')
    } else {
      return [409, { error: 'not_stoppable', state: task.state }]
    }
    return [200, { stopped: true }]
  }

  async function health() {
    const queued = (await store.listTasks({ state: 'queued' })).length
    const running = (await store.listTasks({ state: 'running' })).length
    return [200, { up: true, queued, running, maxConcurrent: config.limits.maxConcurrent }]
  }

  async function route(request) {
    if (!tokenOk(request.headers['x-chat-to-fix-token'], token)) return [401, { error: 'unauthorized' }]
    const url = new URL(request.url, 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean)
    const m = request.method
    if (m === 'POST' && url.pathname === '/events') return postEvent(request)
    if (m === 'GET' && url.pathname === '/health') return health()
    if (m === 'GET' && url.pathname === '/tasks') return listTasks(url)
    if (m === 'GET' && parts[0] === 'tasks' && parts.length === 2) return getTask(decodeURIComponent(parts[1]), url)
    if (m === 'POST' && parts[0] === 'tasks' && parts.length === 3 && parts[2] === 'stop') return stopTask(decodeURIComponent(parts[1]))
    return [404, { error: 'not_found' }]
  }

  const server = createServer((request, response) => {
    route(request).then(([status, payload]) => [status, payload], (error) =>
      error instanceof HttpError ? [error.status, { error: error.error }] : [500, { error: 'internal_error' }],
    ).then(([status, payload]) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    })
  })

  return {
    async listen() {
      await new Promise<void>((resolve, reject) => server.listen(config.httpPort, '127.0.0.1', () => resolve()).once('error', reject))
      return (server.address() as any).port
    },
    close() {
      return new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.() })
    },
    get port() { return (server.address() as any)?.port },
  }
}
