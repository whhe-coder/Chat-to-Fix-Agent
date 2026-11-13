// request_review: the review of the Coding bot's change, run by the system (spec: software-spec 5.5,
// docs/chat-to-fix/design/plan-dsh-coding.md).
//
// The Coding bot calls it once its change is made. The system, not the Coding bot, builds what the reviewer
// sees: the reviewer's instructions (core/prompts/reviewer.md), the task (the Slack request and the step
// results), the Coding bot's own description of the change, and the real diff of the code directory against
// the base commit. The reviewer is a DSH subagent of the Coding bot's session on the read-only preset of the
// registry (`reviewer.preset`), started and awaited by the bot layer (botlayer.runReview); it reads the code
// in the code directory and answers "pass" or "not pass". The system records the verdict, the reviewer's text
// and the round on the task (task.review), counts the rounds and refuses a review beyond reviewMaxRounds.
import { botDef } from '../registry/bots.ts'
import { loadPrompt } from '../prompts/index.ts'
import { cutText, material } from './material.ts'
import { PATCH_MAX_CHARS } from './repo.ts'

export const REVIEW_TEXT_MAX = 4000
const minutesOf = (config) => config?.limits?.reviewMinutes ?? 15
const maxRoundsOf = (config) => config?.limits?.reviewMaxRounds ?? 3

/**
 * The verdict of the reviewer's answer: its first non-empty line must start with "pass" or "not pass"
 * (reviewer.md). Anything else counts as not passed, and the comments say so.
 */
export function verdictOf(text) {
  const first = String(text ?? '').split('\n').map((line) => line.replace(/[*_#`>:：.。!！\s]+/g, ' ').trim().toLowerCase()).find((line) => line !== '') ?? ''
  if (/^(not pass|fail)|^(不通过|未通过)/.test(first)) return { verdict: 'fail', clear: true }
  if (/^pass(ed)?\b|^通过/.test(first)) return { verdict: 'pass', clear: true }
  return { verdict: 'fail', clear: false }
}

const stepText = (task, step, role) => task.stepResults?.[step]?.[role]?.text

/** What the reviewer is given: instructions, then the task, the description and the diff, each marked as material. */
export function reviewPrompt({ instructions, task, summary, diff }) {
  const parts = [instructions.trim(), '', '# The review', '']
  parts.push('Your working directory is the code directory of this task: the changed files and the code around them are there. Read what you need; change nothing.')
  parts.push('', '## The task')
  if (task.origin?.text) parts.push('The request as it was written in Slack:', material('the Slack request', task.origin.text))
  const fetch = stepText(task, 'fetch', 'slack')
  if (fetch) parts.push('The Slack bot\'s summary of it:', material('the Slack bot', fetch))
  const issue = stepText(task, 'issue', 'jira')
  if (task.jira?.key || issue) parts.push(`The Jira issue${task.jira?.key ? ` ${task.jira.key}` : ''}:`, material('the Jira bot', issue ?? '(no summary recorded)'))
  if (task.step === 'ci') {
    const failed = (task.ci?.failedJobs ?? []).map((job) => job.name).join(', ')
    parts.push('', `This change fixes a failed CI round${failed ? ` (failed jobs: ${failed})` : ''}. The Pipeline bot's failure summary:`, material('the Pipeline bot', stepText(task, 'ci', 'pipeline') ?? '(no summary recorded)'))
  }
  parts.push('', '## The Coding bot\'s description of the change', material('the Coding bot', summary))
  const files = (diff.files ?? []).map((file) => `- ${file.path} (+${file.added} -${file.removed})`)
  const { text, note } = cutText(diff.patch ?? '', PATCH_MAX_CHARS)
  parts.push('', `## The change (git diff against the base commit ${task.repo?.base ?? ''})`.trim(), `Changed files: ${diff.totalFiles ?? files.length}, changed lines: ${diff.totalLines ?? '?'}`, ...files, material('the repository', text))
  if (note) parts.push(note)
  parts.push('', 'Answer with "pass" or "not pass" on the first line, then your reasons.')
  return parts.join('\n')
}

/** The RoleTool definition of request_review. */
export function reviewTools() {
  return [
    {
      name: 'request_review',
      roles: ['coding'],
      write: true,
      retries: 0,
      // The review's own limit plus a margin for stopping it and reading its usage.
      timeoutMs: (config) => minutesOf(config) * 60_000 + 60_000,
      description: 'Have your change reviewed, once it is made and the tests you could run pass. A read-only reviewer with its own context gets the task, your description and the real diff of the code directory, and answers pass or not pass with its reasons. The verdict and the round are recorded on the task by the system. At most three rounds per step (per CI round in step ci). Only in step code or step ci.',
      parameters: {
        summary: { type: 'string', required: true, description: 'What you changed and why, and what you verified (which test commands ran, with what result), in a few sentences' },
      },
      async run(ctx, args) {
        const { task, config } = ctx
        const summary = String(args.summary ?? '').trim()
        if (summary === '') throw new Error('summary must not be empty')
        const dir = task.repo?.dir
        if (!dir) throw new Error('the code directory is not prepared yet')
        const previous = task.review && task.review.verdict !== 'cannot_fix' ? (task.review.rounds ?? 0) : 0
        const max = maxRoundsOf(config)
        if (previous >= max) throw new Error(`the review limit of ${max} rounds is reached (last verdict: ${task.review.verdict}); stop and report that the review did not pass, with the reason`)
        const diff = await ctx.adapters.repo.diff(dir, task.repo.base)
        if ((diff.totalFiles ?? diff.files?.length ?? 0) === 0 && !diff.patch) throw new Error('there is no change in the code directory to review')
        const reviewer = botDef(ctx.role)?.reviewer
        if (!reviewer) throw new Error(`the ${ctx.role} bot has no reviewer in the registry`)
        const prompt = reviewPrompt({ instructions: await loadPrompt(reviewer.instructions), task, summary, diff })
        const result = await ctx.botlayer.runReview({ sessionId: ctx.sessionId, prompt, preset: reviewer.preset, timeoutMs: minutesOf(config) * 60_000 })
        if (result.stopReason !== 'completed') {
          throw new Error(`the review did not finish (${result.stopReason}${result.diagnostic ? `: ${result.diagnostic}` : ''}); nothing was recorded, ask for the review again`)
        }
        const { verdict, clear } = verdictOf(result.text)
        const rounds = previous + 1
        const answer = cutText(result.text, REVIEW_TEXT_MAX).text
        const comments = clear ? answer : `(The reviewer's answer did not start with pass or not pass, so it counts as not passed.)\n${answer}`
        await ctx.store.patchTask(task.id, { review: { verdict, comments, rounds, at: new Date().toISOString(), by: 'reviewer' } })
        return [
          `Review round ${rounds} of at most ${max}: ${verdict === 'pass' ? 'pass' : 'not pass'}. The system recorded it on the task.`,
          verdict === 'pass' ? '' : rounds < max ? 'Change the code following the comments, then ask for the review again.' : 'This was the last round: stop and report that the review did not pass, with the reason.',
          '',
          'The reviewer\'s answer:',
          material('the reviewer', answer),
        ].filter((line, i) => !(i === 1 && line === '')).join('\n')
      },
    },
  ]
}
