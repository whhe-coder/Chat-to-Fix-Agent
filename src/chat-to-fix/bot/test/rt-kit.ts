// Test kit for the restored DS Bot tests. DS Bot's own tests built the runtime through its entry
// (bot/index.js, which also registered the `POST /api/bot` web route) and drove it through that
// route. chat-to-fix has no web channel, so this kit builds the runtime through OUR entry
// (src/bot/index.ts createRuntime + runtimeOf) and gives `call(endpoint, payload)` the same
// answer shape the route had ({ ok, value } / { ok: false, error: { code, message } }), each
// endpoint calling the runtime function it reached in bot/src/host/channel.js (commit 263a272).
import { createRuntime as makeBotLayer, runtimeOf } from '../../src/bot/index.ts'

// The internal runtime object (what DS Bot's `createRuntime` returned), built through the task layer's entry.
export function createRuntime(ctx, config: any = {}) {
  return runtimeOf(makeBotLayer(ctx, config))
}

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
// channel.js errorCode: programming errors are `bot/internal`, other errors are refusals meant for the user.
const isInternal = error => error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError
  || error instanceof SyntaxError || (typeof error?.code === 'string' && /^E[A-Z_]+$/.test(error.code))
export function errorCode(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('bot/')) return error.code
  return isInternal(error) ? 'bot/internal' : 'bot/refused'
}

// The team view and live fields the `state` endpoint answered (channel.js view() and live()),
// without the parts only the web UI read (avatars, secrets, connectors, memory, IM, computer).
export function stateView(rt) {
  const { state } = rt
  const view = {
    revision: state.revision,
    workspaceId: state.workspaceId ?? null,
    mainBotId: state.mainBotIds[0] ?? null,
    mainBotIds: state.mainBotIds,
    bots: Object.values(state.bots).map(({ segments, kickoff, ...bot }: any) => ({
      ...bot, sessionId: rt.chatOf(bot.id), parts: (segments ?? []).map(segment => segment.sessionId), ...(kickoff ? { waiting: true } : {}),
      ...(rt.localAgentBadge?.(bot.appliedModel ?? bot.model) !== undefined ? { engine: rt.localAgentBadge(bot.appliedModel ?? bot.model) } : {}),
    })),
    rooms: Object.values(state.rooms).map(({ log, seen, paused, sessions, segments, parts: ownParts, ...room }: any) => {
      const parts = [...Object.values(sessions ?? {}), ...Object.values(segments ?? {}).flat().map((segment: any) => segment.sessionId), ...(ownParts ?? []).map(segment => segment.sessionId)]
      const last = (log ?? []).filter(line => line.kind === undefined).at(-1)
      return { ...room, sessionId: rt.sessionOfRoom(room), ownParts: (ownParts ?? []).map(segment => segment.sessionId), parts, ...(last ? { preview: last.who === 'User' ? last.text : `${last.who}：${last.text}` } : {}) }
    }),
    exchangeTurns: state.exchangeTurns,
    questions: state.questions,
    views: state.views ?? {},
    closedCards: state.closedCards ?? {},
    agents: Object.values(state.agents ?? {}),
    models: rt.cachedCatalog?.() ?? [],
    defaultModel: rt.cachedDefault?.() ?? null,
    permissions: rt.permissionCatalog?.() ?? null,
    prefs: state.prefs,
    readOnly: rt.readOnly() ?? null,
  }
  const live = {
    activity: rt.activityView(),
    work: { bots: rt.workView(), rooms: rt.roomWorkView(), approvals: rt.approvalsView(), waiting: rt.waitingView?.() ?? {}, turns: rt.turnsView?.() ?? {}, steered: rt.steeredView?.() ?? {} },
  }
  return { ...view, ...live }
}

// channel.js setPrefs, down to the prefs the restored tests set (they use `theme` as "any saved change").
async function setPrefs(rt, body) {
  const { state } = rt
  if (body.theme !== undefined) {
    if (typeof body.theme !== 'string' || !/^[a-z][\w-]{0,31}$/.test(body.theme)) throw invalid('Unknown theme')
    state.prefs.theme = body.theme
  }
  if (body.defaultBotModel !== undefined) {
    if (body.defaultBotModel === null || body.defaultBotModel === '') delete state.prefs.defaultBotModel
    else state.prefs.defaultBotModel = await rt.resolveModel(body.defaultBotModel)
  }
  if (body.thinking !== undefined) {
    if (body.thinking === true) state.prefs.thinking = true
    else if (body.thinking === false || body.thinking === null) delete state.prefs.thinking
  }
  return rt.save()
}

// `call(endpoint, payload)`: what a POST to /api/bot did, as a direct call into the runtime.
//   state -> stateView(rt) (revision, bots, rooms, activity, work.*)    set-prefs -> setPrefs
//   create-bot / update-bot / delete-bot / duplicate-bot -> rt.createBot / updateBot / deleteBot / duplicateBot
//   create-room / update-room / delete-room -> rt.createRoom / updateRoom / deleteRoom
//   stop-room-work / stop-member-work -> rt.stopRoomWork / stopMemberWork    approval-answer -> rt.answerApproval
//   room-progress -> rt.roomProgress    exchange / exchange-text / file-text -> rt.state.exchanges / exchangeText / fileText
//   send -> sendUser (below)    team-workspace / folders / folder-* -> rt.setTeamWorkspace / folderEndpoint
//   earlier / chat -> rt.earlierPage / chatPage    diagnostics-log -> rt.diagnostics.logText
export function apiOf(rt) {
  const { state } = rt
  const ok = value => ({ ok: true, value })
  const fail = (message, code = 'bot/error') => ({ ok: false, error: { code, message, details: {} } })
  const handle = async (endpoint, payload, signal?): Promise<any> => {
    try {
      const body: any = payload ?? {}
      await rt.refresh()
      const readOnly = rt.readOnly()
      if (readOnly !== undefined && !['state', 'room-progress', 'exchange', 'exchange-text', 'file-text', 'approval-answer', 'diagnostics-log', 'earlier', 'chat'].includes(endpoint)) return fail(readOnly, 'bot/read-only')
      switch (endpoint) {
        case 'state':
          if (readOnly === undefined) await rt.bootstrap()
          await rt.catalog()
          return ok(stateView(rt))
        case 'set-prefs':
          await rt.load()
          await setPrefs(rt, body)
          return ok(state.prefs)
        case 'duplicate-bot':
          await rt.load()
          return ok(await rt.duplicateBot(body.id))
        case 'exchange': {
          await rt.load()
          const pair = new Set([body.a, body.b])
          return ok(state.exchanges.filter(entry => pair.has(entry.from) && pair.has(entry.to)))
        }
        case 'exchange-text': {
          await rt.load()
          const entry = state.exchanges.find(item => item.id === body.id)
          if (entry === undefined) return fail('This message is no longer kept', 'bot/stale')
          return ok(await rt.exchangeText(entry))
        }
        case 'file-text': {
          if (typeof body.file?.attachmentId !== 'string') return fail('No file named', 'bot/invalid')
          const read = await rt.fileText(body.file)
          return read === undefined ? fail('This file cannot be read here', 'bot/unavailable') : ok(read)
        }
        case 'earlier':
          await rt.load()
          return ok(await rt.earlierPage(String(body.sessionId ?? ''), body.cursor ?? undefined))
        case 'chat':
          await rt.load()
          return ok(await rt.chatPage(String(body.botId ?? ''), body.cursor ?? undefined))
        case 'room-progress': {
          // Any part id of the group's own Session means the group itself.
          const room = rt.roomOf(body.roomId) ?? rt.roomOf(rt.pastOwners.get(body.roomId)?.roomId)
          return ok([...rt.roomProgress.entries()].filter(([, entry]: any) => entry.roomId === (room?.id ?? body.roomId)).map(([callId, entry]: any) => ({ callId, replies: entry.replies, speaking: entry.slots.filter(slot => slot.status === 'speaking').map(slot => slot.id) })))
        }
        case 'create-bot': {
          await rt.bootstrap()
          return ok(await rt.createBot({ name: body.name, role: body.role, color: body.color, instructions: body.instructions, brief: body.brief, avatar: body.avatar, model: body.model, effort: body.effort, workDir: body.workDir }))
        }
        case 'update-bot':
          await rt.load()
          return ok(await rt.updateBot(body.id, body))
        case 'delete-bot':
          await rt.load()
          await rt.deleteBot(body.id)
          return ok(stateView(rt))
        case 'create-room': {
          await rt.load()
          const room = await rt.createRoom({ members: Array.isArray(body.members) ? body.members : [], name: body.name, ...(typeof body.admin === 'string' ? { admin: body.admin } : {}) })
          return ok(room)
        }
        case 'update-room': {
          await rt.load()
          const { room, changes } = await rt.updateRoom(body.id, {
            name: body.name,
            notice: body.notice,
            mode: body.mode,
            admin: body.admin,
            members: Array.isArray(body.members) ? body.members : undefined,
            add: Array.isArray(body.add) ? body.add : undefined,
            remove: Array.isArray(body.remove) ? body.remove : undefined,
            workDir: body.workDir,
            permission: body.permission,
          })
          return ok({ room: stateView(rt).rooms.find(entry => entry.id === room.id), changes })
        }
        case 'delete-room':
          await rt.load()
          await rt.deleteRoom(body.id)
          return ok(stateView(rt))
        case 'folders':
        case 'folder-pick':
        case 'folder-list':
          await rt.load()
          return ok(await rt.folderEndpoint(endpoint, body, signal))
        case 'team-workspace':
          await rt.load()
          return ok({ team: await rt.setTeamWorkspace(String(body.path ?? '')) })
        case 'approval-answer':
          rt.answerApproval(body.id, body.choice)
          return ok(true)
        case 'stop-member-work':
          return ok(await rt.stopMemberWork(String(body.roomId ?? ''), String(body.botId ?? '')))
        case 'stop-room-work':
          return ok(await rt.stopRoomWork(String(body.roomId ?? '')))
        case 'send': {
          // channel.js sendUser (a user message into a Session, a Bot id or a group id).
          const text = String(body.text ?? '').trim()
          if (text === '' || typeof body.sessionId !== 'string') return fail('Nothing to send', 'bot/invalid')
          await rt.load()
          await sendUser(rt, { sessionId: body.sessionId, content: [{ type: 'text', text }] })
          return ok(true)
        }
        case 'diagnostics-log':
          return ok(await rt.diagnostics.logText())
        default:
          return fail(`Unknown endpoint ${endpoint}`, 'bot/not-found')
      }
    } catch (error) {
      const code = errorCode(error)
      const message = error?.message ?? String(error)
      if (code === 'bot/internal') rt.noteFailure?.({ source: 'api', text: `${endpoint}: ${message}`, code: error?.code ?? error?.name, stack: error?.stack })
      return fail(message, code)
    }
  }
  return handle
}

// channel.js sendUser: a Bot id, a group id, or an earlier part of either resolves to its
// current part; the text is queued as a user prompt.
export async function sendUser(rt, { sessionId: ref, content, requestId = crypto.randomUUID() }) {
  const past = rt.pastOwners.get(ref)
  const room = rt.roomOf(ref)
  const sessionId = rt.botOf(ref) ? rt.chatOf(ref)
    : room !== undefined ? rt.sessionOfRoom(room)
      : past?.roomId === undefined && past !== undefined ? rt.chatOf(past.botId)
        : past !== undefined ? rt.sessionOfRoom(rt.roomOf(past.roomId)) : ref
  await rt.ensureCapabilities(sessionId)
  await rt.ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue', content }, AbortSignal.timeout(30_000))
}

export { invalid }
