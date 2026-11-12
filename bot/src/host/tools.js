// Team tools: the roster, bot-to-bot messages and stops, and group posts. Group rounds and reading chats are in groups.js.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MESSAGE_INLINE_MAX, SOURCE_KIND } from './constants.js'
import { within } from './folders.js'
import { absoluteLinks } from './links.js'
import { NAME_MAX } from './requests.js'
import { unquote } from './text.js'
import { mentionSpans } from '../shared/mentions.js'

// DSH's own defineTool, handed on so the task layer defines its role tools the same way.
export { defineTool }

export const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
export const GROUP_REF = { type: 'string', required: true, description: 'Exact group chat name from list_bots' }
const BLOCKING_QUESTION_TOOL = 'ask_user_question'
// DS Bot has its own group goals; DSH's session goal still does not survive conversation parts.
const GOAL_TOOLS = ['create_goal', 'update_goal', 'get_goal']
// DSH's delegation tools start child agents the user cannot watch or stop, and they
// end with the conversation part that started them; Bots hand work to other Bots.
// Agent Teams' teammates are such children too (#973).
const DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'ralph', 'spawn_teammate', 'wait_agent', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update']
// restrict() refuses a whole list when one name is registered in the Agent's own
// scope, so each group is masked on its own.
const HIDDEN_TOOL_GROUPS = [[BLOCKING_QUESTION_TOOL, ...GOAL_TOOLS], DELEGATION_TOOLS]
const HIDDEN_TOOLS = HIDDEN_TOOL_GROUPS.flat()
// The guidance DSH writes into the prompt for the hidden tools. Agent Teams makes
// every root Session a Team Lead and tells it to spawn teammates in `team:policy`;
// its `team:identity` context is required, so DSH puts it back after any filter.
const HIDDEN_SECTIONS = new Set([...HIDDEN_TOOLS.map(name => `tool:${name}`), 'tool:goal', 'team:policy'])
const GOAL_REFUSAL = 'Bot chats do not run /goal. To give a group a goal, use Set a goal in its + menu.'
// DSH 0.2.2's schedule tools can deliver to a new Session, which is outside the team and
// has no Bot; a Bot's tasks deliver to its own chat, which DS Bot moves on with each part.
const SCHEDULE_TARGET_TOOLS = ['schedule_create', 'schedule_edit']
const SCHEDULE_TARGET_REFUSAL = 'A Bot’s scheduled tasks run in its own chat. Use target "this_session".'
const DELEGATION_REFUSAL = 'Bots do not start subagents, teammates or workflows. Do the work yourself, or hand it to another Bot with message_bot.'
const WORKING_DIRECTORY_TOOL = 'working_directory'

export function install(rt) {
  const { ctx, state } = rt

  const callerBot = (exec) => rt.botOf(rt.selfOf(exec.agent?.id))
  const callerRoom = (exec) => {
    const roomId = rt.groupOwners.get(exec.agent?.id)?.roomId
    return roomId ? { fromRoomId: roomId } : {}
  }

  const roomLine = (room, self) => {
    const members = room.members.map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${bot.id === room.admin ? ' (admin)' : ''}${bot.id === self ? ' (you)' : ''}`)
    const parts = [
      `members: ${members.join(', ')}`,
      room.mode === 'admin' && room.admin ? 'plain messages go to the admin first' : 'every member replies in turn',
      room.notice ? `notice: ${room.notice.split('\n')[0].slice(0, 100)}` : '',
      room.workDir ? `members work in ${room.workDir} here` : '',
      room.permission ? `members work with the ${room.permission} permissions here` : '',
      room.goal !== undefined ? `goal: "${room.goal.title}" (${room.goal.status}${room.goal.status === 'active' || room.goal.status === 'paused' ? `, stage ${Math.min(room.goal.current + 1, room.goal.stages.length)}/${room.goal.stages.length}` : ''})` : '',
    ].filter(Boolean)
    return `- "${room.name}" — ${parts.join('; ')}`
  }
  // Main Bots see every group; other Bots see the groups they are in.
  // chat-to-fix: a Bot may stop another only as the admin of a group both are members of.
  const mayStop = (senderId, targetId) => Object.values(state.rooms).some(room => rt.isAdminOf(room, senderId) && room.members.includes(senderId) && room.members.includes(targetId))
  const visibleRooms = self => Object.values(state.rooms).filter(room => rt.isMain(self) || room.members.includes(self))

  rt.teamTools.push(defineTool({
    name: 'list_bots',
    description: 'List every Bot on the user\'s team with its role, what it does and what it is doing right now, and the group chats you can see.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const lines = Object.values(state.bots).map(bot => {
        // A private Bot is only named to the others: not what it does, where, or what now.
        if (bot.private === true && bot.id !== self) return `- ${bot.name} (${[bot.role, 'private Bot, closed to other Bots'].filter(Boolean).join(', ')})`
        const model = bot.appliedModel ?? bot.model
        const tags = [bot.role, model ? `model ${model}` : '', bot.workDir ? `works in ${bot.workDir}` : '', rt.isMain(bot.id) ? 'Main Bot' : '', bot.private === true ? 'private' : '', bot.id === self ? 'you' : ''].filter(Boolean).join(', ')
        const job = bot.instructions ? ` — ${bot.instructions.split('\n')[0].slice(0, 120)}` : ''
        const now = bot.id === self ? '' : `\n  now: ${rt.statusOf(bot.id)}`
        return `- ${bot.name}${tags ? ` (${tags})` : ''}${job}${now}`
      })
      if (lines.length === 0) return 'No Bots yet.'
      const rooms = visibleRooms(self)
      return [
        'Bots:',
        ...lines,
        '',
        rooms.length === 0 ? 'Group chats: none you can see.' : 'Group chats:',
        ...rooms.map(room => roomLine(room, self)),
      ].join('\n')
    },
  }))

  // Sessions a Bot is running in right now: its own chat plus each group Session
  // with a live turn. An idle Bot reports just its own chat.
  const activeSessions = (botId) => {
    const running = [...new Set([rt.chatOf(botId), ...rt.groupSessionsOf(botId)])]
      .filter(sessionId => rt.live.get(sessionId)?.turn !== undefined)
    return { running, idle: running.length === 0 }
  }
  const whereOf = (sessionId) => {
    const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
    return room ? `group "${room.name}"` : 'its own chat'
  }
  // A Bot request still in the inbox: no step or turn has taken it out yet.
  const unreadRequest = (agent, senderId, toUser) => {
    for (const [message, steered] of [...(agent.inbox?.nextStep ?? []).map(message => [message, true]), ...(agent.inbox?.nextTurn ?? []).map(message => [message, false])]) {
      const source = message.source
      if (source?.kind === SOURCE_KIND && source.role === 'request' && source.senderSessionId === senderId
        && (source.audience === 'user') === toUser && !source.deferred && !source.resumed) return { message, steered }
    }
    return undefined
  }
  // A message's own words and files, without its header line.
  const bodyOf = (message) => {
    const content = Array.isArray(message.content) ? message.content : []
    const first = content.find(block => block?.type === 'text')?.text ?? ''
    return { text: first.slice(first.indexOf('\n') + 1), files: content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment) }
  }

  // A tool that throws shows as failed in the chat, instead of as sent or stopped.
  const refuse = (message) => { throw new Error(message) }

  // The works (handoffs.js) the calling turn does: what it answers, and the requests
  // that joined it.
  const worksOf = (exec) => {
    const turn = rt.live.get(exec.agent?.id)
    return [rt.workOf(turn?.info), ...(turn?.joined ?? []).map(joined => rt.workOf(joined.info))].filter(Boolean)
  }
  const tooLong = text => `Not sent: the message has ${text.length} characters, more than ${MESSAGE_INLINE_MAX}, and this DeepSeek Harness cannot send it as a file. Write it to a file in your working folder and send its path instead.`

  // Work for a group stays in it: from a group Session, message_bot calls a member there
  // exactly as an "@Name" line would, and never reaches a Bot outside the group.
  const groupRefusal = (room, sender, target) => {
    if (room.members.includes(target.id)) return undefined
    return `Not sent: ${target.name} is not in "${room.name}", and work for this group stays in it. Ask the user to add ${target.name} to the group.`
  }

  const callInGroup = async (exec, room, sender, target, message) => {
    const call = `@${target.name}`
    await rt.roomStepText(exec.agent.id, rt.live.get(exec.agent.id)?.info, message.startsWith(call) ? message : `${call} ${message}`, false)
    return `Called ${target.name} in "${room.name}" with your message, as writing "${call}" there does: it works on it in the group, and you answer its result there. Nothing went to its own chat.`
  }

  // The Bots each Session's post_to_group called by name in its current turn, so that
  // turn does not also send them the same work in their own chats.
  const calledInPosts = new Map()
  const turnOf = exec => rt.live.get(exec.agent?.id)?.turn

  rt.teamTools.push(defineTool({
    name: 'message_bot',
    description: 'Send a message to another Bot on the team. If that Bot is working, it reads your message at its next step and can change course, then answers once that work is done; if it is idle, it starts on it right away. Its reply arrives later as a new message to you; with reply_to "user" it answers the user in its own chat instead. In a group chat it reaches only members of that group, as writing "@Name" there does. With request_id you name the request yourself: a repeat of that name with the same message is not sent again, but gives the receipt of the first call back.',
    parameters: {
      to: { type: 'string', required: true, description: 'Exact Bot name from list_bots' },
      message: { type: 'string', required: true, description: 'Self-contained message; the other Bot cannot see this conversation' },
      reply_to: {
        type: 'string',
        enum: ['me', 'user'],
        description: '"me" (default): the reply comes back to you and the user does not see it. "user": the Bot answers the user in its own chat, where the user reads it, and nothing comes back to you. Use "user" whenever the user wants to hear from that Bot directly or asks Bots to say something in their own chats.',
      },
      when: {
        type: 'string',
        enum: ['now', 'queue'],
        description: '"now" (default): a working Bot reads your message at its next step, between its current actions, and answers once its current work is done; use it for questions, information it needs, corrections and warnings. "queue": it reads your message only after its current work is done, as a separate task; use it only for a new task unrelated to what it is doing now. With reply_to "user" the message always queues.',
      },
      request_id: {
        type: 'string',
        description: `Your own name for this request, up to ${NAME_MAX} characters, so that a repeat of it is not sent twice. Send the same request_id with the same message when you repeat a call: the receipt of the first call comes back and nothing is sent again. A request_id names one request: with other content it is refused.`,
      },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined) return 'Only Bots on the team can use message_bot.'
      const target = rt.findBot(args.to)
      if (target === undefined) return `No Bot named ${args.to}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`
      if (target.id === sender.id) return 'You cannot message yourself.'
      if (String(args.message ?? '').trim() === '') return 'Write a message to send.'
      const name = typeof args.request_id === 'string' ? args.request_id.trim() : ''
      if (name.length > NAME_MAX) return `The request_id is ${name.length} characters long; a request name is at most ${NAME_MAX}.`
      const text = absoluteLinks(String(args.message), rt.sessionFolder?.(exec.agent?.session ?? exec.agent))
      const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
      // The request the caller named: it is admitted once, and a repeat of it is not sent again.
      const request = name === '' ? undefined : rt.requestIdentity({
        caller: sender.id,
        context: room === undefined ? 'chat' : `room:${room.id}`,
        name,
        payload: {
          to: target.id,
          message: String(args.message ?? '').replace(/\r\n?/g, '\n').trim(),
          reply_to: args.reply_to === 'user' ? 'user' : 'me',
          when: args.when === 'queue' ? 'queue' : 'now',
        },
      })
      // What the caller gets for a request that was admitted before.
      const answer = (outcome) => {
        if (outcome.status === 'replay') return outcome.receipt
        if (outcome.status === 'conflict') refuse(`Not sent: request_id "${name}" was already used for a different request. A request_id names one request; send this one under a new name.`)
        if (outcome.status === 'uncertain') refuse(`Not sent again: the outcome of request_id "${name}" is not known (the delivery failed, or DS Bot restarted while it was in flight), so it was not sent again. Check whether ${target.name} got it before sending it under a new name.`)
        if (outcome.status === 'expired') return `Nothing was sent again: request_id "${name}" was admitted before, but its receipt is no longer kept, so only the fact that it was sent is left. Send the work under a new request_id if it must be done again.`
        if (outcome.status === 'readonly') refuse(`Not sent: this window cannot save the Bot team, so it cannot record the request_id "${name}". Send it from the window that owns the team, or leave the request_id out.`)
        return outcome.receipt
      }
      if (request !== undefined) {
        const seen = await rt.knownRequest(request)
        if (seen !== undefined) return answer(seen)
      }
      if (room !== undefined) {
        const refusal = groupRefusal(room, sender, target)
        if (refusal !== undefined) refuse(refusal)
        const send = () => callInGroup(exec, room, sender, target, text.trim())
        return request === undefined ? await send() : answer(await rt.admitRequest(request, send))
      }
      const posted = calledInPosts.get(exec.agent?.id)
      const postedIn = posted !== undefined && posted.turn === turnOf(exec) ? posted.calls.get(target.id) : undefined
      if (postedIn !== undefined) refuse(`Not sent: you called ${target.name} in "${postedIn}" in this turn, and it works on that there. Send each task one way only; to add to it, post in that group.`)
      // Whoever waits for this work gets the answer by itself; a message there only
      // sends the work round in a circle. Not a failed call: the turn goes on with
      // the work, and the result says where its answer goes instead of showing a
      // bare error the Bot cannot act on.
      const works = worksOf(exec)
      if (rt.upstreamOf(works).has(target.id)) {
        return `Not sent: ${target.name} is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back. Finish the work and end your turn; to ask ${target.name} something, end your turn with the question.`
      }
      const send = async () => {
        const toUser = args.reply_to === 'user'
        const work = toUser ? undefined : works[0]
        const chat = rt.chatOf(target.id)
        const agent = await rt.resolveAgent(chat)
        const status = rt.statusOf(target.id)
        // A request it has not read yet, sent for the same work, takes this one in, so
        // messages to a Bot that cannot read them do not pile up.
        const earlier = unreadRequest(agent, sender.id, toUser)
        const joinable = earlier !== undefined && (toUser || rt.sameWork(earlier.message.source.exchangeId, work))
        const before = joinable ? bodyOf(earlier.message) : undefined
        let long = await rt.attachLong(before ? `${before.text}\n\n${text}` : text, `Message from ${sender.name}.txt`)
        // Nothing went out, so a named request must not take this as a delivered
        // receipt: admitRequest drops the pending record instead, and a retry can send.
        if (long === undefined) { if (request !== undefined) request.unsent = true; return tooLong(text) }
        const joins = before !== undefined && agent.inbox?.remove?.(earlier.message.id) === true
        if (before !== undefined && !joins) long = await rt.attachLong(text, `Message from ${sender.name}.txt`) ?? long
        const working = rt.live.get(chat)?.turn !== undefined
        const steer = (args.when !== 'queue' && !toUser) || (joins && earlier.steered)
        const exchangeId = joins ? earlier.message.source.exchangeId : randomUUID()
        if (joins) rt.forgetDelivery?.(exchangeId)
        else if (!toUser) rt.openWork(exchangeId, { from: sender.id, to: target.id, parent: work })
        try {
          await rt.deliver({ fromId: sender.id, toId: target.id, text: long.text, files: [...long.files, ...(joins ? before.files : [])], length: long.length, role: 'request', steer, exchangeId, ...(joins ? { merged: true } : {}), ...(toUser ? { audience: 'user' } : {}) })
        } catch (error) {
          // The delivery stays noted for the next start while its Bot exists
          // (resume.js), and the resent request still answers up the tree, so the
          // work it opened stays too. Only a target that is gone drops the work.
          if (!joins && rt.botOf(target.id) === undefined) rt.dropWork(exchangeId)
          throw error
        }
        const sent = toUser
          ? `Delivered to ${target.name}. It will answer the user in its own chat; nothing comes back to you, so point the user to ${target.name}'s chat instead of relaying.`
          : working && steer
            ? `Delivered to ${target.name} while it is working: it reads your message at its next step and answers once that work is done. Its reply will arrive later as a new message; do not wait for it.`
            : working
              ? `Queued for ${target.name}: it reads your message after its current work. Its reply will arrive later as a new message; do not wait for it.`
              : `Delivered to ${target.name}. Its reply will arrive later as a new message; do not wait for it.`
        const asker = rt.ownsWork(sender.id, work) ? rt.botOf(state.works[work].from)?.name : undefined
        const notes = [
          joins ? `${target.name} had not read your earlier message yet, so this one was added to it, and it answers both at once.` : '',
          status === 'idle' ? '' : `${target.name} now: ${status}.`,
          asker ? `When you have handed on everything, end your turn: each reply brings you back to this work, and your answer goes to ${asker} once all of it is back.` : '',
        ].filter(Boolean)
        const out = [sent, ...notes].join(' ')
        // Messages reach a Bot's own chat only; work in a group goes on without them.
        const groups = activeSessions(target.id).running.filter(sessionId => sessionId !== chat)
        if (groups.length === 0) return out
        const stop = mayStop(sender.id, target.id) ? ' If it must not go on there, use stop_bot.' : ''
        return `${out} Your message does not reach its work in ${groups.map(whereOf).join(' and ')}.${stop}`
      }
      return request === undefined ? await send() : answer(await rt.admitRequest(request, send))
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'stop_bot',
    description: 'Group admin only: for a Bot that shares a group chat with you, which you administer. Stop another Bot\'s running turn immediately — when it must not finish a dangerous action and a message_bot warning is not enough. Its queued messages are dropped with the turn. It is then told why in a new turn, whose reply comes back to you.',
    parameters: {
      bot: { type: 'string', required: true, description: 'Exact Bot name from list_bots' },
      reason: { type: 'string', description: 'Why it was stopped; it reads this afterwards' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined) refuse('Only Bots on the team can use stop_bot.')
      const target = rt.findBot(args.bot)
      if (target === undefined) refuse(`No Bot named ${args.bot}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`)
      if (target.id === sender.id) refuse('You cannot stop yourself.')
      if (!mayStop(sender.id, target.id)) refuse(`Only the admin of a group that ${target.name} is also in can stop it.`)
      const { running } = activeSessions(target.id)
      if (running.length === 0) refuse(`${target.name} is not running right now, so there is nothing to stop. Use message_bot to reach it.`)
      for (const sessionId of running) {
        const agent = await rt.resolveAgent(sessionId)
        agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })
      }
      const why = String(args.reason ?? '').trim() || 'Stop what you are doing; the previous turn was ended on purpose. Acknowledge briefly.'
      await rt.deliver({ fromId: sender.id, toId: target.id, text: why, role: 'stopped', ...callerRoom(exec) })
      return `Stopped ${target.name} in ${running.map(whereOf).join(' and ')}. It is told why in a new turn, whose reply comes back to you.`
    },
  }))

  const groupNames = self => visibleRooms(self).map(room => `"${room.name}"`).join(', ') || 'none'
  const pickRoom = (ref, self) => {
    const matches = rt.findRooms(ref).filter(room => visibleRooms(self).includes(room))
    if (matches.length === 1) return { room: matches[0] }
    if (matches.length > 1) return { error: `Several group chats are called "${unquote(ref)}". Rename one first.` }
    return { error: `No group chat called "${unquote(ref)}" that you can see. Groups: ${groupNames(self)}.` }
  }

  // DSH's working_directory changes a Session's folder in place, and the next part starts in
  // the Bot's working folder again. A Bot that changes to a folder outside its working folder
  // sets its working folder instead, with the checks of a folder change, and goes on in a fresh part
  // there; a folder inside it only moves this Session there. In a group without a folder of
  // its own the change holds only for that conversation: the Bot's folder, its other groups
  // and its own chat keep theirs (folders.js memberDirs).
  ctx.on('tools/execute', async (exec, next) => {
    // Resolved as DSH gets it, untrimmed, so that both mean the same folder.
    const cd = exec.name === WORKING_DIRECTORY_TOOL && typeof exec.arguments?.cd === 'string' ? exec.arguments.cd : ''
    const session = exec.agent?.session
    if (cd === '' || session === undefined) return next()
    await rt.load()
    const bot = callerBot(exec)
    if (bot === undefined) return next()
    const room = rt.roomOf(rt.groupOwners.get(exec.agent.id)?.roomId)
    const home = rt.workDirOf({ botId: bot.id, roomId: room?.id }) ?? rt.teamFolder()
    const target = await rt.folderAt(rt.sessionFolder(session), cd)
    if (target === undefined || !(await rt.isFolder(target)) || home === undefined || within(target, await rt.real(home))) return next()
    if (room?.workDir) throw new Error(`Every member of "${room.name}" works in ${room.workDir} here, so you stay inside it. The user or a Main Bot can change the group's folder.`)
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(`Your working folder cannot change now: ${readOnly}`)
    // Saved folders are trimmed like typed ones, so such a name would save another folder.
    if (unquote(target) !== target) throw new Error(`${JSON.stringify(target)} cannot be a working folder: its name starts or ends with a space or a quote mark.`)
    const workDir = await rt.workFolder(target)
    if (room !== undefined) {
      // The folder holds only for this group conversation, so only this Session's
      // writes widen; the private-Bot check is the one updateBot would run.
      await rt.checkPrivacyChange(bot, { moving: true, workDir })
      await rt.approveFolder(exec, { path: workDir, sessions: [exec.agent.id], who: { en: bot.name, zh: ` ${bot.name} ` } })
      const result = await next()
      if (result?.isError !== true) {
        ;(room.memberDirs ??= {})[bot.id] = workDir ?? null
        await rt.save()
      }
      return result
    }
    await rt.approveFolder(exec, { path: workDir, sessions: rt.sessionsOfBot(bot.id), who: { en: bot.name, zh: ` ${bot.name} ` } })
    const result = await next()
    if (result?.isError !== true) await rt.updateBot(bot.id, { workDir: workDir ?? '' }, rt.selfOf(exec.agent?.id))
    return result
  })

  rt.teamTools.push(defineTool({
    name: 'post_to_group',
    description: 'Post a message into a group chat as yourself. A Main Bot may post into any group, any other Bot into a group it is in. A Main Bot\'s or the group admin\'s post starts a round: members reply in the group, where the user reads them. Another member\'s post calls only the members it names with "@Name"; without one it is only written into the group.',
    parameters: {
      group: GROUP_REF,
      message: { type: 'string', required: true, description: 'What to say; write "@Name" to choose who answers, and a name without "@" to only mention a member' },
      report_back: { type: 'boolean', description: 'Also send the members\' replies back to you as a new message when the round ends' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const sender = rt.botOf(self)
      if (sender === undefined) return 'Only Bots on the team can use post_to_group.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      // An ordinary member's post calls only the members it names (openingSpeakers).
      const member = !rt.isMain(self) && !rt.isAdminOf(room, self)
      const info = rt.live.get(exec.agent?.id)?.info
      if (info?.role === 'room' && info.roomId === room.id) return `You are speaking in "${room.name}" right now. Write your message as your reply instead.`
      const text = absoluteLinks(String(args.message ?? '').trim(), rt.sessionFolder?.(exec.agent?.session ?? exec.agent))
      if (text === '') return 'Write a message to post.'
      // Counted on the whole message. A post past MESSAGE_INLINE_MAX keeps only its
      // first LONG_HEAD characters, and the round reads this list instead of that text.
      const spans = mentionSpans(text, room.members.map(rt.botOf).filter(Boolean))
      const named = []
      for (const span of spans) {
        if (span.bot && span.bot.id !== self && !named.includes(span.bot.id)) named.push(span.bot.id)
      }
      const mentions = { ids: named, all: spans.some(span => span.all === true) }
      const reportBack = args.report_back === true
      if (member && reportBack && named.length === 0) {
        return 'Nobody would answer: your post only calls the members you name. Write "@Name" for each member who should answer, or post without report_back.'
      }
      const long = await rt.attachLong(text, `Post from ${sender.name}.txt`)
      if (long === undefined) return tooLong(text)
      // Replies the poster waits for, while it works on what a Bot asked it for, are
      // work handed on for that request (handoffs.js).
      const work = reportBack ? worksOf(exec).find(id => rt.ownsWork(self, id)) : undefined
      const sub = work === undefined ? undefined : randomUUID()
      if (sub !== undefined) rt.openWork(sub, { from: self, room: room.id, parent: work })
      try {
        // A post that wants the replies names the conversation it was written
        // from, so the report comes back there instead of the own chat.
        await rt.postToRoom(room, sender, long.text, { mentions, ...(reportBack ? { reportBack: true, ...callerRoom(exec) } : {}), ...(member ? { member: true } : {}), ...(sub ? { sub } : {}), ...(long.length ? { length: long.length } : {}) }, long.files)
      } catch (failure) {
        if (sub !== undefined) rt.dropWork(sub)
        return `Could not post in "${room.name}": ${failure.message}`
      }
      if (member && named.length === 0) return `Posted in "${room.name}", where the user and its members read it. Nobody answers it: your post only calls the members you name with @Name.`
      if (named.length > 0) {
        const turn = turnOf(exec)
        const earlier = calledInPosts.get(exec.agent?.id)
        const calls = new Map(earlier !== undefined && earlier.turn === turn ? earlier.calls : [])
        for (const id of named) calls.set(id, room.name)
        calledInPosts.set(exec.agent?.id, { turn, calls })
      }
      const asker = sub === undefined ? undefined : rt.botOf(state.works[work]?.from)?.name
      const waits = asker ? ` End your turn when you have handed on everything: the replies bring you back to this work, and your answer goes to ${asker} once all of it is back.` : ''
      return `Posted in "${room.name}". Members reply there, where the user reads them${reportBack ? '; their replies also come back to you as a new message when the round ends' : ', and nothing comes back to you'}.${waits}`
    },
  }))

  // The team tools live in each Session's own scope, never in the global layer:
  // a Bot's chat and a member's group Session get all of them, a group's own
  // Session gets only its relay, and a Session ds-bot does not own gets none —
  // so they never appear in a plain dsh conversation, and another plugin's
  // same-named global tool can neither collide with them at boot nor shadow
  // them inside these Sessions. What is scoped onto a Session is kept by its
  // disposers and goes with the ownership: indexSessions (store.js) runs
  // syncScopedTools on every save and adopt, so a deleted Bot's adopted
  // Session, a member who left, or a deleted group shows the plain dsh surface
  // again — and the unload effect lifts whatever is left. The same sync scopes
  // the live Agents back: a reload lifts their scope while they are still
  // live, and agent/created does not fire for them again, so without the walk
  // their next request would come without the team tools.
  /** @type {Map<string, {agent: any, relay: boolean, tools: boolean, restricted: boolean, filtered: boolean, disposers: Array<() => void>, unlisted: Set<string>}>} */
  const scoped = new Map()
  const unscope = (id) => {
    const held = scoped.get(id)
    if (held === undefined) return
    scoped.delete(id)
    for (const dispose of held.disposers) {
      try {
        dispose()
      } catch (error) {
        rt.warn('ds-bot: a scoped tool of %s was not removed: %s', id, error)
      }
    }
  }
  const syncScopedTools = () => {
    // unscope() deletes as it goes, which a Map keys iterator takes in stride.
    for (const id of scoped.keys()) {
      if (!rt.isBotSession(id) && rt.roomOf(id) === undefined) unscope(id)
    }
    // A reload lifts the scope of Agents that are still live, and an adopted
    // file can newly own one that already runs: scope each live Agent the team
    // owns before its next request. hideBotUnusedTools does nothing for a
    // Session that stays unowned, and nothing twice for one already scoped.
    for (const agent of ctx.get?.('agents')?.list?.() ?? []) hideBotUnusedTools(agent)
  }
  ctx.effect(() => () => { for (const id of scoped.keys()) unscope(id) }, 'ds-bot: scoped team tools')

  // A wanted Session whose Agent cannot take scoped tools yet is warned about
  // once; held.tools stays unset, so the next step's check tries again.
  const registerless = new WeakSet()
  const shareBotTools = (agent) => {
    if (agent === undefined) return
    const id = agent.session?.id
    const owns = rt.isBotSession(id)
    const relayOnly = !owns && rt.roomOf(id) !== undefined
    const wanted = owns || relayOnly
    let held = scoped.get(id)
    // The local-agent tools (the CLI permission bridge) join the scope only of
    // a Bot whose route is a local agent; they are not in rt.teamTools. A Bot
    // can move onto or off a local route after its Agent exists.
    const self = owns ? rt.botOf(rt.selfOf(id)) : undefined
    const localBot = rt.isLocalAgentRef?.(self?.appliedModel ?? self?.model) === true
    // A Session that left the team, a scope of the wrong kind, a fresh Agent
    // for one Session, or a Bot that changed between a local route and a model
    // all start over; a wanted scope is registered again below.
    if (held !== undefined && (!wanted || held.agent !== agent || held.relay !== relayOnly || (held.tools === true && held.local !== localBot))) {
      unscope(id)
      held = undefined
    }
    if (!wanted || held?.tools === true) return
    if (typeof agent.ctx?.tools?.register !== 'function') {
      if (!registerless.has(agent)) {
        registerless.add(agent)
        rt.warn('ds-bot: %s needs the team tools but its Agent cannot register them yet', id)
      }
      return
    }
    const disposers = []
    const failed = []
    const registered = []
    for (const def of [...rt.teamTools, ...(localBot ? (rt.localAgentTools ?? []) : [])]) {
      if (relayOnly && def.name !== 'group_relay') continue
      try {
        const dispose = agent.ctx.tools.register(def)
        if (typeof dispose === 'function') {
          disposers.push(dispose)
          ;(held ??= { relay: relayOnly, tools: false, restricted: false, filtered: false, disposers: [], unlisted: new Set() }).toolLifts ??= new Map()
          held.toolLifts.set(def.name, dispose)
        }
        registered.push(def.name)
      } catch (error) {
        // A tool another plugin already scoped onto this agent stays missing
        // rather than stopping the team; the rest still land.
        failed.push(`${def.name}: ${error.message ?? error}`)
      }
    }
    held ??= { relay: relayOnly, tools: false, restricted: false, filtered: false, disposers: [], unlisted: new Set() }
    held.agent = agent
    held.relay = relayOnly
    held.tools = true
    held.local = localBot
    held.disposers.push(...disposers)
    scoped.set(id, held)
    // A scope made outside creation never reached a collected tool list; the
    // assemble adds the pending names to the step's list once, then clears them.
    for (const name of registered) held.unlisted.add(name)
    if (failed.length > 0) rt.warn('ds-bot: team tools not served to %s: %s', id, failed.join('; '))
    // chat-to-fix: the task layer registers the role tools of the bot this session belongs to, in the
    // session's own scope (spec 4, 4.1). The group's own relay Session is not a bot's.
    if (owns) rt.taskLayer?.attachRoleTools?.(agent)
  }

  // The standard preset registers `subagent` (model selection) in each Agent's own
  // scope, where restrict() and a same-name section cannot reach it, so the Bot's
  // assembly drops the hidden tools and their guidance instead. restrict still
  // masks what it can, so lookup and execution stay aligned, and the guard
  // refuses calls. The assembly filter goes on every Bot Session whether or not
  // the tools are served yet: subagent's own agent/created listener can run
  // after this one.
  const filterBotAssembly = (agent, held) => {
    if (held.filtered === true || typeof agent.ctx?.on !== 'function') return
    const dispose = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      // DSH 0.2.2 adds the tool list after this waterfall (#814), so only an
      // older assembly still carries tools to drop here.
      return {
        ...assembled,
        ...Array.isArray(assembled.tools) ? { tools: assembled.tools.filter(tool => !HIDDEN_TOOLS.includes(tool.name)) } : {},
        sections: assembled.sections.filter(section => !HIDDEN_SECTIONS.has(section.name)),
      }
    })
    held.filtered = true
    if (typeof dispose === 'function') held.disposers.push(dispose)
  }

  // Tools joined after the first scoping (mail tools appear when the first
  // account is added) register into every held Agent and are offered once.
  const addTeamTool = (def) => {
    if (rt.teamTools.some(tool => tool.name === def.name)) return
    rt.teamTools.push(def)
    for (const held of scoped.values()) {
      if (held.relay || typeof held.agent?.ctx?.tools?.register !== 'function') continue
      try {
        const dispose = held.agent.ctx.tools.register(def)
        if (typeof dispose === 'function') held.disposers.push(dispose)
        held.unlisted.add(def.name)
      } catch { /* an agent that refuses it simply lacks the tool */ }
    }
  }
  const removeTeamTool = (name) => {
    const at = rt.teamTools.findIndex(tool => tool.name === name)
    if (at !== -1) rt.teamTools.splice(at, 1)
    // Scoped registrations already handed out are disposed by name.
    for (const held of scoped.values()) {
      held.toolLifts?.get(name)?.()
      held.toolLifts?.delete(name)
      held.unlisted.delete(name)
    }
  }

  // Per-Bot connector switches (state.connectors[id].offFor): deny the served
  // tools matching each off connector's prefix. Re-applied on tools/change.
  const maskConnectorTools = (agent, held) => {
    if (typeof agent.ctx?.tools?.restrict !== 'function' || typeof ctx.tools?.schemas !== 'function') return
    const botId = rt.selfOf(agent.session?.id)
    const prefixes = rt.connectorOffFor?.(botId) ?? []
    const served = new Set(ctx.tools.schemas(agent).map(schema => schema.name))
    const deny = [...served].filter(name => prefixes.some(prefix => name.startsWith(prefix)))
    const before = held.connectorDenied ?? new Set()
    if (deny.length === before.size && deny.every(name => before.has(name))) return
    for (const lift of held.connectorLifts ?? []) { try { lift() } catch { /* already lifted */ } }
    held.connectorLifts = []
    held.connectorDenied = new Set(deny)
    for (const name of deny) {
      try {
        const lift = agent.ctx.tools.restrict({ deny: [name] })
        if (typeof lift === 'function') held.connectorLifts.push(lift)
      } catch { /* a scoped name cannot be restricted; connectors are global */ }
    }
  }
  const reapplyToolMasks = () => {
    for (const held of scoped.values()) {
      if (held.agent === undefined) continue
      try { maskConnectorTools(held.agent, held) } catch (error) { rt.warn('ds-bot: connector mask failed: %s', error) }
    }
  }

  // restrict() throws on a name this profile does not serve.
  const maskHiddenTools = (agent, held, served) => {
    const groups = HIDDEN_TOOL_GROUPS.map(group => group.filter(name => served.has(name))).filter(group => group.length > 0)
    if (groups.length === 0) return
    // Marked after one attempt even when a group fails, so a profile that can
    // never mask it is not re-masked on every resolve.
    held.restricted = true
    for (const deny of groups) {
      try {
        const lift = agent.ctx.tools.restrict({ deny })
        if (typeof lift === 'function') held.disposers.push(lift)
      } catch {
        // A name in the Agent's own scope fails the whole list (restrict() masks
        // inherited tools only), so mask the rest one at a time; what stays is
        // covered by the assembly filter and the guard.
        for (const name of deny) {
          try {
            const lift = agent.ctx.tools.restrict({ deny: [name] })
            if (typeof lift === 'function') held.disposers.push(lift)
          } catch {
            // Expected for names in the Agent's own scope.
          }
        }
      }
    }
  }

  // dsh's own question tool holds the turn open until the user answers, and every
  // message from another Bot or a group round queues behind it. Bot Sessions ask
  // through ask_user instead, so it is taken out of their tool list, as are the goal
  // and delegation tools. The restricts are kept with the Session's scope, so they
  // lift with it.
  const hideBotUnusedTools = (agent) => {
    shareBotTools(agent)
    const id = agent?.session?.id
    // The shell shadows go with the scope, so a reload or a Session that leaves
    // the team lifts them like the rest, and the Agent can be scoped again.
    const shadows = rt.shadowShells?.(agent) ?? []
    if (shadows.length > 0) {
      const held = scoped.get(id) ?? { relay: false, tools: false, restricted: false, filtered: false, disposers: [], unlisted: new Set() }
      held.agent = agent
      held.disposers.push(...shadows)
      scoped.set(id, held)
    }
    if (agent === undefined || !rt.isBotSession(id)) return
    const held = scoped.get(id) ?? { relay: false, tools: false, restricted: false, filtered: false, disposers: [], unlisted: new Set() }
    held.agent = agent
    scoped.set(id, held)
    filterBotAssembly(agent, held)
    if (held.restricted !== true && typeof agent.ctx?.tools?.restrict === 'function') {
      maskHiddenTools(agent, held, new Set(ctx.tools.schemas(agent).map(schema => schema.name)))
    }
    maskConnectorTools(agent, held)
  }
  ctx.on('tools/change', () => reapplyToolMasks())
  // A new Bot, part, or group Session gets its Agent before ds-bot records it, so the
  // recording path resolves it again once the session is known as a Bot's; meanwhile
  // the guard refuses the question and delegation tools in any Bot Session, and a
  // goal made there is blocked.
  ctx.tools.guard((exec) => {
    if (!rt.isBotSession(exec.agent?.id)) return undefined
    if (exec.name === BLOCKING_QUESTION_TOOL) return `Bots cannot use ${BLOCKING_QUESTION_TOOL}. Ask with ask_user in your own chat, or ask in your reply.`
    const target = exec.arguments?.target
    if (SCHEDULE_TARGET_TOOLS.includes(exec.name) && target !== undefined && target !== 'this_session') return SCHEDULE_TARGET_REFUSAL
    return DELEGATION_TOOLS.includes(exec.name) ? DELEGATION_REFUSAL : undefined
  })
  // Creation waits for this listener, so the Agent's first step already lacks the tool.
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await rt.load()
      hideBotUnusedTools(agent)
      // Creation runs before the first step collects the tool list, so the
      // names just registered will already be in it; nothing stays pending.
      scoped.get(agent?.session?.id)?.unlisted?.clear()
    } catch (error) {
      rt.warn('ds-bot: hiding %s on agent/created failed: %s', HIDDEN_TOOLS.join(', '), error)
    }
  })

  // A live Agent the creation path missed — after a restart, agent/created may
  // run before this plugin's listeners are back — is scoped by the load or
  // here, before the step's request. The request's tool list was collected
  // before this waterfall, so names scoped since are added now: a same-named
  // global entry is replaced by the scoped schema, and a PTC list that reaches
  // team tools through run_code is left alone.
  ctx.on('system-prompt/assemble', async function scopeTeamTools(_assembly, context, next) {
    const agent = context.agent
    if (agent === undefined) return next()
    try {
      await rt.load()
      hideBotUnusedTools(agent)
    } catch (error) {
      rt.warn('ds-bot: scoping the tools of %s failed: %s', agent.session?.id ?? agent.id, error)
    }
    const assembled = await next()
    const held = scoped.get(agent.session?.id)
    if (held?.unlisted === undefined || held.unlisted.size === 0) return assembled
    // DSH 0.2.2 collects the scoped tools itself after this waterfall (#814).
    if (!Array.isArray(assembled.tools)) {
      held.unlisted.clear()
      return assembled
    }
    const pending = [...held.unlisted]
    // Cleared whatever happens below: the names are offered once, not on
    // every step.
    held.unlisted.clear()
    if ((assembled.tools ?? []).some(tool => tool.name === 'run_code')) return assembled
    if (typeof ctx.tools?.schemas !== 'function') return assembled
    try {
      const wanted = new Set(pending)
      const current = new Map(ctx.tools.schemas(agent).filter(schema => wanted.has(schema.name)).map(schema => [schema.name, schema]))
      let changed = false
      const tools = (assembled.tools ?? []).map((tool) => {
        const schema = current.get(tool.name)
        if (schema === undefined) return tool
        changed = true
        return schema
      })
      const present = new Set((assembled.tools ?? []).map(tool => tool.name))
      for (const name of pending) {
        if (present.has(name) || !current.has(name)) continue
        changed = true
        tools.push(current.get(name))
      }
      return changed ? { ...assembled, tools } : assembled
    } catch (error) {
      rt.warn('ds-bot: listing the scoped tools of %s failed: %s', agent.session?.id ?? agent.id, error)
      return assembled
    }
  })

  // The /goal command stays open in every Session, so a goal started in a Bot chat or a
  // group is blocked at once; DSH's round driver then starts no round for it.
  let goals = null
  const attachGoals = (sub) => {
    const own = sub.goals
    goals = own
    sub.effect(() => () => { if (goals === own) goals = null }, 'ds-bot: goal service')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['goals'], attachGoals)
  else if (ctx.get?.('goals') !== undefined) attachGoals({ goals: ctx.get('goals'), effect: (execute, label) => ctx.effect(execute, label) })
  const blockGoal = async (sessionId) => {
    const service = goals
    if (service === null) return
    try {
      const agent = await rt.resolveAgent(sessionId)
      const goal = service.get(agent)
      if (goal?.phase !== 'active') return
      service.block(agent, { id: goal.id, revision: goal.revision }, { code: 'not-supported', message: GOAL_REFUSAL })
    } catch (error) {
      rt.warn('ds-bot: blocking the goal in %s failed: %s', sessionId, error)
    }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'goal/change' || event.data?.goal?.phase !== 'active') return
    const id = session?.id
    if (!rt.isBotSession(id) && rt.roomOf(id) === undefined) return
    // block() appends to the same log, so it waits until every listener has seen this change.
    setTimeout(() => void blockGoal(id), 0)
  })

  Object.assign(rt, { pickRoom, hideBotUnusedTools, syncScopedTools, addTeamTool, removeTeamTool, reapplyToolMasks })
}
