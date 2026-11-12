// The DSH plugin entry of chat-to-fix: the bot layer (DS Bot's modules, src/bot/index.ts) plus the
// task layer (src/app.ts), connected in one process.
//
// A DSH profile loads this file as a plugin row (config/cordis.patch.yml). Configuration:
//   CHAT_TO_FIX_CONFIG       path of the configuration file (or `configPath` in the plugin row)
//   CHAT_TO_FIX_HTTP_TOKEN   the token every request to the control interface must carry
import { connectTaskLayer, createRuntime, defineTool, inject as botInject } from './bot/index.ts'
import { loadConfig, secret } from './config.ts'
import { createApp } from './app.ts'

export const name = 'chat-to-fix'
export const inject = botInject

export function createChatToFix(ctx, pluginConfig = {}, env = process.env) {
  const config = loadConfig({ path: pluginConfig.configPath, env })
  const token = secret(env, 'CHAT_TO_FIX_HTTP_TOKEN')
  if (token === undefined) throw new Error('chat-to-fix: CHAT_TO_FIX_HTTP_TOKEN is not set')
  // What the Claude Code driver reads from rt.config (bot/src/host/local-agents/launch.ts). The key is
  // given only when engineAuth is 'apiKey'; with 'login' no key goes to the child process.
  const engine = {
    engineAuth: config.engineAuth,
    engineMaxTurns: config.limits.engineMaxTurns,
    ...(config.engineAuth === 'apiKey' ? { engineApiKey: secret(env, 'ANTHROPIC_API_KEY') } : {}),
  }
  const botlayer = createRuntime(ctx, { ...pluginConfig, ...engine, language: config.language })
  // Adapters for Slack, Jira and GitLab are not built yet; the task layer runs without them.
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
