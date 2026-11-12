import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGate } from '../src/task/gate.js'
import { createFlow, STEPS, UNBOUND_WRITE_TOOLS, validateFlow } from '../src/flow/steps.js'
import { allBotDefs } from '../src/registry/bots.js'

const merge = (target, patch) => {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) merge(target[key], value)
    else target[key] = structuredClone(value)
  }
  return target
}

function fakeStore(initial = {}) {
  const task = merge({
    id: 'T-1', state: 'running', endReason: null, step: 'fetch', stepAt: null, stepResults: {},
    slack: { readAt: null, sent: { ack: false, question: false, result: false } },
    jira: { key: null, url: null, commentedMr: false, status: null },
    repo: null, review: null, mr: null, needsInfo: { main: null, coding: null }, runs: [{ no: 1 }],
  }, initial)
  const records = []
  return {
    task, records,
    getTask: async (id) => (id === task.id ? structuredClone(task) : undefined),
    patchTask: async (id, patch) => structuredClone(merge(task, patch)),
    appendRecord: async (id, entry) => { records.push(entry) },
  }
}

const limits = { diffMaxFiles: 10, diffMaxLines: 300 }
const ok = { ok: true }

function setup(initial, diff = { files: ['a.js'], totalFiles: 1, totalLines: 5 }, options = {}) {
  const store = fakeStore(initial)
  const diffCalls = []
  const repo = { diff: async (dir, base) => { diffCalls.push([dir, base]); return typeof diff === 'function' ? diff() : diff } }
  const closed = []
  const gate = createGate({ store, repo, limits, onClosed: (...args) => closed.push(args), now: () => 'NOW', ...options })
  return { store, gate, diffCalls, closed }
}

const FETCH_DONE = { slack: { readAt: 't', sent: { ack: true } }, stepResults: { fetch: { slack: { text: 's', at: 't' } } } }

test('advance: only to the next step; skip, back and stay are refused', async () => {
  const { gate, store } = setup({ ...FETCH_DONE })
  for (const bad of ['prepare', 'fetch', 'close', 'nowhere']) {
    const r = await gate.advance('T-1', bad)
    assert.equal(r.ok, false)
    assert.equal(store.task.step, 'fetch')
  }
  assert.deepEqual(await gate.advance('T-1', 'issue'), ok)
  assert.equal(store.task.step, 'issue')
  assert.equal(store.task.stepAt, 'NOW')
  assert.equal((await gate.advance('T-1', 'fetch')).ok, false)
})

test('advance: missing evidence is listed exactly and the step stays', async () => {
  const { gate, store } = setup({ slack: { readAt: 't' } })
  const r = await gate.advance('T-1', 'issue')
  assert.deepEqual(r, { ok: false, missing: ['slack.sent.ack', 'stepResults.fetch'] })
  assert.equal(store.task.step, 'fetch')
  assert.equal(store.records.at(-1).type, 'refused')
  assert.match(store.records.at(-1).text, /slack\.sent\.ack, stepResults\.fetch/)
})

test('advance: success appends an advance record', async () => {
  const { gate, store } = setup({ ...FETCH_DONE })
  await gate.advance('T-1', 'issue')
  const rec = store.records.at(-1)
  assert.equal(rec.type, 'advance')
  assert.equal(rec.text, 'fetch -> issue')
  assert.equal(rec.step, 'fetch')
  assert.equal(rec.run, 1)
})

test('advance through every step with the evidence of each', async () => {
  const { gate, store } = setup({ ...FETCH_DONE, step: 'fetch' })
  await gate.advance('T-1', 'issue')
  assert.deepEqual((await gate.advance('T-1', 'prepare')).missing, ['jira.key'])
  store.task.jira.key = 'DEMO-7'
  await gate.advance('T-1', 'prepare')
  assert.deepEqual((await gate.advance('T-1', 'code')).missing, ['repo.dir', 'repo.branch', 'repo.base'])
  store.task.repo = { dir: '/d', branch: 'b', base: 'abc' }
  await gate.advance('T-1', 'code')
  assert.deepEqual((await gate.advance('T-1', 'mr')).missing, ['review.verdict == pass'])
  store.task.review = { verdict: 'fail' }
  assert.deepEqual((await gate.advance('T-1', 'mr')).missing, ['review.verdict == pass'])
  store.task.review = { verdict: 'pass' }
  await gate.advance('T-1', 'mr')
  store.task.mr = { url: 'http://mr' }
  await gate.advance('T-1', 'writeback')
  assert.deepEqual((await gate.advance('T-1', 'close')).missing, ['jira.commentedMr', 'slack.sent.result'])
  store.task.jira.commentedMr = true
  store.task.slack.sent.result = true
  await gate.advance('T-1', 'close')
  assert.equal(store.task.step, 'close')
  assert.equal((await gate.advance('T-1', 'close')).ok, false)
})

test('code step: an empty diff is missing evidence "diff"; the adapter gets dir and base', async () => {
  const { gate, diffCalls } = setup(
    { step: 'code', repo: { dir: '/d', branch: 'b', base: 'abc' }, review: { verdict: 'pass' } },
    { files: [], totalFiles: 0, totalLines: 0 },
  )
  assert.deepEqual(await gate.advance('T-1', 'mr'), { ok: false, missing: ['diff'] })
  assert.deepEqual(diffCalls, [['/d', 'abc']])
})

test('allow: by current step, purpose-keyed slack_reply', async () => {
  const { gate, store } = setup({})
  assert.deepEqual(await gate.allow('T-1', 'slack_reply', 'ack'), ok)
  const wrongPurpose = await gate.allow('T-1', 'slack_reply', 'result')
  assert.equal(wrongPurpose.ok, false)
  assert.match(wrongPurpose.reason, /belongs to step writeback/)
  assert.equal((await gate.allow('T-1', 'jira_create_issue')).ok, false)
  assert.equal((await gate.allow('T-1', 'review_report')).ok, false)
  assert.equal((await gate.allow('T-1', 'slack_reply')).ok, false)
  assert.equal((await gate.allow('T-1', 'no_such_tool')).ok, false)
  store.task.step = 'writeback'
  assert.deepEqual(await gate.allow('T-1', 'slack_reply', 'result'), ok)
  assert.deepEqual(await gate.allow('T-1', 'jira_add_comment'), ok)
  assert.deepEqual(await gate.allow('T-1', 'jira_transition'), ok)
  assert.equal((await gate.allow('T-1', 'slack_reply', 'ack')).ok, false)
})

test('allow: every refusal appends a refused record with the reason', async () => {
  const { gate, store } = setup({})
  const r = await gate.allow('T-1', 'mr_open_draft')
  assert.equal(r.ok, false)
  const rec = store.records.at(-1)
  assert.equal(rec.type, 'refused')
  assert.equal(rec.text, r.reason)
  assert.equal(rec.tool, 'mr_open_draft')
  assert.equal(rec.step, 'fetch')
  const before = store.records.length
  await gate.allow('T-1', 'slack_reply', 'ack')
  assert.equal(store.records.length, before)
})

test('allow: mr_open_draft refused in fetch; refused in mr without a pass; refused over the limit', async () => {
  const base = { repo: { dir: '/d', branch: 'b', base: 'abc' } }
  const inFetch = setup({ ...base, review: { verdict: 'pass' } })
  assert.equal((await inFetch.gate.allow('T-1', 'mr_open_draft')).ok, false)

  const noPass = setup({ ...base, step: 'mr', review: { verdict: 'fail' } })
  const r1 = await noPass.gate.allow('T-1', 'mr_open_draft')
  assert.equal(r1.ok, false)
  assert.match(r1.reason, /review has not passed/)
  const noReview = setup({ ...base, step: 'mr' })
  assert.equal((await noReview.gate.allow('T-1', 'mr_open_draft')).ok, false)

  const tooManyFiles = setup({ ...base, step: 'mr', review: { verdict: 'pass' } }, { files: [], totalFiles: 11, totalLines: 5 })
  const r2 = await tooManyFiles.gate.allow('T-1', 'mr_open_draft')
  assert.match(r2.reason, /the change exceeds the size limit/)
  const tooManyLines = setup({ ...base, step: 'mr', review: { verdict: 'pass' } }, { files: [], totalFiles: 1, totalLines: 301 })
  assert.match((await tooManyLines.gate.allow('T-1', 'mr_open_draft')).reason, /size limit/)

  const fine = setup({ ...base, step: 'mr', review: { verdict: 'pass' } }, { files: [], totalFiles: 10, totalLines: 300 })
  assert.deepEqual(await fine.gate.allow('T-1', 'mr_open_draft'), ok)
})

test('allow: slack_reply question needs both confirmations; works in any step', async () => {
  const { gate, store } = setup({ step: 'code' })
  assert.equal((await gate.allow('T-1', 'slack_reply', 'question')).ok, false)
  await gate.confirmNeedsInfo('T-1', 'coding', 'which repo?')
  assert.equal((await gate.allow('T-1', 'slack_reply', 'question')).ok, false)
  await gate.confirmNeedsInfo('T-1', 'main', 'agreed')
  assert.deepEqual(await gate.allow('T-1', 'slack_reply', 'question'), ok)
  store.task.step = 'fetch'
  assert.deepEqual(await gate.allow('T-1', 'slack_reply', 'question'), ok)
  assert.deepEqual(await gate.allow('T-1', 'needs_info_confirm'), ok)
})

test('confirmNeedsInfo: only main and coding; reports whether the other has confirmed', async () => {
  const { gate, store } = setup({})
  assert.deepEqual(await gate.confirmNeedsInfo('T-1', 'main', 'unclear'), { other: false })
  assert.equal(store.task.needsInfo.main.text, 'unclear')
  assert.equal(store.task.needsInfo.main.at, 'NOW')
  assert.deepEqual(await gate.confirmNeedsInfo('T-1', 'coding', 'yes'), { other: true })
  assert.equal(store.task.needsInfo.main.text, 'unclear')
  for (const role of ['slack', 'jira', 'pipeline', 'x']) {
    await assert.rejects(gate.confirmNeedsInfo('T-1', role, 't'), /only main and coding/)
  }
  assert.equal(store.task.needsInfo.coding.text, 'yes')
  assert.equal(store.records.filter((r) => r.type === 'refused').length, 4)
})

test('close needs_info: refused with one confirmation, refused without the question; then ok', async () => {
  const { gate, store, closed } = setup({})
  await gate.confirmNeedsInfo('T-1', 'main', 'a')
  assert.equal((await gate.close('T-1', 'needs_info')).ok, false)
  await gate.confirmNeedsInfo('T-1', 'coding', 'b')
  assert.equal((await gate.close('T-1', 'needs_info')).ok, false)
  assert.equal(store.task.state, 'running')
  store.task.slack.sent.question = true
  assert.deepEqual(await gate.close('T-1', 'needs_info'), ok)
  assert.equal(store.task.state, 'needs_info')
  assert.equal(store.task.endReason, 'needs_info')
  assert.deepEqual(closed, [['T-1', 'needs_info', 'needs_info']])
})

test('close done: only in step close; state done, reason completed', async () => {
  const { gate, store, closed } = setup({ step: 'mr' })
  assert.equal((await gate.close('T-1', 'done')).ok, false)
  assert.deepEqual(closed, [])
  store.task.step = 'close'
  assert.deepEqual(await gate.close('T-1', 'done'), ok)
  assert.equal(store.task.state, 'done')
  assert.equal(store.task.endReason, 'completed')
  assert.deepEqual(closed, [['T-1', 'done', 'completed']])
  assert.equal(store.records.at(-1).type, 'system')
  assert.equal((await gate.close('T-1', 'done')).ok, false)
  assert.equal(closed.length, 1)
})

test('close failed and needs_person: need a note; mapping of state and end reason', async () => {
  const a = setup({})
  assert.equal((await a.gate.close('T-1', 'failed')).ok, false)
  assert.equal((await a.gate.close('T-1', 'failed', '   ')).ok, false)
  assert.deepEqual(await a.gate.close('T-1', 'failed', 'repo is gone'), ok)
  assert.equal(a.store.task.state, 'failed')
  assert.equal(a.store.task.endReason, 'repo is gone')
  assert.deepEqual(a.closed, [['T-1', 'failed', 'repo is gone']])

  const b = setup({})
  assert.equal((await b.gate.close('T-1', 'needs_person')).ok, false)
  assert.deepEqual(await b.gate.close('T-1', 'needs_person', 'cannot decide'), ok)
  assert.equal(b.store.task.state, 'failed')
  assert.equal(b.store.task.endReason, 'needs_person')

  assert.equal((await setup({}).gate.close('T-1', 'bogus', 'x')).ok, false)
})

test('close refusal appends a refused record with the reason', async () => {
  const { gate, store } = setup({})
  const r = await gate.close('T-1', 'done')
  assert.equal(r.ok, false)
  assert.equal(store.records.at(-1).type, 'refused')
  assert.match(store.records.at(-1).text, /close\(done\) refused/)
  assert.match(r.reason, /not in step close/)
})

test('swapping two steps and changing a role only touches the definitions', async () => {
  // issue and prepare swapped: a modified copy of steps.js data, nothing else changed.
  const steps = structuredClone(STEPS)
  const [issue, prepare] = [steps[1], steps[2]]
  steps[1] = { ...prepare, no: 2 }
  steps[2] = { ...issue, no: 3 }
  steps[2].roles = ['main'] // and a different role in charge of the issue step
  assert.deepEqual(validateFlow(allBotDefs(), steps), [])
  const flow = createFlow(steps, UNBOUND_WRITE_TOOLS)

  const { gate, store } = setup({ ...FETCH_DONE }, undefined, { flow })
  await gate.advance('T-1', 'prepare')
  assert.equal(store.task.step, 'prepare')
  assert.equal((await gate.allow('T-1', 'repo_prepare')).ok, true)
  assert.equal((await gate.allow('T-1', 'jira_create_issue')).ok, false)
  assert.equal((await gate.advance('T-1', 'issue')).ok, false)
  assert.deepEqual((await gate.advance('T-1', 'issue')).missing, ['repo.dir', 'repo.branch', 'repo.base'])
  store.task.repo = { dir: '/d', branch: 'b', base: 'abc' }
  assert.deepEqual(await gate.advance('T-1', 'issue'), ok)
  assert.equal((await gate.allow('T-1', 'jira_create_issue')).ok, true)
  assert.deepEqual((await gate.advance('T-1', 'code')).missing, ['jira.key'])
})

test('rerun keeps jira, repo, mr and ack: a fetch->issue advance needs no new issue', async () => {
  // After a rerun the store sets step back to fetch and clears needsInfo/review/stepResults.
  const { gate, store } = setup({ jira: { key: 'DEMO-7' }, repo: { dir: '/d', branch: 'b', base: 'abc' }, slack: { readAt: 't', sent: { ack: true } }, stepResults: {} })
  assert.deepEqual((await gate.advance('T-1', 'issue')).missing, ['stepResults.fetch'])
  store.task.stepResults.fetch = { slack: { text: 's' } }
  assert.deepEqual(await gate.advance('T-1', 'issue'), ok)
  assert.deepEqual((await gate.advance('T-1', 'prepare')), ok)
  assert.deepEqual((await gate.advance('T-1', 'code')), ok)
})
