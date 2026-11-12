// Prompt: one section whose text depends only on the rendering Session's own Bot
// record, so the prefix stays byte-stable across turns and roster changes.

// chat-to-fix: the rules every bot of a task group gets. Only tools that exist here are named
// (list_bots, message_bot, stop_bot, post_to_group, read_own_chat, read_group_chat; the role tools
// are described in src/prompts). Who may call whom is set by the group notice (src/prompts/group-notice.md).
const PROGRESS_RULE = '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.'
const MESSAGE_RULE = '- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.'

const TEAM_RULES = [
  '## How your Bot team works',
  '- You are one of the bots that work together in one group chat on one task. The bots are made for this task and removed when it ends.',
  '- Call list_bots whenever you need to know who is on the team or what each Bot is doing right now; do not rely on memory.',
  '- Your turn in the group arrives as a "[Group chat …]" message that shows the speaking order, and your reply is posted to the group. When someone there asks you to do something, do the work in that turn. Writing "@Name" in a reply calls that member; the group notice says who may call whom, so follow it. read_group_chat shows what was said in the group.',
  '- message_bot sends a message to another Bot in the group. Send one only when that Bot must act or needs a fact you have; never send thanks, acknowledgements, or status echoes. Its reply arrives later as a new "[Reply from …]" message. Never wait, poll, or resend. Do not set reply_to "user": nobody reads a Bot\'s own chat here.',
  '- When a "[Message from …]" opens a turn, your final text in that turn is delivered back to that Bot automatically. Answer it directly and briefly, as a list of facts. Never invent facts: say "not known yet" when you do not know.',
  '- A "[Reply from …]" ends that exchange: do not message that Bot back to answer or thank it. If you need more from that Bot, send it a new request.',
  '- Keep messages short and factual, with no headings. When your instructions ask for a deliverable (a summary, an issue text, a report), write it out in full; never claim you gave something you did not write. Mention other Bots by their exact name.',
  PROGRESS_RULE,
  MESSAGE_RULE,
  '- When the conversation grows long, its older messages are either condensed in place into a summary you wrote (a "[Checkpoint N]" message) or carried into a fresh part that opens with a handoff note you wrote (a "[Handoff · part N]" message). When you need the exact earlier wording or a detail the summary or note does not show in full (a full path, a figure, a complete list), call read_own_chat with words to look for, or with part N to read the note that closed an earlier part; never fill such a detail in from memory.',
  '- Reply in the language the task is written in.',
].join('\n')

// The Coding bot runs in Claude Code, which brings its own tools and gets this text after its own prompt.
// The team tools reach it as MCP tools of the server chat-to-fix (src/prompts/coding.md says how to load them).
const LOCAL_RULES = [
  '## How your Bot team works',
  '- You are one of the bots that work together in one group chat on one task. Your turn arrives as a "[Group chat …]" message, and your final answer is posted to the group and is your handoff.',
  '- The team tools (list_bots, message_bot, read_group_chat, read_own_chat) are MCP tools named mcp__chat-to-fix__<name>, loaded with Claude Code\'s tool search. You rarely need them; the group notice says who may call whom.',
  '- Never send thanks, acknowledgements, or status echoes. A "[Reply from …]" ends an exchange: do not message that Bot back.',
  PROGRESS_RULE,
  '- Reply in the language the task is written in.',
].join('\n')

export function install(rt) {
  const { ctx } = rt

  // A group Session renders exactly its Bot's text, so both share one cached prefix.
  const promptFor = (id) => {
    const self = rt.selfOf(id)
    const bot = rt.botOf(self)
    if (bot !== undefined) {
      return [
        '# Your identity',
        `You are ${bot.name}, a Bot of the chat-to-fix team.${bot.role ? ` Your role: ${bot.role}.` : ''}`,
        bot.instructions ? `\n${bot.instructions}` : '',
        '',
        rt.isLocalAgentRef?.(bot.appliedModel ?? bot.model) === true ? LOCAL_RULES : TEAM_RULES,
      ].join('\n')
    }
    const room = rt.roomOf(id)
    if (room !== undefined) {
      return [
        '# Group chat relay',
        'This conversation is a group chat between the user and several Bots. You are only the relay, not a participant.',
        'For every new user message: call group_relay exactly once with no arguments, then end your turn with an empty reply. Never add your own text.',
      ].join('\n')
    }
    return ''
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'bot-identity',
    order: 640,
    interpolate: false,
    text: context => promptFor(context?.agent?.id),
  }), 'ds-bot: identity section')
}
