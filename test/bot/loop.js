// A real DSH agent loop (the agent-loop testkit, as in bot/test/local-agents-loop.test.js; the
// packages come through bot/test/loop-kit.js) whose
// model route is the local-agents adapter of a bot-layer host. Shared by the tests under
// test/bot/ and by the real-run script.
import { Context, SessionId, createUserMessage, mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '../../bot/test/loop-kit.js'

// The agent of `sessionId` on route claude-code; the role tools of that session (as the host's
// fake Agent scope holds them) are registered in the loop's tool scope, so a call that comes
// back over the MCP bridge runs the registry's wrapper.
export async function mountLoop(host, adapter, sessionId, { model = 'default', approval } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['claude-code'], adapter)
  if (approval !== undefined) ctx.provide('approval', approval)
  await mountAgentLoopTestHarness(ctx)
  const names = new Set(host.rt.taskLayer?.bridgedToolNames(sessionId) ?? [])
  for (const entry of host.agentOf(sessionId).registrations) {
    if (entry.active && names.has(entry.name)) ctx.tools.register(entry.def)
  }
  const agent = await ctx.agentLoop.create(SessionId(sessionId), { provider: 'claude-code', model })
  return { ctx, agent, close: () => ctx.fiber.dispose() }
}

export const send = (agent, text) => agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))

export function waitForIdle(ctx, agent, ms = 180_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { dispose(); reject(new Error('the turn did not end in time')) }, ms)
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { clearTimeout(timer); dispose(); resolve() }
    })
  })
}

export const events = agent => agent.session.snapshotEvents()
// The answer (text blocks) and the reasoning (activity lines) of the assistant messages.
const blocks = (agent, type) => events(agent).filter(event => event.type === 'assistant/message')
  .flatMap(event => (event.data.message.content ?? []).filter(block => block.type === type).map(block => block.text ?? ''))
export const answerOf = agent => blocks(agent, 'text').join('\n')
export const reasoningOf = agent => blocks(agent, 'reasoning').join('\n')
export const endOf = agent => events(agent).findLast(event => event.type === 'turn/end')?.data.reason.kind
