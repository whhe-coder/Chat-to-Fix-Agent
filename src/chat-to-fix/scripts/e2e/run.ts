// One-pass end-to-end regression suite for REAL runs (real models, fake Slack / Jira / GitLab).
//
//   . scripts/dev-env.sh && node scripts/e2e/run.ts [--cases a,b] [--dir <folder outside the project>] [--prepare-only]
//        [--timeout-minutes 20] [--port 3090] [--api-model anthropic/claude-sonnet-5-5]
//        [--coding-model anthropic/claude-sonnet-5-5] [--keychain-service chat-to-fix-anthropic] [--poll-seconds 3]
//
// Each case is a bug report in a bound Slack channel against a small throwaway front-end repository; it is
// expected to go through all eight steps in one run (no needs_info, no rerun). The runner
//  1. prepares ONE run folder (default ~/chat-to-fix-runs/e2e-<timestamp>) with all case repositories and ONE
//     chat-to-fix.json with one binding per case (a folder that already holds a prepared run is used as it is);
//  2. with --prepare-only stops here and prints the commands: nothing is started, no model is called;
//  3. otherwise starts the system (scripts/start-chat-to-fix.sh with the overlay; ANTHROPIC_API_KEY comes from the
//     environment or, only when the environment lacks it, from the keychain item chat-to-fix-anthropic into the
//     child's environment; it is never printed or written), injects the cases one at a time, waits for each task
//     to end (per-case time limit: the task is stopped), runs the checks (scripts/e2e/checks.ts), stops the system
//     at the end (also on Ctrl-C or failure) and writes report.json and report.md into the folder.
// The default set is the UI cases; the optional ones (missing-key, button-state, discount) are run by name.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { updateJson } from '../../core/adapters/fake/files.ts'
import { threadFile } from '../../core/adapters/slack.ts'
import { DEFAULT_KEYCHAIN_SERVICE, keychainHas } from '../first-run.ts'
import { sendFakeEvent, sendFakeSlash } from '../fake-event.ts'
import { ALL_CASE_IDS, DEFAULT_CASE_IDS, loadCase } from './cases.ts'
import { runChecks, summarize } from './checks.ts'
import { loadManifest, prepareE2e, ROOT } from './prepare.ts'
import { collectEvidence, inspectWorkspace } from './workspace.ts'
import { fmtTokens, fmtTps, fmtUsd, mergeUsage, TPS_BASIS_LABEL } from '../../core/task/usage.ts'

const exec = promisify(execFile)
export const END_STATES = ['done', 'failed', 'stopped', 'timed_out', 'needs_info', 'expired']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback } }

/** The fake service files the checks read: { issues, mrs, replies }. */
export function readFake(dataDir: string) {
  const root = join(dataDir, 'fake')
  let replies = []
  try { replies = readFileSync(join(root, 'slack', 'replies.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)) } catch { /* none yet */ }
  return { issues: readJson(join(root, 'jira', 'issues.json'), {}), mrs: readJson(join(root, 'gitlab', 'mrs.json'), {}), replies }
}

/** Runs the checks for one finished task. Returns { id, pass, checks, summary, error? }. */
export function evaluateCase({ caseDef, task, dataDir, manifestCase }: { caseDef: any, task: any, dataDir: string, manifestCase?: any }) {
  const records = task?.records ?? []
  let ws
  let evidence
  let error
  try {
    if (task?.repo?.dir !== undefined && task?.repo?.base !== undefined && existsSync(task.repo.dir)) {
      ws = inspectWorkspace({ worktreeDir: task.repo.dir, base: task.repo.base, remote: task.binding?.remote ?? manifestCase?.remote, localRepo: task.binding?.localRepo ?? manifestCase?.localRepo, defaultBranch: task.binding?.defaultBranch ?? manifestCase?.defaultBranch })
      evidence = collectEvidence({ caseDef, ws })
    }
  } catch (e) { error = `could not inspect the worktree: ${e.message}` }
  const ctx = { caseDef, task, records, fake: readFake(dataDir), ws, evidence }
  try {
    const checks = runChecks(ctx)
    return { id: caseDef.id, title: caseDef.title, pass: checks.every((c) => c.ok), checks, summary: summarize(ctx), ...(error ? { error } : {}) }
  } finally {
    ws?.cleanup()
  }
}

/**
 * The Slack thread of a case: earlier messages are written to the discussion file, the trigger is posted as the event.
 * A command case (inputMode 'command') is posted as the /fix slash command instead: the server opens the discussion
 * itself (task.origin.threadTs is its opening message); the result has the { status, body } shape either way.
 */
export async function injectCase({ caseDef, manifestCase, dataDir, url, token, fetchImpl = globalThis.fetch }) {
  if (caseDef.inputMode === 'command') {
    const slash: any = await sendFakeSlash({ channel: manifestCase.channel, text: caseDef.message, url, token, user: caseDef.user, fetchImpl })
    // empty text or a DM never reach /events: report it as a rejected event
    return slash.ok ? { status: slash.status, body: slash.body } : { status: 400, body: { error: slash.reason, ephemeral: slash.ephemeral } }
  }
  const sec = Math.floor(Date.now() / 1000)
  let threadTs
  for (const [i, message] of (caseDef.thread ?? []).entries()) {
    const ts = `${sec - 60 + i}.${String(i + 1).padStart(6, '0')}`
    threadTs ??= ts
    await updateJson(threadFile(dataDir, manifestCase.channel, threadTs), [], (messages) => ({ value: [...messages, { ts, user: message.user, at: new Date().toISOString(), text: message.text, files: [] }], result: undefined }))
  }
  return sendFakeEvent({ channel: manifestCase.channel, text: caseDef.message, threadTs, dataDir, url, token, user: caseDef.user, fetchImpl })
}

async function api(conn, path, method = 'GET', fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${conn.url}${path}`, { method, headers: { 'x-chat-to-fix-token': conn.token } })
  let body
  try { body = await response.json() } catch { body = {} }
  return { status: response.status, body }
}

/**
 * Starts the system, runs the cases one at a time, always stops the system. `system` = { start(), stop() };
 * `conn()` returns { url, token } (called after start). Returns the report object (also written to the folder).
 */
export async function runSuite({ dir, manifest, caseIds, caseTimeoutMs = 20 * 60_000, pollMs = 3000, conn, system, log = (line) => console.log(line), fetchImpl = globalThis.fetch, shouldStop = () => false, casesDir }: any) {
  const startedAt = new Date().toISOString()
  const results = []
  const report: any = { dir, startedAt, finishedAt: undefined, interrupted: false, caseTimeoutMinutes: caseTimeoutMs / 60_000, results }
  const save = () => writeReport(dir, report)
  const finish = () => {
    report.finishedAt = new Date().toISOString()
    report.passed = results.filter((r) => r.pass).length
    report.total = results.length
    report.usage = mergeUsage(results.map((r) => r.summary?.usage))
    save()
  }
  try {
    log('starting the system ...')
    await system.start()
    const c = conn()
    for (const id of caseIds) {
      if (shouldStop()) { report.interrupted = true; break }
      const manifestCase = manifest.cases.find((m) => m.id === id)
      const caseDef = loadCase(id, casesDir)
      const result: any = { id, title: caseDef.title, pass: false, checks: [], summary: {} }
      results.push(result)
      const t0 = Date.now()
      try {
        log(`[${id}] injecting the report into ${manifestCase.channel}`)
        const injected = await injectCase({ caseDef, manifestCase, dataDir: manifest.dataDir, url: c.url, token: c.token, fetchImpl })
        const taskId = injected.body?.taskId
        if (injected.status >= 300 || typeof taskId !== 'string') throw new Error(`the event was not accepted: ${injected.status} ${JSON.stringify(injected.body)}`)
        result.taskId = taskId
        log(`[${id}] task ${taskId} queued; waiting (limit ${Math.round(caseTimeoutMs / 60_000)} min)`)
        let task
        let timedOut = false
        // A follow-up case: the first needs_info is answered once (an @ in the task's discussion) and the wait goes on;
        // a second needs_info (after the task left the first one) ends the wait.
        let followUp: { runs: number, left: boolean } | undefined
        for (;;) {
          task = (await api(c, `/tasks/${encodeURIComponent(taskId)}`, 'GET', fetchImpl)).body
          if (followUp !== undefined && (task?.state !== 'needs_info' || (task?.runs?.length ?? 0) > followUp.runs)) followUp.left = true
          if (task?.state === 'needs_info' && caseDef.followUp !== undefined && followUp === undefined) {
            const { channel, threadTs } = task.origin ?? {}
            if (typeof channel !== 'string' || typeof threadTs !== 'string') throw new Error(`the task has no discussion to answer in (origin: ${JSON.stringify(task.origin ?? null)})`)
            followUp = { runs: task.runs?.length ?? 0, left: false }
            log(`[${id}] needs_info: sending the follow-up into ${channel} ${threadTs}`)
            const sent = await sendFakeEvent({ channel, threadTs, text: caseDef.followUp.text, dataDir: manifest.dataDir, url: c.url, token: c.token, user: caseDef.user, fetchImpl })
            if (sent.status >= 300) { log(`[${id}] the follow-up was not accepted: ${sent.status} ${JSON.stringify(sent.body)}`); break }
          } else if (END_STATES.includes(task?.state) && !(task?.state === 'needs_info' && followUp !== undefined && !followUp.left)) {
            // the end of the run can show up a moment after the state (real run of ci-changeset, 2026-11-12): wait a little for it
            for (let i = 0; i < 10 && task?.runs?.at?.(-1)?.endedAt == null; i += 1) { await sleep(Math.min(pollMs, 1000)); task = (await api(c, `/tasks/${encodeURIComponent(taskId)}`, 'GET', fetchImpl)).body }
            break
          }
          if (shouldStop()) { await api(c, `/tasks/${encodeURIComponent(taskId)}/stop`, 'POST', fetchImpl); report.interrupted = true }
          else if (Date.now() - t0 > caseTimeoutMs && !timedOut) { timedOut = true; log(`[${id}] time limit reached: stopping ${taskId}`); await api(c, `/tasks/${encodeURIComponent(taskId)}/stop`, 'POST', fetchImpl) }
          else if (Date.now() - t0 > caseTimeoutMs + 60_000) break
          await sleep(pollMs)
        }
        task = (await api(c, `/tasks/${encodeURIComponent(taskId)}?records=1`, 'GET', fetchImpl)).body
        Object.assign(result, evaluateCase({ caseDef, task, dataDir: manifest.dataDir, manifestCase }), { timedOut, taskId })
        log(`[${id}] ${task.state}${task.endReason ? ` (${task.endReason})` : ''}: ${result.pass ? 'PASS' : 'FAIL'}${result.pass ? '' : ' - ' + result.checks.filter((k) => !k.ok).map((k) => k.id).join(', ')}`)
      } catch (error) {
        result.error = error.message
        result.checks = [{ id: 'runner', title: '用例执行', ok: false, detail: error.message }]
        log(`[${id}] ERROR: ${error.message}`)
      }
      result.wallSec = Math.round((Date.now() - t0) / 1000)
      save()
    }
    // The cases are over: the report is final now. Stopping the system comes after and can be slow (or the
    // process can be killed during it); the report must not keep saying "not finished" for that.
    finish()
  } catch (error) {
    report.error = error.message
    log(`the suite failed: ${error.message}`)
  } finally {
    try { await system.stop() } catch (error) { report.stopError = error.message; log(`could not stop the system: ${error.message}`) }
    finish()
  }
  return report
}

const mark = (ok) => (ok ? '[x]' : '[ ]')

// ---- token billing in the report (task.usage, core/task/usage.ts)
const costCell = (usage) => (usage && usage.calls > 0 ? `${fmtUsd(usage.totalUsd)}${usage.unpriced ? '（含未定价）' : ''}` : '-')
const tokenText = (b) => `输入 ${fmtTokens(b.input)} / 输出 ${fmtTokens(b.output)} / 缓存读 ${fmtTokens(b.cacheRead)} / 缓存写 ${fmtTokens(b.cacheWrite)}`
// 速度的来源：DSH 自己的算法（五个 bot）；2026-11-13 前的旧报告里修复 bot 的速度由 CLI 结果推算
const basisText = (b) => (b.last?.tpsBasis === undefined || b.last?.tpsBasis === null ? '' : TPS_BASIS_LABEL[b.last.tpsBasis] ?? b.last.tpsBasis)
const usageHeader = (report) => {
  const u = report.usage
  if (!u || !(u.calls > 0)) return []
  return [`- 花费：${fmtUsd(u.totalUsd)}${u.unpriced ? '（含未定价的调用，未计入）' : ''}　${tokenText(u)}　${u.calls} 次调用`, `- 平均输出速度：${fmtTps(u.outputTps)}（总输出 token ÷ 总计时用时；五个 bot 的速度都取自 DSH 的 sessionStats，来源见各用例的“花费”表）`]
}
const usageSection = (u) => {
  if (!u || !(u.calls > 0)) return []
  const rows = Object.entries<any>(u.byRole ?? {}).map(([role, b]) => `| ${role} | ${b.models.join(', ')}${b.last?.effort ? `（effort ${b.last.effort}）` : ''} | ${fmtUsd(b.usd)}${b.unpriced ? '（含未定价）' : ''} | ${tokenText(b)} | ${b.calls} | ${fmtTps(b.outputTps)} | ${basisText(b) || '-'} |`)
  return [
    '', '### 花费', '',
    `合计 ${fmtUsd(u.totalUsd)}${u.unpriced ? '（含未定价的调用，未计入）' : ''}；${tokenText(u)}；平均输出速度 ${fmtTps(u.outputTps)}。`, '',
    '| bot | 模型 | 花费 | token | 调用数 | 输出速度 | 速度来源 |', '|---|---|---|---|---|---|---|',
    ...rows,
  ]
}
const fence = (s) => '```\n' + String(s ?? '').replace(/```/g, "'''") + '\n```'

/** report.md (Chinese headings). */
export function renderReport(report) {
  const lines = [
    '# Chat-to-Fix 端到端回归报告', '',
    `- 运行目录：${report.dir}`,
    `- 开始：${report.startedAt}　结束：${report.finishedAt ?? '（进行中，用例还没跑完）'}`,
    `- 结果：${report.passed ?? report.results.filter((r) => r.pass).length} / ${report.total ?? report.results.length} 个用例通过${report.interrupted ? '（被中断）' : ''}`,
    `- 单用例时间上限：${report.caseTimeoutMinutes} 分钟`,
    ...usageHeader(report),
    ...(report.error ? [`- 套件错误：${report.error}`] : []),
    ...(report.stopError ? [`- 停止系统时出错：${report.stopError}`] : []),
    '', '## 总表', '',
    '| 用例 | 结果 | 任务 | 状态 | 耗时(秒) | 评审轮数 | 记录数 | 拒绝 | 工具错误 | 花费 | 输出速度 |', '|---|---|---|---|---|---|---|---|---|---|---|',
    ...report.results.map((r) => `| ${r.id} | ${r.pass ? '通过' : '失败'} | ${r.taskId ?? '-'} | ${r.summary?.state ?? '-'}${r.summary?.endReason ? ` (${r.summary.endReason})` : ''}${r.timedOut ? ' 超时' : ''} | ${r.summary?.durationSec ?? r.wallSec ?? '-'} | ${r.summary?.reviewRounds ?? '-'} | ${r.summary?.records ?? '-'} | ${r.summary?.refusals ?? '-'} | ${r.summary?.toolErrors ?? '-'} | ${costCell(r.summary?.usage)} | ${fmtTps(r.summary?.usage?.outputTps)} |`),
    ...(report.usage?.calls > 0 ? [`| 合计 | | | | | | | | | ${costCell(report.usage)} | ${fmtTps(report.usage.outputTps)} |`] : []),
  ]
  for (const r of report.results) {
    lines.push('', `## ${r.id}：${r.title} — ${r.pass ? '通过' : '失败'}`, '', '### 检查项', '')
    for (const c of r.checks) lines.push(`- ${mark(c.ok)} ${c.title}${c.detail ? ` — ${String(c.detail).replace(/\n/g, ' ')}` : ''}`)
    if (r.error) lines.push('', `执行错误：${r.error}`)
    lines.push(...usageSection(r.summary?.usage))
    const t = r.summary?.texts
    if (t) {
      lines.push('', '### 最终文本', '', '**Slack 回复**', '')
      if (t.slack?.length) for (const s of t.slack) lines.push(`- ${s.purpose}：${String(s.text).replace(/\n/g, ' ')}`)
      else lines.push('- (无)')
      lines.push('', '**Jira**', '')
      lines.push(t.jira ? fence(`${t.jira.key}（${t.jira.status}）${t.jira.title}\n\n${t.jira.description}\n\n验收：${t.jira.acceptance}\n\n评论：\n${(t.jira.comments ?? []).join('\n---\n')}`) : '(无)')
      lines.push('', '**MR**', '')
      lines.push(t.mr ? fence(`${t.mr.url}（draft=${t.mr.draft}, ${t.mr.state}）\n${t.mr.title}\n\n${t.mr.description}`) : '(无)')
      if (t.commit?.length) lines.push('', `提交信息：${t.commit.join(' / ')}`)
    }
  }
  return lines.join('\n') + '\n'
}

export function writeReport(dir, report) {
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(join(dir, 'report.md'), renderReport(report))
}

/** The real system: start/stop scripts of the project. The key is passed in the child's environment only. */
export function createSystem({ dir, env = process.env, keyFromKeychain, log = (line) => console.log(line), execImpl = exec }: any) {
  const childEnv = () => ({ ...env, CHAT_TO_FIX_DATA: dir, CHAT_TO_FIX_START_TIMEOUT: '120', ...(env.ANTHROPIC_API_KEY ? {} : keyFromKeychain ? { ANTHROPIC_API_KEY: keyFromKeychain() } : {}) })
  return {
    async start() {
      const { stdout } = await execImpl('sh', [join(ROOT, 'scripts', 'start-chat-to-fix.sh')], { cwd: ROOT, env: childEnv(), timeout: 240_000 })
      log(stdout.trim())
    },
    async stop() {
      const { stdout } = await execImpl('sh', [join(ROOT, 'scripts', 'stop-chat-to-fix.sh')], { cwd: ROOT, env: { ...env, CHAT_TO_FIX_DATA: dir }, timeout: 60_000 })
      log(stdout.trim())
    },
  }
}

export function parseArgs(argv) {
  const values = { '--dir': 'dir', '--cases': 'cases', '--timeout-minutes': 'timeoutMinutes', '--port': 'port', '--api-model': 'apiModel', '--coding-model': 'codingModel', '--keychain-service': 'keychainService', '--poll-seconds': 'pollSeconds' }
  const o: any = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--prepare-only') o.prepareOnly = true
    else if (values[arg] !== undefined) { if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`); o[values[arg]] = argv[++i] }
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (o.cases !== undefined) {
    o.cases = o.cases.split(',').map((s) => s.trim()).filter(Boolean)
    const unknown = o.cases.filter((c) => !ALL_CASE_IDS.includes(c))
    if (unknown.length > 0 || o.cases.length === 0) throw new Error(`unknown case(s): ${unknown.join(', ') || '(none given)'}; known: ${ALL_CASE_IDS.join(', ')}`)
  }
  for (const key of ['port', 'timeoutMinutes', 'pollSeconds']) if (o[key] !== undefined) o[key] = Number(o[key])
  if (o.port !== undefined && !(Number.isInteger(o.port) && o.port >= 0 && o.port < 65536)) throw new Error('--port must be an integer from 0 to 65535')
  if (o.timeoutMinutes !== undefined && !(o.timeoutMinutes > 0)) throw new Error('--timeout-minutes must be a positive number')
  return o
}

export { DEFAULT_CASE_IDS }

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const existing = o.dir === undefined ? undefined : loadManifest(o.dir)
  let dir
  let manifest
  let blockers = []
  if (existing !== undefined) {
    dir = resolve(o.dir)
    manifest = existing
    console.log(`Using the prepared folder ${dir}`)
    const env = process.env
    const user = env.USER ?? userInfo().username
    if (!(typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY !== '') && !keychainHas(manifest.keychainService ?? DEFAULT_KEYCHAIN_SERVICE, user)) blockers.push(`ANTHROPIC_API_KEY is not set and the keychain has no item "${manifest.keychainService ?? DEFAULT_KEYCHAIN_SERVICE}" for ${user}`)
    if (typeof manifest.codingModel !== 'string' || manifest.codingModel.startsWith('claude-code/')) blockers.push('this folder was prepared for the removed Claude Code route; prepare a new folder')
  } else {
    const prepared = await prepareE2e({ dir: o.dir, cases: o.cases, port: o.port, apiModel: o.apiModel, codingModel: o.codingModel, keychainService: o.keychainService })
    dir = prepared.dir
    manifest = prepared.manifest
    blockers = prepared.blockers
    console.log(`Prepared the e2e run in ${dir}`)
    for (const c of manifest.cases) console.log(`  ${c.id.padEnd(16)} channel ${c.channel}  jira ${c.jiraProject}  repo ${c.localRepo}`)
    console.log(`  configuration     ${prepared.configPath}`)
    console.log(`  models            ${manifest.apiModel} (four flow bots), ${manifest.codingModel} (Coding bot and its reviewer)`)
    console.log(`  Anthropic key     ${prepared.keySource === 'env' ? 'set in the environment' : prepared.keySource === 'keychain' ? 'found in the keychain (read only when the suite starts the system)' : 'NOT AVAILABLE'}`)
    for (const w of prepared.warnings) console.log(`WARNING: ${w}`)
  }
  for (const b of blockers) console.log(`BLOCKED: ${b}`)
  const caseIds = (o.cases ?? manifest.cases.map((c) => c.id)).filter((id) => manifest.cases.some((c) => c.id === id))
  if (o.cases !== undefined && caseIds.length !== o.cases.length) throw new Error(`the prepared folder does not hold: ${o.cases.filter((c) => !caseIds.includes(c)).join(', ')}`)

  if (o.prepareOnly) {
    console.log('\nNothing was started and no model was called. Commands (also in ' + join(dir, 'commands.txt') + '):\n')
    console.log(readFileSync(join(dir, 'commands.txt'), 'utf8'))
    if (blockers.length > 0) process.exitCode = 1
    return
  }
  if (blockers.length > 0) { process.exitCode = 1; return }

  const user = process.env.USER ?? userInfo().username
  const service = manifest.keychainService ?? DEFAULT_KEYCHAIN_SERVICE
  const system = createSystem({ dir, keyFromKeychain: () => execFileSync('security', ['find-generic-password', '-a', user, '-s', service, '-w'], { encoding: 'utf8' }).trim() })
  let interrupted = false
  process.once('SIGINT', () => { interrupted = true; console.log('\nCtrl-C: stopping the running task and the system ...') })
  process.once('SIGTERM', () => { interrupted = true })
  const report = await runSuite({
    dir, manifest, caseIds, system,
    caseTimeoutMs: (o.timeoutMinutes ?? 20) * 60_000, pollMs: (o.pollSeconds ?? 3) * 1000,
    conn: () => ({ url: `http://127.0.0.1:${manifest.port}`, token: readFileSync(join(dir, 'http-token'), 'utf8').trim() }),
    shouldStop: () => interrupted,
  })
  console.log(`\n${report.passed} / ${report.total} passed. Report: ${join(dir, 'report.md')}`)
  if (report.passed !== report.total || report.interrupted || report.error) process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`e2e failed: ${error.message}`)
    process.exitCode = 1
  })
}
