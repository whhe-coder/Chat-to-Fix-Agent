# Coding bot 改用 DSH 原生编码：评估和方案

- 日期：2026-11-13
- 状态：方案 A 已在分支 `dsh-coding` 实现（未提交）；单元测试、类型检查、冒烟都通过；真实模型对比运行还没批准。第 0 节是实施结果和定下的事，第 1 节起是实施前的评估，保留原样。
- 依据：仓库 `main` 的 `0d80fd3`（含 Logan 的 `fd4407d`）；根目录 `node_modules/@deepseek-ai/*`（DSH 0.2.2-rc.1）和 `@earendil-works/pi-ai` 的实际文件。下文引用的包名、文件、行号都按这个版本。
- 关联：[决策记录](decision-record.md) 第 3.1、3.6 节、[软件说明](software-spec.md) 第 5.5、6.5、9 节、[规格 5](spec-5-bot-layer.md) 第 4.9 节、[规格 4](spec-4-tools-and-adapters.md) 第 4.10 节、[Agent 配置说明](../configuration.md)、[架构说明](../architecture.md) 第 6 节。

## 0. 实施结果（2026-11-13）

### 0.1 定下的事

| 事 | 定的是什么 | 谁定 |
|---|---|---|
| 密钥 | 五个 bot 都在 DSH 里跑，共用一个 `ANTHROPIC_API_KEY`；所有部署都要它。Logan 的无 key 路线（`fd4407d`：`claude-code/` 默认模型、`flowArgs`、`engineAuth: 'login'`）随 Claude Code 路线一起删 | Zihui；Logan 在 Slack 同意 |
| bash | 不给。新预设 `coding`（读写改和搜索），测试只经 `run_tests` | Zihui |
| 审查 | 系统起的 `request_review`：只读子 agent，系统拼输入（含真实 diff），同步等结果，系统记结论和轮数 | Zihui |
| `review_report` | 保留名字，只收 `verdict: cannot_fix`（只在 CI 步）。理由：门禁、`ci_stop`、Pipeline 的提示词和旧记录都认“review.verdict 为 cannot_fix”，换名字要连带改这些，收窄比改名改动小；审查本身的结论只由 `request_review` 写（`review.by: 'reviewer'`），`review_report` 写的是 `by: 'coding'` | 我（按授权） |
| 删除时机 | 同一个分支里删 | Zihui |
| 真实对比运行 | 还没批准；命令和费用估计见 0.4 | 待定 |

### 0.2 改了什么

| 部分 | 改动 | 位置 |
|---|---|---|
| 注册表 | 五条只差数据：加 `preset`（四个 `readonly`，coding `coding`）、coding 加 `effort: 'codingEffort'`、`permission` 写死 `workspace-write`；`reviewer` 改成 `{ instructions, preset }`；coding 的工具加 `repo_diff`、`run_tests`、`request_review` | `core/registry/bots.ts` |
| 建 bot | 预设取条目的 `preset`（`presetOf` 删了）；推理强度经 `updateBot` 设，模型不支持时只警告 | `core/task/runner.ts`、`core/task/botlayer.ts` |
| 配置 | `codingModel` 默认 `anthropic/claude-sonnet-5-5`；`claude-code/` 线路报错；`anthropic/` 模型没有 key 报错，文字说明五个 bot 都要它；删 `engineAuth`、`codingPermission`；新上限 `codingMaxSteps`（取代 `engineMaxTurns`）、`testMinutes`、`reviewMinutes`；`reviewMaxRounds` 生效；测试命令只要求一行 | `core/config.ts`、`config.example.json` |
| DSH 补丁 | 新预设 `preset-coding`；插件行不再有 `claudeCommand` | `config/cordis.patch.yml` |
| 工具 | `run_tests`、`request_review` 两个新文件；`review_report` 收窄；`task_read` 列出测试命令；注册框架支持每个工具自己的超时和重试次数 | `core/tools/tests.ts`、`review.ts`、`task.ts`、`register.ts`、`index.ts`；`core/flow/steps.ts` |
| 门面 | 加 `runReview`（DSH 子 agent，`delivery: 'caller'`）和审查者用量；删 `reportEngineUsage` | `core/task/botlayer.ts` |
| 看守 | 测试和审查进行中不算沉默；一轮工具调用超过 `codingMaxSteps` 就停，任务以 `coding_max_steps` 失败 | `core/task/monitor.ts`、`store.ts` |
| 记录 | 删掉解析 CLI 推理行的 `onEngineLines`。原计划要截断写和读的长参数：不用做，存储本来就把每条记录的文字截到 2000 字 | `core/task/recorder.ts` |
| 提示词 | `coding.md` 改写（DSH 工具、`run_tests`、`request_review`，没有 ToolSearch、MCP、Bash 规则）；`reviewer.md` 改工具名、写明材料由系统给；群公告去掉 Claude Code | `core/prompts/` |
| 脚本 | `connected.ts` 要 key（`MISSING_KEY`），默认模型都是 `anthropic/...`；`first-run.ts`、`e2e/` 去掉 CLI、叠加文件和 `--engine-auth`、`--claude-bin`，`e2e/run.ts` 加 `--coding-model`；e2e 的评审检查认 `request_review`（旧报告的 `review_report` 也认），“失败的工具调用”不算 DSH 自带文件工具的可恢复失败；启动脚本不再传 `CLAUDE_BIN`；`dev-env.sh` 不再找 `claude`；流程页的标签 | `scripts/` |
| 冒烟 | 主 bot 的第一句回答 @ 一次修复 bot，检查它的会话预设 `coding`、工具清单和带推理强度的用量；去掉假 CLI；修好打开文件的白名单（仓库根 `node_modules` 及其真实路径、`/usr/share/icu`） | `scripts/smoke.ts`、`scripts/mock-llm.ts`（加 `MOCK_RULES`） |
| 根目录 | `.env.example` 加 `ANTHROPIC_API_KEY`（五个 bot 共用）和可选的 `CHAT_TO_FIX_API_MODEL`、`CHAT_TO_FIX_CODING_MODEL`；`config/local-env/README.md` 加这三行（Logan 的文件，本次获准） | 仓库根 |

### 0.3 删了什么（按 `git diff` 统计）

| 类别 | 删的 | 行数 |
|---|---|---|
| 整个删掉的代码文件 | `bot/src/host/local-agents/`（7 个文件）、`core/engine/`（`claude.ts`、`args.ts`、`env.ts`）、`scripts/claude-demo.ts`、`scripts/lib/fake-claude.sh` | 2083 |
| 整个删掉的测试文件 | `test/engine.test.ts`、`test/launch.test.ts`、`test/bot/claude-driver.test.ts`、`engine-binding.test.ts`、`idle-replay.test.ts`、`test/bot/loop.ts`、`bot/test/local-agents*.test.ts`（3 个）、`bot/test/loop-kit.ts`、`test/fixtures/fake-claude.ts`、`bot/test/fixtures/echo-argv-env.ts` | 2454 |
| 代码合计（含改动的文件） | 删 2506 行，加 697 行（其中新文件 `tests.ts` 107 行、`review.ts` 103 行） | 净减约 1800 |
| 测试合计 | 删 2780 行，加 515 行（新文件 `test/coding-tools.test.ts` 181 行） | 净减约 2260 |

DS Bot 里对本地 Agent 的调用都是可选调用，模块拿掉后不用改；只删了 `bot/test/scoped-tools-creation.test.ts` 里测本地 Agent 审批桥的一条测试。

### 0.4 验证

| 检查 | 结果 |
|---|---|
| `npm test` | connections 17/17，slack-bot 17/17，agent 645/645，agent-layer 22/22，agent-bot 481 通过、2 跳过（共 483） |
| `npm run typecheck` | 无错 |
| `npm run smoke:agent` | 25/25（原来 23 过 1 失败，失败的是打开文件白名单；新加两项修复 bot 的检查） |
| 真实模型 | 没跑（未批准） |

改之前的基线：agent 691，agent-layer 45，agent-bot 505 通过、2 跳过。agent 和 agent-layer 少了的是随 Claude Code 路线删掉的测试；新加的是 `coding-tools.test.ts` 10 条、门面 3 条（`runReview` 2 条、推理强度 1 条）、看守 2 条、配置 3 条，以及改写的旧测试。

冒烟没覆盖的：审查要在 `code` 步才能调，冒烟的任务停在第 1 步，所以真实 DSH 里的 `startActivation` 参数和子会话用量投影只在单元测试里用假服务测过。这是对比运行要先看的地方。

对比运行（花钱，待批准）：

```sh
cd <worktree 根目录>
. src/chat-to-fix/scripts/dev-env.sh
node src/chat-to-fix/scripts/e2e/run.ts --cases copy-typo,ci-changeset --timeout-minutes 25
# 可选再加 cross-file-ui；先只准备、不启动：加 --prepare-only
```

key 从环境或钥匙串 `chat-to-fix-anthropic` 读。费用估计：Claude Code 时期同样两例整任务 $0.30–$0.40，其中修复 bot $0.11–$0.16；DSH 原生估计每例 $0.4–$1.0（修复 bot 回合更多，审查者另算），两例约 $1–$2，加 `cross-file-ui` 约 $1.5–$3。建议上限 $3；任务卡住时 `POST /tasks/<id>/stop`，或 Ctrl-C（脚本会停系统）。判定标准不变：两例都一次跑通、检查全过、修复 bot 费用不超过 Claude Code 的 3 倍。

### 0.5 Logan 要知道的

- 他的无 key 路线（`fd4407d`）已撤：`scripts/connected.ts` 没有 `ANTHROPIC_API_KEY` 就报错，`claude-code/...` 模型被拒，`engineAuth` 没了，`CLAUDE_BIN` 不再用。他本机要在根目录 `.env.local` 里填 `ANTHROPIC_API_KEY`。
- 他自己的文件里要改的：根目录 `README.md` 第 92 行（“未设置时，它们与修复 bot 一样使用已登录的 Claude Code”）改成“五个 bot 都用 `ANTHROPIC_API_KEY`，必须设置”；他的 `plans/`、`spec/` 里如果写了 Claude Code 或无 key 运行，也要改（这次没查也没动）。
- 根目录 `.env.example` 和 `config/local-env/README.md` 这次改了（他同意的）：加了 `ANTHROPIC_API_KEY` 和两个可选模型变量。
- 已经在跑的 Agent 用的是旧配置（`codingModel: claude-code/...`）：先 `npm stop`，再 `npm start`，配置会重新生成。

### 0.6 和第 1 至 12 节的出入

- 第 5 节第 8 项（截断记录）不用做：存储已经截断。
- 第 9 节估 31 小时；实际在一次会话里做完，文档改动比估计的多（`architecture.md`、`configuration.md`、根目录 `.env.example` 是后加的要求）。
- 第 12 节的待定已在 0.1 定下。

## 1. 问题

Coding bot 现在跑在 Claude Code 命令行上（DS Bot 的“本地 Agent”路线 `claude-code/...`）。Zihui 的判断：DSH 本身就会写代码（自带 write、edit、apply_patch、bash、subagent），把 Coding bot 换成 DSH 原生只是“换一个东西”，结构会更简单。要核对的是：这个判断对不对，换了要改什么、能删什么、风险和工作量多大。

## 2. 结论

1. **能力上对。** DSH 自带的东西够用：读写改文件（`dsh-tool-fs`）、搜索、按会话工作目录限写的沙箱、审批策略、带独立预设的子 agent、按会话的用量统计都在。DS Bot 的群聊代码本来就会等 DSH 子 agent（`turns.ts` 的 `hasSubagents`，`groups.ts` 第 1240 行）。工具名（`read`、`write`、`edit`、`glob`、`grep`）也和 Claude Code 一样。
2. **“只换一个东西”不对。** 一行配置确实能切过去：`codingModel` 改成 `anthropic/claude-sonnet-5-5`，Coding bot 就用 DSH 的 `standard` 预设跑起来（`runner.ts` 的 `presetOf`）。但这样会丢掉现在的几条保证，要补的有五处：
   - **要 API 密钥。** DSH 原生只能走 API 线路。Logan 的 `fd4407d` 让没有 `ANTHROPIC_API_KEY` 的部署全部改走已登录的 Claude Code；那种部署下 DSH 原生的 Coding bot 根本跑不起来。
   - **bash 没有命令白名单。** DSH 的沙箱只管写文件，不管读、不管网络（`dsh-bash-sandbox` README 第 32、170 行）。`standard` 预设还带 web、jobs、schedule、ask_user、plan、plugin_manager 等工具。
   - **子 agent 是异步的。** `subagent` 工具立刻返回，审查结果在下一轮以通知送回（`dsh-subagent` README 第 45 行）；审查者的说明要由 Coding bot 自己写进任务，独立性比现在弱。
   - **审查者的用量不在 Coding bot 的会话里。** 子 agent 是另一个会话，现在的计费只读 bot 自己的会话。
   - **没有步数上限。** DSH 没有回合或步数上限（决策记录 3.2），现在靠的是命令行的 `--max-turns 200`。
3. **结构变简单，只在一种情况下成立：** 所有部署都有 API 密钥，并且把 Claude Code 整条路线（包括 Logan 给四个流程 bot 加的无密钥路线）一起删掉。这时能删约 2000 行代码和约 2400 行测试，个人指令隔离那套绕法也不用了。只要还保留无密钥部署，Claude Code 路线就得留着，两条路并存反而更复杂。
4. **这推翻了一条已记录的决定。** 决策记录 3.1 否掉“DSH 原生 agent 接 Claude 模型”，原因是编码质量取决于 DSH 对 Claude 的第三方适配层（pi-ai），没有验证过。这个理由现在还成立一半：四个流程 bot 已经用 `anthropic/claude-sonnet-5-5` 走 pi-ai 跑通过真实任务，说明工具调用、缓存、计费都正常；但长时间的编码回合没验证过。所以要先跑两三个真实用例，和 Claude Code 的结果对比，再决定删不删。

**建议：** 先确认密钥（待定第 1 条）。有密钥就走方案 A：Coding bot 用新的 `coding` 预设（只有读写改和搜索，没有 bash），测试命令和审查各由一个我们自己的工具执行；真实用例对比通过后，再删 Claude Code 路线。没有密钥就不改，或者走方案 B（两条路并存），但那样不会更简单。

## 3. 现状：Coding bot 怎么接的

| 环节 | 现在的做法 | 位置 |
|---|---|---|
| 注册表 | `coding`：`model: 'codingModel'`（默认 `claude-code/default`，`connected.ts` 用 `claude-code/claude-sonnet-5-5`），`permission: 'codingPermission'`（`workspace-write`），工具 `request_code`、`review_report`、`needs_info_confirm`，另有 `reviewer`（`reviewer.md`，工具 `Read`、`Grep`、`Glob`） | `core/registry/bots.ts` |
| 建 bot | 和其他四个一样调 `botlayer.createBot`；预设 `standard`（其他四个是 `readonly`）；模型线路是 `claude-code`，所以 DSH 只是一层壳，工具和提示词都交给命令行 | `core/task/runner.ts` 的 `presetOf`、`core/task/botlayer.ts` 的 `createBot` |
| 模型线路 | 本地 Agent 模块扫描 `claude` 命令，注册 `claude-code` 线路的 `LlmAdapter`；每个 DSH 会话一个 `claude` 进程，双向逐行 JSON | `bot/src/host/local-agents/index.ts`、`adapter.ts`、`claude-engine.ts`、`core/engine/claude.ts` |
| 启动参数 | `launchFor`：绑定到 coding 的会话用 `codingArgs`：`-p`、stream-json、`--permission-prompts none`、`--permission-mode acceptEdits`、`--tools Read,Edit,Write,Bash,Glob,Grep,Agent,ToolSearch`、`--allowedTools`（MCP 工具、`git status`、`git diff`、每条测试命令一条精确规则加一条前缀规则）、`--agents`（reviewer，同模型同强度）、`--max-turns`、`--effort`、`--no-session-persistence`、`--mcp-config` 加 `--strict-mcp-config`；环境加 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`（否则审查在后台跑、回合先结束） | `bot/src/host/local-agents/launch.ts`、`core/engine/args.ts` |
| 流程 bot 无密钥路线 | `fd4407d`：没有密钥时四个流程 bot 也走命令行，`flowArgs` 只放行各自的 MCP 工具 | `args.ts` 的 `flowArgs`、`launch.ts`、`scripts/connected.ts` |
| 隔离 | 环境变量白名单（`childEnv`）；`--setting-sources project`；`--settings {claudeMdExcludes}` 排除工作目录以上和用户配置目录的指令文件；`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`；`apiKey` 时每会话私有 `CLAUDE_CONFIG_DIR` | `core/engine/env.ts`、`launch.ts` 的 `engineIsolation` |
| 角色工具 | 经本机 MCP 桥递给命令行（`LoopbackMcp`），名字 `mcp__chat-to-fix__<名>`，提示词要求先用 ToolSearch 加载 | `local-agents/mcp.ts`、`core/tools/register.ts` 的 `bridgedToolNames`、`core/prompts/coding.md` |
| 测试命令 | 频道绑定的 `testCommands`，经 `runner.codingOptions(taskId)` 给启动参数；同一清单写进系统文字，要求原样运行 | `runner.ts`、`launch.ts` 的 `withTestCommands`、`args.ts` 的 `testRules` |
| 工作目录 | `repo_prepare` 调 `setGroupWorkDir`，只给 coding 设成员目录；群会话在这个目录里建，命令行的 cwd 取会话头 | `core/tools/repo.ts` 第 76 行、`botlayer.ts` 的 `setGroupWorkDir`、`local-agents/index.ts` 的 `cwdFor` |
| 记录 | 命令行内部的工具调用不是 DSH 工具调用；适配器把拒绝和工具错误写成 `▸ denied:` 等推理行，记录器再解析成 `refusal`、`tool_error` | `adapter.ts` 第 464 行起、`core/task/recorder.ts` 的 `onEngineLines` |
| 计费 | 命令行每回合的 `result`：每个模型一行（审查者单独一行），费用用命令行自己的 `costUSD`，速度由 `duration_api_ms` 推算，来源记 `cli` | `adapter.ts` 的 `reportUsage`、`botlayer.ts` 的 `reportEngineUsage`、`core/task/usage.ts`、`pricing.ts` |
| 监控 | `engine_silent`：coding 回合在跑且 10 分钟没有任何会话事件，停掉并让主 bot（CI 步是 Pipeline bot）重叫，第二次就结束任务；编码步 40 分钟上限 | `core/task/monitor.ts` 第 496 行起 |
| 空闲关闭 | 命令行进程 10 分钟没输出就关，回合在跑时重新计时；下一条消息起新进程，适配器重放最近 12 条消息 | `adapter.ts` 的 `arm`、`closeLive`；规格 7 第 4.11 节 |
| 提示词 | `coding.md` 写的是“你通过 Claude Code 工作”、ToolSearch 加载 MCP 工具、Bash 规则、内置 `reviewer` 子 agent；`reviewer.md` 写的是 `Read`、`Grep`、`Glob` | `core/prompts/` |
| 测试 | `test/engine.test.ts`、`test/launch.test.ts`、`test/bot/claude-driver.test.ts`、`engine-binding.test.ts`、`idle-replay.test.ts`、`bot/test/local-agents*.test.ts`、假命令行 `test/fixtures/fake-claude.ts`、`scripts/lib/fake-claude.sh`（冒烟）、真模型套件 `scripts/e2e/`（`--claude-bin`） | |

四个 API bot 的做法（Coding bot 要照着走的样子）：`model` 是 `apiModel`（`anthropic/...`，DSH 的 `llm-pi-ai` 线路，`config/cordis.patch.yml` 第 1 行组），`permission: 'read-only'`，预设 `readonly`（补丁第 6 组新加：只有 `read`、`read_image`、`glob`、`grep` 和压缩）；角色工具由 `attachRoleTools` 直接注册进会话；用量从 DSH 的 `tokenUsage` 和 `sessionStats` 投影按回合相减得到（`botlayer.ts` 的 `roundUsage`），按价格表计费。

## 4. DSH 自带什么

| 需要的能力 | DSH 有没有 | 出处 |
|---|---|---|
| 每个 bot 自己的工作目录 | 有。会话建在哪个目录，工具就以它为当前目录；`setGroupWorkDir` 现在的做法直接可用 | `dsh-tool-fs` README 第 28 行；`groups.ts` 第 292 行 |
| 读、写、改文件 | 有：`read`、`write`、`edit`，可选 `apply_patch`；名字和参数照 Claude Code 定 | `dsh-tool-fs` README 第 48–54 行 |
| 搜索 | 有：`glob`、`grep` | `dsh-tool-fs-search` |
| 写文件限在工作目录 | 有。`workspace-write` 模式下写只能落在会话目录、额外授权目录和临时目录 | `dsh-fs-sandbox` README 第 12、48 行；`dsh-base/cordis.patch.yml` 第 524 行 |
| 读文件限在工作目录 | **没有**。沙箱只管写；读不受限（四个 API bot 和现在的 Claude Code 也一样） | `dsh-fs-sandbox` README 第 12 行；`dsh-sandbox` README 第 166 行 |
| bash | 有，每次一个新 shell，在 macOS 上用 Seatbelt 限写 | `dsh-tool-bash`、`dsh-bash-sandbox`、`dsh-sandbox-local` README 第 73、81 行 |
| bash 只放行指定命令 | **没有**。没有命令白名单；网络不限；进程环境按名字剔除含 KEY、PASSWORD、SECRET、TOKEN 的变量 | `dsh-bash-sandbox` README 第 32、170 行；`dsh-subprocess-local` README 第 12、156 行 |
| 不弹审批 | 有。审批策略 `never` 直接拒绝，越权请求一律失败；我们的补丁第 3 组已把三个权限预设都设成 `never` | `dsh-user-approval` README 第 12、36 行；`config/cordis.patch.yml` |
| 按 bot 定工具集 | 有：agent 预设（`dsh-agent-preset`），我们已用它做了 `readonly` | `config/cordis.patch.yml` 第 6 组；`dsh-web-app/presets/standard.patch.yml` |
| 只读审查子 agent | 有。`subagent` 工具可用 `agentPreset` 给子 agent 指定独立预设（只有进程内 spawn 支持）；子 agent 继承父的模型、强度、工作目录 | `dsh-tool-subagent` README “Selecting a child preset”；`dsh-subagent-spawn-in-process` README 第 12、56 行 |
| 同步等审查结果 | 工具形式**没有**：`subagent` 立刻返回，结果作为下一轮的通知送回；没有 wait 工具。服务接口有：`ctx.subagents.startActivation({..., delivery: 'caller'})` 返回可等待的 `result`，还能带 `outputSchema` 要求结构化结论 | `dsh-subagent` README 第 45、61 行；`dsh-subagent/lib/types/types.d.ts` 的 `SubagentActivationSpec`、`SubagentStartRequest` |
| 群里等子 agent | DS Bot 已处理：成员有子 agent 在跑时，这一轮的答复只算进度，不算交回 | `turns.ts` 第 190–260 行；`groups.ts` 第 1240 行 |
| 推理强度 | 有。Sonnet 5.5 在 pi-ai 目录里支持 low 到 max，DS Bot 的 bot 有 `effort` 字段 | `@earendil-works/pi-ai/dist/providers/data/anthropic.json`；`roster.ts` 第 154–179、344–390 行 |
| 用量 | 有：每个会话的 `tokenUsage`、`sessionStats` 投影；子 agent 的用量在子会话里，不并入父会话 | `botlayer.ts` 第 56 行起；`dsh-client-ui-subagent` README 第 66 行 |
| 步数、回合上限 | **没有** | 决策记录 3.2 |
| 仓库指令文件 | 有：读工作目录到仓库根（以 `.git` 为标记）之间的 `AGENTS.md`、`CLAUDE.md`；全局的只读 `$DSH_HOME` 和 `$DSH_AGENTS_HOME`，启动脚本已把这两个指到数据目录。不像 Claude Code 那样一路读到 `~` | `dsh-agent-instructions` README 第 34、38、40 行 |
| 工具超时 | 内置 bash、read、write、edit 没有超时；我们自己的角色工具有 `toolTimeoutSeconds`（默认 30 秒）和重试 | `dsh-tool-call-timeout-policy` README 第 42 行；`core/tools/register.ts` 第 155、199 行 |

## 5. 要改的代码（方案 A）

| # | 改什么 | 怎么改 | 位置 |
|---|---|---|---|
| 1 | Coding bot 的预设 | 补丁里新加 `coding` 预设：persona（写明是 Coding bot）、agent-instructions、time-context、`tool-fs`（read、write、edit；`applyPatch` 先关）、`tool-fs-search`、压缩（含 tool-result-pruner）。不放 bash、pwsh、jobs、web、schedule、subagent、ask_user、plan、todo、goal、skill、plugin_manager | `config/cordis.patch.yml`、`config/README.md` |
| 2 | 注册表和建 bot | coding 加 `preset: 'coding'`；去掉 `reviewer` 的命令行工具名，改成指向审查工具；`CONFIG_DEFAULTS.codingModel` 改为 `anthropic/claude-sonnet-5-5`；`createBot` 带上 `effort`（`codingEffort`）。补丁第 1 组的 `models` 要包含 Coding 用的模型 | `core/registry/bots.ts`、`core/task/runner.ts`、`core/task/botlayer.ts`、`core/config.ts` |
| 3 | 跑测试 | 新角色工具 `run_tests`（coding 专用，`code`、`ci` 两步可用）：参数是测试命令的序号或原文，只接受绑定里的 `testCommands`；在任务的代码目录里用 `execFile` 跑（不经 shell 拼接的命令按参数拆；带 `&&` 的命令用 `sh -c` 原样跑），环境用 `childEnv` 白名单，自带超时（新上限 `testMinutes`），输出截断；不重试 | 新文件 `core/tools/tests.ts`，`core/tools/index.ts`、`register.ts`（每个工具可以有自己的超时和重试次数） |
| 4 | 看改动 | `git status`、`git diff` 用已有的 `repo_diff`（现在 `roles: ['pipeline']`）：把 `coding` 加进它的角色 | `core/tools/repo.ts`、`bots.ts` |
| 5 | 审查 | 新角色工具 `request_review`：系统用 `ctx.get('subagents').startActivation` 起一个子 agent，`provider: 'spawn'`、`agentPreset: 'readonly'`、`delivery: 'caller'`，提示内容由系统拼：`reviewer.md` + 任务摘要 + Jira 单 + 代码目录对基准提交的真实 diff + Coding bot 写的改动说明；要求 `outputSchema`（`verdict`、`problems`）；等结果返回给 Coding bot，同时把结论记到任务上（等于现在的 `review_report`，轮数由系统数，`reviewMaxRounds` 第一次真正生效）。超时用编码步剩余时间 | 新文件 `core/tools/review.ts`；`core/tools/task.ts` 的 `review_report` 保留给 `cannot_fix` 或删掉，见待定第 3 条 |
| 6 | 审查者的用量 | 审查结束后读子会话的 `tokenUsage`、`sessionStats`，以 Coding bot 的名义发一条用量（模型照子会话的） | `botlayer.ts` 新加一个门面函数，审查工具调用 |
| 7 | 监控 | `engine_silent` 改成“Coding bot 无输出”：审查进行中（工具调用未返回）不算沉默；新加步数上限：数 Coding bot 一轮里的工具调用，超过 `codingMaxSteps`（取代 `engineMaxTurns`）就停 bot 并记录；提示文字去掉 “Claude Code” | `core/task/monitor.ts`、`core/config.ts` |
| 8 | 记录 | Coding bot 的读写改现在是普通的 DSH 工具调用，会直接记成 `tool_call`、`tool_result`。`write`、`edit` 的参数含整段文件内容，要截断 | `core/task/recorder.ts` |
| 9 | 提示词 | `coding.md` 重写工具一节：用 `read`、`edit`、`write`、`glob`、`grep`；测试只用 `run_tests`；审查调 `request_review`；去掉 ToolSearch、MCP 名、Bash 规则。`reviewer.md` 的工具名改成 `read`、`glob`、`grep` | `core/prompts/coding.md`、`reviewer.md` |
| 10 | 冒烟 | 冒烟里 Coding bot 也走模拟模型：检查它的会话预设是 `coding`，请求里的工具有 `read`、`write`、`edit`、`run_tests`、`request_review`，没有 bash、web、subagent 等；去掉假命令行 | `scripts/smoke.ts`、`scripts/mock-llm.ts` |
| 11 | 真模型套件 | 去掉 `--claude-bin`、`engineAuth`、钥匙串里的 Claude 相关检查；`codingModel` 用 `anthropic/...`；`no_refusal_or_tool_errors` 这项检查要区分 DSH 工具的正常失败（如 `edit` 找不到唯一匹配） | `scripts/e2e/*.ts`、`scripts/first-run.ts` |
| 12 | 单元测试 | 新工具、预设、监控、用量的测试；改 `registry`、`runner`、`botlayer`、`recorder`、`monitor`、`prompts`、`config` 的测试 | `test/` |

方案 B（两条路并存）只做 1、2、3、4、5、6、7、9、10，再加一处：按 `codingModel` 的线路选预设（`claude-code/` 用 `standard`、走命令行；其他用 `coding`）。命令行那条路不删。

## 6. 可以删的（方案 A 在对比通过后）

| 删什么 | 位置 | 规模 |
|---|---|---|
| Claude Code 驱动 | `core/engine/claude.ts` | 401 行 |
| 启动参数：`claudeArgs`、`codingArgs`、`flowArgs`、`testRules`、`CODING_TOOLS`、`EFFORT_LEVELS` 移到 config | `core/engine/args.ts` | 187 行 |
| 认证和隔离：`authEnv`、`memoryExcludes`、`isolationSettings`、`userConfigHome`（`childEnv` 留给 `run_tests`） | `core/engine/env.ts` | 约 80 行 |
| 本地 Agent 模块整个 | `bot/src/host/local-agents/`（`adapter.ts`、`claude-engine.ts`、`discover.ts`、`engines.ts`、`index.ts`、`launch.ts`、`mcp.ts`） | 1286 行 |
| 门面和任务层里的命令行部分 | `botlayer.ts` 的 `reportEngineUsage`；`recorder.ts` 的 `onEngineLines`；`usage.ts`、`contracts.ts` 里 `cli` 来源的分支（旧记录的显示文字保留）；`pricing.ts` 的注释；`plugin.ts` 的 `engineSettings`；`config.ts` 的 `engineAuth`；`app.ts` 的 `codingOptions`；`runner.ts` 的 `codingOptions` 改为给 `run_tests` 用 | 约 120 行 |
| 脚本 | `scripts/claude-demo.ts`、`scripts/lib/fake-claude.sh`；`connected.ts` 的无密钥分支 | 约 130 行 |
| 测试 | `test/engine.test.ts`、`test/launch.test.ts`、`test/bot/claude-driver.test.ts`、`engine-binding.test.ts`、`idle-replay.test.ts`、`bot/test/local-agents*.test.ts`、`test/fixtures/fake-claude.ts`、`bot/test/fixtures/echo-argv-env.ts` | 约 2400 行 |
| 配置补丁 | 第 7 组的 `claudeCommand`；启动脚本里的 `CLAUDE_BIN` | 几行 |

DS Bot 其他文件对本地 Agent 的调用都是可选调用（`rt.isLocalAgentRef?.()` 等，在 `prompt.ts`、`parts.ts`、`roster.ts`、`tools.ts`、`botlayer.ts`），模块拿掉不用改它们。顺带解决 `config/README.md` 记的两处泄漏（`discover.ts` 的 `npm prefix -g` 写 `~/.npm/_logs`，登录 shell 读 `~/.zprofile`），也不再写 `~/.claude`。

## 7. 保留的

- 任务层、门面、四个 API bot、工具注册和步骤把关：不变。
- `childEnv` 白名单：`run_tests` 用。
- `engine_silent` 这个结束原因的名字：旧任务记录里有，保留名字，改含义说明。
- 旧记录里 `source: 'cli'` 的用量：显示和汇总照旧能读。
- 方案 B 或待定第 1 条答“不能保证有密钥”时：整个 Claude Code 路线和 `fd4407d` 的流程 bot 无密钥路线都留着。
- 根目录 `README.md` 第 92 行（Logan 写的模型认证说明）是 Logan 的文件，我们不改；方案 A 落地后请 Logan 改。

## 8. 风险

| 风险 | 说明 | 怎么控制 |
|---|---|---|
| 编码质量 | Claude Code 的系统提示、工具实现和多年的编码调优换成 DSH 的 persona 和工具。模型相同（Sonnet 5.5、强度 high），差别在外壳。没有数据 | 先跑真实用例对比（第 10 节），不达标就停在方案 B 或不改 |
| 没有密钥的部署 | `fd4407d` 的场景下 Coding bot 跑不了 | 待定第 1 条；方案 A 启动时检查，没有密钥直接报配置错误 |
| 命令执行面 | 不给 bash 后，模型只能跑绑定里的测试命令，比现在更窄（现在靠命令行的前缀规则）。但测试命令跑的是模型改过的代码，它可以改 `test.sh` 让它做别的事——现在也一样，真正的边界仍然是部署时的容器 | `run_tests` 用环境变量白名单，不带任何令牌；部署照软件说明第 10 节放进容器 |
| 读文件不受限 | DSH 的读没有目录限制，Coding bot 能读到数据目录、`.env.local` 等。这不是新问题：Claude Code 官方说明也只限写、不限读，四个 API bot 现在也一样 | 记进安全说明；方案 A 的 Coding bot 没有网络和 shell，读到的东西只能写进群聊；部署用容器 |
| 审查的独立性 | 方案 A 由系统拼审查输入（真实 diff），比现在更独立；如果改用 DSH 的 `subagent` 工具，说明和输入都由 Coding bot 写，比现在弱 | 用 `request_review`（待定第 3 条） |
| 依赖 DSH 内部接口 | `ctx.get('subagents').startActivation` 不在插件的 inject 名单里（DS Bot 的 `stopSubagents` 也是这么拿的）；DSH 是开发者预览版，接口可能变 | 封装在一个文件里，加单元测试；升级 DSH 时核对 |
| 费用失控 | DSH 没有步数上限；登录模式下的费用是订阅额度，换成 API 是真钱 | 第 5 节第 7 项的步数上限，加上已有的编码步 40 分钟上限 |
| 记录变多 | Coding bot 的每次读写改都成为记录 | 截断参数；流程页按需折叠 |
| 工作树的 `.git` 标记 | 工作树的 `.git` 是文件不是目录；如果 DSH 的指令文件查找不认它，会往上一级找仓库根 | 冒烟里验证；不认就在 `agent-instructions` 行配 `rootMarkers` 或关掉上溯 |

## 9. 工作量

| 项 | 方案 A | 方案 B |
|---|---|---|
| 预设、注册表、建 bot、配置（第 5 节 1、2） | 2 小时 | 3 小时（加按线路选预设） |
| `run_tests`、`repo_diff` 给 coding、工具单独的超时和重试（3、4） | 3 小时 | 3 小时 |
| `request_review`、审查用量（5、6） | 7 小时 | 7 小时 |
| 监控、记录（7、8） | 2 小时 | 2 小时 |
| 提示词（9） | 1.5 小时 | 2 小时（两条路各一份工具说明） |
| 冒烟、真模型套件（10、11） | 3 小时 | 2 小时 |
| 删 Claude Code 路线和它的测试（第 6 节） | 6 小时 | 0 |
| 单元测试（12） | 含在上面各项 | 含在上面各项 |
| 文档（第 11 节） | 5 小时 | 4 小时 |
| 真实用例对比（跑和看结果） | 2 小时 | 2 小时 |
| 合计 | 约 31 小时（4 个工作日） | 约 27 小时，不删任何东西 |

“一行配置直接切”（只改 `codingModel` 和 `coding.md`）约 1 小时，但会丢掉第 2 节列的几条保证，不建议作为交付。

## 10. 验证

1. 单元测试：`npm test`、`npm run typecheck` 全绿；新测试覆盖 `run_tests`（只接受绑定里的命令、超时、环境里没有令牌、步骤限制）、`request_review`（拼出的输入含真实 diff、结构化结论落到任务上、轮数上限、超时）、审查用量记账、步数上限、`coding` 预设被创建时选中。
2. 冒烟：`npm run smoke:agent`（模拟模型，不花钱）。新加检查：Coding bot 会话的预设是 `coding`；它的模型请求里有 `read`、`write`、`edit`、`glob`、`grep`、`run_tests`、`request_review`，没有 bash、pwsh、web、subagent、jobs、schedule、plugin_manager；`--sentinel-home` 下主目录没有新写入（应比现在少：没有 `~/.npm/_logs`、`~/.claude`）。
3. 真实用例（要另外批准，花真钱）：用 `scripts/e2e/run.ts` 跑 `copy-typo` 和 `ci-changeset` 两个已用 Claude Code 跑过的用例，可选加 `cross-file-ui`。对比项：一次跑通与否、自动检查结果、改动是否最小、Coding bot 的轮数、时长、费用。参考：2026-11-12 用 Claude Code 的两次运行整任务 $0.30–$0.40，其中 Coding bot $0.11–$0.16（`~/chat-to-fix-runs/e2e-20261112-*/report.md`）。估计 DSH 原生每例整任务 $0.4–$1.0，两例约 $1–$2，三例约 $1.5–$3；上限按 $3 批。
4. 判定：两例都一次跑通、检查全过、Coding bot 费用不超过 Claude Code 的 3 倍，才进行第 6 节的删除。

## 11. 文档改动清单

| 文档 | 位置 | 改成什么 |
|---|---|---|
| `software-spec.md` | 3.1 分层、3.2、3.3、3.4、4.3、5.2、5.3 | Coding bot 是 DSH 会话，预设 `coding`，不再有命令行进程 |
| | 5.5 编码和审查 | 审查由 `request_review` 起只读子 agent，输入由系统拼，结论由系统记，轮数由代码数 |
| | 6.5 coding bot 两张表 | 引擎、权限、工具、审查子 agent 全部改写；去掉 MCP 桥 |
| | 5.8、7.7 监控 | `engine_silent` 改为“Coding bot 无输出”，加步数上限 |
| | 8.1 用量、8.2 配置 | 去掉 `engineAuth`；`codingModel` 默认值；`codingEffort` 不再是 `--effort`；新 `testMinutes`、`codingMaxSteps` |
| | 9 权限和安全 | 去掉 `claudeMdExcludes`、`CLAUDE_CONFIG_DIR` 两段；写明 DSH 读不受限、测试命令由工具执行、环境白名单 |
| | 10 部署形态 | 不再需要本机 Claude Code；所有形态都要 API 密钥 |
| `decision-record.md` | 1 约束、2.1–2.4、2.7 | 改成 DSH 原生编码 |
| | 3.1 候选方案 | 加一行新决定（日期、理由、对比结果），旧结论标为已改 |
| | 3.3、3.5、3.6 | 删命令行相关的核对项，在 3.6 记这次判断的变化 |
| `spec-5-bot-layer.md` | 1 范围、3 门面、4.2 安装顺序 | 去掉 `localAgents` 模块和 `reportEngineUsage`；加审查用量的门面函数 |
| | 4.9 Claude Code 驱动（A5） | 整节改为“Coding bot 的 DSH 预设和两个工具”，旧内容移到附注 |
| | 5、6、7 | 代码参考、实现清单、验收相应改 |
| `spec-4-tools-and-adapters.md` | 3 接口、4.1 挂载 | 去掉 MCP 桥；加 `run_tests`、`request_review`；`repo_diff` 加 coding |
| | 4.8 端到端测试台、5、7 | 去掉假命令行 |
| `spec-6-config-prompts-verification.md` | 2.1、4.1 配置 | 同 software-spec 8.2 |
| | 2.2、4.2 提示词 | `coding.md`、`reviewer.md` 的必写内容 |
| | 4.3 补丁、4.3a 启动脚本 | 加 `coding` 预设；去掉 `claudeCommand`、`CLAUDE_BIN` |
| | 4.4、4.6、4.7 | 镜像不再装 Claude Code；验证工具改 |
| `spec-3-watchdog.md` | 2.2 上限键、3.1、4.3、4.5、5 | `engineMaxTurns` 换成 `codingMaxSteps`；`engine_silent` 新含义 |
| `spec-2-state-and-storage.md` | 2.4 执行记录、2.5 结束原因、3.2 记录器 | `usage` 的 `cli` 来源只剩旧记录；`refusal` 记录不再从推理行解析 |
| `spec-1-registry-and-flow.md` | 2.1、2.2、6、7 | 注册表加 `preset`；`reviewer` 字段改 |
| `spec-7-ci-loop.md` | 4.4、4.10 | 提示文字 |
| | 4.11 空闲关闭后重放 | 整节标为“已不适用”（DSH 会话自己保存） |
| `tools-and-limits.md` | 1、2.6 coding bot、4、5 | 工具表加 `run_tests`、`request_review`；上限表改 |
| `README.md`（设计文档目录） | 文档表、已知缺口 | 加本文；`reviewMaxRounds` 一行改为“随本方案实现” |
| `src/chat-to-fix/README.md` | 怎么工作、运行、目录 | 不再需要 Claude Code 命令行；需要 `ANTHROPIC_API_KEY` |
| `src/chat-to-fix/config/README.md` | Runtime installation、Rows 第 6、7 行、Known leaks | 加 `coding` 预设；去掉 Claude Code 和两处泄漏 |
| `src/chat-to-fix/HANDOVER.md` | 3、4、8 | 历史快照，只在开头加一句指向本文 |
| `implementation-guide.md`、`kickoff-plan.md`、`notes/ci-loop-design.md` | — | 历史文档，不改正文，开头加一句指向本文 |
| 根目录 `README.md` 第 92 行 | — | Logan 的文件，不改，请 Logan 改 |

## 12. 待定（要 Zihui 定）

1. **密钥。** 公司的部署和 Logan 的环境能不能保证有 Anthropic API 密钥？能，走方案 A；不能，不改或走方案 B。顺带要和 Logan 说：方案 A 会删掉 `fd4407d` 的无密钥路线。
2. **bash。** 不给 bash、测试由 `run_tests` 执行（建议）；还是给 DSH 的 bash（沙箱限写，但任何命令、网络都放开）。
3. **审查。** 系统起子 agent 的 `request_review`、结论由系统记（建议）；还是用 DSH 的 `subagent` 工具，结论仍由 Coding bot 用 `review_report` 自己记。选前者时，`review_report` 只留 `cannot_fix` 一种用法，还是并进 `request_review` 的结果里。
4. **真实用例。** 批准跑 `copy-typo`、`ci-changeset`（可选 `cross-file-ui`），费用上限 $3。
5. **删除的时机。** 对比通过后同一个分支里删，还是先合并方案 A、Claude Code 路线下一个 PR 再删。
6. **决策记录。** 本方案推翻决策记录 3.1 的结论，落地时要在 3.1 和 3.6 记下新决定。
