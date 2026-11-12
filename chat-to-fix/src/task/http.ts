// The listener and control interface (work package B4, spec 3 sections 3.1, 4.1 and 4.7).
// Pattern taken from the reference code bot/src/host/local-agents/mcp.ts: a node:http server bound to
// 127.0.0.1 only, a token check on every request, and a chosen or random port (0 = random).
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { TASK_STATES } from './contracts.ts'
import { bindingOf, DEFAULT_SLASH_COMMAND } from '../config.ts'
import { neutralizeBroadcasts } from '../adapters/slack-http.ts'
import { OUTBOX_DEFAULT_LIMIT, OUTBOX_MAX_LIMIT } from './outbox.ts'

const MAX_BODY = 1_000_000

class HttpError extends Error {
  declare status: any
  declare error: any
  constructor(status, error) { super(error); this.status = status; this.error = error }
}

const isText = (v) => typeof v === 'string' && v.trim() !== ''

const SLASH_USER_ID = /^[A-Za-z0-9._-]{1,64}$/
const SLASH_QUOTE_MAX = 2000 // the quoted request in the opening message; the adapter cuts at 4000 in all

/** The opening message of a /fix discussion (Chinese, like the other notices): mentions the requester, quotes the request. */
export function openingMessage(command, userId, text) {
  let quoted = neutralizeBroadcasts(String(text).trim())
  if (quoted.length > SLASH_QUOTE_MAX) quoted = `${quoted.slice(0, SLASH_QUOTE_MAX - 1)}…`
  const lines = quoted.split(/\r?\n/).map((line) => `> ${line}`).join('\n')
  return `<@${userId}> 用 ${command} 提了一个修复请求：\n${lines}\n进度会回在这条消息的讨论串里。`
}

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

/** One message of a discussion as the task keeps it (origin.followUps, origin.earlier). */
export function followUpOf(body) {
  const seconds = Number(body?.messageTs)
  return {
    user: { ...(body?.user ?? {}) }, text: String(body?.text ?? ''), messageTs: body?.messageTs ?? null,
    at: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : new Date().toISOString(),
    files: Array.isArray(body?.files) ? body.files : [],
  }
}

/** The messages a task's origin holds, oldest first: earlier ones, the trigger, the follow-ups. */
export function discussionOf(origin) {
  if (origin === null || typeof origin !== 'object') return []
  const trigger = isText(origin.text) ? [followUpOf({ user: origin.user, text: origin.text, messageTs: origin.messageTs, files: origin.files })] : []
  return [...(Array.isArray(origin.earlier) ? origin.earlier : []), ...trigger, ...(Array.isArray(origin.followUps) ? origin.followUps : [])]
}

export function createHttp({ config, token, store, outbox, queue, runner, notify, startThread }: any) {
  if (!isText(token)) throw new Error('createHttp: the token is required')

  // /fix events being handled right now, by eventId: a retry that arrives meanwhile waits for the first
  // one instead of posting a second opening message (research note fix-slash-entry, 4.1 step 1).
  const inFlight = new Map<string, Promise<any>>()

  // A /fix command (source 'slash'): the discussion does not exist yet, the server opens it (4.1 steps 1 to 5).
  async function slashEvent(body) {
    const missing = ['eventId', 'channel', 'text'].filter((k) => !isText(body?.[k]))
    if (!isText(body?.user?.id)) missing.push('user.id')
    if (missing.length > 0) return [400, { error: `missing_fields: ${missing.join(', ')}` }]
    if (!SLASH_USER_ID.test(body.user.id)) return [400, { error: 'invalid_user' }]
    // No await between the check and the set below: two requests at once cannot both pass.
    const running = inFlight.get(body.eventId)
    if (running !== undefined) {
      const [status, payload] = await running
      return status === 202 || status === 200 ? [200, { ...payload, duplicate: true }] : [status, payload]
    }
    const work = slashNew(body)
    inFlight.set(body.eventId, work)
    try { return await work } finally { inFlight.delete(body.eventId) }
  }

  async function slashNew(body) {
    // 1. duplicate event (a finished earlier request)
    const known = await store.knownEvent(body.eventId)
    if (known !== undefined) {
      const task = await store.getTask(known)
      return [200, { taskId: known, state: task?.state ?? null, permalink: task?.origin?.permalink ?? null, duplicate: true }]
    }
    // 2. and 3. refusals post nothing to the channel: the forwarder tells the requester through response_url
    const binding = bindingOf(config, body.channel)
    if (binding === undefined) return [422, { error: 'channel_not_bound' }]
    if (await queue.full()) return [429, { error: 'queue_full' }]
    // 4. the opening message is the discussion; sent once (the adapter never repeats a post)
    if (typeof startThread !== 'function') return [502, { error: 'no_adapter' }]
    let opened
    try {
      opened = await startThread(body.channel, openingMessage(config.slack?.slashCommand ?? DEFAULT_SLASH_COMMAND, body.user.id, body.text))
    } catch (error: any) {
      return [502, { error: isText(error?.code) ? error.code : 'slack_error' }]
    }
    if (!isText(opened?.ts)) return [502, { error: 'slack_bad_response' }]
    // 5. the task lives in the new discussion: threadTs = messageTs = the opening message
    const permalink = isText(opened.permalink) ? opened.permalink : null
    const origin: any = {
      eventId: body.eventId, channel: body.channel, threadTs: opened.ts, messageTs: opened.ts,
      user: { id: body.user.id, ...(isText(body.user.name) ? { name: body.user.name } : {}) }, text: body.text,
    }
    if (permalink !== null) origin.permalink = permalink
    const task = await store.createTask(origin, binding)
    await queue.enqueue(task.id)
    return [202, { taskId: task.id, permalink }]
  }

  async function postEvent(request) {
    let body
    try { body = JSON.parse(await readBody(request)) } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(400, 'invalid_json')
    }
    if (body?.source === 'slash') return slashEvent(body)
    if (body?.source !== undefined && body.source !== 'fix' && body.source !== 'mention') return [400, { error: 'invalid_source' }]
    // A retry that arrives while the first copy is still being handled waits for it (no second task).
    if (!isText(body?.eventId)) return threadEvent(body)
    const running = inFlight.get(body.eventId)
    if (running !== undefined) {
      const [status, payload] = await running
      return status === 202 || status === 200 ? [200, { ...payload, duplicate: true }] : [status, payload]
    }
    const work = threadEvent(body)
    inFlight.set(body.eventId, work)
    try { return await work } finally { inFlight.delete(body.eventId) }
  }

  // An event whose discussion already exists. `source` 'fix' (a new request: the Slack Bot posted the task
  // message, threadTs is its ts), 'mention' (a requester's @ in the discussion: only supplements a live task)
  // or none (the older format: an @ may also start a task, tests and the fake e2e suite use it).
  async function threadEvent(body) {
    const source = body?.source
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
    if (source !== 'fix') {
      const existing = await store.findByThread(body.channel, body.threadTs)
      // An @ in the discussion of a live task is kept on the task (origin.followUps): in command mode the bots
      // cannot read the discussion history, so this is how a requester's answer reaches them.
      const live = existing !== undefined && ['queued', 'running', 'needs_info'].includes(existing.state)
      if (live) await store.addFollowUp(existing.id, body.eventId, followUpOf(body))
      // 4. a task of this discussion is queued or running
      if (live && (existing.state === 'queued' || existing.state === 'running')) {
        await notify(existing, 'in_progress')
        return [200, { taskId: existing.id, state: existing.state, inProgress: true }]
      }
      // 5. needs_info: queue the original task again (the rerun reads the discussion again, the answer included)
      if (live && existing.state === 'needs_info') {
        const { position } = await queue.enqueue(existing.id)
        await notify(existing, 'resumed')
        return [202, { taskId: existing.id, state: 'queued', position, rerun: true }]
      }
      // A mention starts nothing: no task, or an ended one, means the requester is pointed to /fix.
      if (source === 'mention') {
        await notify({ id: null, origin: body }, 'no_open_task')
        return [409, { error: 'no_open_task' }]
      }
      // 6. queue full
      if (await queue.full()) {
        await notify({ id: null, origin: body }, 'queue_full')
        return [429, { error: 'queue_full' }]
      }
      // 7. new task (older format only); in the discussion of an ended task it carries that task's messages
      //    (origin.earlier), so in command mode the new task still knows what the discussion was about
      const task = await store.createTask(existing === undefined ? body : { ...body, earlier: discussionOf(existing.origin) }, binding)
      const { position } = await queue.enqueue(task.id)
      return [202, { taskId: task.id, state: 'queued', position }]
    }
    // source 'fix': 6. queue full, 7. new task
    if (await queue.full()) {
      await notify({ id: null, origin: body }, 'queue_full')
      return [429, { error: 'queue_full' }]
    }
    const task = await store.createTask(body, binding)
    const { position } = await queue.enqueue(task.id)
    return [202, { taskId: task.id, state: 'queued', position }]
  }

  async function readOutbox(url) {
    if (outbox === undefined) return [404, { error: 'not_found' }]
    const num = (name, fallback, min) => {
      const raw = url.searchParams.get(name)
      if (raw === null) return fallback
      return /^\d+$/.test(raw) && Number(raw) >= min ? Number(raw) : null
    }
    const after = num('after', 0, 0)
    const limit = num('limit', OUTBOX_DEFAULT_LIMIT, 1)
    if (after === null) return [400, { error: 'invalid_after' }]
    if (limit === null) return [400, { error: 'invalid_limit' }]
    return [200, await outbox.read(after, Math.min(limit, OUTBOX_MAX_LIMIT))]
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
    if (m === 'GET' && url.pathname === '/outbox') return readOutbox(url)
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
