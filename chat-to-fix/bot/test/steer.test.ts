import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from './rt-kit.ts'
import { turnOf } from '../src/host/resume.ts'
import { fakeContext } from './fake-ctx.ts'
import { SOURCE_KIND, STEER_CUT } from '../src/host/constants.ts'

// Only the receiving side of DS Bot's steer cut is kept (turns.ts markSteerCut and the carry into the
// next turn, resume.ts turnOf): the cutter itself (steer.js: shell shadows and the model-call cut) is
// removed. These cases guard that code until it is trimmed; delete them with it.
const TEAM: any = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 } },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

const start = async ({ services = {} }: any = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-steer-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services })
  const agentMap = new Map()
  const deliveries: any = []
  const inboxOf = () => {
    const nextStep: any = []
    const nextTurn: any = []
    return { nextStep, nextTurn,
      prepend: (t, m) => (t === 'next-turn' ? nextTurn : nextStep).unshift(m),
      append: (t, m) => (t === 'next-turn' ? nextTurn : nextStep).push(m),
      remove: mid => { for (const l of [nextStep, nextTurn]) { const at = l.findIndex(m => m.id === mid); if (at !== -1) { l.splice(at, 1); return true } } return false },
    }
  }
  const calls: any = []
  const agentOf = (id, over: any = {}) => {
    const inbox = inboxOf()
    const agent: any = {
      id,
      session: { id, header: { cwd: '/team' } },
      ctx: { tools: { register: t => (calls.push(['register', t]), () => {}), restrict: () => () => {} }, on: () => () => {}, effect: execute => execute?.() },
      status: 'running',
      followup: msg => calls.push(['followup', msg]),
      inject: msg => calls.push(['inject', msg]),
      send: (msg, target) => inbox[target === 'next-turn' ? 'nextTurn' : 'nextStep'].push(msg),
      cancel: (cause, options) => calls.push(['cancel', cause, options]),
      inbox,
      ...over,
    }
    agentMap.set(id, agent)
    return agent
  }
  const agentById = agentOf('dm-a')
  ctx.tools.schemas = () => [{ name: 'pwsh' }, { name: 'bash' }, { name: 'ask_user_question' }]
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => ({ id: 'w1', path: '/team' }), list: () => [{ id: 'w1', path: '/team' }], resolveByPath: async () => undefined, create: async p => ({ id: 'w1', path: p }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'dm-a' }), resolveAgent: async () => ({ agent: agentById }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const origGet = ctx.get
  Object.assign(ctx, { get: name => (name === 'agents' ? agentMap : origGet(name)) })
  const rt = createRuntime(ctx, { home })
  await rt.load?.()
  const origDeliver = rt.deliver
  rt.deliver = (...args) => { deliveries.push(args); return origDeliver ? origDeliver(...args) : Promise.resolve() }
  const emit = async (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) await listener({ id }, { type, data })
    }
    await new Promise(r => setTimeout(r, 0))
  }
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, emit, stop, rt, agent: agentById, agentMap, calls, deliveries }
}


// Carry tests: the cut turn's routing state rides into the turn that claims the steer.
test('steer carry: a cut request turn hands its answer on the next turn', async () => {
  const { emit, stop, rt, deliveries } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: 'do the thing' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-b', exchangeId: 'x1', senderName: 'Writer' },
  })
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: 'me too' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-c', exchangeId: 'x2', senderName: 'Ops' },
  })
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'half done' }] } })
  rt.markSteerCut(dm)
  await emit(dm, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } } })
  assert.deepEqual(deliveries, [])
  await emit(dm, 'turn/start', { turn: 2 })
  const entry = rt.live.get(dm)
  assert.equal(entry.info?.exchangeId, 'x1')
  assert.equal(entry.joined.length, 1)
  assert.equal(entry.carried, true)
  assert.deepEqual(entry.texts, ['half done'])
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } })
  await emit(dm, 'turn/end', { reason: { kind: 'completed' } })
  const reply = deliveries.find(d => d[0]?.replyTo === 'x1')
  assert.ok(reply !== undefined)
  assert.match(reply[0].text, /half done/)
  assert.match(reply[0].text, /all done/)
  const handback = deliveries.find(d => d[0]?.deferred === true)
  assert.ok(handback !== undefined)
  assert.equal(handback[0].exchangeId, 'x2')
  await stop()
})

test('steer carry: a plain user turn delivers nothing for the cut turn', async () => {
  const { emit, stop, rt, deliveries } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'half' }] } })
  rt.markSteerCut(dm)
  await emit(dm, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } } })
  assert.deepEqual(deliveries, [])
  await emit(dm, 'turn/start', { turn: 2 })
  assert.deepEqual(rt.live.get(dm).texts, ['half'])
  await stop()
})

test('steer carry: a cut turn that ends on error keeps normal failure handling', async () => {
  const { emit, stop, rt, deliveries } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: 'do it' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-b', exchangeId: 'x1', senderName: 'Writer' },
  })
  rt.markSteerCut(dm)
  await emit(dm, 'turn/end', { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'over' } } })
  assert.equal(rt.live.get(dm).carry, undefined)
  const failed = deliveries.find(d => /could not answer/.test(d[0]?.text ?? ''))
  assert.ok(failed !== undefined)
  assert.equal(failed[0].replyTo, 'x1')
  await stop()
})

test('steer carry: a pending request survives a carry that reclaims the trigger', async () => {
  const { emit, stop, rt, deliveries } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: 'do the thing' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-b', exchangeId: 'x1', senderName: 'Writer' },
  })
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'half done' }] } })
  rt.markSteerCut(dm)
  await emit(dm, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } } })
  assert.deepEqual(deliveries, [])
  // Another request lands between the cut and the next turn: it waits as pending.
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: '[Ops → Chief]\nme later' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-c', exchangeId: 'x2', senderName: 'Ops' },
  })
  await emit(dm, 'turn/start', { turn: 2 })
  const entry = rt.live.get(dm)
  // The carry's own request reclaims the trigger; the pending one joins it deferred.
  assert.equal(entry.info?.exchangeId, 'x1')
  assert.equal(entry.joined.length, 1)
  assert.equal(entry.joined[0].info.exchangeId, 'x2')
  assert.equal(entry.joined[0].text, 'me later')
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } })
  await emit(dm, 'turn/end', { reason: { kind: 'completed' } })
  const reply = deliveries.find(d => d[0]?.replyTo === 'x1')
  assert.ok(reply !== undefined)
  assert.match(reply[0].text, /all done/)
  const handback = deliveries.find(d => d[0]?.deferred === true)
  assert.ok(handback !== undefined)
  assert.equal(handback[0].exchangeId, 'x2')
  assert.ok(!deliveries.some(d => /was stopped/.test(d[0]?.text ?? '')))
  await stop()
})

test('steer resume: turnOf follows a steer cut to its continuation', async () => {
  const turn = (n, events: any = []) => [
    { type: 'turn/start', data: { turn: n } },
    ...events,
  ]
  const said = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  const took = exchangeId => ({ type: 'user/message', data: { source: { kind: SOURCE_KIND, role: 'request', exchangeId }, content: [{ type: 'text', text: 'do' }] } })
  const ended = reason => ({ type: 'turn/end', data: { reason } })
  const cut: any = { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } }

  // A cut turn whose continuation answered: the continuation's reason and the texts
  // merged, with the cut step's interrupted draft dropped.
  const follow = turnOf([
    ...turn(1, [took('x1'), said('a'), { type: 'step/start', data: { turn: 1, step: 2 } }, said('p'), ended(cut)]),
    ...turn(2, [said('b'), ended({ kind: 'completed' })]),
  ], 'x1')
  assert.deepEqual(follow?.reason, { kind: 'completed' })
  assert.deepEqual(follow?.texts, ['a', 'b'])

  // A cut turn with no continuation yet: read as unfinished, not as stopped.
  const dangling = turnOf([
    ...turn(1, [took('x1'), said('a'), ended(cut)]),
  ], 'x1')
  assert.equal(dangling?.reason, undefined)
  assert.deepEqual(dangling?.texts, ['a'])

  // A user stop stays a stop.
  const stopped = turnOf([
    ...turn(1, [took('x1'), ended({ kind: 'aborted', reason: { kind: 'user' } })]),
  ], 'x1')
  assert.deepEqual(stopped?.reason, { kind: 'aborted', reason: { kind: 'user' } })
})
