// The DSH packages of the agent-loop testkit, re-exported: harness-resolve.mjs resolves
// @deepseek-ai/* only for files under bot/, so tests outside it (test/bot/) import them from here.
export { Context } from '@deepseek-ai/cordis'
export { createUserMessage } from '@deepseek-ai/dsh-llm'
export { SessionId } from '@deepseek-ai/dsh-session'
export { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
