// The task tools (spec 1 section 5): reading the task, reading the execution record, advancing a
// step, closing the task, confirming missing information and reporting the review verdict. They
// are thin calls to ctx.store and ctx.gate; the checks themselves live in core/task/gate.ts.
// Purposes are from tools-and-limits.md section 2. Who has which tool is decided by the bot
// registry (core/registry/bots.ts); the roles below must agree with it (the tests check this).
import { CLOSE_OUTCOMES, REVIEW_VERDICTS, STEP_IDS } from '../task/contracts.ts'

const RECORDS_MAX = 200
const LINE_TEXT_MAX = 300
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}...` : text)

// The part of the task a bot may see: spec 2 section 4.4. No tokens, no raw event fields other
// than the message text, no other task.
function taskView(task) {
  return {
    id: task.id,
    state: task.state,
    step: task.step,
    origin: { permalink: task.origin?.permalink ?? null, text: task.origin?.text ?? null },
    stepResults: task.stepResults ?? {},
    jira: { key: task.jira?.key ?? null, url: task.jira?.url ?? null },
    repo: { dir: task.repo?.dir ?? null, branch: task.repo?.branch ?? null },
    review: task.review ?? null,
    mr: { url: task.mr?.url ?? null },
    ci: ciView(task.ci),
    needsInfo: task.needsInfo ?? { main: null, coding: null },
  }
}

// Spec 7, 4.3: what a bot sees of the CI state. The failed jobs keep their id so ci_read_log can name one.
function ciView(ci) {
  if (!ci) return null
  return {
    status: ci.status ?? null,
    sha: ci.sha ?? null,
    round: ci.round ?? 0,
    pipelineUrl: ci.pipelineUrl ?? null,
    failedJobs: (ci.failedJobs ?? []).map((job) => ({ id: job.id, name: job.name, url: job.url ?? null })),
    logRead: ci.logRead === true,
    settled: ci.settled === true,
    outcome: ci.outcome ?? null,
    note: ci.note ?? null,
  }
}

const recordLine = (entry) => {
  const who = [entry.role, entry.tool].filter(Boolean).join(' ')
  const head = [entry.at, `run ${entry.run ?? '-'}`, entry.step ?? '-', entry.type, who, entry.ok === false ? 'FAILED' : ''].filter(Boolean).join(' | ')
  return entry.text ? `${head}: ${clip(String(entry.text).replace(/\s+/g, ' '), LINE_TEXT_MAX)}` : head
}

/** The RoleTool definitions of the task tools. */
export function taskTools() {
  return [
    {
      name: 'task_read',
      roles: 'all',
      write: false,
      description: 'Read this task: the Slack discussion link and message, the current step, the summary of each finished step, the Jira key and link, the code directory and branch, the review verdict, the MR link, the CI state (status, round, failed jobs, outcome), and which bots have confirmed that information is missing.',
      parameters: {},
      async run(ctx) {
        return JSON.stringify(taskView(ctx.task), null, 2)
      },
    },
    {
      name: 'task_records',
      roles: ['main'],
      write: false,
      description: 'Read the execution record of this task: which bot did each step, which tools it called, the result and the time. Optionally only one step. Long records show the latest entries.',
      parameters: {
        step: { type: 'string', enum: [...STEP_IDS], description: 'Only the entries of this step' },
      },
      async run(ctx, args) {
        const entries = await ctx.store.readRecords(ctx.task.id, args.step ? { step: args.step } : undefined)
        if (entries.length === 0) return args.step ? `No records for step ${args.step}.` : 'No records yet.'
        const shown = entries.slice(-RECORDS_MAX)
        const lines = shown.map(recordLine)
        if (shown.length < entries.length) lines.unshift(`(showing the latest ${shown.length} of ${entries.length} entries)`)
        return lines.join('\n')
      },
    },
    {
      name: 'task_advance',
      roles: ['main'],
      write: true,
      description: 'Move the task to the next step. Allowed only when the evidence of the current step is complete; otherwise the missing evidence is listed and the task stays where it is. Only the next step can be named.',
      parameters: {
        to: { type: 'string', required: true, enum: [...STEP_IDS], description: 'The step to move to: the one right after the current step' },
      },
      async run(ctx, args) {
        const result = await ctx.gate.advance(ctx.task.id, args.to)
        if (result.ok) return `Advanced to step ${args.to}.`
        const detail = result.missing?.length > 0 ? `missing evidence: ${result.missing.join(', ')}` : result.reason ?? 'refused'
        return `Cannot advance to ${args.to}: ${detail}`
      },
    },
    {
      name: 'task_close',
      roles: ['main'],
      write: true,
      description: 'End the task. outcome "done" needs the task to be in step close; "needs_info" needs both the Main and the Coding bot to have confirmed missing information and the question to have been sent to Slack; "failed" and "needs_person" need a note. After a successful close the group and its members are dissolved.',
      parameters: {
        outcome: { type: 'string', required: true, enum: [...CLOSE_OUTCOMES], description: 'How the task ends' },
        note: { type: 'string', description: 'Why; required for failed and needs_person' },
      },
      async run(ctx, args) {
        const result = await ctx.gate.close(ctx.task.id, args.outcome, args.note)
        return result.ok ? `Task closed: ${args.outcome}.` : `Cannot close: ${result.reason}`
      },
    },
    {
      name: 'needs_info_confirm',
      roles: ['main', 'coding'],
      write: true,
      description: 'Record your confirmation that information needed for this task is missing, with the question to ask. Both the Main bot and the Coding bot must confirm before the question goes to Slack and the task can end as needs_info.',
      parameters: {
        text: { type: 'string', required: true, description: 'What information is missing, as a question for the person who asked' },
      },
      async run(ctx, args) {
        if (args.text.trim() === '') throw new Error('text must not be empty')
        const { other } = await ctx.gate.confirmNeedsInfo(ctx.task.id, ctx.role, args.text)
        const otherRole = ctx.role === 'main' ? 'coding' : 'main'
        return `Recorded. The ${otherRole} bot has ${other ? 'already confirmed' : 'not confirmed yet'}.`
      },
    },
    {
      name: 'review_report',
      roles: ['coding'],
      write: true,
      description: 'Record the verdict of the internal review of the change: pass or fail, the review comments and the number of review rounds. Allowed in step code and step ci (in step ci it records the review of this CI round\'s fix). In step ci only, cannot_fix says the CI failure cannot be fixed; the comments must say why. If called again, the last call counts.',
      parameters: {
        verdict: { type: 'string', required: true, enum: [...REVIEW_VERDICTS], description: 'Whether the review passed; cannot_fix (only in step ci) when the CI failure cannot be fixed' },
        comments: { type: 'string', required: true, description: 'The review comments' },
        rounds: { type: 'integer', required: true, description: 'How many review rounds were run' },
      },
      async run(ctx, args) {
        if (args.rounds < 1) throw new Error('rounds must be at least 1')
        // Spec 7, 4.6: "cannot fix" is a CI-step verdict only.
        if (args.verdict === 'cannot_fix' && ctx.task.step !== 'ci') throw new Error(`the verdict cannot_fix can be used only in step ci, the task is in step ${ctx.task.step}`)
        // Rounds above 3 are still recorded; the monitor applies the limit (spec 1 section 5).
        await ctx.store.patchTask(ctx.task.id, { review: { verdict: args.verdict, comments: args.comments, rounds: args.rounds, at: new Date().toISOString() } })
        return `Recorded: review ${args.verdict}, round ${args.rounds}.`
      },
    },
  ]
}

/** Defines every task tool in the registry. */
export function registerTaskTools(registry) {
  for (const def of taskTools()) registry.defineRoleTool(def)
}
