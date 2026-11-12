// Composition root of the task layer: builds every part and connects them.
//
// The bot layer (I1) and the adapters (I5) are passed in, so the same wiring runs against the
// real bot layer inside DSH and against the fake bot layer in tests. When no adapters are passed,
// the ones the configuration names are created (fake implementations until the real hookup exists).
import { createStore } from './task/store.ts'
import { createGate } from './task/gate.ts'
import { createQueue } from './task/queue.ts'
import { createHttp } from './task/http.ts'
import { createRunner } from './task/runner.ts'
import { createMonitor } from './task/monitor.ts'
import { createRecorder } from './task/recorder.ts'
import { createToolRegistry } from './tools/register.ts'
import { registerAllTools } from './tools/index.ts'
import { createAdapters } from './adapters/index.ts'
import { loadPrompt, groupNotice } from './prompts/index.ts'
import { allBotDefs, validateRegistry } from './registry/bots.ts'
import { validateFlow } from './flow/steps.ts'

const missingRepo = Object.freeze({
  diff: async () => { throw Object.assign(new Error('the repository adapter is not configured'), { code: 'no_adapter', retryable: false }) },
})

export function createApp({ config, botlayer, adapters: givenAdapters, token, defineTool, warn = (...args) => console.warn(...args), now = () => Date.now() }: any) {
  // Startup checks: a registry or flow definition that does not hold together stops the process here.
  const problems = [...validateRegistry(), ...validateFlow(allBotDefs())]
  if (problems.length) throw new Error(`chat-to-fix: the bot registry or the flow definition is invalid: ${problems.join('; ')}`)

  // The adapters named by the configuration (fake or real); a test may pass its own instead.
  const adapters = givenAdapters ?? createAdapters(config, { warn })

  const store = createStore({ dataDir: config.dataDir, warn })

  // The monitor ends tasks through the runner and the runner is built after it, so the call is late-bound.
  let runner
  const send = adapters.slack ? (origin, text) => adapters.slack.reply(origin, 'system', text) : undefined
  const monitor = createMonitor({ store, botlayer, limits: config.limits, end: (id, state, reason) => runner.end(id, state, reason), send, now, warn })
  runner = createRunner({ store, botlayer, config, monitor, notify: monitor.notify, loadPrompt, groupNotice, repo: adapters.repo, warn, now })
  const queue = createQueue({ store, limits: config.limits, runner, notify: monitor.notify as any, now })
  runner.bind({ queue })

  const gate = createGate({
    store,
    repo: adapters.repo ?? missingRepo,
    limits: config.limits,
    onClosed: (id, state, reason) => runner.end(id, state, reason),
  })
  const recorder = createRecorder({ store, botlayer, warn })
  // `defineTool` is DSH's own tool constructor (@deepseek-ai/dsh-tools), passed in by the plugin entry;
  // without it the registry registers plain definitions, which is what the tests use.
  const tools = createToolRegistry({ store, gate, adapters, config, botlayer, warn, ...(defineTool ? { defineTool } : {}) })
  registerAllTools(tools)
  const undefinedTools = tools.validate()
  if (undefinedTools.length) throw new Error(`chat-to-fix: the tool definitions do not match the bot registry: ${undefinedTools.join('; ')}`)
  const http = createHttp({ config, token, store, queue, runner, notify: monitor.notify })

  return {
    store, gate, queue, runner, monitor, recorder, tools, http,
    // The two functions the bot layer calls back (spec 5, section 3).
    taskLayer: {
      attachRoleTools: agent => tools.attachRoleTools(agent),
      bridgedToolNames: sessionId => tools.bridgedToolNames(sessionId),
    },
    async start() {
      recorder.start()
      monitor.start()
      await runner.restore()
      return http.listen()
    },
    async stop() {
      monitor.stop()
      recorder.stop()
      await http.close()
    },
  }
}
