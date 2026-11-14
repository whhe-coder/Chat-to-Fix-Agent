// I1: the bot-layer facade (spec 5, section 3). The task layer calls the bot layer only
// through this file, and receives only the payload shapes of contracts.js.
//
// Ids. A DS Bot "bot id" is the id of the bot's first own-chat DSH session and never
// changes (store.js: "A Bot's id is the Session id of its first own-chat segment"). This
// facade uses that bot id everywhere: the value createBot returns, the argument of
// bindBot/stopBot/deleteBot/askBot, and the `botId` of every event payload and of
// botOfSession. A bot also has other DSH sessions (its group sessions, later parts); the
// payloads carry the DSH session that produced the event in `sessionId`, and `botId` is
// always rt.selfOf(sessionId), so every session of one bot maps to the same botId.
import { randomUUID } from 'node:crypto'
import { lineText } from '../../bot/src/host/groups.ts'
import { textOf } from '../../bot/src/host/text.ts'
import { tpsOf } from './usage.ts'

const iso = (time?) => new Date(time ?? Date.now()).toISOString()
const unbracket = text => text.replace(/^\[([\s\S]*)\]$/, '$1')

export function createBotLayer(rt) {
  const { ctx } = rt
  /** @type {Map<string, {taskId: string, role: string}>} */
  const bindings = new Map()
  const listeners = { line: new Set(), session: new Set(), tool: new Set(), round: new Set(), approval: new Set(), usage: new Set() }
  const subscribe = (set, fn) => {
    set.add(fn)
    return () => set.delete(fn)
  }
  const fire = (set, payload) => {
    for (const fn of set) {
      try { fn(payload) } catch (error) { rt.warn('chat-to-fix: event listener failed: %s', error) }
    }
  }
  // A session of this team: a bot's own chat, one of its group sessions, or a group's own session.
  const teamSession = id => id !== undefined && (rt.selfOf(id) !== undefined || rt.roomOf(id) !== undefined)
  const botIdOf = id => rt.selfOf(id) ?? null
  const needRoom = (groupId) => {
    const room = rt.roomOf(groupId)
    if (room === undefined || room.id !== groupId) throw new Error(`Unknown group ${groupId}`)
    return room
  }
  const needBot = (botId) => {
    const bot = rt.botOf(botId)
    if (bot === undefined) throw new Error(`Unknown bot ${botId}`)
    return bot
  }

  // --- events ---------------------------------------------------------------------------
  // Group lines: groups.js:252 (onRoomLine). A notice line keeps its text in noticeText, which
  // groups.js reaches through lineText (in brackets).
  rt.onRoomLine((room, line) => {
    const notice = line.kind === 'notice'
    const text = line.text || (line.kind === undefined ? '' : unbracket(lineText(line)))
    fire(listeners.line, { groupId: room.id, kind: notice ? 'notice' : 'line', botId: line.botId ?? null, name: line.who ?? '', text, at: iso() })
  })

  // --- usage ----------------------------------------------------------------------------
  // Every bot runs on an API route and reports usage (source 'dsh') through DSH's per-session projections, read
  // through ctx.sessionController.projections({ sessionId }): `tokenUsage` (the session's token totals: uncached
  // input, output, cache read, cache write; every settled call and failed attempt is in it) and
  // `sessionStats` of @deepseek-ai/dsh-session-stats (ttftMs and ttftSteps, decodeMs and decodeTokens: the
  // time and the output tokens of the first-token-to-message span). They are session totals, so a round's
  // usage is the difference between the read at its turn/start and the read at its turn/end, and one
  // usage event is fired per round, just before the round-end event. The speed is derived from them
  // (decodeTokens / decodeMs, the very quotient of DSH's stats table); nothing is recomputed from streams.
  // DSH reports no cost, so the task layer prices the tokens from its table (core/task/pricing.ts).
  // The reviewer's session (runReview below) is a child session: its totals are read once when it ends and
  // booked to the Coding bot. Not counted: model calls DSH keeps out of the session log (a session title, a
  // compaction summary).
  const READ_MS = 5000
  const canRead = () => typeof ctx.sessionController?.projections === 'function'
  async function readTotals(id) {
    try {
      const got = await ctx.sessionController.projections({ sessionId: id }, AbortSignal.timeout(READ_MS))
      const values = got?.kind === 'sequenced' ? got.values : got?.kind === 'migration-required' ? got.values : undefined
      return values === undefined ? undefined : { tokens: values.tokenUsage, stats: values.sessionStats }
    } catch (error) {
      rt.warn('chat-to-fix: could not read the usage projections of %s: %s', id, error?.message ?? error)
      return undefined
    }
  }
  const diff = (after, before, key) => Math.max(0, (after?.[key] ?? 0) - (before?.[key] ?? 0))
  // The usage event of one round from the totals before and after it; undefined when nothing was billed.
  function roundUsage(id, before, after, at) {
    if (before === undefined || after?.tokens === undefined) return undefined
    const input = diff(after.tokens, before.tokens, 'uncachedInputTokens')
    const output = diff(after.tokens, before.tokens, 'outputTokens')
    const cacheRead = diff(after.tokens, before.tokens, 'cacheReadTokens')
    const cacheWrite = diff(after.tokens, before.tokens, 'cacheWriteTokens')
    if (input + output + cacheRead + cacheWrite === 0) return undefined
    const botId = botIdOf(id)
    const ref = rt.botOf(botId)?.appliedModel ?? rt.botOf(botId)?.model
    const effort = rt.botOf(botId)?.effort
    const decodeMs = diff(after.stats, before.stats, 'decodeMs')
    const decodeTokens = diff(after.stats, before.stats, 'decodeTokens')
    const ttftSteps = diff(after.stats, before.stats, 'ttftSteps')
    const outputTps = tpsOf(decodeTokens, decodeMs)
    return {
      sessionId: id, botId, source: 'dsh', model: typeof ref === 'string' && ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : (ref ?? 'unknown'),
      ...(typeof effort === 'string' && effort !== '' ? { effort } : {}),
      input, output, cacheRead, cacheWrite, costUsd: null,
      durationMs: decodeMs, tpsTokens: decodeTokens, ...(ttftSteps > 0 ? { ttftMs: Math.round(diff(after.stats, before.stats, 'ttftMs') / ttftSteps) } : {}),
      outputTps, tpsBasis: outputTps === null ? null : 'dsh-decode', at,
    }
  }
  const baselines = new Map() // session id -> the pending read at its turn/start
  const settling = new Map() // session id -> the chain that fires its round ends in order

  // Session events and round ends: turns.js:627 (session/event), :1012 (turn/end). turns.js
  // clears its own turn state at turn/end, so the final answer is kept here from the
  // assistant/message events of the turn. Every session event is forwarded with its own type.
  const answers = new Map()
  const calls = new Map()
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (!teamSession(id)) return
    const at = iso(event.time)
    fire(listeners.session, { sessionId: id, botId: botIdOf(id), type: event.type, event, at })
    switch (event.type) {
      case 'turn/start':
        answers.delete(id)
        if (canRead() && botIdOf(id) !== null) baselines.set(id, readTotals(id))
        break
      case 'assistant/message':
        answers.set(id, textOf(event.data?.message?.content))
        break
      case 'tool/call':
        calls.set(event.data?.callId, Date.now())
        break
      case 'tool/ptc-dispatch-start':
        calls.set(event.data?.subCallId, Date.now())
        break
      case 'turn/end': {
        const kind = event.data?.reason?.kind
        const round = {
          sessionId: id,
          botId: botIdOf(id),
          groupId: rt.groupOwners.get(id)?.roomId ?? rt.roomOf(id)?.id ?? null,
          text: answers.get(id) ?? '',
          failed: kind === 'error' || kind === 'aborted',
          at,
        }
        answers.delete(id)
        const baseline = baselines.get(id)
        baselines.delete(id)
        if (baseline === undefined) { fire(listeners.round, round); break }
        // The bot's usage of this round goes out first, then its round end (the records keep that order).
        const job = async () => {
          try {
            const usage = roundUsage(id, await baseline, await readTotals(id), at)
            if (usage !== undefined) fire(listeners.usage, usage)
          } catch (error) {
            rt.warn('chat-to-fix: usage of %s was not recorded: %s', id, error?.message ?? error)
          }
          fire(listeners.round, round)
        }
        settling.set(id, (settling.get(id) ?? Promise.resolve()).then(job))
        break
      }
    }
  })

  // Tool results: turns.js:1096 (tools/result). The model-facing text is result.content.
  ctx.on('tools/result', (exec, result) => {
    const id = exec?.agent?.id
    if (!teamSession(id)) return
    const started = calls.get(exec.callId)
    calls.delete(exec.callId)
    const text = Array.isArray(result?.content) ? textOf(result.content) : typeof result?.value === 'string' ? result.value : JSON.stringify(result?.value ?? '')
    fire(listeners.tool, { sessionId: id, botId: botIdOf(id), tool: exec.name, args: exec.arguments ?? {}, ok: result?.isError !== true, text, ms: started === undefined ? 0 : Date.now() - started, at: iso() })
  })

  // Approvals: approvals.js:15 (onApproval); only the opening of one is an event.
  rt.onApproval((kind, data) => {
    if (kind !== 'open') return
    fire(listeners.approval, { id: data.id, sessionId: data.sessionId, botId: data.botId ?? null, tool: data.tool, text: data.detail?.text || data.reason || data.detail?.code || '' })
  })

  // The reviewer of the Coding bot (core/tools/review.ts, request_review): a DSH subagent of the calling
  // session, started by the system and awaited here, so the review happens inside the Coding bot's tool call.
  // @deepseek-ai/dsh-subagent startActivation: provider 'spawn' (a fresh in-process child that does not see
  // the conversation; it inherits the parent's model, effort and working directory), `agentPreset` names the
  // child's tools, delivery 'caller' returns the result here instead of waking the parent with a notice. The
  // subagents service is not in the plugin's inject list, so it is read with ctx.get (as turns.ts does).
  // -> { childId, text, stopReason, diagnostic? }; throws when the review cannot start or does not end in time.
  const REVIEW_LABEL = 'review'
  async function runReview({ sessionId, prompt, preset, timeoutMs }) {
    const subagents = ctx.get?.('subagents')
    if (typeof subagents?.startActivation !== 'function') throw new Error('the DSH subagents service is not available')
    const parent = ctx.get?.('agents')?.get?.(sessionId) ?? await rt.resolveAgent(sessionId)
    const controller = new AbortController()
    const activation = await subagents.startActivation({
      provider: 'spawn',
      label: REVIEW_LABEL,
      delivery: 'caller',
      signal: controller.signal,
      request: { prompt: [{ type: 'text', text: prompt }], parent, ...(preset ? { agentPreset: preset } : {}) },
    })
    let timer
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the review did not end within ${Math.round(timeoutMs / 60_000)} minutes`)), timeoutMs)
      })
      const result: any = await Promise.race([activation.result, timeout])
      return {
        childId: activation.childId,
        text: textOf(result?.output ?? []),
        stopReason: result?.stopReason ?? 'error',
        ...(typeof result?.diagnostic === 'string' ? { diagnostic: result.diagnostic } : {}),
      }
    } catch (error) {
      controller.abort()
      await Promise.resolve(activation.dispose?.()).catch(() => {})
      throw error
    } finally {
      clearTimeout(timer)
      await reportChildUsage(sessionId, activation.childId)
    }
  }

  // The reviewer's whole usage, booked to the session that asked for the review.
  async function reportChildUsage(sessionId, childId) {
    if (!canRead() || childId === undefined) return
    const usage = roundUsage(sessionId, { tokens: {}, stats: {} }, await readTotals(childId), iso())
    if (usage !== undefined) fire(listeners.usage, { ...usage, reviewer: true })
  }

  return {
    // roster.js:140 createBot (pickModel holds the greeting back), :316 updateBot. Roles map to
    // DS Bot's `role` label. `preset` is the permission preset the bot's session is created
    // with (roster.js botPreset) and is stored on the bot.
    async createBot({ name, label, instructions, model, effort, permission, preset }) {
      await rt.load()
      const bot = await rt.createBot({ name, role: label, instructions, pickModel: true, preset })
      // No greeting: the one held for the "choose a model later" bot is cleared before a model is set.
      delete bot.kickoff
      await rt.save()
      const patch: any = {}
      if (model) patch.model = model
      if (permission) patch.permission = permission
      if (Object.keys(patch).length > 0) await rt.updateBot(bot.id, patch)
      // The thinking level is checked against the model's catalog entry; a model without levels keeps its default.
      if (effort) {
        try { await rt.updateBot(bot.id, { effort }) } catch (error) { rt.warn('chat-to-fix: the thinking level %s was not set for %s: %s', effort, name, error?.message ?? error) }
      }
      return bot.id
    },

    // roster.js:493 createRoom; mode fixed to admin, admin passed explicitly.
    async createGroup({ name, memberIds, adminId, notice }) {
      await rt.load()
      const room = await rt.createRoom({ members: memberIds, name, notice, mode: 'admin', admin: adminId })
      return room.id
    },

    // The code directory is the working folder of the Coding bot only (folders.js memberDirs:
    // the folder of one member inside one group). A group-wide folder (updateRoom workDir) would
    // move every member's existing group conversation to a fresh part at its next turn, with a
    // model call for each API bot's handoff note; the four API bots keep their own folder.
    // The Coding bot's group session is made after this call, in the directory (groups.js
    // groupSessionFor); one that exists already follows at its next turn (followFolder).
    async setGroupWorkDir(groupId, dir) {
      await rt.load()
      const room = needRoom(groupId)
      const coding = room.members.filter(id => bindings.get(id)?.role === 'coding')
      if (coding.length === 0) {
        rt.warn('chat-to-fix: no bound Coding bot in group %s; the work directory %s was not set for anyone', groupId, dir)
        return
      }
      const path = await rt.cleanWorkDir(dir)
      // The group may have changed while the path was checked.
      const live = needRoom(groupId)
      for (const id of coding.filter(member => live.members.includes(member))) {
        ;(live.memberDirs ??= {})[id] = path ?? null
      }
      await rt.save()
      for (const id of coding) void rt.followFolder({ botId: id, roomId: groupId })
    },

    // channel.js:670 sendUser, for a group id only and without ensureCapabilities.
    async postTask(groupId, text, requestId = randomUUID()) {
      await rt.load()
      const room = needRoom(groupId)
      await ctx.sessionController.prompt({
        requestId,
        sessionId: rt.sessionOfRoom(room),
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, AbortSignal.timeout(30_000))
    },

    // tools.js:161 message_bot (its own-chat path) and handoffs.js:101 openWork: a request from
    // the bot behind fromSessionId; the answer goes back to that session (to its group session
    // when the request is made from one, as fromRoomId does).
    async askBot({ fromSessionId, toBotId, text }) {
      await rt.load()
      const sender = needBot(rt.selfOf(fromSessionId))
      const target = needBot(toBotId)
      if (sender.id === target.id) throw new Error('A bot cannot ask itself')
      const exchangeId = randomUUID()
      const parent = rt.workOf(rt.live.get(fromSessionId)?.info)
      rt.openWork(exchangeId, { from: sender.id, to: target.id, parent })
      const fromRoomId = rt.groupOwners.get(fromSessionId)?.roomId
      try {
        await rt.deliver({ fromId: sender.id, toId: target.id, text, role: 'request', steer: rt.live.get(rt.chatOf(target.id))?.turn !== undefined, exchangeId, ...(fromRoomId ? { fromRoomId } : {}) })
      } catch (error) {
        rt.dropWork(exchangeId)
        throw error
      }
    },

    // turns.js:273 stopChat (own chat) and groups.js:1353 stopMemberWork (each group it is in).
    async stopBot(botId) {
      await rt.load()
      needBot(botId)
      await rt.stopChat(botId)
      for (const room of Object.values(rt.state.rooms) as any[]) {
        if (room.members.includes(botId)) await rt.stopMemberWork(room.id, botId)
      }
    },

    // groups.js:1378 stopRoomWork. Callers stop a group before deleting it.
    async stopGroup(groupId) {
      await rt.stopRoomWork(groupId)
    },

    // roster.js:649 deleteRoom.
    async deleteGroup(groupId) {
      await rt.load()
      await rt.deleteRoom(groupId)
    },

    // roster.js:701 deleteBot; the binding goes with it.
    async deleteBot(botId) {
      await rt.load()
      await rt.deleteBot(botId)
      bindings.delete(botId)
    },

    // store.js: the group record.
    groupExists: groupId => rt.roomOf(groupId)?.id === groupId,

    // groups.js:1401 (workingInRoom, roomBatchPending), goals.js:614 (inbox) and turns.js (roomProgress):
    // no round in progress, no member working, no unfinished batch, empty group inbox.
    isQuiet(groupId) {
      const room = rt.roomOf(groupId)
      if (room === undefined) return true
      if ([...rt.roomProgress.values()].some(round => round.roomId === room.id)) return false
      if (rt.workingInRoom(room).length > 0) return false
      if (rt.roomBatchPending(room.id) === true) return false
      return (rt.roomInbox.get(room.id)?.length ?? 0) === 0
    },

    // turns.js:415 activityView, :462 workView, :503 roomWorkView; handoffs.js:263 waitingView.
    status: () => ({ activity: rt.activityView(), work: rt.workView(), rooms: rt.roomWorkView(), waiting: rt.waitingView() }),

    onGroupLine: fn => subscribe(listeners.line, fn),
    onSessionEvent: fn => subscribe(listeners.session, fn),
    onToolResult: fn => subscribe(listeners.tool, fn),
    onRoundEnd: fn => subscribe(listeners.round, fn),
    onApproval: fn => subscribe(listeners.approval, fn),
    onUsage: fn => subscribe(listeners.usage, fn),
    // approvals.js:100
    answerApproval: (id, choice) => rt.answerApproval(id, choice),

    runReview,

    // New: the in-memory binding table.
    // A bot's own-chat session gets its tool scope when the bot is created, which is before the
    // runner can bind it, so the attach hook in tools.js (shareBotTools) has already run for it
    // and found no role. Binding therefore attaches the role's tools to that session itself;
    // the bot's group sessions are made later and get them through the hook.
    async bindBot(botId, { taskId, role }) {
      bindings.set(botId, { taskId, role })
      if (typeof rt.taskLayer?.attachRoleTools !== 'function') return
      try {
        const agent = await rt.resolveAgent(rt.chatOf(botId))
        if (agent !== undefined) rt.taskLayer.attachRoleTools(agent)
      } catch (error) {
        rt.warn('chat-to-fix: could not attach the role tools of %s to its own session: %s', botId, error)
      }
    },
    unbindBot(botId) { bindings.delete(botId) },
    // store.js:494 selfOf plus the binding table.
    botOfSession(sessionId) {
      const botId = rt.selfOf(sessionId)
      const binding = botId === undefined ? undefined : bindings.get(botId)
      return binding === undefined ? undefined : { botId, role: binding.role, taskId: binding.taskId }
    },
  }
}
