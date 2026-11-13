// The task tools (spec 1 section 5): reading the task, reading the execution record, advancing a
// step, closing the task, confirming missing information and recording a CI failure as not fixable. They
// are thin calls to ctx.store and ctx.gate; the checks themselves live in core/task/gate.ts.
// Purposes are from tools-and-limits.md section 2. Who has which tool is decided by the bot
// registry (core/registry/bots.ts); the roles below must agree with it (the tests check this).
import { CLOSE_OUTCOMES, STEP_IDS } from '../task/contracts.ts'

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
    origin: { permalink: task.origin?.permalink ?? null, text: task.origin?.text ?? null, followUps: (task.origin?.followUps ?? []).map((message) => ({ text: message.text ?? '' })) },
    stepResults: task.stepResults ?? {},
    jira: { key: task.jira?.key ?? null, url: task.jira?.url ?? null },
    issueAssessment: task.issueAssessment ?? null,
    repo: { dir: task.repo?.dir ?? null, branch: task.repo?.branch ?? null },
    testCommands: task.binding?.testCommands ?? [],
    review: task.review ?? null,
    mr: { url: task.mr?.url ?? null },
    ci: ciView(task.ci),
    needsInfo: task.needsInfo ?? { main: null, jira: null, coding: null },
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
      description: 'Read this task: the Slack discussion link and message, the current step, the summary of each finished step, the Jira key and link, the code directory and branch, the test commands of the repository, the review verdict, the MR link, the CI state (status, round, failed jobs, outcome), and which bots have confirmed that information is missing.',
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
      description: 'End the task. outcome "done" needs step close; "needs_info" needs confirmation from Main and Jira in step issue, or Main and Coding later, plus the question sent to Slack; "failed" and "needs_person" need a note. After close the group is dissolved.',
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
      roles: ['main', 'jira', 'coding'],
      write: true,
      description: 'Record that information is missing, with a question. In step issue the Jira bot and Main must confirm; in later steps Coding and Main must confirm before Slack can ask the question and the task can end as needs_info.',
      parameters: {
        text: { type: 'string', required: true, description: 'What information is missing, as a question for the person who asked' },
      },
      async run(ctx, args) {
        if (args.text.trim() === '') throw new Error('text must not be empty')
        const { other } = await ctx.gate.confirmNeedsInfo(ctx.task.id, ctx.role, args.text)
        const otherRole = ctx.role === 'main' ? (ctx.task.step === 'issue' ? 'jira' : 'coding') : 'main'
        return `Recorded. The ${otherRole} bot has ${other ? 'already confirmed' : 'not confirmed yet'}.`
      },
    },
    {
      // The review itself is request_review (core/tools/review.ts): the system records its verdict. What the
      // Coding bot still records itself is that a failed CI round cannot be fixed (spec 7, 4.6); ci_stop with
      // reason not_fixable needs it.
      name: 'review_report',
      roles: ['coding'],
      write: true,
      description: 'Step ci only: record that this CI failure cannot be fixed (verdict cannot_fix), with the reason in the comments: the cause cannot be located, the fix is outside the ticket, or it cannot be fixed automatically. The Pipeline bot then stops the CI loop. A review of a change is not recorded here: request_review records it.',
      parameters: {
        verdict: { type: 'string', required: true, enum: ['cannot_fix'], description: 'Always cannot_fix' },
        comments: { type: 'string', required: true, description: 'Why the failure cannot be fixed' },
      },
      async run(ctx, args) {
        if (ctx.task.step !== 'ci') throw new Error(`the verdict cannot_fix can be used only in step ci, the task is in step ${ctx.task.step}`)
        const comments = String(args.comments ?? '').trim()
        if (comments === '') throw new Error('comments must say why the failure cannot be fixed')
        const rounds = ctx.task.review?.rounds ?? 0
        await ctx.store.patchTask(ctx.task.id, { review: { verdict: 'cannot_fix', comments, rounds, at: new Date().toISOString(), by: 'coding' } })
        return 'Recorded: cannot_fix. The Pipeline bot can now stop the CI loop.'
      },
    },
  ]
}

/** Defines every task tool in the registry. */
export function registerTaskTools(registry) {
  for (const def of taskTools()) registry.defineRoleTool(def)
}
