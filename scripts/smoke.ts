// Smoke run of chat-to-fix in the bundled DSH runtime, with a local mock model (scripts/mock-llm.ts)
// instead of a real one: no API key, no real model call, and the Coding bot's Claude Code route
// points at a stand-in (scripts/lib/fake-claude.sh). Prints a pass/fail list; exit code 0 only
// when every check passed. Everything it starts is stopped again, also on failure.
//
//   . scripts/dev-env.sh && node scripts/smoke.ts [--sentinel-home]
//
// --sentinel-home  runs the DSH process with HOME set to an empty directory under the data
//                  directory, so everything the process and its children write under "~" lands
//                  there and is listed exactly (the real-home snapshot also sees other programs).
// CHAT_TO_FIX_SMOKE_DATA selects the data directory (default <project>/.data/smoke; it is wiped first
// and must lie under <project>/.data).
//
// The run: start the mock; write a chat-to-fix configuration and a patch overlay that points the
// `anthropic` route at the mock (key reference CHAT_TO_FIX_MOCK_LLM_KEY, a dummy value); start chat-to-fix
// with scripts/start-chat-to-fix.sh; GET /health; POST /events; follow the task to `running`; check the
// five bots and the group (GET /tasks/:id?records=1 and $DATA/dsh/bot/state.json), the agent
// preset of each bot session (DSH session logs), the task message and the tool list in the Main
// bot's model request (mock log), its reply in the execution record, the sockets; POST
// /tasks/:id/stop; scripts/stop-chat-to-fix.sh; stop the mock; compare the home-directory snapshots.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = resolve(process.env.CHAT_TO_FIX_SMOKE_DATA ?? join(ROOT, '.data', 'smoke'))
if (!DATA.startsWith(join(ROOT, '.data') + '/')) { console.error(`smoke: the data directory must lie under ${join(ROOT, '.data')}`); process.exit(2) }
const SENTINEL = process.argv.includes('--sentinel-home')
const MODEL = 'claude-sonnet-5-5'
const REPLY = 'MOCK-REPLY: the Main bot has read the task.'
const CHANNEL = 'C0456'
// DSH's built-in tools that write, run commands or reach the network.
const WRITE_OR_SHELL = ['write', 'edit', 'apply_patch', 'str_replace_editor', 'bash', 'pwsh', 'job_output', 'job_kill', 'job_list', 'subagent', 'subagent_fork', 'workflow', 'web_search', 'web_fetch', 'plugin_manager', 'schedule_create', 'schedule_edit']
// Places under the real home that belong to DSH or DS Bot; a change there fails the run. Other
// changes in the window are listed (other programs on this machine write there too).
const HOME = process.env.HOME
const DSH_PLACES = ['.dsh', '.agents', '.deepseek', '.pi', '.anthropic', '.config', '.cache', '.local', 'Documents/mywork/ds-bot'].map((p) => join(HOME, p))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`)
  return Boolean(ok)
}
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const mockLog = () => existsSync(join(DATA, 'mock.jsonl'))
  ? readFileSync(join(DATA, 'mock.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
async function until(what, fn, timeoutMs = 60_000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(everyMs)
  }
  throw new Error(`timed out waiting for ${what}`)
}
const filesUnder = (dir) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => !e.isDirectory()).map((e) => join(e.parentPath ?? e.path, e.name).slice(dir.length + 1)).sort()
}
// The agent preset a DSH session was created with (header line of its zstd-compressed log).
const presetOfSession = (sessionId) => {
  const root = join(DATA, 'dsh', 'sessions')
  for (const dir of existsSync(root) ? readdirSync(root) : []) {
    const file = join(root, dir, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(file)) return JSON.parse(zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n', 1)[0]).agentPreset
  }
  return undefined
}

// The environment for the start script: no real key and no real Claude Code can reach the process.
const env = { ...process.env, CHAT_TO_FIX_DATA: DATA, CHAT_TO_FIX_MOCK_LLM_KEY: 'mock-not-a-key', CHAT_TO_FIX_PASS_ENV: 'CHAT_TO_FIX_MOCK_LLM_KEY' }
for (const name of ['ANTHROPIC_API_KEY', 'CHAT_TO_FIX_HTTP_TOKEN', 'CHAT_TO_FIX_CONFIG', 'CLAUDE_BIN']) delete env[name]
const startEnv = SENTINEL ? { ...env, HOME: join(DATA, 'sentinel-home') } : env

let mock
let started = false
async function cleanup() {
  if (started) {
    try { await run('sh', [join(ROOT, 'scripts/stop-chat-to-fix.sh')], { env }) } catch (error) { console.error(`smoke: stop-chat-to-fix failed: ${error.stderr || error.message}`) }
  }
  if (mock && mock.exitCode === null && mock.signalCode === null) {
    try { process.kill(-mock.pid, 'SIGTERM') } catch {}
    for (let i = 0; i < 25 && mock.exitCode === null && mock.signalCode === null; i += 1) await sleep(200)
    if (mock.exitCode === null && mock.signalCode === null) try { process.kill(-mock.pid, 'SIGKILL') } catch {}
  }
}
process.on('SIGINT', () => { void cleanup().then(() => process.exit(130)) })

let startedAt
let chatToFixGroup
async function main() {
  // 0. Fresh data directory.
  rmSync(DATA, { recursive: true, force: true })
  mkdirSync(DATA, { recursive: true, mode: 0o700 })
  if (SENTINEL) mkdirSync(join(DATA, 'sentinel-home'), { mode: 0o700 })

  // 1. The mock model, in its own process group.
  mock = spawn(process.execPath, [join(ROOT, 'scripts/mock-llm.ts')], {
    env: { PATH: process.env.PATH, MOCK_LOG: join(DATA, 'mock.jsonl'), MOCK_REPLY: REPLY, MOCK_PORT: '0' },
    detached: true, stdio: ['ignore', 'pipe', 'inherit'],
  })
  const mockPort = await new Promise((ok, fail) => {
    let out = ''
    mock.stdout.on('data', (chunk) => { out += chunk; const m = out.match(/listening on 127\.0\.0\.1:(\d+)/); if (m) ok(Number(m[1])) })
    mock.once('exit', (code) => fail(new Error(`the mock exited (${code})`)))
    setTimeout(() => fail(new Error('the mock did not start')), 10_000)
  })
  check('mock model listens on 127.0.0.1', mockPort > 0, `port ${mockPort}`)

  const config = {
    dataDir: join(DATA, 'chat-to-fix'),
    worktreesDir: join(DATA, 'chat-to-fix', 'worktrees'),
    httpPort: 0,
    language: 'zh',
    apiModel: `anthropic/${MODEL}`,
    adapters: { slack: 'fake', jira: 'fake', gitlab: 'fake' },
    bindings: [{ channel: CHANNEL, repo: 'group/project', jiraProject: 'DEMO' }],
  }
  writeFileSync(join(DATA, 'chat-to-fix.json'), JSON.stringify(config, null, 2))
  const overlay = join(DATA, 'smoke.patch.yml')
  writeFileSync(overlay, [
    '# Smoke-run overlay: the anthropic route goes to the local mock model; the key reference is a dummy.',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      anthropic:',
    '        apiKeyEnv: CHAT_TO_FIX_MOCK_LLM_KEY',
    `        baseURL: http://127.0.0.1:${mockPort}`,
    '        models:',
    `          - id: ${MODEL}`,
    '# The Coding bot\'s route runs a stand-in that answers --version and refuses everything else.',
    '- id: chat-to-fix',
    '  config:',
    `    claudeCommand: ${join(ROOT, 'scripts/lib/fake-claude.sh')}`,
    '',
  ].join('\n'))

  // Every outward HTTP(S) request of the process is routed to the mock, which refuses and logs it
  // (DSH installs the proxy from these variables at launch; loopback stays direct).
  for (const target of [env, startEnv]) {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) target[name] = `http://127.0.0.1:${mockPort}`
    for (const name of ['NO_PROXY', 'no_proxy']) target[name] = '127.0.0.1,localhost,::1'
  }

  // 2. Start chat-to-fix.
  writeFileSync(join(DATA, 'home-before.txt'), (await run('sh', [join(ROOT, 'scripts/isolation-snapshot.sh')], { env, maxBuffer: 64 << 20 })).stdout)
  started = true
  startedAt = new Date()
  let startOut
  try {
    startOut = (await run('sh', [join(ROOT, 'scripts/start-chat-to-fix.sh'), '--patch', overlay], { env: startEnv, timeout: 150_000 })).stdout
  } catch (error) {
    check('chat-to-fix starts in the bundled DSH', false, (error.stderr || error.message).trim().split('\n').slice(-6).join(' | '))
    return
  }
  const port = Number(startOut.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1])
  check(`chat-to-fix starts in the bundled DSH (profile chat-to-fix, config/cordis.patch.yml + overlay${SENTINEL ? ', sentinel HOME' : ''})`, port > 0, startOut.trim())
  const token = readFileSync(join(DATA, 'http-token'), 'utf8').trim()
  const api = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'x-chat-to-fix-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    })
    return { status: response.status, body: await response.json() }
  }
  const startLog = readFileSync(join(DATA, 'run', 'chat-to-fix.log'), 'utf8')
  check('every plugin row activated (no startup warning in the log)', !/did not activate|StartupError|plugin tree failed|skipping profile bundle/.test(startLog),
    startLog.split('\n').filter((l) => /did not activate|pending|failed|skipping/.test(l)).slice(0, 6).join(' | '))

  // Sockets and open files of the whole process group.
  const pgid = readFileSync(join(DATA, 'run', 'chat-to-fix.pid'), 'utf8').trim()
  chatToFixGroup = pgid
  const groupPids = async () => (await run('ps', ['-axo', 'pid=,pgid='])).stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter(([, g]) => g === pgid).map(([p]) => p)
  const lsof = async (...args) => (await run('lsof', ['-nP', '-a', '-p', (await groupPids()).join(','), ...args]).catch((e) => ({ stdout: e.stdout ?? '' }))).stdout.trim()
  const listening = (await lsof('-i', '-sTCP:LISTEN')).split('\n').slice(1).filter(Boolean)
  writeFileSync(join(DATA, 'sockets-startup.txt'), (await lsof('-i')) + '\n')
  check('the process group listens only on 127.0.0.1, one port (the control interface)', listening.length === 1 && listening[0].includes(`127.0.0.1:${port} (LISTEN)`), listening.map((l) => l.replace(/\s+/g, ' ')).join(' | '))

  // 3. The control interface.
  const health = await api('GET', '/health')
  check('GET /health', health.status === 200 && health.body.up === true, JSON.stringify(health.body))

  const ts = `${Math.floor(Date.now() / 1000)}.000100`
  const event = { eventId: `smoke-${Date.now()}`, channel: CHANNEL, threadTs: ts, messageTs: ts, text: 'Smoke test: the login page shows a blank screen.', user: { id: 'U-SMOKE' } }
  const posted = await api('POST', '/events', event)
  const taskId = posted.body.taskId
  check('POST /events creates a task', posted.status === 202 && typeof taskId === 'string', JSON.stringify(posted.body))
  if (!taskId) return
  const taskUrl = `/tasks/${encodeURIComponent(taskId)}`

  let task
  try {
    task = await until('the task to reach running with its run', async () => {
      const t = (await api('GET', `${taskUrl}?records=1`)).body
      if (['failed', 'stopped', 'timed_out', 'done'].includes(t.state)) throw new Error(`the task ended: ${t.state} (${t.endReason})`)
      const last = t.runs?.at(-1)
      return t.state === 'running' && last?.groupId && Object.keys(last.bots ?? {}).length === 5 ? t : undefined
    }, 90_000)
  } catch (error) {
    check('the task reaches running', false, `${error.message}; see ${join(DATA, 'run', 'chat-to-fix.log')}`)
    return
  }
  const runEntry = task.runs.at(-1)
  check('the task reaches running', true, `state ${task.state}, step ${task.step}`)
  check('the run has five bots and one group (GET /tasks/:id?records=1)', Object.keys(runEntry.bots).length === 5 && typeof runEntry.groupId === 'string',
    `group ${runEntry.groupId}; ${Object.entries(runEntry.bots).map(([role, id]) => `${role}=${id}`).join(' ')}`)

  const statePath = join(DATA, 'dsh', 'bot', 'state.json')
  const state = readJson(statePath)
  const room = state.rooms?.[runEntry.groupId]
  const botIds = Object.values(runEntry.bots)
  check('the bot layer state file holds the five bots and the group',
    botIds.every((id) => state.bots?.[id] !== undefined) && room !== undefined && botIds.every((id) => room.members?.includes(id)) && room.admin === runEntry.bots.main,
    `${statePath.slice(ROOT.length + 1)}: ${Object.keys(state.bots ?? {}).length} bots (${botIds.map((id) => state.bots?.[id]?.name).join(', ')}), ${Object.keys(state.rooms ?? {}).length} group ("${room?.name}", admin ${state.bots?.[room?.admin]?.name})`)

  // The agent preset of each bot's own session (the bot id is its own session's id).
  const presets = Object.entries(runEntry.bots).map(([role, id]) => [role, presetOfSession(id)])
  check('each API bot\'s own session is on agent preset readonly, the Coding bot\'s on standard (DSH session logs)',
    presets.every(([role, p]) => p === (role === 'coding' ? 'standard' : 'readonly')), presets.map(([role, p]) => `${role}=${p}`).join(' '))

  // The Main bot's model request carrying the task message. The pi-ai route sends no session
  // header, so the request is attributed by its tools: task_advance is a role tool of `main`
  // (src/registry/bots.ts), attached only to sessions of the bot bound to that role.
  let mainCall
  try {
    mainCall = await until('a model request with the task message', () => mockLog().find((e) => String(e.allUserText ?? '').includes(`Task ${taskId}`)), 60_000)
  } catch {
    check('the task message reached the Main bot\'s session (mock model log)', false, `${mockLog().length} model calls, none with "Task ${taskId}"`)
    return
  }
  const withTask = mockLog().filter((e) => String(e.allUserText ?? '').includes(`Task ${taskId}`))
  check('the task message reached the Main bot\'s session (mock model log)', mainCall.toolNames.includes('task_advance'),
    `request #${mainCall.id} of ${mockLog().length}; ${withTask.length} request(s) carry the task message; attributed to Main by its role tool task_advance (no session header on this route)`)
  check('the Main bot\'s session holds its role tools', ['task_records', 'task_advance', 'task_close', 'needs_info_confirm'].every((n) => mainCall.toolNames.includes(n)),
    `${mainCall.toolNames.length} tools: ${mainCall.toolNames.join(', ')}`)
  const forbidden = mainCall.toolNames.filter((n) => WRITE_OR_SHELL.includes(n))
  check('the Main bot\'s session has no DSH write, edit, shell, job, web or plugin tool', forbidden.length === 0 && mainCall.toolNames.includes('read'),
    forbidden.length ? `present: ${forbidden.join(', ')}` : `read, read_image, glob, grep present; ${WRITE_OR_SHELL.join('/')} absent`)

  // The reply in the execution record.
  try {
    const records = await until('the Main bot\'s reply in the execution record', async () => {
      const r = await api('GET', `${taskUrl}?records=1`)
      return (r.body.records ?? []).some((e) => e.role === 'main' && String(e.text ?? '').includes(REPLY)) ? r.body.records : undefined
    }, 60_000)
    const line = records.find((e) => e.role === 'main' && String(e.text ?? '').includes(REPLY))
    check('the Main bot\'s reply appears in the execution record', true, `${records.length} records; ${line.type} by ${line.role}: "${String(line.text).slice(0, 60)}"`)
  } catch (error) {
    const r = await api('GET', `${taskUrl}?records=1`)
    check('the Main bot\'s reply appears in the execution record', false, `${error.message}; records: ${JSON.stringify((r.body.records ?? []).map((e) => [e.type, e.role, String(e.text ?? '').slice(0, 40)])).slice(0, 600)}`)
  }

  const sockets = (await lsof('-i')).split('\n').slice(1).filter(Boolean)
  writeFileSync(join(DATA, 'sockets-running.txt'), sockets.join('\n') + '\n')
  const outward = sockets.filter((l) => !/127\.0\.0\.1|\[::1\]/.test(l))
  check('no socket of the process group leaves 127.0.0.1 (lsof while running)', outward.length === 0, outward.join(' | ') || `${sockets.length} sockets, all loopback`)
  const files = (await lsof('-Fn')).split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1))
  const outside = [...new Set(files.filter((f) => !f.startsWith(ROOT + '/') && !/^\/(dev|usr\/lib|System|private\/var\/db|Library\/Preferences\/Logging)\b/.test(f) && f !== '/' && !f.startsWith(process.env.CHAT_TO_FIX_NODE_BIN ?? dirname(process.execPath))))]
  writeFileSync(join(DATA, 'open-files-running.txt'), [...new Set(files)].join('\n') + '\n')
  check('every file the process group holds open lies in the project (besides node, /dev, system libraries)', outside.length === 0, outside.join(' | ') || `${new Set(files).size} paths`)

  // 4. Stop the task, then the process.
  const stopped = await api('POST', `${taskUrl}/stop`)
  const final = (await api('GET', taskUrl)).body
  const cleaned = readJson(statePath)
  check('POST /tasks/:id/stop stops the task and removes its bots and group', stopped.status === 200 && final.state === 'stopped' && botIds.every((id) => cleaned.bots?.[id] === undefined) && cleaned.rooms?.[runEntry.groupId] === undefined,
    `${JSON.stringify(stopped.body)}; state ${final.state} (${final.endReason}); bots left ${Object.keys(cleaned.bots ?? {}).length}, groups left ${Object.keys(cleaned.rooms ?? {}).length}`)
  check('the Claude Code stand-in was never run for a turn (no real model call possible)', !existsSync(join(DATA, 'tmp', 'fake-claude.log')),
    existsSync(join(DATA, 'tmp', 'fake-claude.log')) ? readFileSync(join(DATA, 'tmp', 'fake-claude.log'), 'utf8').trim() : 'only --version was asked, if anything')
  const calls = mockLog()
  const proxied = calls.filter((e) => e.proxyRequest || e.proxyConnect)
  check('every model request went to the mock', calls.filter((e) => !e.proxyRequest && !e.proxyConnect).every((e) => e.model === MODEL && !e.unexpected), `${calls.length - proxied.length} requests, all /v1/messages for ${MODEL}`)
  check('no outward HTTP(S) request was attempted (proxy log)', proxied.length === 0, proxied.map((e) => e.proxyRequest ?? `CONNECT ${e.proxyConnect}`).join(' | ') || 'none')
}

try {
  await main()
} catch (error) {
  check('smoke run completed without an unexpected error', false, error.stack?.split('\n').slice(0, 3).join(' | ') ?? String(error))
} finally {
  await cleanup()
  const pidFile = join(DATA, 'run', 'chat-to-fix.pid')
  const members = (await run('ps', ['-axo', 'pid=,pgid='])).stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter(([, g]) => chatToFixGroup !== undefined && g === chatToFixGroup)
  check('stop-chat-to-fix.sh stopped the process (pid file gone, process group empty)', !existsSync(pidFile) && members.length === 0, `process group ${chatToFixGroup ?? '-'}: ${members.length} processes left`)
  check('the mock model is stopped', mock === undefined || mock.exitCode !== null || mock.signalCode !== null)
  if (existsSync(join(DATA, 'home-before.txt'))) {
    const { stdout } = await run('sh', [join(ROOT, 'scripts/isolation-snapshot.sh')], { env, maxBuffer: 64 << 20 })
    writeFileSync(join(DATA, 'home-after.txt'), stdout)
    const before = new Set(readFileSync(join(DATA, 'home-before.txt'), 'utf8').split('\n'))
    const after = new Set(stdout.split('\n'))
    const changed = [...new Set([...before].filter((l) => !after.has(l)).concat([...after].filter((l) => !before.has(l))).map((l) => l.replace(/^\S+ /, '')))].sort()
    writeFileSync(join(DATA, 'home-diff.txt'), changed.join('\n') + '\n')
    const dshChanged = changed.filter((p) => DSH_PLACES.some((place) => p === place || p.startsWith(place + '/')))
    check('no DSH or DS Bot place in the real home changed (~/.dsh, ~/.agents, ~/.config, ~/.cache, ~/.local, ~/Documents/mywork/ds-bot, ...)', dshChanged.length === 0, dshChanged.join(', ') || 'unchanged')
    console.log(`INFO  other changes in the real-home snapshot during the run window (any program on this machine): ${changed.filter((p) => !dshChanged.includes(p)).join(', ') || 'none'}`)
    if (startedAt) {
      const npmLogs = changed.filter((p) => p.startsWith(join(HOME, '.npm/_logs/')))
      if (npmLogs.length) console.log(`INFO  new npm debug logs (chat-to-fix started ${startedAt.toISOString()}): ${npmLogs.map((p) => p.slice(join(HOME, '.npm/_logs/').length)).join(', ')}`)
    }
  }
  if (SENTINEL) {
    const written = filesUnder(join(DATA, 'sentinel-home'))
    const known = written.filter((f) => f.startsWith('.npm/_logs/'))
    check('under the sentinel HOME the process wrote nothing but the known npm debug log', written.length === known.length,
      written.length ? `written: ${written.join(', ')}` : 'nothing written')
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\nsmoke: ${results.length - failed.length} passed, ${failed.length} failed; data in ${DATA}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}
