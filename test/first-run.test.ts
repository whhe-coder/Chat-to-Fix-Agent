// scripts/first-run.ts (prepares a first real run) and scripts/show-task.ts (prints a task).
// No model is called, nothing is started; the keychain lookup is injected, the key is a fake value,
// the CLI is stood in for by the node binary, and everything is written under a temporary HOME.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadConfig } from '../src/config.ts'
import { prepareFirstRun, DEFAULT_KEYCHAIN_SERVICE, SAMPLE_REPORT } from '../scripts/first-run.ts'
import { connection, formatRecord, formatTask, showTask } from '../scripts/show-task.ts'

const run = promisify(execFile)
const FAKE_KEY = 'sk-ant-api03-FAKE-KEY-FOR-TESTS-0123456789'
const tmp = () => mkdtempSync(join(tmpdir(), 'chat-to-fix-firstrun-'))
const everyFile = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !/[\\/]\.git[\\/]/.test(join(e.parentPath, e.name))).map((e) => join(e.parentPath, e.name))
const prepare = (extra: any = {}) => {
  const home = tmp()
  return prepareFirstRun({ home, user: 'tester', port: 0, claudeBin: process.execPath, env: { ...process.env, ANTHROPIC_API_KEY: undefined }, hasKeychainItem: () => false, ...extra }).then((r) => ({ ...r, home }))
}

test('first-run writes the data folder outside the project: test repo, config, overlay, commands', async () => {
  const r = await prepare({ env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: FAKE_KEY } })
  assert.equal(r.ready, true)
  assert.equal(r.keySource, 'env')
  assert.ok(r.dir.startsWith(join(r.home, 'chat-to-fix-runs') + '/'), r.dir)
  assert.ok(existsSync(join(r.dir, 'test-repo', 'project', 'test.sh')) && existsSync(join(r.dir, 'test-repo', 'project.git')))

  const config = JSON.parse(readFileSync(r.configPath, 'utf8'))
  assert.equal(config.apiModel, 'anthropic/claude-sonnet-5-5')
  assert.equal(config.engineAuth, 'apiKey')
  assert.deepEqual(config.adapters, { slack: 'fake', jira: 'fake', gitlab: 'fake' })
  assert.ok(config.dataDir.startsWith(r.dir) && config.worktreesDir.startsWith(r.dir))
  assert.deepEqual(config.bindings[0].testCommands, ['sh test.sh'])
  assert.equal(config.bindings[0].localRepo, r.repo.localRepo)
  assert.equal(config.bindings[0].remote, r.repo.remote)
  // The real loader accepts it.
  const loaded: any = loadConfig({ path: r.configPath, env: { ANTHROPIC_API_KEY: FAKE_KEY } })
  assert.equal(loaded.bindings[0].channel, 'C0456')

  const overlay = readFileSync(r.patchPath, 'utf8')
  assert.match(overlay, /- id: chat-to-fix/)
  assert.ok(overlay.includes(`claudeCommand: ${JSON.stringify(process.execPath)}`))

  // The printed commands: start with the overlay, inject with the sample report, watch, stop.
  const text = readFileSync(r.commandsPath, 'utf8')
  assert.equal(text, r.text)
  assert.ok(text.includes(`export CHAT_TO_FIX_DATA='${r.dir}'`))
  assert.ok(text.includes(`sh scripts/start-chat-to-fix.sh --patch '${r.patchPath}'`))
  assert.ok(text.includes('node scripts/fake-event.ts --channel C0456 --text '))
  assert.ok(text.includes(SAMPLE_REPORT))
  assert.match(text, /show-task\.ts T-1 --dir/)
  assert.match(text, /\/tasks\/T-1\/stop/)
  assert.match(text, /stop-chat-to-fix\.sh/)
  assert.doesNotMatch(text, /security find-generic-password/, 'no keychain line when the key is in the environment')
  assert.doesNotMatch(text, /read -rs/)

  // The key is never written anywhere.
  for (const file of everyFile(r.dir)) assert.equal(readFileSync(file).includes(FAKE_KEY), false, file)
})

test('first-run: with no key in the environment, an existing keychain item is exported by the start command (existence only is checked)', async () => {
  const asked = []
  const r = await prepare({ hasKeychainItem: (service, account) => { asked.push([service, account]); return true } })
  assert.deepEqual(asked, [[DEFAULT_KEYCHAIN_SERVICE, 'tester']])
  assert.equal(r.keySource, 'keychain')
  assert.equal(r.ready, true)
  const exportLine = 'export ANTHROPIC_API_KEY="$(security find-generic-password -a "$USER" -s chat-to-fix-anthropic -w)"'
  assert.ok(r.commands.start.includes(exportLine))
  // the export comes right before the start command
  const start = r.commands.start
  assert.equal(start.at(-2), exportLine)
  assert.match(start.at(-1), /^sh scripts\/start-chat-to-fix\.sh --patch /)
})

test('first-run: the keychain service name is a flag, and a key in the environment skips the keychain', async () => {
  const asked = []
  const custom = await prepare({ keychainService: 'my-service', hasKeychainItem: (s) => { asked.push(s); return true } })
  assert.deepEqual(asked, ['my-service'])
  assert.ok(custom.text.includes('-s my-service -w'))
  const calls = []
  await prepare({ env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: FAKE_KEY }, hasKeychainItem: () => { calls.push(1); return true } })
  assert.equal(calls.length, 0)
})

test('first-run: no key and no keychain item blocks the run (files are still written)', async () => {
  const r = await prepare()
  assert.equal(r.ready, false)
  assert.equal(r.keySource, undefined)
  assert.ok(r.blockers.some((b) => /ANTHROPIC_API_KEY is not set/.test(b) && /chat-to-fix-anthropic/.test(b)))
  assert.ok(existsSync(r.configPath))
  assert.match(r.text, /read -rs ANTHROPIC_API_KEY/)
})

test('first-run: a missing CLI blocks the run; a data folder inside the project or a used one is refused', async () => {
  const noCli = await prepare({ env: { PATH: '/nonexistent', ANTHROPIC_API_KEY: FAKE_KEY }, claudeBin: join(tmp(), 'no-such-claude') })
  assert.equal(noCli.ready, false)
  assert.ok(noCli.blockers.some((b) => /Claude Code CLI was not found/.test(b)))
  await assert.rejects(prepareFirstRun({ dir: new URL('../.data/first-run-test', import.meta.url).pathname, env: {}, claudeBin: process.execPath, hasKeychainItem: () => false }), /outside the project/)
  const used = tmp()
  writeFileSync(join(used, 'something'), 'x')
  await assert.rejects(prepareFirstRun({ dir: used, env: {}, claudeBin: process.execPath, hasKeychainItem: () => false }), /not empty/)
})

test('first-run as a command: default folder under HOME, prints the commands, never the key, starts nothing', async () => {
  const home = tmp()
  const script = new URL('../scripts/first-run.ts', import.meta.url).pathname
  const { stdout } = await run(process.execPath, [script, '--port', '0', '--claude-bin', process.execPath], {
    env: { PATH: process.env.PATH, HOME: home, USER: 'tester', ANTHROPIC_API_KEY: FAKE_KEY },
  })
  const [folder] = readdirSync(join(home, 'chat-to-fix-runs'))
  assert.match(folder, /^\d{8}-\d{6}$/)
  const dir = join(home, 'chat-to-fix-runs', folder)
  assert.ok(existsSync(join(dir, 'chat-to-fix.json')) && existsSync(join(dir, 'first-run.patch.yml')) && existsSync(join(dir, 'commands.txt')))
  assert.ok(stdout.includes('sh scripts/start-chat-to-fix.sh --patch'))
  assert.ok(stdout.includes('Nothing was started and no model was called'))
  assert.equal(stdout.includes(FAKE_KEY), false)
  assert.equal(existsSync(join(dir, 'run')), false, 'the system was not started')
  for (const file of everyFile(home)) assert.equal(readFileSync(file).includes(FAKE_KEY), false, file)
})

test('first-run as a command: exit code 1 when blocked', async () => {
  const home = tmp()
  const script = new URL('../scripts/first-run.ts', import.meta.url).pathname
  // HOME is empty and the keychain is the real one: use a service name that cannot exist.
  await assert.rejects(
    run(process.execPath, [script, '--port', '0', '--claude-bin', process.execPath, '--keychain-service', 'chat-to-fix-test-no-such-item-xyz'], { env: { PATH: process.env.PATH, HOME: home, USER: 'tester' } }),
    (e: any) => e.code === 1 && /BLOCKED: ANTHROPIC_API_KEY is not set/.test(e.stdout),
  )
})

// ---- show-task ----
const TASK = {
  id: 'T-1', state: 'running', endReason: null, step: 'code', runs: [{ no: 1, endedAt: null }],
  slack: { readAt: 'x', sent: { ack: true, question: false, result: false } },
  jira: { key: 'DEMO-1', url: 'fake://jira/DEMO-1', commentedMr: false }, repo: { dir: '/w/T-1', branch: 'ai/DEMO-1' }, review: null, mr: null, needsInfo: { main: null, coding: null },
}
const RECORDS = [
  { at: '2026-11-12T10:00:01.000Z', type: 'line', step: 'fetch', role: 'main', text: 'hello\n  world' },
  { at: '2026-11-12T10:00:05.000Z', type: 'tool_call', step: 'code', role: 'coding', tool: 'task_read', text: 'task_read {}' },
  { at: '2026-11-12T10:00:06.000Z', type: 'tool_result', step: 'code', role: 'coding', tool: 'task_read', ok: false, text: 'x'.repeat(400) },
]

async function stub(handler) {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, token: req.headers['x-chat-to-fix-token'] })
    const [status, body] = handler(req.url)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()))
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, seen, close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections?.() }) }
}

test('show-task prints the state and the records in readable form and sends the token', async (t) => {
  const s = await stub((url) => (url.startsWith('/tasks/T-1') ? [200, { ...TASK, records: RECORDS }] : [200, { tasks: [{ id: 'T-1', state: 'running', step: 'code', jiraKey: 'DEMO-1', mrUrl: null }] }]))
  t.after(s.close)
  const out = []
  const task = await showTask({ id: 'T-1', conn: { url: s.url, token: 'secret-token' }, out: (l) => out.push(l) })
  assert.equal(task.state, 'running')
  assert.equal(s.seen[0].token, 'secret-token')
  assert.match(out[0], /^T-1 {2}running {2}step=code {2}run 1/)
  assert.ok(out.some((l) => /jira {4}DEMO-1/.test(l)))
  assert.ok(out.some((l) => /execution records \(3\)/.test(l)))
  assert.ok(out.some((l) => /10:00:01 fetch +main +line +hello world$/.test(l)), 'newlines are folded')
  assert.ok(out.some((l) => /coding +tool_call +task_read \{\}/.test(l)))
  const failed = out.find((l) => /tool_result FAILED/.test(l))
  assert.ok(failed && failed.endsWith('…'), 'long text is shortened')
  const full = []
  await showTask({ id: 'T-1', conn: { url: s.url, token: 't' }, full: true, out: (l) => full.push(l) })
  assert.ok(full.some((l) => l.endsWith(`task_read ${'x'.repeat(400)}`)))
  assert.equal(out.join('\n').includes('secret-token'), false)
  // no id: the list
  const list = []
  await showTask({ conn: { url: s.url, token: 't' }, out: (l) => list.push(l) })
  assert.match(list[0], /^T-1 {2}running {2}step=code {2}jira=DEMO-1/)
})

test('show-task --follow prints only new records until the task ends; an unknown task is an error', async (t) => {
  let polls = 0
  const s = await stub((url) => {
    if (url.startsWith('/tasks/T-9')) return [404, { error: 'task_not_found' }]
    polls += 1
    return polls === 1 ? [200, { ...TASK, records: RECORDS.slice(0, 1) }] : [200, { ...TASK, state: 'done', endReason: 'completed', step: 'close', records: RECORDS }]
  })
  t.after(s.close)
  const out = []
  const task = await showTask({ id: 'T-1', conn: { url: s.url, token: 't' }, follow: true, intervalMs: 1, sleep: async () => {}, out: (l) => out.push(l) })
  assert.equal(task.state, 'done')
  assert.equal(polls, 2)
  assert.equal(out.filter((l) => /hello world/.test(l)).length, 1, 'the first record is printed once')
  assert.equal(out.filter((l) => /task_read/.test(l)).length, 2)
  assert.match(out.at(-1), /done \(completed\)/)
  await assert.rejects(showTask({ id: 'T-9', conn: { url: s.url, token: 't' }, out: () => {} }), /404 \(task_not_found\)/)
})

test('show-task finds the connection from the first-run folder', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'http-token'), 'tok-from-file\n')
  writeFileSync(join(dir, 'chat-to-fix.json'), JSON.stringify({ httpPort: 3191 }))
  assert.deepEqual(connection({ dir }, {}), { url: 'http://127.0.0.1:3191', token: 'tok-from-file' })
  assert.deepEqual(connection({ dir, url: 'http://x:1/' }, { CHAT_TO_FIX_HTTP_TOKEN: 'envtok' }), { url: 'http://x:1', token: 'envtok' })
  assert.throws(() => connection({}, {}), /no connection/)
  assert.match(formatTask(TASK), /branch=ai\/DEMO-1/)
  assert.match(formatRecord({ type: 'system', text: 'run ended' }), /system +run ended$/)
})
