import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.ts'
import { fakeContext } from './fake-ctx.ts'

function start() {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
    ['coder', { name: 'Coder', role: 'Code', model: 'claude-code/default' }],
  ])
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
    isLocalAgentRef: ref => String(ref).startsWith('claude-code/'),
  })
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  return { ctx, prompt }
}

test('Bots get the progress rules for group work, once, without changing the group prompt prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.',
  ]
  for (const id of ['main', 'worker', 'coder']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule))
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  const message = '- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.'
  for (const id of ['main', 'worker']) assert.ok(prompt(id).split('\n').includes(message))
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('the rules name only tools that exist here and no feature that was removed', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  // The team tools of bot/src/host (tools.ts, groups.ts) and the one option of message_bot that the text mentions.
  const real = new Set(['list_bots', 'message_bot', 'stop_bot', 'post_to_group', 'read_own_chat', 'read_group_chat', 'reply_to'])
  for (const id of ['main', 'worker', 'coder']) {
    const text = prompt(id)
    const named: string[] = [...new Set<string>(text.replace(/mcp__chat-to-fix__<name>/g, '').match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])]
    assert.deepEqual(named.filter(name => !real.has(name)), [], `${id} names a tool that does not exist`)
    for (const stale of [/ask_user/, /show_view/, /update_bot/, /update_group/, /group_goal/, /request_secret/, /list_secrets/, /web_search/, /browser/i, /DS Bot/, /Main Bot/, /own memory/, /your own computer/, /long-lived/, /tap-to-answer/, /create_bot/, /goal-grill/]) {
      assert.doesNotMatch(text, stale, `${id}: ${stale}`)
    }
  }
})

test('every bot is named by its record; the Coding bot on a local route gets the short rules with the MCP tool names', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('worker'), /^# Your identity\nYou are Dev, a Bot of the chat-to-fix team\.\n\nCheck files\./)
  assert.match(prompt('coder'), /You are Coder, a Bot of the chat-to-fix team\. Your role: Code\./)
  assert.match(prompt('worker'), /\n- Call list_bots whenever/)
  assert.doesNotMatch(prompt('coder'), /\n- Call list_bots whenever/)
  assert.match(prompt('coder'), /mcp__chat-to-fix__<name>.*tool search/)
  assert.doesNotMatch(prompt('worker'), /mcp__chat-to-fix/)
  assert.ok(prompt('coder').length < prompt('worker').length)
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})
