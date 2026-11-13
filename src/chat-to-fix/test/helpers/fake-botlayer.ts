// In-memory implementation of the I1 bot-layer facade (core/task/contracts.ts, spec 5 section 3).
// Other tests reuse it, so it follows the contract: every I1 function exists with the same
// arguments and result, and unknown ids are refused the way the real facade refuses them.
//
//   const layer = createFakeBotLayer()
//   layer.calls                  every call in order: { name, args }
//   layer.bots / layer.groups    Maps of what exists now (id -> record)
//   layer.posts                  messages posted with postTask: { groupId, text, requestId }
//   layer.bindings               Map botId -> { taskId, role }
//   layer.fail                   make a function throw: fail.createBot = true | Error | { nth: 3, error? }
//                                (nth counts calls to that function, starting at 1)
//   layer.emit.groupLine(e) / sessionEvent(e) / toolResult(e) / roundEnd(e) / approval(e) / usage(e)
//   layer.setQuiet(groupId, bool)   what isQuiet answers (default true)
//   layer.linkSession(sessionId, botId)   a session id other than the bot id (default: same id)
//   layer.reviewer = (req) => result      what runReview answers (default: { text: 'pass', stopReason: 'completed' });
//   layer.reviews                         every runReview request: { sessionId, prompt, preset, timeoutMs }
//
// A bot id doubles as its session id, as in DS Bot (a bot is a session).

const FUNCTIONS = [
  'createBot', 'createGroup', 'setGroupWorkDir', 'postTask', 'askBot', 'stopBot', 'stopGroup',
  'deleteGroup', 'deleteBot', 'groupExists', 'isQuiet', 'status',
  'onGroupLine', 'onSessionEvent', 'onToolResult', 'onRoundEnd', 'onApproval', 'onUsage', 'answerApproval',
  'bindBot', 'unbindBot', 'botOfSession', 'runReview',
]

const text = (value) => typeof value === 'string' && value.trim() !== ''

export function createFakeBotLayer({ fail = {} } = {}) {
  const calls = []
  const counts = {}
  const bots = new Map()
  const groups = new Map()
  const posts = []
  const bindings = new Map()
  const sessions = new Map()
  const quiet = new Map()
  const answers = []
  const subscribers = { groupLine: new Set(), sessionEvent: new Set(), toolResult: new Set(), roundEnd: new Set(), approval: new Set(), usage: new Set() }
  let nextBot = 1
  let nextGroup = 1

  const reviews = []
  const layer: any = { calls, bots, groups, posts, bindings, answers, fail, reviews, reviewer: () => ({ text: 'pass\nThe change is right.', stopReason: 'completed' }) }

  // Logs the call and throws when the function was told to fail.
  function enter(name, args) {
    calls.push({ name, args })
    counts[name] = (counts[name] ?? 0) + 1
    const rule = layer.fail[name]
    if (rule === undefined || rule === false) return
    if (rule === true) throw new Error(`fake bot layer: ${name} failed`)
    if (rule instanceof Error) throw rule
    if (typeof rule === 'object' && rule.nth === counts[name]) throw rule.error ?? new Error(`fake bot layer: ${name} failed (call ${rule.nth})`)
  }

  const subscribe = (set, fn) => {
    if (typeof fn !== 'function') throw new TypeError('a subscriber must be a function')
    set.add(fn)
    return () => { set.delete(fn) }
  }

  const api = {
    async createBot(def) {
      enter('createBot', [def])
      for (const field of ['name', 'label', 'instructions', 'model', 'permission']) {
        if (!text(def?.[field])) throw new Error(`createBot: ${field} is required`)
      }
      const id = `bot-${nextBot++}`
      bots.set(id, { id, ...def })
      return id
    },
    async createGroup(def) {
      enter('createGroup', [def])
      if (!text(def?.name) || !Array.isArray(def.memberIds) || !text(def.adminId)) throw new Error('createGroup: name, memberIds and adminId are required')
      for (const id of def.memberIds) if (!bots.has(id)) throw new Error(`createGroup: no such bot ${id}`)
      if (!def.memberIds.includes(def.adminId)) throw new Error('createGroup: the admin must be a member')
      const id = `group-${nextGroup++}`
      groups.set(id, { id, mode: 'admin', workDir: null, ...def })
      return id
    },
    async setGroupWorkDir(groupId, dir) {
      enter('setGroupWorkDir', [groupId, dir])
      if (!groups.has(groupId)) throw new Error(`no such group ${groupId}`)
      groups.get(groupId).workDir = dir
    },
    async postTask(groupId, message, requestId) {
      enter('postTask', [groupId, message, requestId])
      if (!groups.has(groupId)) throw new Error(`no such group ${groupId}`)
      posts.push({ groupId, text: message, requestId })
    },
    async askBot(req) {
      enter('askBot', [req])
      if (!bots.has(req?.toBotId)) throw new Error(`no such bot ${req?.toBotId}`)
    },
    async stopBot(botId) {
      enter('stopBot', [botId])
      if (!bots.has(botId)) throw new Error(`no such bot ${botId}`)
    },
    async stopGroup(groupId) {
      enter('stopGroup', [groupId])
      if (!groups.has(groupId)) throw new Error(`no such group ${groupId}`)
    },
    async deleteGroup(groupId) {
      enter('deleteGroup', [groupId])
      if (!groups.delete(groupId)) throw new Error(`no such group ${groupId}`)
      quiet.delete(groupId)
    },
    async deleteBot(botId) {
      enter('deleteBot', [botId])
      if (!bots.delete(botId)) throw new Error(`no such bot ${botId}`)
      bindings.delete(botId)
    },
    groupExists(groupId) {
      enter('groupExists', [groupId])
      return groups.has(groupId)
    },
    isQuiet(groupId) {
      enter('isQuiet', [groupId])
      return quiet.get(groupId) ?? true
    },
    status() {
      enter('status', [])
      return { bots: [...bots.keys()], groups: [...groups.keys()] }
    },
    onGroupLine(fn) { enter('onGroupLine', [fn]); return subscribe(subscribers.groupLine, fn) },
    onSessionEvent(fn) { enter('onSessionEvent', [fn]); return subscribe(subscribers.sessionEvent, fn) },
    onToolResult(fn) { enter('onToolResult', [fn]); return subscribe(subscribers.toolResult, fn) },
    onRoundEnd(fn) { enter('onRoundEnd', [fn]); return subscribe(subscribers.roundEnd, fn) },
    onApproval(fn) { enter('onApproval', [fn]); return subscribe(subscribers.approval, fn) },
    onUsage(fn) { enter('onUsage', [fn]); return subscribe(subscribers.usage, fn) },
    answerApproval(id, choice) {
      enter('answerApproval', [id, choice])
      if (choice !== 'allow' && choice !== 'reject') throw new Error(`answerApproval: bad choice ${choice}`)
      answers.push({ id, choice })
    },
    bindBot(botId, binding) {
      enter('bindBot', [botId, binding])
      if (!bots.has(botId)) throw new Error(`no such bot ${botId}`)
      if (!text(binding?.taskId) || !text(binding?.role)) throw new Error('bindBot: taskId and role are required')
      bindings.set(botId, { taskId: binding.taskId, role: binding.role })
    },
    unbindBot(botId) {
      enter('unbindBot', [botId])
      bindings.delete(botId)
    },
    botOfSession(sessionId) {
      enter('botOfSession', [sessionId])
      const botId = sessions.get(sessionId) ?? sessionId
      const binding = bindings.get(botId)
      return binding === undefined ? undefined : { botId, role: binding.role, taskId: binding.taskId }
    },
    async runReview(req) {
      enter('runReview', [req])
      reviews.push(req)
      return { childId: `review-${reviews.length}`, ...(await layer.reviewer(req)) }
    },
  }
  for (const name of FUNCTIONS) layer[name] = api[name]

  layer.setQuiet = (groupId, value) => { quiet.set(groupId, Boolean(value)) }
  layer.linkSession = (sessionId, botId) => { sessions.set(sessionId, botId) }
  layer.callsOf = (name) => calls.filter(call => call.name === name)
  const fire = (set) => (event) => { for (const fn of [...set]) fn(event) }
  layer.emit = {
    groupLine: fire(subscribers.groupLine),
    sessionEvent: fire(subscribers.sessionEvent),
    toolResult: fire(subscribers.toolResult),
    roundEnd: fire(subscribers.roundEnd),
    approval: fire(subscribers.approval),
    usage: fire(subscribers.usage),
  }
  layer.subscriberCount = () => Object.values(subscribers).reduce((sum, set) => sum + set.size, 0)
  return layer
}
