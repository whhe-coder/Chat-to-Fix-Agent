// The progress notices the tools send right when a fact is written (jira_created, mr_opened, ci_fix_pushed):
// real store and tool registry, a gate that always allows, stub adapters and a notify that records.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../core/task/store.ts'
import { createToolRegistry } from '../core/tools/register.ts'
import { registerAllTools } from '../core/tools/index.ts'
import { commitUrlOf } from '../core/tools/material.ts'
import { newCi } from '../core/task/contracts.ts'

const ROLES = ['main', 'slack', 'jira', 'pipeline', 'coding']
const MR_URL = 'https://gitlab.example.com/group/project/-/merge_requests/12'

async function rig({ notifyFails = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-notices-'))
  const store = createStore({ dataDir: dir, warn() {} })
  const sent = []
  const warnings = []
  const notify = async (task, kind) => {
    if (notifyFails) throw new Error('outbox down')
    sent.push({ kind, id: task.id, jira: task.jira, mr: task.mr, round: task.ci?.round, commitUrl: task.commitUrl })
  }
  const state = { mrUrl: MR_URL, pushSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }
  const adapters = {
    jira: { createIssue: async () => ({ key: 'DEMO-1', url: 'https://jira.example.com/browse/DEMO-1' }) },
    repo: {
      openDraftMR: async () => ({ url: state.mrUrl, iid: 12, sha: 'sha-mr-1' }),
      pushFix: async () => ({ sha: state.pushSha }),
    },
  }
  const binding = { channel: 'C1', repo: 'group/project', jiraProject: 'DEMO' }
  const task = await store.createTask(
    { eventId: 'E1', channel: 'C1', threadTs: '1.1', messageTs: '1.1', user: { id: 'U1', name: 'tester' }, text: 'x', files: [], permalink: 'https://example.slack.com/p1' },
    binding,
  )
  await store.startRun(task.id, { groupId: 'g1', bots: { main: 'm', slack: 's', jira: 'j', pipeline: 'p', coding: 'c' } })
  await store.patchTask(task.id, { issueAssessment: { ready: true, sourceQuote: 'x', problem: 'problem', outcome: 'outcome' } })
  const sessions = new Map(ROLES.map((role) => [`S-${role}`, { botId: `bot-${role}`, role, taskId: task.id }]))
  const botlayer = { botOfSession: (id) => sessions.get(id), setGroupWorkDir: async () => {} }
  const gate = { allow: async () => ({ ok: true }) }
  const registry = createToolRegistry({ store, gate: gate as any, adapters, config: { limits: {} }, botlayer: botlayer as any, notify, warn: (...a) => warnings.push(a), retryDelayMs: 0 } as any)
  registerAllTools(registry)
  const call = (role, name, args = {}) => registry.call(name, `S-${role}`, args)
  return { store, task, sent, warnings, state, call }
}

const ISSUE = { title: 't', description: 'd', acceptance: 'a' }
const MR = { title: 'DEMO-1 fix', description: 'd' }
const PUSH = { commit_message: 'fix: the second round' }
const prepare = (r) => r.store.patchTask(r.task.id, { jira: { key: 'DEMO-1', url: 'u' }, repo: { dir: '/w/T-1', branch: 'ai/DEMO-1', base: 'abc' } })
const failedCi = (r, patch: any = {}) => r.store.patchTask(r.task.id, {
  step: 'ci', mr: { url: MR_URL, iid: 12, sha: 'sha-mr-1' },
  ci: { ...newCi('sha-mr-1', '2026-11-12T00:00:00.000Z'), status: 'failed', failedJobs: [{ id: 1, name: 'lint' }], ...patch },
})

test('jira_create_issue: a new issue sends jira_created once with the fresh key and url; reuse and rerun send nothing', async () => {
  const r = await rig()
  assert.match(await r.call('jira', 'jira_create_issue', ISSUE), /Created the Jira issue DEMO-1/)
  assert.deepEqual(r.sent.map((s) => s.kind), ['jira_created'])
  assert.equal(r.sent[0].jira.key, 'DEMO-1')
  assert.equal(r.sent[0].jira.url, 'https://jira.example.com/browse/DEMO-1')
  assert.equal((await r.store.getTask(r.task.id)).notified.jira_created, true)
  // the task already has an issue: nothing is created, nothing is sent
  assert.match(await r.call('jira', 'jira_create_issue', ISSUE), /already has the Jira issue/)
  assert.equal(r.sent.length, 1)
  // a rerun (startRun) keeps `notified`; a new issue after the key was cleared still does not repeat the notice
  await r.store.patchTask(r.task.id, { jira: { key: null } })
  await r.store.startRun(r.task.id, { groupId: 'g2', bots: { main: 'm', slack: 's', jira: 'j', pipeline: 'p', coding: 'c' } })
  assert.equal((await r.store.getTask(r.task.id)).notified.jira_created, true)
  await r.call('jira', 'jira_create_issue', ISSUE)
  assert.equal(r.sent.length, 1)
})

test('mr_open_draft: the first MR sends mr_opened once; an existing MR (rerun) sends nothing', async () => {
  const r = await rig()
  await prepare(r)
  assert.match(await r.call('pipeline', 'mr_open_draft', MR), /Opened the Draft MR/)
  assert.deepEqual(r.sent.map((s) => s.kind), ['mr_opened'])
  assert.equal(r.sent[0].mr.url, MR_URL)
  assert.match(await r.call('pipeline', 'mr_open_draft', MR), /already had a Draft MR/)
  assert.equal(r.sent.length, 1)
  await r.store.startRun(r.task.id, { groupId: 'g2', bots: { main: 'm', slack: 's', jira: 'j', pipeline: 'p', coding: 'c' } })
  assert.match(await r.call('pipeline', 'mr_open_draft', MR), /already had a Draft MR/)
  assert.equal(r.sent.length, 1)
  assert.deepEqual((await r.store.getTask(r.task.id)).notified, { mr_opened: true })
})

test('mr_push_fix: one ci_fix_pushed per round with the round just pushed and the commit link derived from the MR url', async () => {
  const r = await rig()
  await prepare(r)
  await failedCi(r)
  assert.match(await r.call('pipeline', 'mr_push_fix', PUSH), /round 1 of/)
  assert.equal(r.sent.length, 1)
  assert.equal(r.sent[0].kind, 'ci_fix_pushed')
  assert.equal(r.sent[0].round, 1)
  assert.equal(r.sent[0].commitUrl, `https://gitlab.example.com/group/project/-/commit/${r.state.pushSha}`)
  // the next round: the monitor would write a new failure with the carried round
  await failedCi(r, { round: 1 })
  r.state.pushSha = 'ffff0000ffff0000ffff0000ffff0000ffff0000'
  assert.match(await r.call('pipeline', 'mr_push_fix', PUSH), /round 2 of/)
  assert.deepEqual(r.sent.map((s) => s.round), [1, 2])
  assert.match(r.sent[1].commitUrl, /\/-\/commit\/ffff0000ffff/)
})

test('mr_push_fix: a fake MR url gives no commit link; a refused or rejected push sends nothing', async () => {
  const r = await rig()
  await prepare(r)
  await failedCi(r)
  await r.store.patchTask(r.task.id, { mr: { url: 'fake://gitlab/group/project/mr/1' } })
  await r.call('pipeline', 'mr_push_fix', PUSH)
  assert.equal(r.sent.length, 1)
  assert.equal(r.sent[0].commitUrl, undefined)
  const r2 = await rig()
  await prepare(r2)
  assert.match(await r2.call('pipeline', 'mr_push_fix', PUSH), /refused/) // no failed ci
  assert.equal(r2.sent.length, 0)
})

test('commitUrlOf: only a /-/merge_requests/<n> tail is replaced', () => {
  assert.equal(commitUrlOf('https://h/g/p/-/merge_requests/3', 'abc'), 'https://h/g/p/-/commit/abc')
  assert.equal(commitUrlOf('https://h/g/p/-/merge_requests/3/diffs', 'abc'), undefined)
  assert.equal(commitUrlOf('fake://gitlab/g/p/mr/1', 'abc'), undefined)
  assert.equal(commitUrlOf(undefined, 'abc'), undefined)
})

test('a notify failure never fails the tool; it only warns', async () => {
  const r = await rig({ notifyFails: true })
  assert.match(await r.call('jira', 'jira_create_issue', ISSUE), /Created the Jira issue DEMO-1/)
  await r.store.patchTask(r.task.id, { repo: { dir: '/w/T-1', branch: 'ai/DEMO-1', base: 'abc' } })
  assert.match(await r.call('pipeline', 'mr_open_draft', MR), /Opened the Draft MR/)
  await failedCi(r)
  assert.match(await r.call('pipeline', 'mr_push_fix', PUSH), /Pushed the fix/)
  assert.equal(r.warnings.length, 3)
  assert.match(String(r.warnings[0][0]), /cannot send the/)
})
