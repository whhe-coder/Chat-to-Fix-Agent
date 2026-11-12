import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { apiOf, createRuntime } from './rt-kit.ts'
import { fakeContext, restoreChief } from './fake-ctx.ts'

// DSH's settings and credentials for a DeepSeek route that takes an API key. A key set
// or removed is announced the way DSH announces it. `records` are the stored records
// (an account sign-in's), announced by the test.
function keyed(ctx, stored, records) {
  return {
    settings: { describe: () => [{ ns: 'llm-deepseek', revision: 0, value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, user: {}, base: {} }] },
    credentials: {
      describe: async ref => ({ configured: stored.has(ref), writable: true }),
      set: async (ref) => { stored.add(ref); ctx.emit('credentials/reference-updated', ref) },
      unset: async (ref) => { stored.delete(ref); ctx.emit('credentials/reference-updated', ref) },
      describeRecord: async key => ({ configured: records.has(key), writable: true }),
    },
  }
}

// Enough of the dsh services for the roster to make Sessions; kickoff messages are dropped.
// With `keys`, the models' route takes an API key and these are the ones set.
let rt
function start(team?, { models = [], reasoning = {}, archiveError, keys, selection, presets, chief = true }: any = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-roster-'))
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const services: any = {}
  if (presets !== undefined) services.agentPresets = { list: async () => presets }
  const ctx = fakeContext({ services })
  const created: any = []
  const records = new Set()
  if (keys !== undefined) Object.assign(services, keyed(ctx, new Set(keys), records))
  if (selection !== undefined) {
    const baseGet = ctx.get
    ctx.get = name => name === 'agentDefaultModel' ? { currentSelection: () => selection } : baseGet(name)
  }
  const workspaces = new Map()
  const sent: any = []
  const selected: any = []
  const archived: any = []
  const warnings: any = []
  let sessions = 0
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  Object.assign(ctx, {
    llm: {
      listProviders: () => (models.length > 0 ? [{ id: 'deepseek', name: 'DeepSeek' }] : []),
      listModels: async () => models.map(id => ({ id })),
      resolveModelInfo: async (provider, model) => reasoning[`${provider}/${model}`] ?? {},
      ...(keys === undefined ? {} : { listConfigurableProviders: () => [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] }] }),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace: any = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async (sessionId, options) => {
        if (archiveError !== undefined) throw archiveError
        archived.push([sessionId, options])
      },
    },
    sessionController: {
      create: async (request) => { created.push(request); return { sessionId: `s${++sessions}` } },
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async (request) => { selected.push(request) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  rt = createRuntime(ctx, { home })
  if (chief) restoreChief(rt)
  const call = apiOf(rt)
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, stop, home, sent, selected, ctx, archived, warnings, records, created, rt }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
// A greeting goes out after the team is saved, which can take longer than one settle() on a
// busy machine.
const until = async (check) => {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold within 2 s')
    await settle()
  }
}

test('a new name must be one "@" can call; a name saved before the rule still saves', async (t) => {
  const { call, stop } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  await call('state', {})
  for (const name of ['a@b', 'All', '所有人']) assert.equal((await call('create-bot', { name })).ok, false, name)
  const writer = (await call('create-bot', { name: 'Writer 2' })).value
  assert.equal((await call('update-bot', { id: writer.id, name: 'Writer@home' })).ok, false)
  assert.equal((await call('update-bot', { id: writer.id, name: '新 Writer' })).ok, true)
})

// The kickoff arrives as a user message, so it must not name a question tool the Bot's
// instructions can rule out, and it gives way to those instructions.
test('a Bot takes a thinking level its model serves, applied with the model', async (t) => {
  const reasoning: any = { 'deepseek/deepseek-v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } }
  const { call, stop, selected } = start(undefined, { models: ['deepseek-v4-flash'], reasoning })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-bot', { id: chief, model: 'deepseek/deepseek-v4-flash' })
  await settle()
  assert.equal((await call('update-bot', { id: chief, effort: 'low' })).ok, true)
  await settle()
  const main = (await call('state', {})).value.bots.find(bot => bot.id === chief)
  assert.equal(main.effort, 'low')
  assert.equal(main.appliedEffort, 'low')
  assert.equal(selected.at(-1).reasoningEffort, 'low')

  // A level the model does not serve is refused; null clears the pick.
  assert.equal((await call('update-bot', { id: chief, effort: 'max' })).ok, false)
  assert.equal((await call('update-bot', { id: chief, effort: null })).ok, true)
  await settle()
  const cleared = (await call('state', {})).value.bots.find(bot => bot.id === chief)
  assert.equal(cleared.effort, undefined)
  assert.equal(cleared.appliedEffort, undefined)

  // Creating a Bot with a level stores and applies it.
  const writer = (await call('create-bot', { name: 'Writer', model: 'deepseek/deepseek-v4-flash', effort: 'high' })).value
  await settle()
  assert.equal(writer.effort, 'high')
  assert.equal(selected.at(-1).reasoningEffort, 'high')
})

test('a new Bot inherits the profile default thinking level', async (t) => {
  const reasoning: any = { 'deepseek/deepseek-v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } } }
  const selection: any = { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' }
  const { call, stop, selected } = start(undefined, { models: ['deepseek-v4-flash'], reasoning, selection })
  t.after(stop)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await settle()
  assert.equal(writer.model, 'deepseek/deepseek-v4-flash')
  assert.equal(writer.effort, 'high')
  assert.equal(selected.at(-1).reasoningEffort, 'high')

  // An explicit level still wins, and a level the model does not serve is dropped.
  const coder = (await call('create-bot', { name: 'Coder', effort: 'low' })).value
  assert.equal(coder.effort, 'low')

  // An explicit Default pick (null) stays on the model's own level, and so does a
  // copy of a Bot that has no level of its own.
  const plain = (await call('create-bot', { name: 'Plain', effort: null })).value
  assert.equal(plain.effort, undefined)
  const copy = (await call('duplicate-bot', { id: plain.id })).value
  assert.equal(copy.effort, undefined)

  const other: any = { provider: 'deepseek', model: 'other', reasoningEffort: 'max' }
  const { call: call2, stop: stop2 } = start(undefined, { models: ['deepseek/deepseek-v4-flash'], reasoning, selection: other })
  t.after(stop2)
  const tester = (await call2('create-bot', { name: 'Tester' })).value
  assert.equal(tester.effort, undefined)
})

test('a new team has no Main Bot: bootstrap loads the team and creates nothing', async (t) => {
  const { stop, rt } = start(undefined, { chief: false })
  t.after(stop)
  await rt.bootstrap()
  assert.deepEqual(rt.state.mainBotIds, [])
  assert.deepEqual(Object.keys(rt.state.bots), [])
})

test('a Bot is made with the preset its caller names, standard when it names none', async (t) => {
  const presets: any = [{ id: 'standard' }, { id: 'read-only' }, { id: 'broken-one', broken: 'x' }]
  const { stop, rt, created } = start(undefined, { chief: false, presets })
  t.after(stop)
  await rt.load()
  const named = await rt.createBot({ name: 'Reader', pickModel: true, preset: 'read-only' })
  assert.equal(created.at(-1).agentPreset, 'read-only')
  assert.equal(rt.botOf(named.id).preset, 'read-only')
  const plain = await rt.createBot({ name: 'Plain', pickModel: true })
  assert.equal(created.at(-1).agentPreset, 'standard')
  assert.equal(rt.botOf(plain.id).preset, undefined)
  await assert.rejects(rt.createBot({ name: 'Broken', pickModel: true, preset: 'broken-one' }), /not available/)
  await assert.rejects(rt.createBot({ name: 'Ghost', pickModel: true, preset: 'nope' }), /not available/)
  assert.equal(Object.keys(rt.state.bots).length, 2)
})

test('deleting a Bot or group chat stops its Session, so its tasks are removed', async (t) => {
  const { call, stop, archived } = start(undefined, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { members: [chief, writer.id], admin: writer.id })).value
  archived.length = 0
  assert.equal((await call('delete-bot', { id: writer.id })).ok, true)
  assert.equal((await call('delete-room', { id: room.id })).ok, true)
  // `stopActivity` lets DSH's session-stop hook drop the Session's armed
  // scheduled tasks; without it the archive is refused and they keep
  // delivering into the deleted Session.
  assert.deepEqual(archived, [
    [writer.id, { stopActivity: true }],
    [room.id, { stopActivity: true }],
  ])
})

const TEAM_WITH_PART: any = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 2,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2, segments: [{ sessionId: 'w1', endedAt: 3 }] },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test("deleting a Bot also stops its past parts' Sessions, where tasks can stay armed", async (t) => {
  const { call, stop, archived } = start(TEAM_WITH_PART, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  archived.length = 0
  assert.equal((await call('delete-bot', { id: 'w1' })).ok, true)
  // A part switch can leave armed tasks on the old Session (w1); archiving only
  // the current one (w2) would orphan them exactly like a skipped archive.
  assert.deepEqual(archived, [
    ['w1', { stopActivity: true }],
    ['w2', { stopActivity: true }],
  ])
})

test('an archive failure on delete is warned instead of passing silently', async (t) => {
  const { call, stop, warnings } = start(undefined, { models: ['deepseek-v4-flash'], archiveError: new Error('archive refused') })
  t.after(stop)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  assert.equal((await call('delete-bot', { id: writer.id })).ok, true)
  await settle()
  assert.equal(warnings.filter(text => text.includes('not archived')).length, 1)
})

const takeover = (home, team) => {
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'new-owner' }))
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
}

test('a host that loses its lock to another dsh refuses changes instead of making a phantom Bot', async (t) => {
  const { call, stop, home, ctx } = start({ version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief' } } })
  t.after(stop)
  assert.equal((await call('state', {})).value.readOnly, null)
  let created = 0
  const create = ctx.sessionController.create
  ctx.sessionController.create = async (...args) => { created += 1; return create(...args) }
  // Another live dsh takes the lock and writes its own team.
  takeover(home, { version: 1, revision: 9, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief' }, other: { id: 'other', name: 'FromB' } } })
  const answer = await call('create-bot', { name: 'Phantom' })
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'bot/read-only')
  assert.equal(created, 0)
  // The file keeps the new owner's team, and this host now follows it.
  const team = (await call('state', {})).value
  assert.match(team.readOnly, /another dsh/)
  assert.ok(team.bots.some(bot => bot.name === 'FromB'))
  assert.equal(team.bots.some(bot => bot.name === 'Phantom'), false)
})

test('a delete whose save fails still stops the Sessions, and the next save writes it', async (t) => {
  const { call, stop, home, archived } = start(TEAM_WITH_PART, { models: ['deepseek-v4-flash'] })
  t.after(stop)
  await call('state', {})
  archived.length = 0
  const blocker = join(home, `state.json.${process.pid}.tmp`)
  mkdirSync(blocker)
  const answer = await call('delete-bot', { id: 'w1' })
  assert.equal(answer.ok, false)
  // The Bot is gone from the team, so nothing could stop its tasks later.
  assert.deepEqual(archived, [
    ['w1', { stopActivity: true }],
    ['w2', { stopActivity: true }],
  ])
  rmSync(blocker, { recursive: true })
  await call('set-prefs', { theme: 'dark' })
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.bots.w1, undefined)
})

test('a rolled-back Bot does not come back with a save queued before the rollback', async (t) => {
  const { call, stop, home } = start({ version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief' } } })
  t.after(async () => {
    fsp.rename = rename
    syncBuiltinESMExports()
    await stop()
  })
  // The first Bot also saves the team's workspace; later ones save only themselves.
  await call('create-bot', { name: 'Warm' })
  const statePath = join(home, 'state.json')
  const rename = fsp.rename
  let entered
  let release
  const first = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let failed = false
  fsp.rename = async (from, to) => {
    if (to === statePath && !failed) {
      failed = true
      entered()
      await gate
      throw Object.assign(new Error('rename failed'), { code: 'EIO' })
    }
    return rename(from, to)
  }
  syncBuiltinESMExports()
  const phantom = call('create-bot', { name: 'Phantom' })
  await first
  // A second Bot's save queues a snapshot that still holds Phantom.
  const kept = call('create-bot', { name: 'Kept' })
  await settle()
  release()
  assert.equal((await phantom).ok, false)
  assert.equal((await kept).ok, true)
  // The rollback queues a save after Kept's without waiting for it, and no later change may
  // be what drops Phantom, so wait for that save itself.
  const names = () => Object.values<any>(JSON.parse(readFileSync(statePath, 'utf8')).bots).map(bot => bot.name).sort()
  await until(() => !names().includes('Phantom'))
  assert.deepEqual(names(), ['Chief', 'Kept', 'Warm'])
})

test('a write that fails at save time archives the Session it made', async (t) => {
  const { call, stop, home, ctx } = start({ version: 1, mainBotIds: ['chief'], bots: { chief: { id: 'chief', name: 'Chief' } } })
  t.after(stop)
  await call('state', {})
  const created: any = []
  const create = ctx.sessionController.create
  ctx.sessionController.create = async (...args) => {
    const made = await create(...args)
    created.push(made.sessionId)
    // The disk write fails after this request's refresh, before its save.
    mkdirSync(join(home, `state.json.${process.pid}.tmp`))
    return made
  }
  const archived: any = []
  const archive = ctx.workspaceRegistry.archiveSession
  ctx.workspaceRegistry.archiveSession = async (id) => { archived.push(id); return archive(id) }
  const answer = await call('create-bot', { name: 'Phantom' })
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'bot/internal')
  assert.deepEqual(archived, created)
  const team = (await call('state', {})).value
  assert.equal(team.bots.some(bot => bot.name === 'Phantom'), false)
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(Object.values<any>(saved.bots).some(bot => bot.name === 'Phantom'), false)
})

// 公开#178: "User" is how a group log names the user, so a Bot may not take it.
test('a Bot cannot be named or renamed like the user; one named so before keeps working', async (t) => {
  const team: any = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: '', instructions: '', sessionId: 'a', createdAt: 1 },
      u: { id: 'u', name: 'User', role: '', instructions: '', sessionId: 'u', createdAt: 2 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
  const { call, stop } = start(team)
  t.after(stop)
  const made = await call('create-bot', { name: 'user' })
  assert.equal(made.ok, false)
  assert.match(made.error.message, /stands for the user in a chat/)
  const renamed = await call('update-bot', { id: 'a', name: 'You' })
  assert.equal(renamed.ok, false)
  assert.match(renamed.error.message, /stands for the user in a chat/)
  assert.equal((await call('update-bot', { id: 'u', name: 'User', role: 'Tester' })).ok, true)
  assert.equal((await call('update-bot', { id: 'u', name: 'Helper' })).ok, true)
})

// Holds every new Session until `release`, so creates that start together are all
// waiting on it at once, as with a slow DSH.
const holdSessions = (ctx) => {
  const create = ctx.sessionController.create
  let open
  const gate = new Promise(resolve => { open = resolve })
  let waiting = 0
  ctx.sessionController.create = async (request) => {
    waiting += 1
    await gate
    return create(request)
  }
  return { waiting: () => waiting, release: () => { ctx.sessionController.create = create; open() } }
}

// 公开#148: two Main Bots that each made a "Coder" at the same time both got one.
test('Bots created with one name at the same time: one is made, the others are refused', async (t) => {
  const { call, stop, ctx } = start()
  t.after(stop)
  await call('state', {})
  const sessions = holdSessions(ctx)
  const creates: any = [1, 2, 3].map(() => call('create-bot', { name: 'Coder' }))
  // A rename to a name a create is still working on is refused too.
  const chief = (await call('state', {})).value.mainBotId
  const rename = await call('update-bot', { id: chief, name: 'coder' })
  sessions.release()
  const results = await Promise.all(creates)
  assert.deepEqual(results.map(result => result.ok), [true, false, false])
  assert.match(results[1].error.message, /A Bot named Coder already exists/)
  assert.equal(rename.ok, false)
  const names = (await call('state', {})).value.bots.map(bot => bot.name)
  assert.equal(names.filter(name => name.toLowerCase() === 'coder').length, 1)
})

test('copies of one Bot made at the same time get different names', async (t) => {
  const { call, stop, ctx } = start()
  t.after(stop)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const sessions = holdSessions(ctx)
  const copies: any = [1, 2, 3].map(() => call('duplicate-bot', { id: writer.id }))
  await until(() => sessions.waiting() === 3)
  sessions.release()
  const results = await Promise.all(copies)
  assert.deepEqual(results.map(result => result.ok), [true, true, true])
  assert.deepEqual(results.map(result => result.value.name).sort(), ['Writer copy', 'Writer copy 2', 'Writer copy 3'])
})

// 公开#199: two groups made with one name at the same time were both made, and from then
// on a Main Bot could reach neither by name.
test('groups created or renamed to one name at the same time: only one gets it', async (t) => {
  const { call, stop, ctx } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const other = (await call('create-room', { members: [chief, writer.id], name: 'Docs' })).value
  const sessions = holdSessions(ctx)
  const creates: any = [1, 2].map(() => call('create-room', { members: [chief, writer.id], name: 'Ops' }))
  const rename = await call('update-room', { id: other.id, name: 'ops' })
  sessions.release()
  const results = await Promise.all(creates)
  assert.deepEqual(results.map(result => result.ok), [true, false])
  assert.match(results[1].error.message, /Another group chat is already called "Ops"/)
  assert.equal(rename.ok, false)
  const rooms = (await call('state', {})).value.rooms.map(room => room.name).sort()
  assert.deepEqual(rooms, ['Docs', 'Ops'])

  // Once the create ends, its name is no longer held for anyone else.
  const later = await call('create-room', { members: [chief, writer.id], name: 'Ops 2' })
  assert.equal(later.ok, true)
})

test('a create that fails lets its name go', async (t) => {
  const { call, stop, ctx } = start()
  t.after(stop)
  await call('state', {})
  const create = ctx.sessionController.create
  ctx.sessionController.create = async () => { throw new Error('dsh is busy') }
  assert.equal((await call('create-bot', { name: 'Coder' })).ok, false)
  ctx.sessionController.create = create
  assert.equal((await call('create-bot', { name: 'Coder' })).ok, true)
})

test('old late-round and relay-limit fields of a group load away; calls it parked stay for the next round', async (t) => {
  const parked: any = [{ id: 'writer', name: 'Writer', note: 'Chief mentioned you', by: 'chief' }]
  const { call, stop, home } = start({
    version: 1,
    mainBotIds: ['chief'],
    bots: { chief: { id: 'chief', name: 'Chief' }, writer: { id: 'writer', name: 'Writer' } },
    rooms: {
      r1: {
        id: 'r1', name: 'Ops', members: ['chief', 'writer'], mode: 'admin', admin: 'chief', named: true,
        log: [], seq: 0, seen: {}, lateRounds: 7, quietNoticed: true, quietShown: true, relays: 5, relayLimit: 4, paused: parked,
      },
    },
  })
  t.after(stop)
  const shown = (await call('state', {})).value.rooms.find(room => room.id === 'r1')
  for (const key of ['lateRounds', 'quietNoticed', 'quietShown', 'relays', 'relayLimit', 'relayLimitDefault', 'paused']) assert.equal(key in shown, false, key)
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms.r1
  for (const key of ['lateRounds', 'relays', 'relayLimit']) assert.equal(key in saved, false, key)
  assert.deepEqual(saved.paused, parked)

  // A limit sent by an older client changes nothing.
  const set = await call('update-room', { id: 'r1', relayLimit: 4 })
  assert.equal(set.ok, true)
  assert.deepEqual(set.value.changes, [])
})

// #227: a team-level default model for new Bots. A create that names a model keeps it;
// the team's pick comes next, and only when it is still served. Without either, the Bot
// takes its creator's served model, as it always has.
const TEAM_MODEL: any = {
  version: 1,
  mainBotIds: ['chief'],
  bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief', instructions: '', createdAt: 1, model: 'deepseek/deepseek-v4-pro' } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}


test('set-prefs stores a served default model, clears it, and refuses an unknown one', async (t) => {
  const { call, stop } = start(TEAM_MODEL, { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  assert.equal((await call('set-prefs', { defaultBotModel: 'deepseek/deepseek-v4-flash' })).value.defaultBotModel, 'deepseek/deepseek-v4-flash')
  // A bare model id resolves to its full ref.
  assert.equal((await call('set-prefs', { defaultBotModel: 'deepseek-v4-pro' })).value.defaultBotModel, 'deepseek/deepseek-v4-pro')
  const refused = await call('set-prefs', { defaultBotModel: 'gone/model' })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Model gone\/model is not available/)
  assert.equal(rt.state.prefs.defaultBotModel, 'deepseek/deepseek-v4-pro')
  assert.equal('defaultBotModel' in (await call('set-prefs', { defaultBotModel: null })).value, false)
  assert.equal('defaultBotModel' in rt.state.prefs, false)
})

test('a model-less create-bot starts the Bot on the saved team default model', async (t) => {
  const { call, stop } = start(TEAM_MODEL, { models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  t.after(stop)
  await call('set-prefs', { defaultBotModel: 'deepseek/deepseek-v4-pro' })

  // The HTTP create names no model: the team's saved pick applies, not the DSH default.
  const defaulted = (await call('create-bot', { name: 'Defaulted' })).value
  assert.equal(defaulted.model, 'deepseek/deepseek-v4-pro')

  // An explicit model still wins over the team default.
  const named = (await call('create-bot', { name: 'Named', model: 'deepseek/deepseek-v4-flash' })).value
  assert.equal(named.model, 'deepseek/deepseek-v4-flash')

  // A saved pick the catalog no longer serves falls back to the DSH default…
  rt.state.prefs.defaultBotModel = 'gone/model'
  const stale = (await call('create-bot', { name: 'Stale' })).value
  assert.equal(stale.model, 'deepseek/deepseek-v4-flash')

  // …and so does a create once the pick is cleared.
  await call('set-prefs', { defaultBotModel: null })
  const plain = (await call('create-bot', { name: 'Plain' })).value
  assert.equal(plain.model, 'deepseek/deepseek-v4-flash')
})
