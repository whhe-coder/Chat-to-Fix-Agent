// The DSH plugin entry of chat-to-fix: the bot layer (DS Bot's modules, core/bot/index.ts) plus the
// task layer (core/app.ts), connected in one process.
//
// A DSH profile loads this file as a plugin row (config/cordis.patch.yml). Configuration:
//   CHAT_TO_FIX_CONFIG       path of the configuration file (or `configPath` in the plugin row)
//   CHAT_TO_FIX_HTTP_TOKEN   the token every request to the control interface must carry
import { connectTaskLayer, createRuntime, defineTool, inject as botInject } from './bot/index.ts'
import { loadConfig, secret } from './config.ts'
import { createApp } from './app.ts'

export const name = 'chat-to-fix'
export const inject = botInject

export function createChatToFix(ctx, pluginConfig: any = {}, env = process.env) {
  const config = loadConfig({ path: pluginConfig.configPath, env })
  const token = secret(env, 'CHAT_TO_FIX_HTTP_TOKEN')
  if (token === undefined) throw new Error('chat-to-fix: CHAT_TO_FIX_HTTP_TOKEN is not set')
  // The model keys (ANTHROPIC_API_KEY) are read by DSH itself through the profile patch, never by this layer.
  const botlayer = createRuntime(ctx, { ...pluginConfig, language: config.language })
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
