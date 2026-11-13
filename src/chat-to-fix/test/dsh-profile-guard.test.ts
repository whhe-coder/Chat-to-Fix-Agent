// Guard for the DSH plugin tree of the chat-to-fix profile (docs/chat-to-fix/design/plan-dsh-trim.md section 6).
// Composes the tree with `dsh --dump-config` (nothing is started, no network, no model) and checks it against
// four lists: WHITELIST (rows that must be on), KEEP_DISABLED (rows that must stay off), REMOVED (rows the
// trim switched off) and PENDING (rows still on, waiting for a trim step). Strict: a row that is on and in
// none of WHITELIST / PENDING fails the test, so rows a DSH upgrade adds are decided one by one.
//
// When a trim step switches rows off: move them from PENDING to REMOVED. When the code starts using another
// DSH service: add it to SOFT_SERVICES, PROVIDER_OF and WHITELIST. After a DSH upgrade: run this test first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PATCH_FILE, PROJECT_DIR, dumpTree, isEnabled, parseRows, type Row } from '../scripts/lib/dsh-tree.ts'

const PLAN = 'docs/chat-to-fix/design/plan-dsh-trim.md'

interface Keep { id: string, pkg: string, why: string }

// Rows that must be on (plan section 2.3). `pkg` is the package the row must load; `why` says what needs it.
const WHITELIST: Keep[] = [
  { id: 'llm', pkg: '@deepseek-ai/dsh-llm', why: '我们的必需注入；`agent-loop`、`session-controller`、`llm-pi-ai` 都必需' },
  { id: 'llm-pi-ai', pkg: '@deepseek-ai/dsh-llm-pi-ai', why: 'anthropic 路线（补丁第 1 行），五个 bot 和审查者的模型都走它' },
  { id: 'tools', pkg: '@deepseek-ai/dsh-tools', why: '我们的必需注入；`agent-loop` 必需' },
  { id: 'system-prompt', pkg: '@deepseek-ai/dsh-system-prompt', why: '我们的必需注入；`tools`、`working-directory` 必需' },
  { id: 'session-controller', pkg: '@deepseek-ai/dsh-api-session-controller', why: '我们的必需注入；建会话、选模型、读投影' },
  { id: 'session', pkg: '@deepseek-ai/dsh-session', why: '我们的必需注入 `sessions`' },
  { id: 'session-title', pkg: '@deepseek-ai/dsh-session-title', why: '我们的必需注入 `sessionTitle`' },
  { id: 'workspace', pkg: '@deepseek-ai/dsh-workspace', why: '我们的必需注入 `workspaceRegistry`；`session-controller` 必需' },
  { id: 'agent', pkg: '@deepseek-ai/dsh-agent', why: '`agents`：`session-controller`、`agent-loop`、`session-title` 必需；我们 `ctx.get`' },
  { id: 'agent-loop', pkg: '@deepseek-ai/dsh-agent-loop', why: '跑回合；启动必需行' },
  { id: 'tool-executor-native', pkg: '@deepseek-ai/dsh-tool-executor-native', why: '执行工具调用；启动必需行' },
  { id: 'session-projection', pkg: '@deepseek-ai/dsh-session-projection', why: '`sessionProjections`：十几行必需；我们 `ctx.get`' },
  { id: 'working-directory', pkg: '@deepseek-ai/dsh-working-directory', why: '`session-controller`、`subagent` 必需；bot 工作目录' },
  { id: 'fs-sandbox', pkg: '@deepseek-ai/dsh-fs-sandbox', why: '提供 `fs`；写入限制在工作目录（补丁第 3、6b 行）' },
  { id: 'sandbox-policy', pkg: '@deepseek-ai/dsh-sandbox-policy', why: '`fs-sandbox`、`bash-sandbox` 必需；`folders.ts` 用' },
  { id: 'approval', pkg: '@deepseek-ai/dsh-user-approval', why: '`permission` 必需；补丁第 3 行 never' },
  { id: 'permission', pkg: '@deepseek-ai/dsh-permission-presets', why: '`permissions.ts` 用；`subagent` 用；补丁第 3 行' },
  { id: 'bash-sandbox', pkg: '@deepseek-ai/dsh-bash-sandbox', why: '提供 `shell`，`permission` 必需' },
  { id: 'subprocess', pkg: '@deepseek-ai/dsh-subprocess-local', why: '`bash-sandbox` 必需' },
  { id: 'sandbox', pkg: '@deepseek-ai/dsh-sandbox-local', why: '`bash-sandbox` 必需' },
  { id: 'session-query-sqlite', pkg: '@deepseek-ai/dsh-session-query-sqlite', why: '提供 `sessionQuery`，`session-controller` 必需' },
  { id: 'file-reference-local', pkg: '@deepseek-ai/dsh-file-reference-local', why: '提供 `fileReferences`，`session-controller` 的内嵌服务必需' },
  { id: 'attachment-local', pkg: '@deepseek-ai/dsh-attachment-local', why: '提供 `attachments`，`session-controller`、`file-upload` 必需；`delivery.ts` 用' },
  { id: 'file-upload', pkg: '@deepseek-ai/dsh-client-file-upload', why: '提供 `fileUploads`，`session-controller` 必需（补丁第 5 行注释）' },
  { id: 'connection', pkg: '@deepseek-ai/dsh-client-connection', why: '`file-upload` 必需；启动必需行（补丁里改写过，`inject: []`）' },
  { id: 'commands', pkg: '@deepseek-ai/dsh-commands', why: '`file-upload` 必需' },
  { id: 'credentials', pkg: '@deepseek-ai/dsh-credentials-local', why: '`connection`、`authorization` 必需；`models.ts` 用；`llm-pi-ai` 取 key' },
  { id: 'typert', pkg: '@deepseek-ai/dsh-typert-registry', why: '`session-controller`、`typert-gateway` 必需' },
  { id: 'typert-gateway', pkg: '@deepseek-ai/dsh-api-gateway', why: '`session-controller` 必需' },
  { id: 'remote-access', pkg: '@deepseek-ai/dsh-api-remote-access', why: '`session-controller`、`typert-gateway` 必需' },
  { id: 'typert-loader', pkg: '@deepseek-ai/dsh-typert-loader', why: '给已加载的包注册 typert 定义（`session-controller` 的主机方法从这来）；不提供服务' },
  { id: 'agent-default-model', pkg: '@deepseek-ai/dsh-agent-default-model', why: '`session-controller` 必需；`models.ts` 读默认模型、写回用户默认；补丁第 2 行' },
  { id: 'config-editor', pkg: '@deepseek-ai/dsh-config-editor', why: '`agent-default-model.saveSelection` 经它写个人资料补丁（DSH 选模型时写回，`models.ts` 第 203–226 行再改回用户默认）' },
  { id: 'settings', pkg: '@deepseek-ai/dsh-settings', why: '`agent-default-model`、`llm-pi-ai`、`agent-preset-registry` 可选使用；`session-controller` `ctx.get`' },
  { id: 'storage', pkg: '@deepseek-ai/dsh-storage', why: '`storage-domain` 必需' },
  { id: 'storage-json', pkg: '@deepseek-ai/dsh-storage-json', why: '`storage` 的后端' },
  { id: 'storage-domain', pkg: '@deepseek-ai/dsh-storage-domain', why: '`workspace` 必需' },
  { id: 'session-persistence-jsonl', pkg: '@deepseek-ai/dsh-session-persistence-jsonl', why: '提供 `sessionPersistence`，`workspace` 必需；会话落盘' },
  { id: 'session-projection-cache', pkg: '@deepseek-ai/dsh-session-projection-cache', why: '`session-controller` `ctx.get`；读投影的缓存' },
  { id: 'token-meter', pkg: '@deepseek-ai/dsh-token-meter', why: '投影 `tokenUsage`（计费）；`parts.ts` 用；预设里的压缩必需 `tokenMeter`' },
  { id: 'session-stats', pkg: '@deepseek-ai/dsh-session-stats', why: '投影 `sessionStats`（首字时间、速度）' },
  { id: 'subagent', pkg: '@deepseek-ai/dsh-subagent', why: '`request_review` 的 `startActivation`；`turns.ts` 停子 agent' },
  { id: 'subagent-spawn-in-process', pkg: '@deepseek-ai/dsh-subagent-spawn-in-process', why: '注册提供者 `spawn`，审查只用它' },
  { id: 'agent-preset-registry', pkg: '@deepseek-ai/dsh-agent-preset-registry', why: '`roster.ts` `botPreset`；`parts.ts` 取预设的压缩引擎；审查者的预设' },
  { id: 'preset-readonly', pkg: '@deepseek-ai/dsh-agent-preset', why: '四个流程 bot 和审查者（`core/registry/bots.ts` 第 33–78 行）' },
  { id: 'preset-coding', pkg: '@deepseek-ai/dsh-agent-preset', why: 'Coding bot（`bots.ts` 第 74 行）' },
  { id: 'skill', pkg: '@deepseek-ai/dsh-skill', why: '`sandbox` 可选使用、`session-controller` 的技能目录 `ctx.get`；便宜，留着' },
  { id: 'authorization', pkg: '@deepseek-ai/dsh-authorization', why: '`llm-pi-ai` 可选使用（提供者鉴权）' },
  { id: 'timer', pkg: '@deepseek-ai/cordis-plugin-timer', why: 'Cordis 的定时器基础服务' },
  { id: 'llm-retry', pkg: '@deepseek-ai/dsh-llm-retry', why: '模型请求失败时重试；没有它一次网络抖动就让任务失败' },
  { id: 'timeout-policy', pkg: '@deepseek-ai/dsh-tool-call-timeout-policy', why: '工具调用超时' },
  { id: 'spill-local', pkg: '@deepseek-ai/dsh-spill-local', why: '超大工具结果落文件（`spillStore`）' },
  { id: 'spill-policy', pkg: '@deepseek-ai/dsh-spill-policy', why: '控制超大结果进上下文的大小' },
  { id: 'session-checkpoint-policy', pkg: '@deepseek-ai/dsh-session-checkpoint-policy', why: '每步前落盘，崩溃后能接着跑' },
  { id: 'image-offload', pkg: '@deepseek-ai/dsh-compaction-image-offload', why: '图片超出模型额度时换成文字' },
  { id: 'repeat-tool-reminder', pkg: '@deepseek-ai/dsh-repeat-tool-reminder', why: '模型反复同参调用同一工具时提醒它换办法' },
  { id: 'chat-to-fix', pkg: 'chat-to-fix/src/chat-to-fix/core/plugin.ts', why: '入口' },
]

// Rows the patch switched off in sections 4 and 5 (telemetry, headless); they must stay off.
const KEEP_DISABLED: string[] = [
  'web-startup', 'webserver', 'web-runtime', 'modules',
  'client-hmr', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics',
  'session-log-download', 'ui-deliverables', 'directory-picker', 'open-in-app',
  'office-to-pdf', 'harness-dev-context', 'workspace-changes',
]

// Rows the trim has switched off (one block per step; see the plan, section 4).
const REMOVED: string[] = [
  // step 1
  'ui-file-actions', 'ui-context-menu', 'ui-open-in-app', 'ui-settings-account',
  'cordis-client-runner', 'ui-theme', 'locale', 'shortcuts',
  'ui-shortcuts', 'ui-layout', 'ui-renderer', 'ui-session',
  'resources', 'ui-sidebar', 'ui-sidebar-right', 'ui-sidebar-documentpreview',
  'ui-sidebar-terminal', 'ui-sidebar-files', 'ui-settings', 'ui-settings-general',
  'ui-settings-models', 'ui-plugin-manager', 'ui-settings-plugin-inventory', 'ui-conversation',
  'ui-approval', 'message-quotes', 'ui-chat', 'ui-brand-official',
  'ui-attachment', 'ui-file-drag', 'ui-tool', 'ui-cordis',
  'ui-workspace', 'ui-workflow-run', 'ui-input-trigger', 'ui-commands',
  'ui-skill', 'ui-subagent', 'ui-reference', 'ui-secret-mask',
  'ui-jobs', 'ui-schedule', 'ui-goal', 'ui-message-feedback',
  'ui-model-selection', 'ui-permission', 'ui-agent-preset', 'entry-customization',
  'ui-settings-session-log', 'ui-settings-plugins', 'ui-settings-shell', 'ui-settings-agent-loop',
  'ui-settings-subagent', 'ui-settings-web-search', 'ui-plan', 'ui-user-questions',
  'ui-trajectory',
]

// Rows that are still on and wait for a trim step. Each step moves its rows to REMOVED; at the end this is empty
// (step 10 decides the last six one by one: a row kept moves to WHITELIST with a reason).
const PENDING: string[] = [
  // step 2
  'api-remotes', 'job-controller', 'terminal-controller', 'workspace-files',
  'account-controller', 'settings-controller', 'workspace-controller', 'plugin-inventory',
  'message-feedback', 'command-feedback', 'session-turn-outline', 'session-reference',
  'cordis-host-runner', 'cordis-inspect-providers',
  // step 3
  'goal', 'goal-round-driver', 'schedule', 'mcp-resources',
  'otel',
  // step 4
  'web', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http',
  // step 5
  'plugin-manager',
  // step 6
  'llm-deepseek', 'llm-deepseek-account', 'deepseek-account', 'session-log-deepseek',
  'plugin-package-inventory-deepseek', 'deepseek-llm-api-extensions',
  // step 7
  'preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis',
  'ptc-runtime',
  // step 8
  'subagent-model-selection-settings', 'subagent-fork-in-process',
  // step 9
  'deliverable-file-references',
  // step 10
  'user-questions', 'jobs', 'shell-env', 'hmr',
  'tool-working-directory', 'session-title-llm',
]

// DSH services the code uses besides the required `inject` of core/bot/index.ts (plan section 2.1: `ctx.get(...)`).
const SOFT_SERVICES = ['subagents', 'agents', 'agentPresets', 'permissionPresets', 'workingDirectory', 'sandboxPolicy', 'approval',
  'tokenMeter', 'sessionProjections', 'attachments', 'credentials', 'agentDefaultModel']
// The row that provides each of those services (and the required ones).
const PROVIDER_OF: Record<string, string> = {
  llm: 'llm', tools: 'tools', systemPrompt: 'system-prompt', sessionController: 'session-controller', sessions: 'session',
  sessionTitle: 'session-title', workspaceRegistry: 'workspace', subagents: 'subagent', agents: 'agent',
  agentPresets: 'agent-preset-registry', permissionPresets: 'permission', workingDirectory: 'working-directory',
  sandboxPolicy: 'sandbox-policy', approval: 'approval', tokenMeter: 'token-meter', sessionProjections: 'session-projection',
  attachments: 'attachment-local', credentials: 'credentials', agentDefaultModel: 'agent-default-model',
}

const dumpText = await dumpTree()
const rows = parseRows(dumpText)
const byId = new Map<string, Row[]>()
for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r])
const on = (id: string) => { const r = byId.get(id)?.[0]; return r !== undefined && isEnabled(r) }

test('the dump has the format this test reads (if not, look at scripts/lib/dsh-tree.ts first)', () => {
  const hint = 'dump 格式变了，先看 dsh-tree.ts'
  assert.ok(rows.length >= 150, `${hint}: only ${rows.length} rows`)
  assert.equal((dumpText.match(/^- id:/gm) ?? []).length, rows.length, hint)
  const own = byId.get('chat-to-fix')?.[0]
  assert.ok(own, `${hint}: no chat-to-fix row`)
  assert.equal(own.name, 'chat-to-fix/src/chat-to-fix/core/plugin.ts', hint)
  const dup = [...byId].filter(([, v]) => v.length > 1).map(([k]) => k)
  assert.deepEqual(dup, [], `${hint}: duplicate row ids`)
})

test('every whitelist row is in the tree exactly once, on, and loads the expected package', () => {
  assert.equal(WHITELIST.length, 57)
  for (const w of WHITELIST) {
    const found = byId.get(w.id) ?? []
    assert.equal(found.length, 1, `白名单行 ${w.id} 不见了；它是因为 ${w.why} 要的，见 ${PLAN} 第 2.3 节`)
    assert.ok(isEnabled(found[0]), `白名单行 ${w.id} 被关掉了；它是因为 ${w.why} 要的，见 ${PLAN} 第 2.3 节`)
    assert.equal(found[0].name, w.pkg, `白名单行 ${w.id} 现在加载的包是 ${found[0].name}，应是 ${w.pkg}`)
  }
})

// The ids the patch switches off, with the line each is on, in block (`- id: x` + `disabled: true`) and flow
// (`- { id: x, disabled: true }`) form. Only top-level items; rows nested inside a preset are not looked at.
function patchDisabled(): Array<{ id: string, line: number }> {
  const out: Array<{ id: string, line: number }> = []
  const lines = readFileSync(PATCH_FILE, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const flow = /^- \{(.*)\}\s*(#.*)?$/.exec(lines[i])
    if (flow) {
      const id = /\bid:\s*([\w-]+)/.exec(flow[1])?.[1]
      if (id && /\bdisabled:\s*true\b/.test(flow[1])) out.push({ id, line: i + 1 })
      continue
    }
    const block = /^- id:\s*([\w-]+)/.exec(lines[i])
    if (!block) continue
    let j = i + 1
    for (; j < lines.length && !/^(- |#|$)/.test(lines[j]); j++) {
      if (/^  disabled:\s*true\b/.test(lines[j])) { out.push({ id: block[1], line: i + 1 }); break }
    }
  }
  return out
}

test('the patch does not switch off a whitelist row', () => {
  const white = new Set(WHITELIST.map(w => w.id))
  for (const d of patchDisabled()) {
    assert.ok(!white.has(d.id), `cordis.patch.yml 第 ${d.line} 行关掉了白名单行 ${d.id}；见 ${PLAN} 第 2.3 节`)
  }
})

test('rows that must stay off, and rows the trim removed, are off (or gone from the tree)', () => {
  for (const id of [...KEEP_DISABLED, ...REMOVED]) {
    assert.ok(!on(id), `行 ${id} 应该关着，现在开着`)
  }
})

test('every row the patch switches off is listed in KEEP_DISABLED or REMOVED', () => {
  const known = new Set([...KEEP_DISABLED, ...REMOVED])
  for (const d of patchDisabled()) {
    assert.ok(known.has(d.id), `cordis.patch.yml 第 ${d.line} 行关掉了 ${d.id}，但它不在 KEEP_DISABLED 或 REMOVED 里；挪一下 PENDING 里的名单`)
  }
})

test('the lists do not overlap, and PENDING rows are still on', () => {
  const lists = { WHITELIST: WHITELIST.map(w => w.id), KEEP_DISABLED, REMOVED, PENDING }
  const seen = new Map<string, string>()
  for (const [name, ids] of Object.entries(lists)) {
    for (const id of ids) {
      assert.ok(!seen.has(id), `行 ${id} 同时在 ${seen.get(id)} 和 ${name} 里`)
      seen.set(id, name)
    }
  }
  assert.equal(PENDING.length + REMOVED.length, 101, '第 1–10 步一共 101 行：PENDING + REMOVED 应该是 101')
  for (const id of PENDING) assert.ok(byId.has(id), `PENDING 里的行 ${id} 不在树里了（DSH 升级拿掉了？先从名单里去掉）`)
})

test('no row is on unless it is whitelisted or waiting in PENDING (strict: rows a DSH upgrade adds fail here)', () => {
  const allowed = new Set([...WHITELIST.map(w => w.id), ...PENDING])
  for (const r of rows) {
    if (!isEnabled(r)) continue
    assert.ok(allowed.has(r.id), `新开着的行 ${r.id}（包 ${r.name}）：要么写进白名单并写理由，要么在补丁里关掉`)
  }
})

test('agent presets: readonly and coding are on; after step 7 they are the only ones and the default is readonly', () => {
  const ids = rows
    .filter(r => r.name === '@deepseek-ai/dsh-agent-preset' && isEnabled(r))
    .map(r => /^ {4}id: (\S+)$/m.exec(r.text)?.[1])
  assert.ok(ids.includes('readonly') && ids.includes('coding'), `开着的预设 ${ids.join(', ')} 里要有 readonly 和 coding`)
  const registry = byId.get('agent-preset-registry')?.[0]?.text ?? ''
  const def = /^ {4}default: (\S+)/m.exec(registry)?.[1]
  if (REMOVED.includes('preset-standard')) {
    assert.deepEqual([...ids].sort(), ['coding', 'readonly'], 'standard 预设已删，开着的预设只能是 readonly 和 coding')
    assert.equal(def, 'readonly', '注册表默认预设必须是 readonly，standard 已经没有了')
  } else {
    assert.ok(def, 'agent-preset-registry 没有 default')
  }
})

test('the patch keeps its key settings and the startup-required rows stay off', () => {
  const text = (id: string) => byId.get(id)?.[0]?.text ?? ''
  assert.match(text('llm-pi-ai'), /^ {8}apiKeyEnv: ANTHROPIC_API_KEY$/m, 'llm-pi-ai 里要有 apiKeyEnv: ANTHROPIC_API_KEY')
  assert.match(text('approval'), /^ {4}policy: never\b/m, 'approval 里要有 policy: never')
  assert.match(text('connection'), /^ {2}inject: \[\]/m, 'connection 里要有 inject: []')
  for (const id of ['webserver', 'web-runtime', 'modules', 'web-startup']) {
    assert.ok(byId.has(id) && !on(id), `${id} 是启动必需行，开着起不来会让 DSH 不启动；它必须关着`)
  }
})

test('every DSH service the code uses is provided by a whitelisted row', () => {
  const src = readFileSync(path.join(PROJECT_DIR, 'core', 'bot', 'index.ts'), 'utf8')
  const required = /^export const inject = \[(.*)\]/m.exec(src)?.[1]
    .split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  assert.ok(required?.length, 'core/bot/index.ts 里读不到 export const inject')
  const white = new Set(WHITELIST.map(w => w.id))
  for (const service of [...required, ...SOFT_SERVICES]) {
    const row = PROVIDER_OF[service]
    assert.ok(row, `代码用了 DSH 服务 ${service}，但 PROVIDER_OF 里没有它：在 SOFT_SERVICES、PROVIDER_OF、WHITELIST 里各加一项`)
    assert.ok(white.has(row), `服务 ${service} 的提供行 ${row} 不在白名单里`)
  }
})
