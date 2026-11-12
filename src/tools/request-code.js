// request_code (C5, spec 4 section 4.6): the Coding bot asks the Pipeline bot, in a private
// request, for something from the repository (a file on another branch, a piece of history).
// It goes through the bot layer's askBot, not DS Bot's message_bot (see the spec for why).
import { currentRun } from './material.js'

/** The RoleTool definitions of request_code. */
export function requestCodeTools() {
  return [
    {
      name: 'request_code',
      roles: ['coding'],
      write: false,
      description: 'Ask the Pipeline bot for something from the repository that you cannot reach yourself, for example a file on another branch or a piece of history. Only in step code. The request is private; the answer arrives as a new message.',
      parameters: {
        what: { type: 'string', required: true, description: 'What you want, with the path, branch or commit if you know them' },
      },
      async run(ctx, args) {
        const { task } = ctx
        if (task.step !== 'code') throw new Error(`request_code can be used only in step code, the task is in step ${task.step}`)
        const what = typeof args.what === 'string' ? args.what.trim() : ''
        if (what === '') throw new Error('what must not be empty')
        const toBotId = currentRun(task)?.bots?.pipeline
        if (!toBotId) throw new Error('this task has no Pipeline bot')
        // The calling session id: the registry's ctx does not carry it yet, so the bot id stands in
        // until register.js passes `sessionId` (see the report).
        const fromSessionId = ctx.sessionId ?? ctx.botId
        await ctx.botlayer.askBot({ fromSessionId, toBotId, text: what })
        return 'Sent to the Pipeline bot; the answer will arrive as a new message'
      },
    },
  ]
}
