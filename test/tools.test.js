// Tool registration framework (C0) and the task tools (C1), against the real store and gate.
// Only the bot layer is faked, and only botOfSession; the DSH agent is a small fake with the
// two properties attachRoleTools relies on (agent.session.id, agent.ctx.tools.register).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'
import { createStore } from '../src/task/store.js'
import { createGate } from '../src/task/gate.js'
import { allBotDefs, toolsOfRole } from '../src/registry/bots.js'
import { createToolRegistry, TEAM_TOOL_NAMES } from '../src/tools/register.js'
import { registerTaskTools, taskTools } from '../src/tools/task.js'
import { TEAM_TOOLS } from '../bot/src/host/constants.js'

const SPEC_TASK_TOOLS = ['task_read', 'task_records', 'task_advance', 'task_close', 'needs_info_confirm', 'review_report']
const at = '2026-11-12T02:00:00Z'
const ROLES = ['main', 'slack', 'jira', 'pipeline', 'coding']

async function rig({ limits = {}, retryDelayMs = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-tools-'))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify({
    dataDir: join(dir, 'data'),
    worktreesDir: join(dir, 'worktrees'),
    httpPort: 0,
    apiModel: 'anthropic/test',
    bindings: [{ channel: 'C1', repo: 'group/project', jiraProject: 'DEMO' }],
    limits,
  }))
  const config = loadConfig({ path: configPath, env: {} })
  const store = createStore({ dataDir: config.dataDir, warn() {} })
  const changed = { files: [] }
  const repo = { diff: async () => ({ files: changed.files, totalFiles: changed.files.length, totalLines: changed.files.length * 3 }) }
  const closed = []
  const gate = createGate({ store, repo, limits: config.limits, onClosed: async (id, state, reason) => { closed.push([id, state, reason]) } })

  const task = await store.createTask(
    { eventId: 'E1', channel: 'C1', threadTs: '1.1', messageTs: '1.1', user: { id: 'U1', name: 'tester' }, text: 'the button does nothing', files: [], permalink: 'https://example.slack.com/p1' },
    config.bindings[0],
  )
  await store.startRun(task.id, { groupId: 'g1', bots: { main: 'm', slack: 's', jira: 'j', pipeline: 'p', coding: 'c' } })

  // Every role has a session "S-<role>" bound to the task; "S-none" is bound to nothing.
  const sessions = new Map(ROLES.map(role => [`S-${role}`, { botId: `bot-${role}`, role, taskId: task.id }]))
  const botlayer = { botOfSession: id => sessions.get(id) }
  const warnings = []
  const registry = createToolRegistry({ store, gate, adapters: { marker: 'adapters' }, config, botlayer, warn: (...args) => warnings.push(args), retryDelayMs })
  return { registry, store, gate, config, task, changed, closed, sessions, warnings, botlayer }
}

// The shape of a DSH agent that attachRoleTools relies on.
function fakeAgent(sessionId) {
  const registered = new Map()
  const removed = []
  return {
    registered,
    removed,
    session: { id: sessionId },
    ctx: { tools: { register: (def) => { registered.set(def.name, def); return () => { registered.delete(def.name); removed.push(def.name) } } } },
  }
}

const valid = (extra = {}) => ({ name: 'demo_tool', roles: ['main'], write: false, description: 'A demo.', parameters: {}, run: async () => 'ok', ...extra })

// ---------- C0: definitions ----------

test('defineRoleTool rejects bad definitions and duplicates', async () => {
  const { registry } = await rig()
  const bad = [
    [null, /not an object/],
    [valid({ name: '' }), /name must be/],
    [valid({ name: 'Bad-Name' }), /name must be/],
    [valid({ name: 'message_bot' }), /team tools list/],
    [valid({ name: 'post_to_group' }), /team tools list/],
    [valid({ roles: [] }), /roles must be/],
    [valid({ roles: 'main' }), /roles must be/],
    [valid({ roles: ['main', 'main'] }), /duplicate role/],
    [valid({ write: 'yes' }), /write must be/],
    [valid({ purpose: 'x', write: true }), /purpose must be a function/],
    [valid({ purpose: () => 'x', write: false }), /purpose only makes sense for a write tool/],
    [valid({ description: ' ' }), /description is missing/],
    [valid({ parameters: [] }), /parameters must be an object/],
    [valid({ parameters: { a: { type: 'blob' } } }), /needs a type/],
    [valid({ parameters: { a: { type: 'string', enum: [] } } }), /empty enum/],
    [valid({ run: undefined }), /run must be a function/],
  ]
  for (const [def, pattern] of bad) assert.throws(() => registry.defineRoleTool(def), pattern, JSON.stringify(def)?.slice(0, 60))
  registry.defineRoleTool(valid())
  assert.throws(() => registry.defineRoleTool(valid()), /already defined/)
  assert.throws(() => registry.defineRoleTool(valid({ name: 'message_bot', roles: [] })), /team tools list.*roles must be|roles must be.*team tools list/)
})

test('the copied team tools list matches DS Bot constants.js', () => {
  assert.deepEqual([...TEAM_TOOL_NAMES].sort(), [...TEAM_TOOLS].sort())
})

// ---------- C0: attaching ----------

test('attachRoleTools registers only the tools of the session role; unbound sessions get nothing', async () => {
  const { registry, warnings } = await rig()
  registerTaskTools(registry)
  const expected = {
    main: ['task_read', 'task_records', 'task_advance', 'task_close', 'needs_info_confirm'],
    slack: ['task_read'],
    jira: ['task_read'],
    pipeline: ['task_read'],
    coding: ['task_read', 'needs_info_confirm', 'review_report'],
  }
  for (const role of ROLES) {
    const agent = fakeAgent(`S-${role}`)
    assert.deepEqual(registry.attachRoleTools(agent), expected[role], role)
    assert.deepEqual([...agent.registered.keys()].sort(), [...expected[role]].sort(), role)
    assert.deepEqual(registry.bridgedToolNames(`S-${role}`).sort(), [...expected[role]].sort(), role)
    const def = agent.registered.get('task_read')
    assert.equal(typeof def.execute, 'function')
    assert.equal(def.output.schema.type, 'string')
  }
  const stray = fakeAgent('S-none')
  assert.deepEqual(registry.attachRoleTools(stray), [])
  assert.equal(stray.registered.size, 0)
  assert.deepEqual(registry.bridgedToolNames('S-none'), [])
  assert.deepEqual(registry.attachRoleTools({}), [])
  assert.deepEqual(registry.attachRoleTools(undefined), [])
  assert.deepEqual(warnings, [])
})

test('attachRoleTools is idempotent per agent, restarts for a new agent, and warns when the agent cannot register', async () => {
  const { registry, warnings } = await rig()
  registerTaskTools(registry)
  const first = fakeAgent('S-coding')
  registry.attachRoleTools(first)
  registry.attachRoleTools(first)
  assert.equal(first.registered.size, 3)
  assert.deepEqual(first.removed, [])
  const second = fakeAgent('S-coding')
  registry.attachRoleTools(second)
  assert.equal(first.registered.size, 0, 'the old agent lost its tools')
  assert.equal(second.registered.size, 3)
  registry.detachRoleTools('S-coding')
  assert.equal(second.registered.size, 0)

  const stuck = { session: { id: 'S-main' }, ctx: {} }
  assert.deepEqual(registry.attachRoleTools(stuck), [])
  assert.equal(warnings.length, 1)
})

test('a registered tool runs through the wrapper with the session fixed at attach time', async () => {
  const { registry } = await rig()
  registerTaskTools(registry)
  const agent = fakeAgent('S-coding')
  registry.attachRoleTools(agent)
  const text = await agent.registered.get('task_read').execute({}, { agent })
  assert.equal(JSON.parse(text).id, 'T-1')
})

// ---------- C0: the wrapper ----------

test('call builds a fresh ctx from the latest task', async () => {
  const { registry, store, task, config } = await rig()
  let seen
  registry.defineRoleTool(valid({ name: 'peek', roles: 'all', run: async (ctx, args) => { seen = { ctx, args }; return `step ${ctx.task.step}` } }))
  assert.equal(await registry.call('peek', 'S-slack', { a: 1 }), 'step fetch')
  assert.equal(seen.ctx.role, 'slack')
  assert.equal(seen.ctx.botId, 'bot-slack')
  assert.equal(seen.ctx.adapters.marker, 'adapters')
  assert.equal(seen.ctx.config, config)
  assert.equal(typeof seen.ctx.gate.allow, 'function')
  assert.equal(typeof seen.ctx.store.getTask, 'function')
  await store.patchTask(task.id, { step: 'jira-test' })
  assert.equal(await registry.call('peek', 'S-slack', {}), 'step jira-test')
})

test('call returns text for unknown tools, unbound sessions, wrong roles and bad arguments', async () => {
  const { registry } = await rig()
  registry.defineRoleTool(valid({ name: 'main_only', parameters: { n: { type: 'integer', required: true }, k: { type: 'string', enum: ['a', 'b'] } } }))
  assert.match(await registry.call('nope', 'S-main', {}), /^tool failed: no such tool/)
  assert.match(await registry.call('main_only', 'S-none', { n: 1 }), /^tool failed: .*does not belong to a task/)
  assert.match(await registry.call('main_only', 'S-coding', { n: 1 }), /^tool failed: .*not available to the coding bot/)
  assert.match(await registry.call('main_only', 'S-main', {}), /missing required argument n/)
  assert.match(await registry.call('main_only', 'S-main', { n: 1.5 }), /must be of type integer/)
  assert.match(await registry.call('main_only', 'S-main', { n: 1, k: 'c' }), /must be one of a, b/)
  assert.equal(await registry.call('main_only', 'S-main', { n: 1, k: 'a' }), 'ok')
})

test('a write tool refused by the gate is not run, and the reason is the result', async () => {
  const { registry, store, task } = await rig()
  let ran = 0
  // repo_prepare belongs to step prepare; the task is in step fetch.
  registry.defineRoleTool(valid({ name: 'repo_prepare', roles: ['pipeline'], write: true, run: async () => { ran++; return 'prepared' } }))
  const refused = await registry.call('repo_prepare', 'S-pipeline', {})
  assert.equal(ran, 0)
  assert.match(refused, /repo_prepare belongs to step prepare, the task is in step fetch/)
  assert.ok(!refused.startsWith('tool failed'))
  assert.ok((await store.readRecords(task.id)).some(entry => entry.type === 'refused' && entry.tool === 'repo_prepare'))

  await store.patchTask(task.id, { step: 'prepare' })
  assert.equal(await registry.call('repo_prepare', 'S-pipeline', {}), 'prepared')
  assert.equal(ran, 1)
})

test('purpose is passed to the gate', async () => {
  const { registry, store, task } = await rig()
  let ran = 0
  registry.defineRoleTool(valid({
    name: 'slack_reply', roles: ['slack'], write: true,
    parameters: { purpose: { type: 'string', required: true, enum: ['ack', 'question', 'result'] } },
    purpose: (args) => args.purpose,
    run: async () => { ran++; return 'sent' },
  }))
  assert.equal(await registry.call('slack_reply', 'S-slack', { purpose: 'ack' }), 'sent')
  const question = await registry.call('slack_reply', 'S-slack', { purpose: 'question' })
  assert.match(question, /both main and coding must confirm/)
  assert.equal(ran, 1)
  assert.equal((await store.readRecords(task.id)).filter(entry => entry.type === 'refused').length, 1)
})

test('retryable errors are retried up to toolRetries; other errors are not', async () => {
  const { registry } = await rig({ limits: { toolRetries: 2 } })
  let calls = 0
  registry.defineRoleTool(valid({ name: 'flaky', roles: 'all', run: async () => { if (++calls < 3) throw Object.assign(new Error('busy'), { retryable: true, code: 'E_BUSY' }); return 'finally' } }))
  assert.equal(await registry.call('flaky', 'S-main', {}), 'finally')
  assert.equal(calls, 3)

  let always = 0
  registry.defineRoleTool(valid({ name: 'always', roles: 'all', run: async () => { always++; throw Object.assign(new Error('still busy'), { retryable: true, code: 'E_BUSY' }) } }))
  assert.equal(await registry.call('always', 'S-main', {}), 'tool failed: still busy [E_BUSY]')
  assert.equal(always, 3, 'one try and two retries')

  let once = 0
  registry.defineRoleTool(valid({ name: 'fatal', roles: 'all', run: async () => { once++; throw Object.assign(new Error('bad input'), { retryable: false }) } }))
  assert.equal(await registry.call('fatal', 'S-main', {}), 'tool failed: bad input')
  assert.equal(once, 1)

  let plain = 0
  registry.defineRoleTool(valid({ name: 'plain', roles: 'all', run: async () => { plain++; throw new Error('boom') } }))
  assert.equal(await registry.call('plain', 'S-main', {}), 'tool failed: boom')
  assert.equal(plain, 1)
})

test('a call that takes longer than toolTimeoutSeconds fails as text and is not retried', async () => {
  const { registry } = await rig({ limits: { toolTimeoutSeconds: 0.05, toolRetries: 2 } })
  let calls = 0
  registry.defineRoleTool(valid({ name: 'slow', roles: 'all', run: () => { calls++; return new Promise(() => {}) } }))
  const started = Date.now()
  const result = await registry.call('slow', 'S-main', {})
  assert.match(result, /^tool failed: timed out after 0\.05s \[timeout\]$/)
  assert.equal(calls, 1)
  assert.ok(Date.now() - started < 1000)
})

test('failures never throw: run errors, a throwing purpose, a throwing gate and a throwing botlayer', async () => {
  const { registry, botlayer, task } = await rig()
  registry.defineRoleTool(valid({ name: 'thrower', roles: 'all', run: () => { throw new Error('sync throw') } }))
  assert.equal(await registry.call('thrower', 'S-main', {}), 'tool failed: sync throw')

  registry.defineRoleTool(valid({ name: 'bad_purpose', roles: 'all', write: true, purpose: () => { throw new Error('no purpose') } }))
  assert.equal(await registry.call('bad_purpose', 'S-main', {}), 'tool failed: no purpose')

  registry.defineRoleTool(valid({ name: 'number_result', roles: 'all', run: async () => 42 }))
  assert.equal(await registry.call('number_result', 'S-main', {}), '42')

  botlayer.botOfSession = () => { throw new Error('layer down') }
  assert.match(await registry.call('number_result', 'S-main', {}), /^tool failed: .*does not belong to a task/)
  botlayer.botOfSession = () => ({ botId: 'b', role: 'main', taskId: 'T-99' })
  assert.match(await registry.call('number_result', 'S-main', {}), /^tool failed: task T-99 not found/)
  assert.equal(task.id, 'T-1')
})

// ---------- C1: the registry and the task tools ----------

test('every task tool the registry gives a role is defined, with matching roles', async () => {
  const defs = taskTools()
  assert.deepEqual(defs.map(def => def.name).sort(), [...SPEC_TASK_TOOLS].sort())
  const bots = allBotDefs()
  for (const def of defs) {
    const listedFor = bots.filter(bot => bot.tools.includes(def.name)).map(bot => bot.role).sort()
    if (def.roles === 'all') assert.deepEqual(listedFor, [], `${def.name}: tools for all bots are not listed per role`)
    else assert.deepEqual([...def.roles].sort(), listedFor, `${def.name}: roles must match the registry`)
  }
  // Every task tool a role has in the registry is defined.
  const defined = new Set(defs.map(def => def.name))
  for (const bot of bots) {
    for (const name of toolsOfRole(bot.role)) {
      if (SPEC_TASK_TOOLS.includes(name)) assert.ok(defined.has(name), `${bot.role}: ${name} is not defined`)
    }
  }
  // The registry's own cross-check reports nothing for the task tools.
  const { registry } = await rig()
  registerTaskTools(registry)
  const problems = registry.validate().filter(problem => SPEC_TASK_TOOLS.some(name => problem.includes(name)))
  assert.deepEqual(problems, [])
  assert.ok(registry.validate().length > 0, 'the Slack, Jira and repository tools are not defined yet, so validate reports them')
  // Write flags: what the gate knows as write tools.
  const write = defs.filter(def => def.write).map(def => def.name).sort()
  assert.deepEqual(write, ['needs_info_confirm', 'review_report', 'task_advance', 'task_close'])
})

test('task_read returns the task subset and nothing else', async () => {
  const { registry, store, task } = await rig()
  registerTaskTools(registry)
  await store.patchTask(task.id, { jira: { key: 'DEMO-1', url: 'fake://jira/DEMO-1' }, repo: { dir: '/tmp/wt', branch: 'ai/DEMO-1', base: 'abc' }, stepResults: { fetch: { slack: { text: 'summary', at } } } })
  for (const role of ROLES) {
    const view = JSON.parse(await registry.call('task_read', `S-${role}`, {}))
    assert.equal(view.id, 'T-1')
    assert.equal(view.step, 'fetch')
    assert.equal(view.origin.permalink, 'https://example.slack.com/p1')
    assert.equal(view.origin.text, 'the button does nothing')
    assert.equal(view.jira.key, 'DEMO-1')
    assert.equal(view.repo.branch, 'ai/DEMO-1')
    assert.equal(view.stepResults.fetch.slack.text, 'summary')
    assert.equal(view.mr.url, null)
    assert.deepEqual(Object.keys(view.origin).sort(), ['permalink', 'text'])
    assert.equal(view.repo.base, undefined)
    assert.equal(view.binding, undefined)
    assert.equal(view.runs, undefined)
  }
})

test('task_records reads the record, filtered by step, and only for main', async () => {
  const { registry, store, task } = await rig()
  registerTaskTools(registry)
  assert.equal(await registry.call('task_records', 'S-main', {}), 'No records yet.')
  await store.appendRecord(task.id, { at, step: 'fetch', role: 'slack', type: 'tool_call', tool: 'slack_read_thread', text: 'read it' })
  await store.appendRecord(task.id, { at, step: 'issue', role: 'jira', type: 'tool_result', tool: 'jira_create_issue', ok: false, text: 'denied' })
  const all = await registry.call('task_records', 'S-main', {})
  assert.equal(all.split('\n').length, 2)
  assert.match(all, /slack slack_read_thread: read it/)
  assert.match(all, /FAILED: denied/)
  const issue = await registry.call('task_records', 'S-main', { step: 'issue' })
  assert.equal(issue.split('\n').length, 1)
  assert.match(issue, /jira_create_issue/)
  assert.equal(await registry.call('task_records', 'S-main', { step: 'mr' }), 'No records for step mr.')
  assert.match(await registry.call('task_records', 'S-main', { step: 'bogus' }), /must be one of/)
  assert.match(await registry.call('task_records', 'S-coding', {}), /not available to the coding bot/)
})

test('task_advance: refused with the missing evidence, accepted when it is complete', async () => {
  const { registry, store, task } = await rig()
  registerTaskTools(registry)
  const refused = await registry.call('task_advance', 'S-main', { to: 'issue' })
  assert.equal(refused, 'Cannot advance to issue: missing evidence: slack.readAt, slack.sent.ack, stepResults.fetch')
  assert.equal((await store.getTask(task.id)).step, 'fetch')

  const skipped = await registry.call('task_advance', 'S-main', { to: 'code' })
  assert.match(skipped, /can only advance to the next step \(issue\)/)

  await store.patchTask(task.id, { slack: { readAt: at, sent: { ack: true } }, stepResults: { fetch: { slack: { text: 'summary', at } } } })
  assert.equal(await registry.call('task_advance', 'S-main', { to: 'issue' }), 'Advanced to step issue.')
  assert.equal((await store.getTask(task.id)).step, 'issue')
  const records = await store.readRecords(task.id)
  assert.equal(records.filter(entry => entry.type === 'advance').length, 1)
  assert.equal(records.filter(entry => entry.type === 'refused').length, 2)
  assert.match(await registry.call('task_advance', 'S-main', { to: 'nowhere' }), /must be one of/)
  assert.match(await registry.call('task_advance', 'S-main', {}), /missing required argument to/)
})

test('needs_info_confirm: both confirmations, in either order, and only main and coding', async () => {
  const { registry, store, task } = await rig()
  registerTaskTools(registry)
  const first = await registry.call('needs_info_confirm', 'S-coding', { text: 'which page?' })
  assert.equal(first, 'Recorded. The main bot has not confirmed yet.')
  assert.equal((await store.getTask(task.id)).needsInfo.coding.text, 'which page?')
  const second = await registry.call('needs_info_confirm', 'S-main', { text: 'which page is it?' })
  assert.equal(second, 'Recorded. The coding bot has already confirmed.')
  const stored = (await store.getTask(task.id)).needsInfo
  assert.equal(stored.main.text, 'which page is it?')
  assert.ok(stored.main.at && stored.coding.at)
  assert.match(await registry.call('needs_info_confirm', 'S-jira', { text: 'x' }), /not available to the jira bot/)
  assert.match(await registry.call('needs_info_confirm', 'S-main', { text: '  ' }), /^tool failed: text must not be empty/)
})

test('needs_info_confirm: the main-first order', async () => {
  const { registry } = await rig()
  registerTaskTools(registry)
  assert.equal(await registry.call('needs_info_confirm', 'S-main', { text: 'q' }), 'Recorded. The coding bot has not confirmed yet.')
  assert.equal(await registry.call('needs_info_confirm', 'S-coding', { text: 'q' }), 'Recorded. The main bot has already confirmed.')
})

test('task_close: refused until its conditions hold, then closes with the right state', async () => {
  const { registry, store, task, closed } = await rig()
  registerTaskTools(registry)
  assert.match(await registry.call('task_close', 'S-main', { outcome: 'done' }), /^Cannot close: close\(done\) refused: the task is not in step close/)
  assert.match(await registry.call('task_close', 'S-main', { outcome: 'failed' }), /^Cannot close: .*a note is required/)
  assert.match(await registry.call('task_close', 'S-main', { outcome: 'needs_info' }), /^Cannot close: .*both confirmations/)
  assert.match(await registry.call('task_close', 'S-main', { outcome: 'giveup' }), /must be one of done, needs_info, failed, needs_person/)
  assert.deepEqual(closed, [])
  assert.equal((await store.getTask(task.id)).state, 'running')

  // needs_info needs both confirmations and the question sent to Slack.
  await registry.call('needs_info_confirm', 'S-main', { text: 'q' })
  await registry.call('needs_info_confirm', 'S-coding', { text: 'q' })
  assert.match(await registry.call('task_close', 'S-main', { outcome: 'needs_info' }), /^Cannot close: .*slack\.sent\.question/)
  await store.patchTask(task.id, { slack: { sent: { question: true } } })
  assert.equal(await registry.call('task_close', 'S-main', { outcome: 'needs_info' }), 'Task closed: needs_info.')
  const ended = await store.getTask(task.id)
  assert.equal(ended.state, 'needs_info')
  assert.equal(ended.endReason, 'needs_info')
  assert.deepEqual(closed, [[task.id, 'needs_info', 'needs_info']])
  assert.match(await registry.call('task_close', 'S-main', { outcome: 'failed', note: 'again' }), /already ended/)
})

test('task_close done in step close, and failed with a note', async () => {
  const one = await rig()
  registerTaskTools(one.registry)
  await one.store.patchTask(one.task.id, { step: 'close' })
  assert.equal(await one.registry.call('task_close', 'S-main', { outcome: 'done' }), 'Task closed: done.')
  assert.equal((await one.store.getTask(one.task.id)).state, 'done')
  assert.equal((await one.store.getTask(one.task.id)).endReason, 'completed')

  const two = await rig()
  registerTaskTools(two.registry)
  assert.equal(await two.registry.call('task_close', 'S-main', { outcome: 'failed', note: 'cannot reproduce' }), 'Task closed: failed.')
  const failed = await two.store.getTask(two.task.id)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.endReason, 'cannot reproduce')
  assert.deepEqual(two.closed, [[two.task.id, 'failed', 'cannot reproduce']])
})

test('review_report: refused outside step code, recorded in step code, the last call counts', async () => {
  const { registry, store, task } = await rig()
  registerTaskTools(registry)
  const args = { verdict: 'pass', comments: 'looks fine', rounds: 1 }
  assert.match(await registry.call('review_report', 'S-coding', args), /review_report belongs to step code, the task is in step fetch/)
  assert.equal((await store.getTask(task.id)).review, null)

  await store.patchTask(task.id, { step: 'code' })
  assert.equal(await registry.call('review_report', 'S-coding', { verdict: 'fail', comments: 'null check missing', rounds: 1 }), 'Recorded: review fail, round 1.')
  assert.equal((await store.getTask(task.id)).review.verdict, 'fail')
  assert.equal(await registry.call('review_report', 'S-coding', { ...args, rounds: 4 }), 'Recorded: review pass, round 4.')
  const review = (await store.getTask(task.id)).review
  assert.deepEqual({ verdict: review.verdict, comments: review.comments, rounds: review.rounds }, { verdict: 'pass', comments: 'looks fine', rounds: 4 })
  assert.ok(review.at)

  assert.match(await registry.call('review_report', 'S-coding', { ...args, verdict: 'maybe' }), /must be one of pass, fail/)
  assert.match(await registry.call('review_report', 'S-coding', { ...args, rounds: 0 }), /^tool failed: rounds must be at least 1/)
  assert.match(await registry.call('review_report', 'S-main', args), /not available to the main bot/)
})
