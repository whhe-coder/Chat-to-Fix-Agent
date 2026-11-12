import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: '代码', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Launch', named: true, members: ['b2', 'b3'], admin: 'b3', mode: 'everyone', notice: '', sessions: { b3: 'g3' },
      seq: 0,
      log: [],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

let rt
function start(team = TEAM) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const sent = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({}),
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 1 }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, tool, call, state, sent, stop }
}

test('every Bot sees the update_bot rule in its identity section', async (t) => {
  const { ctx, tool, stop } = start()
  t.after(stop)
  // The first load indexes the Sessions; without it selfOf finds no Bot.
  await tool('list_bots', {}, 'b2')
  const text = ctx.sections.get('bot-identity').text({ agent: { id: 'b2' } })
  assert.match(text, /update_bot changes your own settings/)
  assert.match(ctx.sections.get('bot-identity').text({ agent: { id: 'm1' } }), /update_bot changes your own settings/)
})

test('an instructions change lands as a message in the Bot chat', async (t) => {
  const { call, sent, stop } = start()
  t.after(stop)
  assert.equal((await call('update-bot', { id: 'b2', instructions: 'Ship the fix' })).ok, true)
  // The notice goes out as a follow-up; let the queued delivery run.
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sessionId, 'b2')
  const text = sent[0].message.content[0].text
  assert.match(text, /profile was updated/)
  assert.match(text, /Ship the fix/)
  // A patch that changes nothing sends no message.
  await call('update-bot', { id: 'b2', instructions: 'Ship the fix' })
  await call('update-bot', { id: 'b2', color: 'red' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(sent.length, 1)
})

test('a Bot whose greeting is still held gets no notice before its model pick', async (t) => {
  const team = JSON.parse(JSON.stringify(TEAM))
  delete team.bots.b3.model
  team.bots.b3.kickoff = { text: 'Greet the user.', from: null }
  const { call, sent, stop } = start(team)
  t.after(stop)
  assert.equal((await call('update-bot', { id: 'b3', instructions: 'Ship the fix' })).ok, true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(sent.length, 0)
})
