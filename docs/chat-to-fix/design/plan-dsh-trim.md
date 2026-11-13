# DSH 瘦身方案（Chat-to-Fix）

- 日期：2026-11-13
- 状态：**第 0–7 步已在本分支实施并提交（2026-11-13，各一个提交，可单独回退）**；第 8–11 步还没做（第 8 步子 agent 附带行、第 9 步系统提示词那一段、第 10 步待拍板 6 行、第 11 步依赖瘦身和 `package.json`，都等 Zihui 另行决定）。实施记录见本文末“实施记录”一节。下文各节仍是方案原文。
- 依据：分支 `AIINITIATIVES-5733_dsh-coding`（PR #8），提交 `ae603a8`；根目录 `node_modules/@deepseek-ai/*`（DSH 0.2.2-rc.1）的实际文件；用当前检出重新跑的 `dsh --profile chat-to-fix --patch config/cordis.patch.yml --dump-config`（不启动、不执行 `!!js`，0.3 秒）。
- 规矩（Zihui 定）：DSH 的包不改。瘦身只通过我们的补丁行（`src/chat-to-fix/config/cordis.patch.yml`）和我们的根目录依赖做。
- 关联：[plan-dsh-coding.md](plan-dsh-coding.md)（五个 bot 都在 DSH 里跑、`request_review`、费用估计）、`src/chat-to-fix/config/README.md`（补丁行逐行说明）。

## 0. 一页结论

| 项 | 数 |
|---|---|
| 合成后的插件树 | 199 行，现在开着 158 行（和前一次只读调研的结果逐行一致） |
| 白名单（必须开着） | 57 行：DSH 56 行 + 我们的 `chat-to-fix` 行。DSH 的 56 行里 44 行由服务依赖链核实，12 行标“推断”（基础服务或运行行为上要留） |
| 分 9 步关掉 | 95 行（第 1–9 步），之后开着 63 行 |
| 待拍板 | 6 行（第 10 步）。都关掉后开着 57 行，正好是白名单 |
| 依赖瘦身 | 删 `jsdom`、`oxlint`、`@deepseek-ai/dsh-agent-loop-testkit`：−36.9 MB；`zod` 用 `overrides` 合成一份：约 −358 MB。`node_modules` 982 MB → 约 587 MB |
| 工作量 | 约 1.5–2 天，外加一次真实模型运行（约 $0.4–$2，要另外批准） |

和前一次调研的不同（这次逐个核实后改的）：

1. `session-stats` **不能删**。我们的计费读它的 `sessionStats` 投影（首字时间、输出速度，`core/task/botlayer.ts` 第 75 行）。前一次把它放在“浏览器 API”组里。
2. `subagent-fork-in-process` **可以删**。审查只用 `spawn` 提供者（`botlayer.ts` 第 192 行 `provider: 'spawn'`），`fork` 只给已经关掉的 `subagent_fork` 工具用。前一次把它放在保留里。
3. `api-remotes`、`deliverable-file-references` 从“浏览器 UI”组里拿出来单独处理：前者在主机上转发事件，后者往每个 bot 的系统提示词里加一段话。
4. `user-questions`、`jobs`、`shell-env`、`hmr`、`session-title-llm`、`tool-working-directory` 现在没有消费者，但删不删要拍板（第 10 步）。
5. “插件管理”组只有 `plugin-manager` 一行；`plugin-inventory` 归第 2 步，`plugin-package-inventory-deepseek` 归第 5 步（它要 DeepSeek 的服务）。

行关掉**不省磁盘**：包仍然由 `dsh-base`、`dsh-web-app` 两个包组带进来。省的是启动时加载的插件、服务、事件监听和对外能力（动态代码运行器、网页抓取、DeepSeek 账号登录和会话日志上传、MCP、OTel、计划任务、终端、插件安装）。磁盘只靠第 7 节的依赖瘦身。

## 1. 怎么查的

### 1.1 合成树

```sh
cd src/chat-to-fix && . scripts/dev-env.sh
T=$(mktemp -d); P=$T/dsh/profiles/chat-to-fix; mkdir -p $P $T/home
printf '%s\n' '{"name":"dsh-profile-chat-to-fix","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}' > $P/package.json
printf '[]\n' > $P/cordis.patch.yml
env -i PATH="$PATH" HOME=$T/home DSH_HOME=$T/dsh \
  node ../../node_modules/@deepseek-ai/dsh/lib/bin.js --profile chat-to-fix --patch config/cordis.patch.yml --dump-config > $T/tree.yml
```

`--dump-config` 不启动插件、不执行 `!!js`（`dsh/lib/dump-config-*.js` 的说明），只写临时目录。不需要 `node_modules/chat-to-fix` 链接（试过，结果一样）。前一次调研的 `dump.yml` 是在已经不存在的 `Chat-to-Fix-dsh` 检出上跑的，这次在当前检出上重跑，199 行逐行相同；唯一差别是那次的个人资料补丁里有一行 `agent-default-model`（DSH 选模型时写回的，见 2.3 的 `config-editor`）。

### 1.2 谁要谁

对每个开着的行，读它在包 `exports` 里的主机入口文件（不是浏览器入口），沿相对导入读完，提取：

- **必需注入**：模块级 `export const inject = [...]` 或类上的 `static inject = [...]`。缺一个，这行就停在 pending，启动审计会报出来（见 5.3）。
- **可选使用**：`ctx.inject([...], cb)`（有才跑）和 `ctx.get('x')`（没有就是 `undefined`）。
- **提供的服务**：`super(ctx, "名字")`。有 11 个服务是继承别的包的基类提供的（例如 `bash-sandbox` 继承 `dsh-bash-local` 的 `LocalBashExecutor`，基类里 `super(ctx, "shell")`），逐个对过：`attachments`、`sessionPersistence`、`shell`、`fs`、`sessionQuery`、`credentials`、`fileReferences`、`jobs`、`spillStore`、`subprocess`、`sandbox`。
- **启动必需行**：`dsh-app-boot` 的 `requiredStartupEntryIds` = `agent-loop`、`tool-executor-native`、`tool-executor-ptc`、`webserver`、`web-runtime`、`modules`、`connection`、`headless-runner`、`acp`、`sdk-jsonrpc-server`。开着的必须激活，关掉的不管。

然后把第 1–9 步逐步累加，检查剩下的每一行的必需注入都还有人提供。结果：每一步之后都没有新的缺口。唯一报出的 `workspace-controller` 要 `directoryPicker` 是现状（`directory-picker` 早就关了，它是该包里一个内嵌子服务的注入，现在的冒烟也没有告警），而且 `workspace-controller` 本身在第 2 步就关掉。

我们的代码要的服务另外从源码里找（`core/bot/index.ts` 的 `inject`，`bot/src/host/*.ts` 和 `core/task/botlayer.ts` 里所有 `ctx.get(...)`、`ctx.xxx`）。

局限：这是对打包后 JS 的静态扫描。“核实”指在代码里看到了调用或注入；“推断”指没有服务依赖，但按包的说明，它管的是我们要的运行行为。

## 2. 我们必需的东西（白名单）

### 2.1 我们的代码直接要的服务

| 服务 | 怎么要 | 我们哪里用（文件和符号） | 谁提供 |
|---|---|---|---|
| `llm` | 必需注入 | `core/bot/index.ts` 第 28 行 `inject`；`bot/src/host/models.ts` `catalog()` 用 `ctx.llm.listProviders/listModels/resolveModelInfo` | `llm`（`llm-pi-ai` 往里注册 anthropic 路线） |
| `tools` | 必需注入 | `bot/src/host/tools.ts` `ctx.tools.register/restrict/guard/schemas`（角色工具、`run_tests`、`request_review` 都经它注册） | `tools` |
| `systemPrompt` | 必需注入 | `bot/src/host/prompt.ts` 第 63 行 `ctx.systemPrompt.section` | `system-prompt` |
| `sessionController` | 必需注入 | `roster.ts` `createSession` → `create`；`models.ts` `selectSessionModel` → `selectModel`；`botlayer.ts` `readTotals` → `projections`；还有 `page`、`prompt`、`resolveAgent` | `session-controller` |
| `sessions` | 必需注入 | `parts.ts`、`groups.ts`、`delivery.ts` 里 `ctx.sessions.flush` | `session` |
| `sessionTitle` | 必需注入 | `roster.ts` `createSession` → `ctx.sessionTitle.rename` | `session-title` |
| `workspaceRegistry` | 必需注入 | `roster.ts` `ensureWorkspace` → `resolveByPath/create` | `workspace` |
| `subagents` | `ctx.get` | `botlayer.ts` `runReview` → `startActivation({ provider: 'spawn', delivery: 'caller', agentPreset })`；`turns.ts` 第 238 行 `interrupt` | `subagent` + `subagent-spawn-in-process`（提供者名 `spawn`） |
| `agents` | `ctx.get` | `botlayer.ts` 第 189 行；`turns.ts` 第 225、239 行；`tools.ts` 第 459 行 | `agent` |
| `agentPresets` | `ctx.get` | `roster.ts` `botPreset`（第 77 行）；`parts.ts` 第 297 行 `serviceFor(agent, 'compaction')` | `agent-preset-registry` |
| `permissionPresets` | `ctx.get` | `bot/src/host/permissions.ts` 第 11 行 | `permission` |
| `workingDirectory` | `ctx.get` | `folders.ts` 第 57 行，`parts.ts` 第 1234 行 | `working-directory` |
| `sandboxPolicy`、`approval` | `ctx.get` | `folders.ts` 第 158、167 行 | `sandbox-policy`、`approval` |
| `tokenMeter` | `ctx.get` | `parts.ts` 第 202、236 行 | `token-meter` |
| `sessionProjections` | `ctx.get` | `parts.ts` 第 1415 行，`time-context.ts` 第 26 行 | `session-projection` |
| `attachments` | `ctx.get` | `delivery.ts` 第 140、154 行 | `attachment-local` |
| `credentials` | `ctx.get` | `models.ts` `inPlace`（第 60 行） | `credentials` |
| `agentDefaultModel` | `ctx.get` | `models.ts` `defaultRef`、`defaultEffort`、`selectSessionModel`（第 118、198、213 行） | `agent-default-model` |
| 投影 `tokenUsage` | `sessionController.projections` 的值 | `botlayer.ts` `readTotals`（第 75 行 `values.tokenUsage`） | `token-meter` |
| 投影 `sessionStats` | 同上 | `botlayer.ts` 第 75 行 `values.sessionStats` | `session-stats` |

可选、删了也无妨的：`ctx.inject(['goals'])`（`tools.ts` 第 744 行，用来拦 `/goal`；`/goal` 命令行在 base 里本来就关着）、`ctx.get('directoryPicker')`（`folders.ts` 第 187 行，行早就关了）、`ctx.get('compaction')`（来自预设里的压缩组）。`run_tests`（`core/tools/tests.ts`）用 Node 的 `child_process.spawn`，不经 DSH 的 shell。

### 2.2 依赖链（必需注入，从入口往下）

```
chat-to-fix（core/plugin.ts，inject = core/bot/index.ts:28）
├─ llm ← llm；llm-pi-ai（anthropic 路线，补丁第 1 行）必需 llm
├─ tools ← tools ─ 必需 systemPrompt ← system-prompt
├─ sessions ← session
├─ sessionTitle ← session-title ─ 必需 sessions, sessionProjections, agents
├─ workspaceRegistry ← workspace ─ 必需 storageDomain ← storage-domain ← storage ← storage-json（后端）
│                                 └ 必需 sessionPersistence ← session-persistence-jsonl
└─ sessionController ← session-controller ─ 必需：
     fileReferences ← file-reference-local ─ 必需 agents, workingDirectory
     typert ← typert；typertGateway ← typert-gateway ─ 必需 typert, remoteAccess ← remote-access
     agents ← agent ─ 必需 sessionProjections ← session-projection
     sessionQuery ← session-query-sqlite ─ 必需 sessions
     workingDirectory ← working-directory ─ 必需 fs, sessionProjections, systemPrompt
        fs ← fs-sandbox ─ 必需 sandboxPolicy ← sandbox-policy ─ 必需 sessionProjections
     agentDefaultModel ← agent-default-model（可选 settings ← settings ─ 必需 configEditor ← config-editor）
     attachments ← attachment-local
     fileUploads ← file-upload ─ 必需 agents, attachments, commands ← commands, connection ← connection ─ 必需 credentials ← credentials
     llm, remoteAccess, sessions, sessionProjections, workspaceRegistry（见上）
运行回合：agent-loop（启动必需）─ 必需 agents, sessions, llm, tools, systemPrompt, sessionProjections
执行工具：tool-executor-native（启动必需）─ 必需 tools
审查（request_review）：subagent ─ 必需 workingDirectory, sessionProjections；subagent-spawn-in-process ─ 必需 subagents
预设：agent-preset-registry ─ 必需 sessionProjections, agents；preset-readonly / preset-coding ─ 必需 agentPresets
权限：permission ─ 必需 shell, approval, sessions, agents, sessionProjections
     shell ← bash-sandbox ─ 必需 subprocess ← subprocess, sandbox ← sandbox, sandboxPolicy
     approval ← approval（补丁第 3 行 policy: never）─ 必需 sessionProjections
计费：token-meter（tokenUsage）、session-stats（sessionStats）─ 都必需 sessionProjections
```

`bash-sandbox` 只是给 `permission` 提供 `shell` 服务；bash 工具（`tool-bash`）是关着的，没有 bot 能跑命令。

### 2.3 白名单逐行

| # | 行 | 包（`@deepseek-ai/`） | 为什么要 | 核实 |
|---|---|---|---|---|
| 1 | `llm` | `dsh-llm` | 我们的必需注入；`agent-loop`、`session-controller`、`llm-pi-ai` 都必需 | 核实 |
| 2 | `llm-pi-ai` | `dsh-llm-pi-ai` | anthropic 路线（补丁第 1 行），五个 bot 和审查者的模型都走它 | 核实（冒烟：请求到了 mock） |
| 3 | `tools` | `dsh-tools` | 我们的必需注入；`agent-loop` 必需 | 核实 |
| 4 | `system-prompt` | `dsh-system-prompt` | 我们的必需注入；`tools`、`working-directory` 必需 | 核实 |
| 5 | `session-controller` | `dsh-api-session-controller` | 我们的必需注入；建会话、选模型、读投影 | 核实 |
| 6 | `session` | `dsh-session` | 我们的必需注入 `sessions` | 核实 |
| 7 | `session-title` | `dsh-session-title` | 我们的必需注入 `sessionTitle` | 核实 |
| 8 | `workspace` | `dsh-workspace` | 我们的必需注入 `workspaceRegistry`；`session-controller` 必需 | 核实 |
| 9 | `agent` | `dsh-agent` | `agents`：`session-controller`、`agent-loop`、`session-title` 必需；我们 `ctx.get` | 核实 |
| 10 | `agent-loop` | `dsh-agent-loop` | 跑回合；启动必需行 | 核实 |
| 11 | `tool-executor-native` | `dsh-tool-executor-native` | 执行工具调用；启动必需行 | 核实 |
| 12 | `session-projection` | `dsh-session-projection` | `sessionProjections`：十几行必需；我们 `ctx.get` | 核实 |
| 13 | `working-directory` | `dsh-working-directory` | `session-controller`、`subagent` 必需；bot 工作目录 | 核实 |
| 14 | `fs-sandbox` | `dsh-fs-sandbox` | 提供 `fs`；写入限制在工作目录（补丁第 3、6b 行） | 核实 |
| 15 | `sandbox-policy` | `dsh-sandbox-policy` | `fs-sandbox`、`bash-sandbox` 必需；`folders.ts` 用 | 核实 |
| 16 | `approval` | `dsh-user-approval` | `permission` 必需；补丁第 3 行 never | 核实 |
| 17 | `permission` | `dsh-permission-presets` | `permissions.ts` 用；`subagent` 用；补丁第 3 行 | 核实 |
| 18 | `bash-sandbox` | `dsh-bash-sandbox` | 提供 `shell`，`permission` 必需 | 核实 |
| 19 | `subprocess` | `dsh-subprocess-local` | `bash-sandbox` 必需 | 核实 |
| 20 | `sandbox` | `dsh-sandbox-local` | `bash-sandbox` 必需 | 核实 |
| 21 | `session-query-sqlite` | `dsh-session-query-sqlite` | 提供 `sessionQuery`，`session-controller` 必需 | 核实 |
| 22 | `file-reference-local` | `dsh-file-reference-local` | 提供 `fileReferences`，`session-controller` 的内嵌服务必需 | 核实 |
| 23 | `attachment-local` | `dsh-attachment-local` | 提供 `attachments`，`session-controller`、`file-upload` 必需；`delivery.ts` 用 | 核实 |
| 24 | `file-upload` | `dsh-client-file-upload` | 提供 `fileUploads`，`session-controller` 必需（补丁第 5 行注释） | 核实 |
| 25 | `connection` | `dsh-client-connection` | `file-upload` 必需；启动必需行（补丁里改写过，`inject: []`） | 核实 |
| 26 | `commands` | `dsh-commands` | `file-upload` 必需 | 核实 |
| 27 | `credentials` | `dsh-credentials-local` | `connection`、`authorization` 必需；`models.ts` 用；`llm-pi-ai` 取 key | 核实 |
| 28 | `typert` | `dsh-typert-registry` | `session-controller`、`typert-gateway` 必需 | 核实 |
| 29 | `typert-gateway` | `dsh-api-gateway` | `session-controller` 必需 | 核实 |
| 30 | `remote-access` | `dsh-api-remote-access` | `session-controller`、`typert-gateway` 必需 | 核实 |
| 31 | `typert-loader` | `dsh-typert-loader` | 给已加载的包注册 typert 定义（`session-controller` 的主机方法从这来）；不提供服务 | 推断 |
| 32 | `agent-default-model` | `dsh-agent-default-model` | `session-controller` 必需；`models.ts` 读默认模型、写回用户默认；补丁第 2 行 | 核实 |
| 33 | `config-editor` | `dsh-config-editor` | `agent-default-model.saveSelection` 经它写个人资料补丁（DSH 选模型时写回，`models.ts` 第 203–226 行再改回用户默认） | 核实 |
| 34 | `settings` | `dsh-settings` | `agent-default-model`、`llm-pi-ai`、`agent-preset-registry` 可选使用；`session-controller` `ctx.get` | 核实（可选使用） |
| 35 | `storage` | `dsh-storage` | `storage-domain` 必需 | 核实 |
| 36 | `storage-json` | `dsh-storage-json` | `storage` 的后端 | 推断 |
| 37 | `storage-domain` | `dsh-storage-domain` | `workspace` 必需 | 核实 |
| 38 | `session-persistence-jsonl` | `dsh-session-persistence-jsonl` | 提供 `sessionPersistence`，`workspace` 必需；会话落盘 | 核实 |
| 39 | `session-projection-cache` | `dsh-session-projection-cache` | `session-controller` `ctx.get`；读投影的缓存 | 核实（可选使用） |
| 40 | `token-meter` | `dsh-token-meter` | 投影 `tokenUsage`（计费）；`parts.ts` 用；预设里的压缩必需 `tokenMeter` | 核实 |
| 41 | `session-stats` | `dsh-session-stats` | 投影 `sessionStats`（首字时间、速度） | 核实 |
| 42 | `subagent` | `dsh-subagent` | `request_review` 的 `startActivation`；`turns.ts` 停子 agent | 核实 |
| 43 | `subagent-spawn-in-process` | `dsh-subagent-spawn-in-process` | 注册提供者 `spawn`，审查只用它 | 核实 |
| 44 | `agent-preset-registry` | `dsh-agent-preset-registry` | `roster.ts` `botPreset`；`parts.ts` 取预设的压缩引擎；审查者的预设 | 核实 |
| 45 | `preset-readonly` | `dsh-agent-preset` | 四个流程 bot 和审查者（`core/registry/bots.ts` 第 33–78 行） | 核实（冒烟） |
| 46 | `preset-coding` | `dsh-agent-preset` | Coding bot（`bots.ts` 第 74 行） | 核实（冒烟） |
| 47 | `skill` | `dsh-skill` | `sandbox` 可选使用、`session-controller` 的技能目录 `ctx.get`；便宜，留着 | 推断 |
| 48 | `authorization` | `dsh-authorization` | `llm-pi-ai` 可选使用（提供者鉴权） | 推断 |
| 49 | `timer` | `cordis-plugin-timer` | Cordis 的定时器基础服务 | 推断 |
| 50 | `llm-retry` | `dsh-llm-retry` | 模型请求失败时重试；没有它一次网络抖动就让任务失败 | 推断（行为） |
| 51 | `timeout-policy` | `dsh-tool-call-timeout-policy` | 工具调用超时 | 推断（行为） |
| 52 | `spill-local` | `dsh-spill-local` | 超大工具结果落文件（`spillStore`） | 推断（行为） |
| 53 | `spill-policy` | `dsh-spill-policy` | 控制超大结果进上下文的大小 | 推断（行为） |
| 54 | `session-checkpoint-policy` | `dsh-session-checkpoint-policy` | 每步前落盘，崩溃后能接着跑 | 推断（行为） |
| 55 | `image-offload` | `dsh-compaction-image-offload` | 图片超出模型额度时换成文字 | 推断（行为） |
| 56 | `repeat-tool-reminder` | `dsh-repeat-tool-reminder` | 模型反复同参调用同一工具时提醒它换办法 | 推断（行为） |
| 57 | `chat-to-fix` | 我们的 `core/plugin.ts` | 入口 | — |

另外有 15 行必须**保持关着**（补丁第 4、5 节已经关的）：`web-startup`、`webserver`、`web-runtime`、`modules`、`client-hmr`、`session-telemetry-otel`、`desktop-product-telemetry`、`product-analytics`、`session-log-download`、`ui-deliverables`、`directory-picker`、`open-in-app`、`office-to-pdf`、`harness-dev-context`、`workspace-changes`。守门测试也查它们。

## 3. 可以删的（逐组）

每组的检查方法：列出这组提供的服务，在 1.2 的扫描结果里找“谁必需它、谁可选使用它、谁 `ctx.get` 它”，再在我们的代码里搜。下面“消费者”一栏就是结果。

### 3.1 第 1 组：浏览器界面的主机一半（57 行，风险最低）

行：`ui-file-actions`、`ui-context-menu`、`ui-open-in-app`、`ui-settings-account`、`cordis-client-runner`、`ui-theme`、`locale`、`shortcuts`、`ui-shortcuts`、`ui-layout`、`ui-renderer`、`ui-session`、`resources`、`ui-sidebar`、`ui-sidebar-right`、`ui-sidebar-documentpreview`、`ui-sidebar-terminal`、`ui-sidebar-files`、`ui-settings`、`ui-settings-general`、`ui-settings-models`、`ui-plugin-manager`、`ui-settings-plugin-inventory`、`ui-conversation`、`ui-approval`、`message-quotes`、`ui-chat`、`ui-brand-official`、`ui-attachment`、`ui-file-drag`、`ui-tool`、`ui-cordis`、`ui-workspace`、`ui-workflow-run`、`ui-input-trigger`、`ui-commands`、`ui-skill`、`ui-subagent`、`ui-reference`、`ui-secret-mask`、`ui-jobs`、`ui-schedule`、`ui-goal`、`ui-message-feedback`、`ui-model-selection`、`ui-permission`、`ui-agent-preset`、`entry-customization`、`ui-settings-session-log`、`ui-settings-plugins`、`ui-settings-shell`、`ui-settings-agent-loop`、`ui-settings-subagent`、`ui-settings-web-search`、`ui-plan`、`ui-user-questions`、`ui-trajectory`。

- 检查：这些行的主机入口都是一个文件，绝大多数没有必需注入，只在 `settings` 里登记界面设置。有主机服务的只有三个：`ui-trajectory`（`sessionToolResults`，必需 `sessions`、`typert`）、`ui-plugin-manager`（`pluginRegistryProbe`）、`resources`（`resources`）。白名单里没有任何行必需或 `ctx.get` 这些服务；只有第 2 组的 `workspace-files` 用 `resources`，它同样要关。浏览器入口在 `modules` 关掉以后本来就不会送到任何浏览器。
- 对运维：看不到变化。没有网页服务，这些行现在也什么都不做。
- 风险：低。

### 3.2 第 2 组：给浏览器的主机 API（14 行）

行：`api-remotes`、`job-controller`、`terminal-controller`、`workspace-files`、`account-controller`、`settings-controller`、`workspace-controller`、`plugin-inventory`、`message-feedback`、`command-feedback`、`session-turn-outline`、`session-reference`、`cordis-host-runner`、`cordis-inspect-providers`。

| 行 | 提供 | 消费者（除第 1、2 组和关着的行外） |
|---|---|---|
| `api-remotes` | 把主机事件转发给远端（浏览器） | 无；`session-controller` 是进程内调用，不经它 |
| `job-controller` | `jobController` | 无 |
| `terminal-controller` | `terminalController`（xterm 无头终端） | 无 |
| `workspace-files` | `workspaceFiles` | 只有关着的 `office-to-pdf` |
| `account-controller` | `accountController` | 无 |
| `settings-controller` | `settingsController`、`credentialsController` | 无（我们直接 `ctx.get('credentials')`） |
| `workspace-controller` | `workspaceController`、`directoryPickerController` | 无（我们直接用 `workspaceRegistry`） |
| `plugin-inventory` | `pluginInventory` | 无 |
| `message-feedback`、`command-feedback` | `messageFeedback`、`sessionFeedback`（`/feedback` 命令） | 无 |
| `session-turn-outline` | 投影 `turnOutline` | 无；我们只读 `tokenUsage`、`sessionStats` |
| `session-reference` | `sessionReferenceResolver`（`@会话` 引用） | 无 |
| `cordis-host-runner` | `cordisInspect`、`dynamicCordisRunner`（在 `node:vm` 里跑动态定义） | 只有 `cordis-inspect-providers`（同组） |
| `cordis-inspect-providers` | `tool-cordis` 的主机提供者 | 无 |

- 投影缺了不会出错：`session-controller` 的投影线上格式里每个字段都是 `.optional()`（`typert.host.js` 第 156 行起），而且 `todos`、`plan` 两个投影的行现在就关着，系统照常跑。
- 对运维：没有变化；少了一个动态代码运行器和一个终端控制器。
- 风险：低。

### 3.3 第 3 组：杂项（5 行）

行：`goal`、`goal-round-driver`、`schedule`、`mcp-resources`、`otel`。

- `goal`（`goals`）：消费者是 `goal-round-driver`（同组）、`command-goal`、`tool-goal`（都关着），和我们 `tools.ts` 第 744 行的可选 `ctx.inject(['goals'])`（拦 `/goal`；`/goal` 命令本来就没有）。
- `schedule`（`schedule`）：消费者是 `tool-schedule`（没加载）和 `ui-schedule`（第 1 组）；DS Bot 的 `schedules.ts` 不在我们装的模块里（`core/bot/index.ts` `MODULES`）。
- `mcp-resources`（`mcpResources`）：消费者是 `dsh-mcp-client`（没加载）。我们没有配置任何 MCP 服务。
- `otel`（`otel`）：消费者是 `session-telemetry-otel`、`desktop-product-telemetry`（都关着）。它的依赖带着 OpenTelemetry SDK 和 `got`。
- 对运维：没有变化。
- 风险：低。

### 3.4 第 4 组：网页搜索和抓取（4 行）

行：`web`、`web-search-deepseek`、`web-deepseek-api`、`web-fetch-http`。

- `web`（`web`）：消费者是同组三行和 `tool-web`（关着）。我们的预设都没有 web 工具（冒烟查过）。
- 对运维：没有变化；进程里不再有能往外发请求的网页抓取（`undici`）。
- 风险：低。要在第 5 组之前做，因为两行 DeepSeek 搜索可选使用 `deepseekAccount`。

### 3.5 第 5 组：插件管理（1 行）

行：`plugin-manager`。

- 提供 `pluginManager`（能装、删插件包，跑 pnpm）。消费者：`plugin-inventory`（第 2 组）、`tool-plugin-manager`（关着）、`plugin-market` 等（没加载）。
- 对运维：没有变化；进程里不再有装包能力。
- 风险：低。`hmr` 不在这一步（见第 10 步）。

### 3.6 第 6 组：DeepSeek 模型和账号（6 行）

行：`deepseek-llm-api-extensions`、`session-log-deepseek`、`plugin-package-inventory-deepseek`、`deepseek-account`、`llm-deepseek`、`llm-deepseek-account`。

- `deepseek-llm-api-extensions`：消费者是 `llm-deepseek`、`session-log-deepseek`、`plugin-package-inventory-deepseek`（都在本组）。
- `session-log-deepseek`：把会话日志增量上传给 DeepSeek 官方 API（只在请求 DeepSeek 时）。我们不用 DeepSeek，现在不会触发；关掉是多一层保险。
- `deepseek-account`（`deepseekAccount`，浏览器登录）：消费者是 `account-controller`（第 2 组）、`llm-deepseek-account`（本组）、两行 DeepSeek 搜索（第 4 组）。
- `llm-deepseek`、`llm-deepseek-account`：往 `llm` 里注册 `deepseek` 和 `deepseek-account` 两条路线。
- 对运维：**模型目录里不再有 DeepSeek 路线**。配置里写 `deepseek/...` 的模型会跑不起来（`core/config.ts` 只检查格式 `提供者/模型`）。anthropic 和 pi-ai 的其他提供者不受影响。DS Bot 的模型目录（`models.ts` `catalog`）变短，默认模型照旧是补丁第 2 行的 anthropic。
- 风险：低到中。要拍板：确认没有部署用 DeepSeek 路线。

### 3.7 第 7 组：没用的预设和 PTC（5 行，加一处配置）

行：`preset-standard`、`preset-ptc`、`preset-minimal`、`preset-cordis`、`ptc-runtime`；同时把 `agent-preset-registry` 的 `default` 从 `standard` 改成 `readonly`。

- 预设行只登记到 `agentPresets`，没有别的消费者。我们每个会话都指名预设：`roster.ts` `createSession` → `botPreset(preset)`；bot 都带 `preset`（`bots.ts`）；群的转发会话用 `readonly`；审查传 `reviewer.preset`（`readonly`）。
- 但默认预设是 `standard`（合成树里 `agent-preset-registry` 的 `config.default: standard`）。`botPreset` 不传参数时用 `'standard'`，找不到就返回 `{}`，也就是用注册表默认；注册表默认指向一个不存在的预设会报 `Unknown agent preset`（`agent-preset/not-found`）。所以默认必须同时改成 `readonly`（最小权限）。
- `ptc-runtime`（必需 `fs`、`subprocess`、`sandbox`、`sandboxPolicy`）：消费者是 `tool-executor-ptc`、`workflow-ptc`（都关着）和 `preset-ptc`（本组）。
- 对运维：还在用 `standard` 预设的旧会话（我们的 bot 层不建这种会话，但旧数据目录里可能有）不能再继续。**部署时不能有正在跑的任务**；任务停掉时 bot 和群会被删（冒烟查过），新任务都在新会话上。
- 风险：中。

### 3.8 第 8 组：子 agent 的附带行（2 行）

行：`subagent-model-selection-settings`、`subagent-fork-in-process`。

- `subagent-model-selection-settings`：提供 `subagentModelSelection` 和投影 `subagentModelSelectionPolicy`。只有 `dsh-tool-subagent`（`subagent`/`subagent_fork` 工具，关着）用。`dsh-subagent` 和 `dsh-subagent-spawn-in-process` 的代码里都没有这两个名字；审查者继承父会话的模型和强度（`botlayer.ts` 第 181 行注释）。
- `subagent-fork-in-process`：注册提供者 `fork`。提供者按名字查（`dsh-subagent` `expectProvider(name)`），审查只要 `spawn`。
- 对运维：没有变化。
- 风险：中（紧挨着审查）。冒烟覆盖不到审查（审查要到 `code` 步，冒烟的任务停在第 1 步），要一次真实模型运行确认（见 5.4）。

### 3.9 第 9 组：改系统提示词的行（1 行）

行：`deliverable-file-references`。

- 必需 `systemPrompt`，往**每个会话**的系统提示词里加一段固定的“怎么给文件链接、怎么交付文件”（给网页和 SDK 用的）。我们的输出走 Slack，用不上。
- 对运维：每个 bot 的系统提示词少一段，token 略省；模型行为可能有细微变化。
- 风险：中（行为变化）。要拍板；和第 8 组一起用同一次真实运行验证。

### 3.10 第 10 步：待拍板的 6 行

| 行 | 现在谁用 | 关掉的影响 | 风险 |
|---|---|---|---|
| `user-questions` | `plan-mode`、`tool-ask-user`（都没开）；审批策略是 never，不会问人 | 没有 | 低 |
| `jobs`（`dsh-jobs-local`） | `tool-bash`、`tool-jobs`（关着）、`job-controller`（第 2 组） | 没有 | 低 |
| `shell-env` | `tool-bash`、`tool-pwsh`、`web-app`（都关着） | 没有 | 低 |
| `hmr` | `config-editor` 可选使用（没有就直接写，`dsh-config-editor` 第 132–133 行）；`plugin-manager`（第 5 组） | 配置写入不再经热重载队列；DS Bot 自己把选模型串行了（`models.ts` `selecting`） | 低到中 |
| `session-title-llm` | `sessionTitle` 的可选提供者，用模型给新会话起名 | 可能省掉每个会话一次起名的模型调用（bot 层建会话后马上 `rename`，是否还会触发要看冒烟的 mock 日志） | 低 |
| `tool-working-directory` | 给模型一个“看/换当前目录”的工具 | 冒烟查到 Coding bot 的工具清单里没有它（被 DS Bot 隐藏或没组合进去）；关掉更稳 | 低 |

建议：前四行和 `tool-working-directory` 关；`session-title-llm` 先在冒烟里数一下起名请求再定。

## 4. 分步顺序

总原则：一步一个提交，提交里只有补丁和守门测试的名单两处改动；先做第 0 步。每一步的改动都加在 `cordis.patch.yml` 末尾一个新的第 8 节里（注释用英文，和文件其他部分一致）：

```yaml
# 8. Trim (docs/chat-to-fix/design/plan-dsh-trim.md): rows nothing in chat-to-fix uses, switched off
#    group by group. The whitelist and the removed rows are asserted by test/dsh-profile-guard.test.ts.
```

回退：删掉这一步的片段（或 `git revert` 这一步的提交），重启 Agent。关掉的行还在树里，删片段就恢复原样；没有数据迁移。第 7 步回退时连同 `agent-preset-registry` 那一行一起删。

| 步 | 内容 | 行数 | 风险 | 需要真实模型 |
|---|---|---|---|---|
| 0 | 守门测试、行清单脚本、记基线 | 0 | 无 | 否 |
| 1 | 第 1 组 浏览器界面 | 57 | 低 | 否 |
| 2 | 第 2 组 浏览器 API | 14 | 低 | 否 |
| 3 | 第 3 组 杂项 | 5 | 低 | 否 |
| 4 | 第 4 组 网页 | 4 | 低 | 否 |
| 5 | 第 5 组 插件管理 | 1 | 低 | 否 |
| 6 | 第 6 组 DeepSeek（要拍板） | 6 | 低到中 | 否 |
| 7 | 第 7 组 预设 + 默认改 `readonly` | 5 | 中 | 和 8、9 一起跑一次 |
| 8 | 第 8 组 子 agent 附带行 | 2 | 中 | 同上 |
| 9 | 第 9 组 系统提示词（要拍板） | 1 | 中 | 同上 |
| 10 | 待拍板的 6 行（逐行） | ≤6 | 低 | 否 |
| 11 | 依赖瘦身（第 7 节，单独的提交） | — | 低 / 中 | 否 |

### 第 0 步：守门测试和基线

- 按第 6 节写 `scripts/lib/dsh-tree.ts`、`scripts/dsh-rows.ts`、`test/dsh-profile-guard.test.ts`。名单：白名单 57 行、保持关着 15 行、待定 `PENDING` = 第 1–10 步的全部 101 行（此时它们还开着，严格检查把它们算作允许）、已删 `REMOVED` 为空。
- 记基线（写进这一步的提交说明）：`node scripts/dsh-rows.ts > rows-before.txt`；`npm run typecheck`；`npm test` 各套件的数；`npm run smoke:agent` 全过；冒烟里从启动到 `chat-to-fix: control interface on` 的秒数；运行中进程组的内存（`ps -o rss= -g <进程组>` 求和）；mock 日志里的请求数和其中不带角色工具的请求数（起名一类）。

### 第 1 步

```yaml
- { id: ui-file-actions, disabled: true }
- { id: ui-context-menu, disabled: true }
- { id: ui-open-in-app, disabled: true }
- { id: ui-settings-account, disabled: true }
- { id: cordis-client-runner, disabled: true }
- { id: ui-theme, disabled: true }
- { id: locale, disabled: true }
- { id: shortcuts, disabled: true }
- { id: ui-shortcuts, disabled: true }
- { id: ui-layout, disabled: true }
- { id: ui-renderer, disabled: true }
- { id: ui-session, disabled: true }
- { id: resources, disabled: true }
- { id: ui-sidebar, disabled: true }
- { id: ui-sidebar-right, disabled: true }
- { id: ui-sidebar-documentpreview, disabled: true }
- { id: ui-sidebar-terminal, disabled: true }
- { id: ui-sidebar-files, disabled: true }
- { id: ui-settings, disabled: true }
- { id: ui-settings-general, disabled: true }
- { id: ui-settings-models, disabled: true }
- { id: ui-plugin-manager, disabled: true }
- { id: ui-settings-plugin-inventory, disabled: true }
- { id: ui-conversation, disabled: true }
- { id: ui-approval, disabled: true }
- { id: message-quotes, disabled: true }
- { id: ui-chat, disabled: true }
- { id: ui-brand-official, disabled: true }
- { id: ui-attachment, disabled: true }
- { id: ui-file-drag, disabled: true }
- { id: ui-tool, disabled: true }
- { id: ui-cordis, disabled: true }
- { id: ui-workspace, disabled: true }
- { id: ui-workflow-run, disabled: true }
- { id: ui-input-trigger, disabled: true }
- { id: ui-commands, disabled: true }
- { id: ui-skill, disabled: true }
- { id: ui-subagent, disabled: true }
- { id: ui-reference, disabled: true }
- { id: ui-secret-mask, disabled: true }
- { id: ui-jobs, disabled: true }
- { id: ui-schedule, disabled: true }
- { id: ui-goal, disabled: true }
- { id: ui-message-feedback, disabled: true }
- { id: ui-model-selection, disabled: true }
- { id: ui-permission, disabled: true }
- { id: ui-agent-preset, disabled: true }
- { id: entry-customization, disabled: true }
- { id: ui-settings-session-log, disabled: true }
- { id: ui-settings-plugins, disabled: true }
- { id: ui-settings-shell, disabled: true }
- { id: ui-settings-agent-loop, disabled: true }
- { id: ui-settings-subagent, disabled: true }
- { id: ui-settings-web-search, disabled: true }
- { id: ui-plan, disabled: true }
- { id: ui-user-questions, disabled: true }
- { id: ui-trajectory, disabled: true }
```

流式写法 `{ id: x, disabled: true }` 和现有的块写法等价。2026-11-13 用 `--dump-config` 叠加一个临时片段试过：`ui-file-actions` 合成为 `disabled: true`，第 7 步的 `agent-preset-registry` 合成为 `default: readonly`，开着的行从 158 变 156，别的不变。真正启动时的加载器是否同样认，第 1 步的冒烟会确认；不认就改成块写法。

### 第 2 步

```yaml
- { id: api-remotes, disabled: true }
- { id: job-controller, disabled: true }
- { id: terminal-controller, disabled: true }
- { id: workspace-files, disabled: true }
- { id: account-controller, disabled: true }
- { id: settings-controller, disabled: true }
- { id: workspace-controller, disabled: true }
- { id: plugin-inventory, disabled: true }
- { id: message-feedback, disabled: true }
- { id: command-feedback, disabled: true }
- { id: session-turn-outline, disabled: true }
- { id: session-reference, disabled: true }
- { id: cordis-host-runner, disabled: true }
- { id: cordis-inspect-providers, disabled: true }
```

### 第 3 步

```yaml
- { id: goal, disabled: true }
- { id: goal-round-driver, disabled: true }
- { id: schedule, disabled: true }
- { id: mcp-resources, disabled: true }
- { id: otel, disabled: true }
```

### 第 4 步

```yaml
- { id: web, disabled: true }
- { id: web-search-deepseek, disabled: true }
- { id: web-deepseek-api, disabled: true }
- { id: web-fetch-http, disabled: true }
```

### 第 5 步

```yaml
- { id: plugin-manager, disabled: true }
```

### 第 6 步（拍板后）

```yaml
- { id: llm-deepseek, disabled: true }
- { id: llm-deepseek-account, disabled: true }
- { id: deepseek-account, disabled: true }
- { id: session-log-deepseek, disabled: true }
- { id: plugin-package-inventory-deepseek, disabled: true }
- { id: deepseek-llm-api-extensions, disabled: true }
```

### 第 7 步

```yaml
# The shipped default preset `standard` is switched off below, so the registry's default (used only by a
# session created without a preset; the bot layer names one for every session) becomes the read-only one.
- id: agent-preset-registry
  config:
    default: readonly
- { id: preset-standard, disabled: true }
- { id: preset-ptc, disabled: true }
- { id: preset-minimal, disabled: true }
- { id: preset-cordis, disabled: true }
- { id: ptc-runtime, disabled: true }
```

`config` 会整块替换这一行的配置；合成树里它只有 `default: standard` 一个键，所以这样写没有丢东西。实施时再看一次合成树确认。

### 第 8 步

```yaml
- { id: subagent-model-selection-settings, disabled: true }
- { id: subagent-fork-in-process, disabled: true }
```

### 第 9 步（拍板后）

```yaml
- { id: deliverable-file-references, disabled: true }
```

### 第 10 步（逐行拍板）

```yaml
- { id: user-questions, disabled: true }
- { id: jobs, disabled: true }
- { id: shell-env, disabled: true }
- { id: hmr, disabled: true }
- { id: tool-working-directory, disabled: true }
# - { id: session-title-llm, disabled: true }   # after counting title requests in the smoke run's mock log
```

每关一行，就把它从守门测试的 `PENDING` 挪到 `REMOVED`；留下的从 `PENDING` 挪进白名单并写上理由。

## 5. 每一步的验证

### 5.1 每一步都做

1. **合成树对比**：`node scripts/dsh-rows.ts > rows-after.txt; diff rows-before.txt rows-after.txt`。只允许这一步名单里的行从 `on` 变成 `off`（第 7 步另有 `agent-preset-registry` 的配置变化），行数 199 不变，别的行一行都不变。
2. `npm run typecheck`：无错（这几步不改代码，主要是确认守门测试本身）。
3. `npm test`：全过；其中 `dsh-profile-guard` 在白名单行被关掉时会失败。
4. `npm run smoke:agent`：全过。和瘦身直接相关的几项：
   - `every plugin row activated (no startup warning in the log)`：日志里没有 `did not activate`、`StartupError`；
   - 五个 bot 和群建成，流程 bot 在 `readonly`、Coding bot 在 `coding`；
   - Main bot 和 Coding bot 的工具清单不多不少；
   - `the Coding bot's round is billed from DSH projections`（`tokenUsage`、`sessionStats` 还在）；
   - 没有出 127.0.0.1 的连接，没有对外 HTTP(S) 请求。
5. 和基线比：启动秒数、内存、mock 请求数，记在提交说明里。

### 5.2 各步额外看的

| 步 | 额外看 |
|---|---|
| 1、2 | 冒烟的 `GET /health`、建任务、停任务照常；日志里没有新的告警 |
| 3 | 冒烟里 Main bot 的工具清单没有变（`mcp-resources` 不会再加工具） |
| 4、6 | 对外请求和外连两项照常通过；第 6 步再看 Coding bot 的用量行 `model` 仍是 `claude-sonnet-5-5`，`effort high` |
| 5 | 无 |
| 7 | 预设那一项；日志里没有 `agent-preset/not-found`、`Unknown agent preset`、`The permission preset ... is not available`（`roster.ts` `botPreset`） |
| 8、9 | 真实运行（5.4）。第 9 步另外对比 mock 日志里系统提示词的开头和长度，确认只少了那一段 |
| 10 | 关 `session-title-llm` 前后比 mock 日志里不带角色工具的请求数 |

### 5.3 缺服务时日志里长什么样

日志在 `$CHAT_TO_FIX_DATA/run/chat-to-fix.log`（启动脚本把标准输出和错误都写进去）。

| 现象 | 日志 | 意思 |
|---|---|---|
| 非必需行缺服务 | `dsh: warning: N entries did not activate`，下面每行 `<行> (<包>): pending (waiting for services: <服务>)` | 那一行没起来；如果是 `chat-to-fix` 行，我们的插件没起来 |
| 必需行缺服务 | `dsh: startup failed: N required plugins did not activate`，然后 `Plugins waiting for services (N):` 表，必需行标 `(required)` | DSH 不启动 |
| 我们的插件没起来 | 没有 `chat-to-fix: control interface on 127.0.0.1:`；启动脚本 90 秒后报 `no control interface after 90s` | 通常是上面第一行的结果 |
| 任务层启动失败 | `chat-to-fix: could not start the task layer` | 启动脚本会停掉进程 |
| 审查起不来 | 工具结果 `the DSH subagents service is not available`，或 DSH 的 `no subagent provider registered for "spawn"` | `subagent` 或 `subagent-spawn-in-process` 没了 |
| 预设缺了 | `agent-preset/not-found` / `Unknown agent preset: <id>` | 第 7 步的问题 |
| 计费读不到 | `chat-to-fix: could not read the usage projections of …`、`usage of … was not recorded` | `session-controller` 或投影的问题 |

冒烟已经把第一、二行当成失败（`smoke.ts` 第 184 行）。基线日志只有两行（启动命令和控制接口），没有任何告警，所以任何新告警都是这一步带来的。

### 5.4 要花钱的那一次

第 7、8、9 步改的东西冒烟覆盖不全：审查要到 `code` 步才能调，冒烟停在第 1 步（[plan-dsh-coding.md](plan-dsh-coding.md) 第 0.4 节）。建议三步都做完、冒烟通过后，跑一次 `node scripts/e2e/run.ts` 的 `copy-typo`（估计 $0.4–$1.0；加 `ci-changeset` 共约 $1–$2，上限按 $2 批）。要看：

- 任务一次跑通，检查全过；
- 任务记录里 `review.by = reviewer`、`rounds ≥ 1`；审查者的用量记到 Coding bot 名下；
- 审查者会话的预设是 `readonly`（DSH 会话日志头）；
- 日志里没有 5.3 的任何一行。

不想花钱的替代办法（要改代码，另行拍板）：给 `scripts/mock-llm.ts` 加能回 `tool_use` 的规则，让冒烟一路走到 `code` 步并调一次 `request_review`。工作量约半天到一天，以后每次 DSH 升级都能免费验证审查。

## 6. 守门测试

### 6.1 文件

| 文件 | 内容 |
|---|---|
| `src/chat-to-fix/scripts/lib/dsh-tree.ts` | `dumpTree({ patches })`：建临时 `DSH_HOME`，跑 `--dump-config`，返回文本；`parseRows(text)`：解析顶层行；`isEnabled(row)`：判断开关 |
| `src/chat-to-fix/scripts/dsh-rows.ts` | 命令行：打印 `on|off <id> <包>`，每行一个，按树的顺序；`--patch <文件>` 可叠加（用来试第 N 步的片段） |
| `src/chat-to-fix/test/dsh-profile-guard.test.ts` | 守门测试；由 `npm run test:agent`（`test/*.test.ts`）带上，所以在 `npm test` 里 |

### 6.2 怎么拿到合成树（不启动 DSH）

`dumpTree`：

1. `mkdtemp` 一个临时目录 `T`；建 `T/dsh/profiles/chat-to-fix/package.json`，内容和 `scripts/start-chat-to-fix.sh` 里那段 heredoc 一样（`dsh.profile.bundles` = `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`）；建 `T/dsh/profiles/chat-to-fix/cordis.patch.yml`，内容 `[]`（模拟一个干净的个人资料补丁，这样测的只是我们的补丁）；建 `T/home`。
2. `execFile(process.execPath, [<仓库根>/node_modules/@deepseek-ai/dsh/lib/bin.js, '--profile', 'chat-to-fix', '--patch', <绝对路径 config/cordis.patch.yml>, ...额外 patch, '--dump-config'], { cwd: T, env: { PATH, HOME: T/home, DSH_HOME: T/dsh, DSH_TELEMETRY_DISABLED: '1' }, timeout: 20000 })`。环境只给这几个，不带任何 key。
3. 退出码不是 0 或标准错误非空就失败，并把标准错误带进失败信息。
4. 结束时删掉 `T`。

实测 0.1–0.3 秒，不联网，不加载插件，只写 `T`（DSH 会在 `T/dsh/profiles/chat-to-fix/` 下补一个 `cordis.yml`）。

### 6.3 解析

不引第三方 YAML 包（根依赖里没有直接的 YAML 包，传递依赖不可靠）。`--dump-config` 的输出格式固定：

- 顶层行从第 0 列的 `- id: <id>` 开始，到下一个第 0 列的 `- ` 或 `# == ` 为止；
- 行里第 2 列的 `name: <值>`、`disabled: <值>` 取出来（`name` 去掉引号）；
- 整段原文留着，给少数需要看配置的断言用正则（例如预设行的 `^    id: (\S+)$`、注册表的 `^    default: (\S+)$`）。

自检（任何一条不满足就失败，信息写“dump 格式变了，先看 dsh-tree.ts”）：顶层行数 ≥ 150；文本里 `^- id:` 的个数等于解析出的行数；`chat-to-fix` 行存在且 `name` 是 `chat-to-fix/src/chat-to-fix/core/plugin.ts`；没有重复的 id。

### 6.4 开关的判断

| `disabled` 的值 | 结果 |
|---|---|
| 没有、`false` | 开 |
| `true` | 关 |
| `!!js '!ctx.get(''profileContext'')'` | 开（用 `--profile` 启动时有 profileContext） |
| `!!js process.platform === 'win32'` | `process.platform !== 'win32'` 时开 |
| `!!js process.platform !== 'win32'` | `process.platform === 'win32'` 时开 |
| `!!js ctx.get('profileContext')?.name !== 'desktop'` | 关（我们的个人资料叫 `chat-to-fix`） |
| 其他 `!!js` | 测试失败：“行 X 的 disabled 是新的表达式，先审一下再加进表里” |

只对顶层行判断；预设里嵌套的行不管（预设的组成由冒烟查）。

### 6.5 断言

测试文件里放四张表：

- `WHITELIST`：57 项，`{ id, pkg, why }`，内容就是 2.3 的表（`why` 一句话，带文件和符号）。
- `KEEP_DISABLED`：2.3 末尾那 15 行。
- `REMOVED`：已经关掉的行（第 0 步为空，每一步把这一步的行加进来）。
- `PENDING`：还开着、等着按计划关的行（第 0 步 101 行，每一步挪走一部分；最后为空）。

断言：

1. **白名单在且开着**：每个 `WHITELIST` id 在树里恰好一次、`isEnabled` 为真、`name` 等于 `pkg`（防止同一个 id 换成别的包）。失败信息：“白名单行 X 被关掉或不见了；它是因为 <why> 要的，见 plan-dsh-trim.md 第 2.3 节”。
2. **补丁本身不碰白名单**（不跑 DSH 也能查）：读 `config/cordis.patch.yml` 的文本，找所有“`id: X` 并且同一项里有 `disabled: true`”的项（块写法和流式写法都认），X 不能在 `WHITELIST` 里。失败信息带补丁的行号。
3. **该关的关着**：`KEEP_DISABLED` 和 `REMOVED` 里的每一行要么关着，要么不在树里（DSH 升级拿掉了），不能开着。
4. **没有多出来的行开着**（严格）：开着的行的集合必须是 `WHITELIST ∪ PENDING` 的子集。DSH 升级后新加的行会让这一条失败：“新开着的行 X（包 Y）：要么写进白名单并写理由，要么在补丁里关掉”。
5. **预设**：开着的 `@deepseek-ai/dsh-agent-preset` 行的配置 id 包括 `readonly` 和 `coding`；第 7 步以后只有这两个，并且 `agent-preset-registry` 的 `default` 是 `readonly`（用一个常量 `STEP_7_DONE` 切换，或者直接看 `REMOVED` 里有没有 `preset-standard`）。
6. **补丁的关键配置还在**：`llm-pi-ai` 段里有 `apiKeyEnv: ANTHROPIC_API_KEY`；`approval` 段里有 `policy: never`；`connection` 段里有 `inject: []`；`webserver`、`web-runtime`、`modules`、`web-startup` 关着（它们是启动必需行，开着而起不来会让 DSH 不启动）。
7. **代码要的服务都有人提供**：从 `core/bot/index.ts` 读出 `export const inject = [...]`，再加上 2.1 表里 `ctx.get` 的那些服务名（测试里写成常量 `SOFT_SERVICES`），每个服务在常量 `PROVIDER_OF`（服务 → 行 id）里有一项，且那一行在 `WHITELIST` 里。有人在代码里加了新的注入而没更新白名单时，这一条失败。

测试不调模型、不联网、不启动 DSH，整文件应在 5 秒内跑完。

### 6.6 什么时候改它

- 每做一步：把行从 `PENDING` 挪到 `REMOVED`。
- 代码里新用了一个 DSH 服务：在 `SOFT_SERVICES`、`PROVIDER_OF`、`WHITELIST` 里各加一项。
- 升级 DSH：先跑这个测试；第 4 条报出的新行逐个决定。

## 7. 依赖瘦身

### 7.1 删三个没人用的根依赖

| 包 | 谁用 | 省多少 |
|---|---|---|
| `jsdom` 29.1.1 | 没有。代码里只有 `bot/test/harness-resolve.ts` 第 36 行一句注释提到；`package-lock.json` 里没有别的包依赖它；`node_modules/@deepseek-ai` 和 `deep-view` 里没有导入它 | 35 个包，22.5 MB |
| `oxlint` 1.76.0 | 没有脚本调用它 | 14.3 MB（本机只装了 darwin-arm64 的二进制） |
| `@deepseek-ai/dsh-agent-loop-testkit` | 没有任何导入 | 0.1 MB |

三个都是 PR #4（`b7138f2`，把我们的依赖并进根目录）带进来的。改法：从根 `package.json` 的 `dependencies` 里删这三行，然后 `npm install`（更新 `package-lock.json`）。`@deepseek-ai/dsh-web` 不能删（`dsh-base` 依赖它）；`deep-view` 不能删（`bot/src/host/parts.ts` 第 26 行用）。

验证：`npm ls jsdom oxlint @deepseek-ai/dsh-agent-loop-testkit` 为空；`npm run typecheck`、`npm test`、`npm run smoke:agent` 全过。风险：低。

### 7.2 `zod` 合成一份（可选，单独一个提交）

现状：58 份 `zod`，共 364.5 MB。57 份是 4.4.3（DSH 的包都写死 `"zod": "4.4.3"`），根目录那份是 4.6.7（被几个写范围的包抬上去的），所以每个写死的包都各带一份。

写范围的包：`@anthropic-ai/sdk`、`@agentclientprotocol/sdk`、`openai`（对等依赖 `^3.25 || ^4`）、`@modelcontextprotocol/client`、`@modelcontextprotocol/core`（`^4.2.0`）、`dsh-typert-protocol`、`dsh-working-directory` 和几个实验包（`^4.4.3`）。4.4.3 满足所有这些范围。

改法：根 `package.json` 加

```json
"overrides": { "zod": "4.4.3" }
```

然后 `npm install`。结果应是只剩一份 4.4.3，约省 358 MB。选 4.4.3 而不是 4.6.7：DSH 的 57 个包拿到的正是它们写死的版本；只有写范围的那几个包从 4.6.7 降到 4.4.3，仍在它们声明的范围内。

风险：中。一是 `dsh-typert-protocol`、`dsh-working-directory`（都在白名单链上）现在用的是 4.6.7，会换成 4.4.3；二是以前各包各用一份 zod，合成一份后跨包的 `instanceof` 判断结果可能变（通常是变好）。验证：`find node_modules -type d -path '*/node_modules/zod' | wc -l` 为 1；`npm ls zod` 没有 `invalid`；`npm run typecheck`、`npm test`、`npm run smoke:agent` 全过；之后第一次真实运行时顺带看。回退：删掉 `overrides`，`npm install`。

### 7.3 注意

- 根 `package.json` 是和 Logan 共用的文件。按以前的做法，改之前要 Zihui 同意，并告诉 Logan（根 README 那一行也是这样批的）。
- `npm install` 要联网下载（或用本机缓存），算一次“装包”，要单独批准。
- PR #8 现在只有一个检出（`git worktree list` 只有 `Chat-to-Fix-Remote`；前一次调研用的 `Chat-to-Fix-dsh` 已经不在了），根目录的 `node_modules` 只给这一个检出用，重装不会影响别的工作区。
- 先做 7.1，冒烟过了再做 7.2，两个提交分开，便于回退。

## 8. 预计收益和工作量

### 8.1 收益

| 方面 | 之前 | 之后 |
|---|---|---|
| 开着的插件行 | 158 | 63（第 1–9 步）；57（第 10 步全关） |
| 插件主机入口代码 | — | 少加载约 1.6 MB 的 DSH 入口代码，另外不再加载 OpenTelemetry SDK、`got`、`undici`、`@xterm/headless`、`acorn`、`@js-temporal/polyfill` 等第三方依赖。启动时间和内存在第 0 步记基线后实测，这里不估 |
| 对外能力 | 网页抓取和搜索、DeepSeek 登录和会话日志上传、MCP、OTel、插件安装、`node:vm` 动态代码、终端控制都在进程里（大多因为没有网页服务而够不着） | 都不在进程里 |
| 磁盘 | `node_modules` 982 MB | 7.1 后约 945 MB；7.2 后约 587 MB |
| 安全网 | 没有 | 守门测试：白名单被关、补丁误关、DSH 升级多出新行、代码新用服务而没登记，都会让 `npm test` 失败 |

### 8.2 工作量

| 事 | 估计 |
|---|---|
| 第 0 步（三个文件、名单、基线） | 0.5 天 |
| 第 1–6 步（每步改补丁、挪名单、跑测试和冒烟、记数） | 每步 20–30 分钟，共约 2.5 小时 |
| 第 7–9 步 + 一次真实运行 | 约 2 小时，外加 $0.4–$2 |
| 第 10 步 | 约 1 小时 |
| 第 7 节依赖瘦身 | 1–2 小时（含 `npm install` 和全套验证） |
| 合计 | 约 1.5–2 天 |
| 可选：mock 回 `tool_use`，让冒烟覆盖审查 | 另加 0.5–1 天 |

## 9. 要拍板的事

1. 方案和顺序是否同意；谁来做。
2. 第 6 步：确认没有部署用 `deepseek/...` 路线。
3. 第 7 步：注册表默认预设改成 `readonly`；只在没有任务在跑时部署。
4. 第 9 步：去掉网页用的那段系统提示词，还是留着。
5. 第 7–9 步的真实运行：批不批，预算多少（建议上限 $2）；或者先做“mock 回 `tool_use`”的免费办法。
6. 第 10 步的 6 行，逐行定。
7. 根 `package.json`：删三个依赖、加 `zod` 的 `overrides`；要不要先告诉 Logan；`npm install` 的批准。
8. 守门测试的第 4 条（严格模式）：DSH 升级多出新行时让测试失败，是否同意。

## 10. 实施记录（第 0–7 步，2026-11-13）

做法：每步在 `src/chat-to-fix/config/cordis.patch.yml` 末尾的第 8 节追加该步片段（原样照第 4 节），同时把这一步的行从守门测试的 `PENDING` 挪到 `REMOVED`；跑 `scripts/dsh-rows.ts` 对比基线、`npm run typecheck`、`npm test`、`npm run smoke:agent`，全绿才提交。没有步骤回退，没有改 `package.json` 和 `package-lock.json`，没有调模型，没有启动 3090 端口。第 6 步按 Zihui 的决定直接删（没有部署用 `deepseek/` 路线）；第 7 步按决定删预设并把注册表默认改成 `readonly`；守门测试用严格模式。

| 步 | 提交 | 开着的行（前 → 后） | 对比结果 |
|---|---|---|---|
| 0 | `af2047e` | 158 → 158 | 守门测试 10 项、`scripts/dsh-rows.ts`、`scripts/lib/dsh-tree.ts` |
| 1 | `80c4c31` | 158 → 101 | 57 行 on → off，别的不变 |
| 2 | `8bab6e8` | 101 → 87 | 14 行 |
| 3 | `0375cc7` | 87 → 82 | 5 行 |
| 4 | `73c5cec` | 82 → 78 | 4 行 |
| 5 | `5a0181c` | 78 → 77 | 1 行 |
| 6 | `f9964cd` | 77 → 71 | 6 行 |
| 7 | `e0a9b1d` | 71 → 66 | 5 行 off；`agent-preset-registry` 的 `default` 由 `standard` 改成 `readonly`（合成树里该行 `config` 只有这一个键，所以整块替换没丢东西） |

每步之后的结果都一样：行总数 199 不变，对比里没有任何一行从 off 变回 on；`npm run typecheck` 无错；`npm test` 五个套件 17 + 43 + 682 + 22 + 483 项（最后一个套件 2 项跳过，0 失败，和基线相同）；`npm run smoke:agent` 25 项全过（基线 25 项，约 21 秒，mock 日志 2 个请求）。流式写法 `{ id: x, disabled: true }` 被真实加载器认，没有改成块写法。第 7 步后冒烟日志里没有 `agent-preset/not-found`、`Unknown agent preset`、`The permission preset ... is not available`。

现在开着 66 行：白名单 57 行（含 `chat-to-fix`）加还没做的 9 行（第 8 步 2 行、第 9 步 1 行、第 10 步 6 行）。守门测试的 `PENDING` 剩 9 行，`REMOVED` 92 行。

没做、也没验证的：内存和启动秒数的前后对比（冒烟没有自动记，只有总时长）；第 7 步关预设后的真实审查运行（要等第 8、9 步一起跑一次，见 5.4）。
