// The plugin entry (core/plugin.ts) on the fake DSH context: one call builds the bot layer and
// the task layer, connects them, and the control interface answers.
//
// Run: node --import ./bot/test/harness-resolve.mjs --test --test-force-exit test/bot/plugin.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createChatToFix, inject, name } from '../../core/plugin.ts'
import { runtimeOf } from '../../core/bot/index.ts'
import { start } from './host.ts'

test('the plugin entry builds both layers, connects them, and serves the control interface', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-to-fix-plugin-'))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify({
    dataDir: join(dir, 'data'), worktreesDir: join(dir, 'worktrees'), httpPort: 0,
    apiModel: 'deepseek/v4-flash', codingModel: 'deepseek/v4-flash',
    bindings: [{ channel: 'C1', repo: 'group/project', jiraProject: 'DEMO' }],
  }))
  assert.equal(name, 'chat-to-fix')
  assert.equal(inject.length, 7)

  const host = await start(t, {
    build(ctx, home) {
      assert.throws(() => createChatToFix(ctx, { home }, { CHAT_TO_FIX_CONFIG: configPath }), /CHAT_TO_FIX_HTTP_TOKEN/)
      return createChatToFix(ctx, { home }, { CHAT_TO_FIX_CONFIG: configPath, CHAT_TO_FIX_HTTP_TOKEN: 'tok' })
    },
  })
  const { app, botlayer } = host.built
  assert.equal(typeof runtimeOf(botlayer).taskLayer.attachRoleTools, 'function')
  const port = await app.start()
  t.after(() => app.stop())
  const health = await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-chat-to-fix-token': 'tok' } })).json()
  assert.deepEqual(health, { up: true, queued: 0, running: 0, maxConcurrent: 1, queueMax: 20, queueFull: false, channels: ['C1'] })
  const refused = await fetch(`http://127.0.0.1:${port}/health`)
  assert.equal(refused.status, 401)
})
