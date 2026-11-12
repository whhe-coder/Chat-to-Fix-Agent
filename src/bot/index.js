// chat-to-fix's bot layer entry: DS Bot 0.3.1 trimmed to the modules the task layer needs
// (spec 5, 4.2). At this step the modules are imported straight from ../../bot (an
// unchanged baseline); the trimming packages A4a-A4d edit them later.
import { join } from 'node:path'
import * as diagnostics from '../../bot/src/host/diagnostics.js'
import * as store from '../../bot/src/host/store.js'
import * as models from '../../bot/src/host/models.js'
import * as permissions from '../../bot/src/host/permissions.js'
import * as turns from '../../bot/src/host/turns.js'
import * as handoffs from '../../bot/src/host/handoffs.js'
import * as requests from '../../bot/src/host/requests.js'
import * as delivery from '../../bot/src/host/delivery.js'
import * as roster from '../../bot/src/host/roster.js'
import * as folders from '../../bot/src/host/folders.js'
import * as prompt from '../../bot/src/host/prompt.js'
import * as timeContext from '../../bot/src/host/time-context.js'
import * as tools from '../../bot/src/host/tools.js'
import * as chatIndex from '../../bot/src/host/chat-index.js'
import * as groups from '../../bot/src/host/groups.js'
import * as approvals from '../../bot/src/host/approvals.js'
import * as resume from '../../bot/src/host/resume.js'
import * as parts from '../../bot/src/host/parts.js'
import * as localAgents from '../../bot/src/host/local-agents/index.js'
import * as stubs from './stubs.js'
import { createBotLayer } from '../task/botlayer.js'

export const name = 'chat-to-fix-bot'
// The original's eighth service, `connection`, served only the removed channel and feed.
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry']

// Order matters (see bot/index.js:55-58): diagnostics before store (store takes the log
// function), the stand-ins right after diagnostics, delivery before resume (resume wraps it).
const MODULES = [diagnostics, stubs, store, models, permissions, turns, handoffs, requests, delivery, roster, folders, prompt, timeContext, tools, chatIndex, groups, approvals, resume, parts, localAgents]

const runtimes = new WeakMap()
// The internal object behind a facade, for tests and for the later task-layer hooks.
export const runtimeOf = botlayer => runtimes.get(botlayer)

export function apply(ctx, config = {}) {
  createRuntime(ctx, config)
}

// DSH's own `defineTool`, the one tools.js uses; `createApp({ defineTool })` takes it so the
// role tools are defined the same way as the team tools. (Re-exported from tools.js because
// only files under bot/ can resolve @deepseek-ai/dsh-tools.)
export { defineTool } from '../../bot/src/host/tools.js'

// `config.taskLayer = { attachRoleTools, bridgedToolNames }` is kept on `rt.taskLayer`;
// tools.js (shareBotTools) calls attachRoleTools, local-agents/launch.js calls bridgedToolNames.
// `config` also carries what the Claude Code driver needs (local-agents/launch.js): engineAuth,
// engineApiKey, engineMaxTurns, testCommands, permissionTimeoutMs. Returns the I1 facade.
export function createRuntime(ctx, config = {}) {
  const dshHome = folders.dshHomeOf(process.env.DSH_HOME)
  const home = config.home ?? join(dshHome, 'bot')
  const rt = {
    ctx,
    config,
    dshHome,
    home,
    statePath: join(home, 'state.json'),
    teamTools: [],
    defaults: { mainName: config.mainName ?? 'Chief', mainRole: config.mainRole ?? 'Chief of Staff' },
    taskLayer: config.taskLayer,
  }
  for (const module of MODULES) module.install(rt)
  // Registered last, as channel.js did: this effect runs first on dispose, before the state lock goes.
  ctx.effect(() => { void rt.load() }, 'chat-to-fix: load state')
  const botlayer = createBotLayer(rt)
  // The facade, for the code that starts a Claude Code process: it asks which task role a session is bound to.
  rt.botlayer = botlayer
  runtimes.set(botlayer, rt)
  return botlayer
}

// The facade is created before the task layer (the task layer needs the facade), so the task
// layer is handed over afterwards: `taskLayer = { attachRoleTools, bridgedToolNames }`.
export function connectTaskLayer(facade, taskLayer) {
  const rt = runtimes.get(facade)
  if (rt === undefined) throw new Error('connectTaskLayer: not a bot layer facade')
  rt.taskLayer = taskLayer
}
