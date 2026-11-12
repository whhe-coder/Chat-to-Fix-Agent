// The DSH plugin entry of chat-to-fix: the bot layer (DS Bot's modules, core/bot/index.ts) plus the
// task layer (core/app.ts), connected in one process.
//
// A DSH profile loads this file as a plugin row (config/cordis.patch.yml). Configuration:
//   CHAT_TO_FIX_CONFIG       path of the configuration file (or `configPath` in the plugin row)
//   CHAT_TO_FIX_HTTP_TOKEN   the token every request to the control interface must carry
import { connectTaskLayer, createRuntime, defineTool, inject as botInject } from './bot/index.ts'
import { join } from 'node:path'
import { loadConfig, secret } from './config.ts'
import { createApp } from './app.ts'

export const name = 'chat-to-fix'
export const inject = botInject

/**
 * What the Claude Code driver reads from rt.config (bot/src/host/local-agents/launch.ts). The key is
 * given only when engineAuth is 'apiKey' (it then reaches the CLI as ANTHROPIC_API_KEY through
 * core/engine/env.ts authEnv); with 'login' no key goes to the child process. The key is taken from
 * the environment here and is not part of `config`, so it is never written or logged by this layer.
 * Personal-instruction isolation (claudeMdExcludes, a private config dir for 'apiKey') is explained in
 * core/engine/env.ts and launch.ts.
 * The per-binding test commands are not here: the launcher asks the task layer for them.
 */
export function engineSettings(config, env = process.env) {
  return {
    engineAuth: config.engineAuth,
    engineMaxTurns: config.limits.engineMaxTurns,
    codingEffort: config.codingEffort,
    codingModel: config.codingModel,
    ...(config.engineAuth === 'apiKey' ? { engineApiKey: secret(env, 'ANTHROPIC_API_KEY') } : {}),
  }
}

export function createChatToFix(ctx, pluginConfig: any = {}, env = process.env) {
  const config = loadConfig({ path: pluginConfig.configPath, env })
  const token = secret(env, 'CHAT_TO_FIX_HTTP_TOKEN')
  if (token === undefined) throw new Error('chat-to-fix: CHAT_TO_FIX_HTTP_TOKEN is not set')
  const engine = engineSettings(config, env)
  // engineConfigRoot: where the Claude Code CLI gets a private config dir per session under engineAuth
  // 'apiKey' (bot/src/host/local-agents/launch.ts isolatedConfigDir); inside the data folder, never ~/.claude.
  // It sits beside engineSettings, not in it: the settings object holds only what the key and limits decide.
  const botlayer = createRuntime(ctx, { ...pluginConfig, ...engine, engineConfigRoot: join(config.dataDir, 'engine-config'), language: config.language })
  // The task layer builds the adapters the configuration names (fake or real) itself.
  const app = createApp({ config, botlayer, defineTool, token })
  connectTaskLayer(botlayer, app.taskLayer)
  return { config, botlayer, app }
}

export function apply(ctx, pluginConfig = {}) {
  const { app } = createChatToFix(ctx, pluginConfig)
  // Started with the plugin and stopped with it: recorder, monitor, restart recovery, listener.
  ctx.effect(() => {
    const started = app.start().then(
      port => { console.log(`chat-to-fix: control interface on 127.0.0.1:${port}`) },
      (error) => { console.error('chat-to-fix: could not start the task layer:', error) },
    )
    return () => { void started.then(() => app.stop()).catch(() => {}) }
  }, 'chat-to-fix: task layer')
}
