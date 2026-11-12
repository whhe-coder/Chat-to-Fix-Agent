// Interface contracts between the parts of chat-to-fix.
//
// This file holds names and shapes only. The behaviour of each interface is defined in the
// detailed specifications under ../../../chat-to-fix-design-2026-11-11/ (spec-1 … spec-6).
// One file belongs to one work package; to change a contract, change it here first.

/** The five roles. One bot per service. (spec 1, 2.1) */
export const ROLES = Object.freeze(['main', 'slack', 'jira', 'pipeline', 'coding'])

/** The eight steps, in order. `ci` is the sixth (spec 7, 4.2). (spec 1, 2.3) */
export const STEP_IDS = Object.freeze(['fetch', 'issue', 'prepare', 'code', 'mr', 'ci', 'writeback', 'close'])

/** Task states. (spec 2, 2.3) */
export const TASK_STATES = Object.freeze(['queued', 'running', 'done', 'needs_info', 'failed', 'timed_out', 'stopped', 'expired'])

/** Outcomes accepted by gate.close / task_close. (spec 1, 4.4) */
export const CLOSE_OUTCOMES = Object.freeze(['done', 'needs_info', 'failed', 'needs_person'])

/** Purposes of slack_reply. (spec 4, 4.3) */
export const REPLY_PURPOSES = Object.freeze(['ack', 'question', 'result'])

/**
 * End reasons of a task that ended in state `done`. `completed` is the plain pass; the other three
 * say how the CI step ended (spec 7, 4.8). The MR stays a Draft and the fix commits stay in every case.
 * The Slack bot has already reported inside the flow for all of them, so the runner sends no
 * "ended" system notice for any of these (src/task/runner.ts end(), step 6).
 */
export const DONE_END_REASONS = Object.freeze(['completed', 'completed_ci_failed', 'completed_ci_stopped', 'completed_no_ci'])

/** Types of execution-record entries. (spec 2, 2.4) */
export const RECORD_TYPES = Object.freeze(['line', 'notice', 'tool_call', 'tool_result', 'round_end', 'advance', 'refused', 'limit', 'approval', 'system', 'usage', 'ci'])

// ---------------------------------------------------------------------------------------------
// CI loop contracts (spec 7). Shapes only; the behaviour belongs to the work packages:
//   3a adapters (fake/ci.ts, gitlab-http.ts, repo.ts, git.ts), 3b flow/gate/tools/registry,
//   3c monitor (the wait), config and the system notices.
// ---------------------------------------------------------------------------------------------

/** task.ci.status. (spec 7, 4.3) */
export const CI_STATUSES = Object.freeze(['pending', 'failed', 'passed'])

/**
 * task.ci.outcome once task.ci.settled is true. (spec 7, 4.3; the end reason each gives is in
 * src/flow/steps.ts CI_END_REASONS)
 *   passed            the pipeline of the current commit passed        -> completed
 *   rounds_exhausted  ciMaxRounds fix commits and still failing        -> completed_ci_failed
 *   not_locatable     ci_stop: the log does not show the cause         -> completed_ci_stopped
 *   out_of_scope      ci_stop: the fix is outside the ticket           -> completed_ci_stopped
 *   not_fixable       ci_stop: the Coding bot recorded cannot_fix      -> completed_ci_stopped
 *   branch_changed    mr_push_fix: push rejected, someone else pushed  -> completed_ci_stopped
 *   no_pipeline       no pipeline within ciWaitMinutes, or the wait ran out (note says "wait timed out") -> completed_no_ci
 */
export const CI_OUTCOMES = Object.freeze(['passed', 'rounds_exhausted', 'not_locatable', 'out_of_scope', 'not_fixable', 'branch_changed', 'no_pipeline'])

/** The `reason` values of ci_stop (a subset of CI_OUTCOMES). (spec 7, 4.6) */
export const CI_STOP_REASONS = Object.freeze(['not_locatable', 'out_of_scope', 'not_fixable'])

/** `verdict` values of review_report; `cannot_fix` is accepted only in step ci. (spec 7, 4.6) */
export const REVIEW_VERDICTS = Object.freeze(['pass', 'fail', 'cannot_fix'])

/**
 * One failed job of a pipeline. `projectId` is the project the job lives in: a downstream pipeline
 * may belong to another project and is read with its own project id. (spec 7, 4.3 and 4.5)
 * @typedef {object} CiJob
 * @property {number | string} id
 * @property {string} name
 * @property {string | null} url
 * @property {number | string} pipelineId
 * @property {number | string} projectId
 *
 * task.ci, null until the monitor first sees the task in step ci. (spec 7, 4.3)
 * Written by: the monitor (init, polling, retry, rounds, timeouts), mr_push_fix, ci_read_log (logRead), ci_stop.
 * @typedef {object} TaskCi
 * @property {'pending' | 'failed' | 'passed'} status
 * @property {string} sha                The commit being waited for.
 * @property {number} round              Fix commits appended so far, 0..ciMaxRounds. The pipeline of the first MR commit is not a round.
 * @property {boolean} retried           Whether the failed jobs of this commit were already re-run once by the system.
 * @property {string} since              ISO time the wait for this commit began (kept across restarts).
 * @property {number} waitedMs           Time spent waiting for CI over all rounds.
 * @property {string | null} pipelineUrl The chosen pipeline: with several MR pipelines for one sha, the highest id.
 * @property {CiJob[]} failedJobs        The jobs that count as failed after the retry.
 * @property {boolean} logRead           Whether the pipeline bot read a log (ci_read_log) in this round.
 * @property {boolean} settled           True: the step may advance to writeback.
 * @property {typeof CI_OUTCOMES[number] | null} outcome
 * @property {string | null} note        The explanation of ci_stop, or the system's reason.
 * @property {string | null} [lastPollAt] Optional: when getChecks last ran (the monitor ticks every 5 s, polls every ciPollSeconds).
 *
 * task.mr after spec 7: `iid` and `sha` are new; written by mr_open_draft and mr_push_fix.
 * @typedef {object} TaskMr
 * @property {string} url
 * @property {number | string} [iid]
 * @property {string} [sha]
 *
 * task.closeNote (string, optional): the trimmed note of task_close, written by gate.close for every outcome
 * that has one. The end notice shows it to the requester (`task.closeNote ?? task.endReason`); it survives
 * needs_person, whose endReason is the literal 'needs_person'. startRun clears it (null), so an old reason never shows on a later run.
 */

/**
 * A fresh task.ci for the commit `sha` (the monitor's initialisation, spec 7, 4.4 step 1; also the
 * reset mr_push_fix writes after a push, with `round` and `waitedMs` carried over).
 * @param {string} sha
 * @param {string} at   ISO time
 * @param {{round?: number, waitedMs?: number}} [carry]
 * @returns {TaskCi}
 */
export function newCi(sha: string, at: string, carry: { round?: number, waitedMs?: number } = {}) {
  return {
    status: 'pending', sha, round: carry.round ?? 0, retried: false, since: at, waitedMs: carry.waitedMs ?? 0,
    pipelineUrl: null, failedJobs: [], logRead: false, settled: false, outcome: null, note: null,
  }
}

/**
 * The four functions the `repo` adapter gets (spec 7, 4.5), in the fake (src/adapters/fake/ci.ts via
 * fake/repo) and in the real one (gitlab-http.ts) with the same return shapes. Owner: package 3a.
 * Errors are Error objects with `code` and `retryable`, like the existing functions. The two write
 * functions send once and never retry.
 *
 * @typedef {object} CiChecks
 * @property {'pending' | 'passed' | 'failed'} status
 *   pending: no pipeline for the MR's current sha yet, or one still running (also: a downstream with another sha).
 *   passed: main and downstream pipelines all `success` and no counting failed job.
 *   failed: any counting failed job. `allow_failure: true` jobs do not count; cancelled counts; a downstream
 *   pipeline we cannot read counts as failed and the failed job says so in its name.
 * @property {string} sha             The MR's current head sha the result belongs to.
 * @property {string | null} pipelineUrl
 * @property {CiJob[]} failedJobs     [] unless status is failed.
 *
 * @typedef {object} CiRepoAdapter
 * @property {(binding: object, iid: number | string) => Promise<CiChecks>} getChecks
 *   Reads only; the monitor compares `sha` with task.ci.sha and ignores other shas.
 *   Real: GET merge_requests/:iid (sha, head_pipeline), pipelines of the same sha with the highest id,
 *   trigger_jobs (downstream, read with its own project_id), jobs of each pipeline.
 * @property {(binding: object, job: CiJob, options?: {maxChars?: number}) => Promise<string>} getJobLog
 *   The last `maxChars` (default limits.ciLogMaxChars) characters, ANSI colour codes and GitLab section markers removed.
 *   Real: GET /projects/:job.projectId/jobs/:job.id/trace.
 * @property {(binding: object, jobs: CiJob[]) => Promise<{retried: Array<number | string>}>} retryJobs
 *   Re-runs the given failed jobs once (no retry on error). Real: POST /projects/:projectId/jobs/:id/retry,
 *   NOT verified on a real GitLab yet: keep it behind the adapter and test it on the fake only.
 * @property {(binding: object, dir: string, branch: string, options: {message: string}) => Promise<{sha: string}>} pushFix
 *   Commits all changes of `dir` as a NEW commit (git.commitAll, no amend) and pushes normally (no --force).
 *   Errors: code `nothing_to_commit` (no change), code `push_rejected` (the remote refused: someone else pushed).
 *
 * Changed by spec 7 (same package):
 *   openDraftMR(binding, dir, branch, { title, description, jiraKey, commitMessage? }) -> { url, iid, sha }
 *     now appends a new commit for a second call on the same branch (no amend) and pushes normally;
 *     a rejected push is code `push_rejected`. mr_open_draft stores iid and sha into task.mr.
 *   git.push no longer passes --force.
 */

/**
 * The tools spec 7 adds (4.6), in the parameter-table form of the tool registry (src/tools/register.ts).
 * `step` is where the gate lets a write tool run. Behaviour owner: package 3b (src/tools/ci.ts).
 *
 *   ci_read_log   pipeline  read   any step   job (name or id; must be in task.ci.failedJobs). Returns the log tail
 *                                              (limits.ciLogMaxChars) marked as material; sets ci.logRead = true.
 *   mr_push_fix   pipeline  write  ci         commit_message (one-line Conventional Commit, checkCommitMessage).
 *                                              Refuses unless ci.status == failed and ci.round < ciMaxRounds; extra evidence
 *                                              review.verdict == pass and diff.withinLimits. On success writes
 *                                              ci = newCi(newSha, now, {round: round + 1, waitedMs}) and mr.sha. A rejected
 *                                              push writes ci = {settled: true, outcome: 'branch_changed', note}.
 *   ci_stop       pipeline  write  ci         reason (CI_STOP_REASONS), note (not empty). Refuses unless ci.status == failed,
 *                                              ci.logRead, and for not_fixable review.verdict == cannot_fix. Writes
 *                                              ci = {settled: true, outcome: reason, note}.
 *   review_report coding    write  code, ci   verdict gains `cannot_fix` (only in step ci); comments say why.
 *   request_code  coding    read   code, ci   (was: code only)
 */
export const CI_TOOL_PARAMETERS = Object.freeze({
  ci_read_log: Object.freeze({
    job: Object.freeze({ type: 'string', required: true, description: 'The failed job: its name or its id, as listed in task.ci.failedJobs' }),
  }),
  mr_push_fix: Object.freeze({
    commit_message: Object.freeze({ type: 'string', required: true, description: 'The fix commit message: ONE line "type(scope): summary", Conventional Commit, no body' }),
  }),
  ci_stop: Object.freeze({
    reason: Object.freeze({ type: 'string', required: true, enum: CI_STOP_REASONS, description: 'Why the CI loop stops: not_locatable, out_of_scope or not_fixable' }),
    note: Object.freeze({ type: 'string', required: true, description: 'What you saw in the log and why the loop stops; must not be empty' }),
  }),
})

/**
 * Configuration of spec 7 (4.9). `limits.*` live in src/config.ts DEFAULT_LIMITS (package 3c adds them and
 * `stepMinutes.ci`); binding keys are read by the fake GitLab only (package 3a).
 *   limits.ciPollSeconds   15     polling interval of getChecks
 *   limits.ciWaitMinutes   30     longest wait for one commit's pipeline
 *   limits.ciTotalMinutes  90     longest wait over all rounds
 *   limits.ciMaxRounds     3      most fix commits (the pipeline of the first MR commit is not a round)
 *   limits.ciLogMaxChars   12000  length of the log ci_read_log returns
 *   limits.stepMinutes.ci  30     step limit while a bot is working (not while waiting)
 *   binding.ciJobs         [{ name, command, delaySeconds?, allowFailure?, flaky?, downstream? }]  fake GitLab only
 *   binding.ciNone         true: a push produces no pipeline (fake GitLab only)
 *   language `zh`          CI progress notices use the Chinese templates
 */
export const CI_CONFIG_DEFAULTS = Object.freeze({
  limits: Object.freeze({ ciPollSeconds: 15, ciWaitMinutes: 30, ciTotalMinutes: 90, ciMaxRounds: 3, ciLogMaxChars: 12000 }),
  stepMinutesCi: 30,
})

/**
 * I1 bot-layer facade — src/task/botlayer.ts (spec 5, section 3)
 * @typedef {object} BotLayer
 * @property {(def: {name: string, label: string, instructions: string, model: string, permission: string, preset?: string}) => Promise<string>} createBot
 * @property {(def: {name: string, memberIds: string[], adminId: string, notice: string}) => Promise<string>} createGroup
 * @property {(groupId: string, dir: string) => Promise<void>} setGroupWorkDir
 * @property {(groupId: string, text: string, requestId: string) => Promise<void>} postTask
 * @property {(req: {fromSessionId: string, toBotId: string, text: string}) => Promise<void>} askBot
 * @property {(botId: string) => Promise<void>} stopBot
 * @property {(groupId: string) => Promise<void>} stopGroup
 * @property {(groupId: string) => Promise<void>} deleteGroup
 * @property {(botId: string) => Promise<void>} deleteBot
 * @property {(groupId: string) => boolean} groupExists
 * @property {(groupId: string) => boolean} isQuiet
 * @property {() => object} status
 * @property {(fn: Function) => () => void} onGroupLine
 * @property {(fn: Function) => () => void} onSessionEvent
 * @property {(fn: Function) => () => void} onToolResult
 * @property {(fn: Function) => () => void} onRoundEnd
 * @property {(fn: Function) => () => void} onApproval
 * @property {(fn: Function) => () => void} onUsage
 * @property {(id: string, choice: 'allow' | 'reject') => void} answerApproval
 * @property {(botId: string, binding: {taskId: string, role: string}) => void} bindBot
 * @property {(botId: string) => void} unbindBot
 * @property {(sessionId: string) => ({botId: string, role: string, taskId: string} | undefined)} botOfSession
 */

/**
 * I1 event payloads. The facade turns the bot layer's own events into these shapes, so the task
 * layer (recorder, monitor) never reads a DS Bot or DSH object directly.
 *
 * @typedef {object} GroupLineEvent     onGroupLine
 * @property {string} groupId
 * @property {'line' | 'notice'} kind   'notice' is a system notice in the group (e.g. the idle-relay pause).
 * @property {string | null} botId      null when the line is from the user/system.
 * @property {string} name              Display name of the speaker.
 * @property {string} text
 * @property {string} at                ISO time.
 *
 * @typedef {object} SessionEvent       onSessionEvent
 * @property {string} sessionId
 * @property {string | null} botId
 * @property {string} type              The DSH session event type.
 * @property {object} event             The raw event (for the type-specific fields).
 * @property {string} at
 *
 * @typedef {object} ToolResultEvent    onToolResult
 * @property {string} sessionId
 * @property {string | null} botId
 * @property {string} tool              Tool name.
 * @property {object} args
 * @property {boolean} ok
 * @property {string} text              The result text shown to the model.
 * @property {number} ms                Time taken.
 * @property {string} at
 *
 * @typedef {object} RoundEndEvent      onRoundEnd
 * @property {string} sessionId
 * @property {string | null} botId
 * @property {string | null} groupId
 * @property {string} text              The bot's final answer of the round.
 * @property {boolean} failed           True when the turn ended with an error or was stopped.
 * @property {string} at
 *
 * @typedef {object} UsageEvent         onUsage (one round of an API bot, or one model of one Claude Code turn)
 * @property {string} sessionId
 * @property {string | null} botId
 * @property {'dsh' | 'cli'} source     'dsh': DSH's tokenUsage and sessionStats projections, as the difference over the round; 'cli': the Claude Code result event.
 * @property {string} model             The model that ran (what the provider or the CLI reported).
 * @property {string} [effort]          The effort level the Coding bot was started with.
 * @property {number} input             Uncached input tokens.
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number | null} costUsd    The CLI's own cost ('cli'); null for 'dsh', which the recorder prices from the table.
 * @property {number} durationMs        The span the speed is measured over (DSH: decodeMs of sessionStats; CLI: duration_api_ms, else duration_ms).
 * @property {number} [tpsTokens]       DSH only: decodeTokens, the output tokens of that span.
 * @property {number} [ttftMs]          DSH only: mean time to first token over the round's steps (ttftMs / ttftSteps).
 * @property {'dsh-decode' | 'cli-api' | 'cli-wall' | null} tpsBasis
 * @property {boolean} [failed]
 * @property {string} at
 *
 * @typedef {object} ApprovalEvent      onApproval
 * @property {string} id
 * @property {string} sessionId
 * @property {string | null} botId
 * @property {string} tool
 * @property {string} text              What is being asked.
 */

/**
 * I2 task store — src/task/store.ts (spec 2, 3.1)
 * @typedef {object} TaskStore
 * @property {(eventId: string) => (string | undefined)} knownEvent
 * @property {(origin: object, binding: object) => Promise<object>} createTask
 * @property {(id: string) => Promise<object | undefined>} getTask
 * @property {(id: string, usageRecord: object) => Promise<object | undefined>} addUsage
 * @property {(channel: string, threadTs: string) => Promise<object | undefined>} findByThread
 * @property {(id: string, patch: object) => Promise<object>} patchTask
 * @property {(id: string, run: {groupId: string, bots: Record<string, string>}) => Promise<object>} startRun
 * @property {(id: string, state: string, endReason: string) => Promise<object>} endRun
 * @property {(id: string, entry: object) => Promise<void>} appendRecord
 * @property {(id: string, filter?: {step?: string}) => Promise<object[]>} readRecords
 * @property {(filter?: {state?: string}) => Promise<object[]>} listTasks
 */

/**
 * I3 step checks — src/task/gate.ts (spec 1, sections 3 and 4)
 * @typedef {object} Gate
 * @property {(taskId: string, toStep: string) => Promise<{ok: true} | {ok: false, missing: string[]}>} advance
 * @property {(taskId: string, toolName: string, purpose?: string) => Promise<{ok: true} | {ok: false, reason: string}>} allow
 * @property {(taskId: string, role: string, text: string) => Promise<{other: boolean}>} confirmNeedsInfo
 * @property {(taskId: string, outcome: string, note?: string) => Promise<{ok: true} | {ok: false, reason: string}>} close
 */

/**
 * I4 tool definition — src/tools/register.ts (spec 4, 2.1)
 * @typedef {object} RoleTool
 * @property {string} name
 * @property {string[] | 'all'} roles
 * @property {boolean} write
 * @property {(args: object) => (string | undefined)} [purpose]
 * @property {string} description
 * @property {object} parameters
 * @property {(ctx: ToolContext, args: object) => Promise<string>} run
 *
 * @typedef {object} ToolContext
 * @property {object} task
 * @property {string} role
 * @property {string} botId
 * @property {string} sessionId     The DSH session the call came from (a bot has several: own chat, group sessions).
 * @property {TaskStore} store
 * @property {Gate} gate
 * @property {Adapters} adapters
 * @property {object} config
 * @property {BotLayer} botlayer
 */

/**
 * I5 adapters — src/adapters/ (spec 4, 2.2). Every adapter has a fake and a real implementation.
 * @typedef {object} Adapters
 * @property {{readThread: Function, reply: Function}} slack
 * @property {{createIssue: Function, getIssue: Function, addComment: Function, transition: Function}} jira
 * @property {{prepare: Function, diff: Function, readFile: Function, log: Function, openDraftMR: Function, getMR: Function, cleanup: Function} & CiRepoAdapter} repo
 */

/**
 * I7 bot registry and flow definition — src/registry/bots.ts, src/flow/steps.ts (spec 1, 2.2 and 2.3)
 * @typedef {object} BotDef
 * @property {string} role
 * @property {string} name          Name prefix; the task number is appended when the bot is created.
 * @property {string} label         DS Bot's `role` field (at most 24 characters).
 * @property {string} instructions  Name of the prompt file.
 * @property {string} model         Model route, or the name of the config key that holds it.
 * @property {string} permission
 * @property {string[]} tools       Tools only this bot has.
 *
 * @typedef {object} StepDef
 * @property {number} no
 * @property {string} id
 * @property {string[]} roles
 * @property {string[]} evidence
 * @property {string[]} writeTools
 */
