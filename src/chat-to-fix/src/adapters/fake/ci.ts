// The simulated CI of the fake GitLab (spec 7, 4.5 "fake implementation"; test decisions in section 5).
//
// After every push of a task branch (openDraftMR, pushFix) the fake merge-request half calls
// `onPush`: a pipeline is recorded in <dataDir>/fake/gitlab/pipelines.json for the pushed commit,
// and every job of the binding's `ciJobs` runs its `command` (`sh -c`) in a temporary checkout of
// exactly that commit; the output is the job's log. Binding keys (spec 7, 4.9):
//   ciJobs: [{ name, command, delaySeconds?, allowFailure?, flaky?, downstream?, timeoutSeconds? }]
//     delaySeconds   the job stays "running" at least this long
//     allowFailure   a failure of this job does not count
//     flaky          the first attempt fails without running the command; a retry runs it for real
//     downstream     true or a name: the job belongs to a downstream pipeline (own project id) that a
//                    trigger job of the main pipeline starts; jobs with the same name share one pipeline
//   ciNone: true     a push produces no pipeline at all ("CI was not triggered")
// Without ciJobs (and without ciNone) a push produces a pipeline with no job, which passes at once.
//
// The functions getChecks, getJobLog and retryJobs have the shapes of the real adapter
// (src/adapters/gitlab-http.ts; documented in src/task/contracts.ts, CiRepoAdapter).
//
// Jobs run in the background of this process. A job that was left "running" by a process that has
// since died (nothing in memory runs it) is reported as failed, so the monitor never waits for it.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AdapterError } from '../errors.ts'
import { createGit } from '../git.ts'
import { cleanJobLog } from '../gitlab-http.ts'
import { fakeRoot, readJson, updateJson } from './files.ts'

const LOG_KEEP_CHARS = 1_000_000
const DEFAULT_JOB_TIMEOUT_SECONDS = 120
const DEFAULT_LOG_CHARS = 12000
const isText = (v) => typeof v === 'string' && v.trim() !== ''
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Jobs a process is running right now: key -> promise. Module level, so two adapters on one data dir agree. */
const live = new Map<string, Promise<void>>()

export const pipelinesFile = (dataDir) => join(fakeRoot(dataDir), 'gitlab', 'pipelines.json')

/** Runs one shell command; resolves with { code, output } (output: stdout and stderr in arrival order, the tail kept). */
function runCommand(command, { cwd, env, timeoutMs }) {
  return new Promise<{ code: number | null, output: string, timedOut: boolean }>((resolve) => {
    const chunks: string[] = []
    let size = 0
    const keep = (data) => {
      const text = data.toString('utf8')
      chunks.push(text)
      size += text.length
      while (size > LOG_KEEP_CHARS && chunks.length > 1) size -= chunks.shift()!.length
    }
    let timedOut = false
    let child
    try {
      child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: 127, output: `could not start: ${error.message}\n`, timedOut: false })
      return
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: 127, output: `${chunks.join('')}could not run: ${error.message}\n`, timedOut }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: chunks.join(''), timedOut }) })
  })
}

/** The environment a simulated job sees: the process environment without our own credentials, plus CI variables. */
function jobEnv(repo, branch, sha) {
  const env: any = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('CHAT_TO_FIX_') && value !== undefined) env[key] = value
  return Object.assign(env, { CI: 'true', CI_COMMIT_SHA: sha, CI_COMMIT_REF_NAME: branch, CI_PROJECT_PATH: repo })
}

/**
 * @param {object} config  needs `dataDir`, `worktreesDir`, `commitAuthor`.
 * @param {{ findMr: (binding: object, iid: number | string) => Promise<{ repo: string, branch: string, headSha: string, url: string } | undefined> }} deps
 *   `findMr` looks up the fake merge request by its iid (the MR record belongs to ../../repo.ts).
 */
export function createFakeCi(config, { findMr }) {
  const file = pipelinesFile(config.dataDir)
  const git = createGit({ worktreesDir: config.worktreesDir, commitAuthor: config.commitAuthor })
  const empty = () => ({ nextPipelineId: 1, nextJobId: 1, pipelines: [] as any[] })
  const keyOf = (jobId) => `${file}#${jobId}`
  const pipelineUrl = (p) => `fake://gitlab/${p.repo}/-/pipelines/${p.id}`
  const jobUrl = (p, j) => `fake://gitlab/${p.repo}/-/jobs/${j.id}`

  /** Finishes a job in the file (the runner's last step). */
  const finish = (jobId, ok, log) => updateJson(file, empty(), (db: any) => {
    for (const p of db.pipelines) {
      const job = p.jobs.find((j) => j.id === jobId)
      if (job === undefined) continue
      job.status = ok ? 'success' : 'failed'
      job.log = log
      job.finishedAt = new Date().toISOString()
      return { value: db, result: undefined }
    }
    return { value: undefined, result: undefined }
  })

  /** Runs one recorded job in the background: checkout, command, wait out the delay, record the result. */
  function startJob(pipeline, job) {
    const run = (async () => {
      const started = Date.now()
      let ok
      let log
      if (job.simulateFailure) {
        ok = false
        log = `$ ${job.command ?? job.name}\nSimulated flaky failure of the first attempt (a retry runs the command).\nERROR: Job failed: simulated failure\n`
      } else if (!isText(job.command)) {
        ok = true
        log = 'No command: the job does nothing.\nJob succeeded\n'
      } else {
        const work = join(fakeRoot(config.dataDir), 'gitlab', 'ci-work')
        let dir
        try {
          await mkdir(work, { recursive: true })
          dir = await mkdtemp(join(work, `p${pipeline.id}-j${job.id}-`))
          const target = join(dir, 'checkout')
          await git.checkoutCommit(pipeline.source, pipeline.sha, target)
          const result = await runCommand(job.command, { cwd: target, env: jobEnv(pipeline.repo, pipeline.branch, pipeline.sha), timeoutMs: (Number(job.timeoutSeconds) > 0 ? Number(job.timeoutSeconds) : DEFAULT_JOB_TIMEOUT_SECONDS) * 1000 })
          ok = result.code === 0 && !result.timedOut
          log = `$ ${job.command}\n${result.output}${result.output.endsWith('\n') || result.output === '' ? '' : '\n'}${result.timedOut ? 'ERROR: Job failed: execution took longer than the timeout\n' : ok ? 'Job succeeded\n' : `ERROR: Job failed: exit code ${result.code}\n`}`
        } catch (error) {
          ok = false
          log = `$ ${job.command}\nERROR: the simulated CI could not check out ${pipeline.sha}: ${error.message}\n`
        } finally {
          if (dir !== undefined) await rm(dir, { recursive: true, force: true })
        }
      }
      const left = job.delayMs - (Date.now() - started)
      if (left > 0) await sleepFor(left)
      await finish(job.id, ok, log)
    })().catch(() => { /* a failed write leaves the job running: reported as failed once this process no longer runs it */ })
    const key = keyOf(job.id)
    const tracked = run.finally(() => { live.delete(key) })
    live.set(key, tracked)
  }

  const newJob = (db, spec, index, extra: any = {}) => ({
    id: db.nextJobId++,
    name: isText(spec?.name) ? spec.name : `job-${index + 1}`,
    command: isText(spec?.command) ? spec.command : undefined,
    allowFailure: spec?.allowFailure === true,
    flaky: spec?.flaky === true,
    delayMs: Math.max(0, Math.round((Number(spec?.delaySeconds) || 0) * 1000)),
    timeoutSeconds: spec?.timeoutSeconds,
    simulateFailure: spec?.flaky === true,
    status: 'running',
    log: '',
    startedAt: new Date().toISOString(),
    retried: false,
    ...extra,
  })

  /**
   * Records the pipeline for a pushed commit and starts its jobs. `source` is a local repository (or
   * code directory) that has the commit. Nothing happens for `ciNone` or when the commit already has one.
   * Returns { pipelineId } or undefined.
   */
  async function onPush(binding, { branch, sha, source }: { branch: string, sha: string, source: string }) {
    if (binding?.ciNone === true) return undefined
    const repo = binding?.repo ?? 'unknown/unknown'
    const specs = Array.isArray(binding?.ciJobs) ? binding.ciJobs : []
    const started: Array<[any, any]> = []
    const result = await updateJson(file, empty(), (db: any) => {
      if (db.pipelines.some((p) => p.repo === repo && p.sha === sha && p.parentId === undefined)) return { value: undefined, result: undefined }
      const projectId = Number(binding?.projectId) > 0 ? Number(binding.projectId) : 1
      const base = { repo, sha, branch, source, createdAt: new Date().toISOString(), source_event: 'merge_request_event' }
      const main = { id: db.nextPipelineId++, projectId, ...base, jobs: [] as any[] }
      const children = new Map<string, any>()
      specs.forEach((spec, index) => {
        if (spec?.downstream === undefined || spec.downstream === false) { main.jobs.push(newJob(db, spec, index)); return }
        const group = spec.downstream === true ? 'downstream' : String(spec.downstream)
        let child = children.get(group)
        if (child === undefined) {
          child = { id: db.nextPipelineId++, projectId: projectId + 1000 + children.size, ...base, parentId: main.id, group, jobs: [] as any[] }
          children.set(group, child)
        }
        child.jobs.push(newJob(db, spec, index))
      })
      db.pipelines.push(main)
      for (const child of children.values()) {
        db.pipelines.push(child)
        // The trigger job of the main pipeline; its status follows the downstream pipeline.
        main.jobs.push({ id: db.nextJobId++, name: child.group, bridge: true, downstreamPipelineId: child.id, allowFailure: false, status: 'running', log: '', retried: false })
      }
      for (const p of [main, ...children.values()]) for (const job of p.jobs) if (!job.bridge) { live.set(keyOf(job.id), Promise.resolve()); started.push([p, job]) }
      return { value: db, result: { pipelineId: main.id } }
    })
    for (const [p, job] of started) startJob(p, job)
    return result
  }

  /** What a job is now: a recorded "running" job nobody runs any more counts as failed. */
  const effective = (job) => (job.status === 'running' && !live.has(keyOf(job.id)) ? 'failed' : job.status)

  /** { pending, failed: [jobs] } of one pipeline and everything it triggers. */
  function evaluate(db, pipeline, depth = 0) {
    let pending = false
    const failed: any[] = []
    for (const job of pipeline.jobs.filter((j) => !j.retried)) {
      if (job.bridge) {
        const child = db.pipelines.find((p) => p.id === job.downstreamPipelineId)
        if (child === undefined || depth > 5) { failed.push({ pipeline: pipeline, job }); continue }
        const inner = evaluate(db, child, depth + 1)
        pending ||= inner.pending
        failed.push(...inner.failed)
        continue
      }
      const status = effective(job)
      if (status === 'running') pending = true
      else if ((status === 'failed' || status === 'canceled') && !job.allowFailure) failed.push({ pipeline, job })
    }
    return { pending, failed }
  }

  async function getChecks(binding, iid) {
    const mr = await findMr(binding, iid)
    if (mr === undefined) throw new AdapterError('mr_not_found', `no merge request with iid ${iid}`)
    const db: any = await readJson(file, empty())
    const sha = mr.headSha
    const mains = db.pipelines.filter((p) => p.repo === mr.repo && p.sha === sha && p.parentId === undefined)
    if (mains.length === 0) return { status: 'pending', sha, pipelineUrl: null, failedJobs: [] }
    const main = mains.reduce((a, b) => (b.id > a.id ? b : a))
    const { pending, failed } = evaluate(db, main)
    const status = pending ? 'pending' : failed.length > 0 ? 'failed' : 'passed'
    return {
      status, sha, pipelineUrl: pipelineUrl(main),
      failedJobs: status === 'failed' ? failed.map(({ pipeline, job }) => ({ id: job.id, name: job.name, url: jobUrl(pipeline, job), pipelineId: pipeline.id, projectId: pipeline.projectId })) : [],
    }
  }

  const locate = (db, job) => {
    for (const p of db.pipelines) {
      const found = p.jobs.find((j) => String(j.id) === String(job?.id) && !j.bridge)
      if (found !== undefined) return { pipeline: p, job: found }
    }
    return undefined
  }

  async function getJobLog(_binding, job, { maxChars }: { maxChars?: number } = {}) {
    const db: any = await readJson(file, empty())
    const found = locate(db, job)
    if (found === undefined) throw new AdapterError('gitlab_not_found', `no job ${job?.id} (the fake CI keeps no log for it)`)
    const limit = Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : DEFAULT_LOG_CHARS
    const log = effective(found.job) === 'failed' && found.job.status === 'running'
      ? 'The simulated CI runner stopped before this job finished.\n'
      : found.job.log
    return cleanJobLog(log, limit)
  }

  async function retryJobs(_binding, jobs) {
    const list = Array.isArray(jobs) ? jobs : []
    const started: Array<[any, any]> = []
    const retried = await updateJson(file, empty(), (db: any) => {
      // Check everything first: all jobs are retried or none.
      const targets = list.map((job) => {
        const found = locate(db, job)
        if (found === undefined) throw new AdapterError('gitlab_not_found', `no job ${job?.id} to retry`)
        const status = effective(found.job)
        if (found.job.retried || (status !== 'failed' && status !== 'canceled')) throw new AdapterError('job_not_retryable', `job ${job.id} is not a failed job (status ${status}), it cannot be retried`)
        return found
      })
      for (const { pipeline, job } of targets) {
        job.retried = true
        // Like GitLab: a retry is a new job; the old one is hidden from the pipeline's job list.
        const again = { ...job, id: db.nextJobId++, status: 'running', log: '', retried: false, simulateFailure: false, startedAt: new Date().toISOString(), finishedAt: undefined }
        pipeline.jobs.push(again)
        live.set(keyOf(again.id), Promise.resolve())
        started.push([pipeline, again])
      }
      return { value: db, result: list.map((job) => job.id) }
    })
    for (const [p, job] of started) startJob(p, job)
    return { retried }
  }

  /** Resolves when no job of this process is running any more (tests; real GitLab has no such thing). */
  const idle = async () => { while (live.size > 0) await Promise.all([...live.values()]) }

  return { onPush, getChecks, getJobLog, retryJobs, idle }
}
