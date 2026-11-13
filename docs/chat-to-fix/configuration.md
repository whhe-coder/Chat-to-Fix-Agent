# Agent 配置说明：一个 Anthropic API key 给五个 bot

- 日期：2026-11-13。按分支 `dsh-coding` 的代码写。
- 适用：Chat-to-Fix Agent（`src/chat-to-fix/`）。为什么这样改，见 [design/plan-dsh-coding.md](design/plan-dsh-coding.md)。

## 1. 一句话

五个 bot（主、Slack、Jira、Git Pipeline、修复 bot，加上修复 bot 的审查者）都是 DeepSeek Harness（DSH）里的会话，都走 Anthropic API，共用一个 `ANTHROPIC_API_KEY`。不再需要、也不再使用本机登录的 Claude Code。没有 key，Agent 不启动。

## 2. key 放在哪

| 怎么启动 | key 从哪来 | 没有时 |
|---|---|---|
| `npm start` / `npm run start:dev`（`src/chat-to-fix/scripts/connected.ts`） | 进程环境里的 `ANTHROPIC_API_KEY`；没有就读仓库根目录 `.env.local` 里的（环境优先） | 立即报错：`ANTHROPIC_API_KEY is not set. Chat-to-Fix runs all five bots on the Anthropic API and needs the key ...`，什么都不启动 |
| `sh src/chat-to-fix/scripts/start-chat-to-fix.sh`（直接启动） | 进程环境 | 插件读配置时报错：`ANTHROPIC_API_KEY is not set: Chat-to-Fix runs every bot on the Anthropic API ...`，错误写进 `run/chat-to-fix.log` |
| `node src/chat-to-fix/scripts/first-run.ts`、`node src/chat-to-fix/scripts/e2e/run.ts` | 进程环境；没有就用 macOS 钥匙串里的条目 `chat-to-fix-anthropic`（只在真正启动时读） | 列为 `BLOCKED`，退出码 1 |
| 容器部署 | 容器的环境变量 | 同直接启动 |

`.env.local` 的写法照 [`.env.example`](../../.env.example)：

```sh
cp -n .env.example .env.local
chmod 600 .env.local
# 编辑 .env.local，填 ANTHROPIC_API_KEY=...
```

放进钥匙串（只在用 `first-run.ts` / `e2e/run.ts` 时需要）：

```sh
security add-generic-password -a "$USER" -s chat-to-fix-anthropic -w
```

key 怎么走到模型：启动脚本清空环境，只把一张白名单传给 DSH（其中有 `ANTHROPIC_API_KEY`）；DSH 的配置补丁 `src/chat-to-fix/config/cordis.patch.yml` 第 1 组写 `apiKeyEnv: ANTHROPIC_API_KEY`，由 DSH 自己读。Chat-to-Fix 的代码只检查它在不在，不读、不写、不打印它的值；`run_tests` 跑测试命令时也不把它传下去。

## 3. 模型和推理强度

| 配置 | 含义 | 默认 | `npm start` 时怎么改 |
|---|---|---|---|
| `apiModel` | 四个流程 bot 的模型线路 | `anthropic/claude-sonnet-5-5` | `.env.local` 的 `CHAT_TO_FIX_API_MODEL` |
| `codingModel` | 修复 bot 和它的审查者的模型线路 | `anthropic/claude-sonnet-5-5` | `.env.local` 的 `CHAT_TO_FIX_CODING_MODEL` |
| `codingEffort` | 修复 bot 的推理强度：`low`、`medium`、`high`、`xhigh`、`max`；审查者沿用 | `high` | 配置文件 `chat-to-fix.json` |

- 线路写成 `anthropic/<型号>`。型号要出现在 `config/cordis.patch.yml` 第 1 组的 `models` 里（现在只有 `claude-sonnet-5-5`），换型号时在那里加一行；第 2 组是新会话的默认型号。
- 补丁第 8 节关掉了 DeepSeek 的两条路线（`deepseek`、`deepseek-account`）和账号登录：模型目录里只有 `anthropic` 路线，写 `deepseek/...` 的线路跑不起来。DSH 现在开着的插件行和为什么要它们，见守门测试 `test/dsh-profile-guard.test.ts` 的白名单；DSH 升级后先跑这个测试，它会报出新开着的行。
- `claude-code/...` 线路已删，写了会启动失败，错误里说明这条路线没了。旧配置里的 `engineAuth`、`codingPermission` 会被忽略，可以删掉。`dev-env.local.sh` 里的 `CLAUDE_BIN` 也不再用。
- 模型不支持所选的推理强度时，bot 照建，只在日志里记一条警告。
- 改了 key 或模型后，先 `npm stop` 再 `npm start`。`npm start` 发现正在运行的 Agent 用的是旧模型配置时会提示先停。

## 4. 修复 bot 能做什么

| 能力 | 做法 | 相关配置 |
|---|---|---|
| 读、搜索、改文件 | DSH 的 `read`、`read_image`、`glob`、`grep`、`edit`、`write`（agent 预设 `coding`）。写只能落在本任务的代码目录和临时目录里 | — |
| 跑命令 | 没有 shell。只能用 `run_tests` 跑频道绑定里列出的测试命令，每条原样用 `sh -c` 在代码目录里运行；环境变量只放行白名单（`PATH`、`HOME`、`LANG` 等），不带任何令牌 | 绑定的 `testCommands`（每条一行）；`limits.testMinutes`（默认 10） |
| 审查 | `request_review`：系统起一个只读审查者（预设 `readonly`），给它任务、修复 bot 的说明和真实 diff，等它答完，记结论和轮数 | `limits.reviewMinutes`（默认 15）、`limits.reviewMaxRounds`（默认 3） |
| 看守 | 一轮里没动静 `engineSilentMinutes` 分钟（测试、审查进行中不算）就停掉重叫；一轮工具调用超过 `codingMaxSteps` 就停掉，任务失败 | `limits.engineSilentMinutes`（默认 10）、`limits.codingMaxSteps`（默认 200）、`limits.stepMinutes.code`（默认 40） |
| 软上限 | 任务花的钱（`task.usage.totalUsd`，所有 bot 加审查者，按价格表算；没有定价的模型记 0）或运行时间（扣掉等 CI 的时间）到软上限，系统给主 bot 发一条消息：停止工作，不再叫 coding bot，以 `needs_person` 收尾并写给提问人看的说明；有 Jira 单就让 Jira bot 留一条同样原因的评论；有 Draft MR 就提一句。coding bot 的回合还在跑就先停掉。每个软上限每次运行只触发一次。CI 等待时间在 CI 步骤之后也一直扣除；CI 步骤已定论（settled）或任务在写回、收尾步骤时不再触发软上限（成果已交付，走完流程就是收尾）。到硬上限直接结束任务，只是兜底 | `limits.softTaskUsd`（默认 2.5 美元）、`limits.softTaskMinutes`（默认 20）。任务总时限 `limits.taskMinutes`（默认 80）不变，仍是兜底；`softTaskMinutes` 必须小于它，否则配置无效。没有硬预算 |

注意：

- 测试命令跑的是修复 bot 刚改过的代码，所以 `run_tests` 不是沙箱。DSH 的沙箱只限写、不限读。部署时真正的边界是容器。
- 四个流程 bot 是预设 `readonly`：只有读和搜索，没有写、shell、网络。

频道绑定的例子（`chat-to-fix.json` 的 `bindings`）：

```json
{ "channel": "C0456", "repo": "group/project", "jiraProject": "DEMO", "testCommands": ["sh test.sh", "npm ci && npm test"] }
```

## 5. 怎么确认能用

| 检查 | 命令（仓库根目录） | 花不花钱 | 看什么 |
|---|---|---|---|
| GitLab、Jira 连得上 | `npm run check:agent-connections` | 不花 | `GitLab ok; Jira ok`。它不检查 Anthropic key |
| 单元测试、类型 | `npm test`；`npm run typecheck` | 不花 | 全部通过 |
| 冒烟（模拟模型） | `npm run smoke:agent` | 不花，不用真 key | 全部 PASS。其中检查：修复 bot 的会话是预设 `coding`；它的模型请求里有读写改工具和它的角色工具，没有 shell、网络、子 agent 工具；它那一轮的用量记着推理强度 `high` |
| 启动 | `npm start`，再 `npm run logs:agent` | 不花（还没提任务） | 日志里有 `chat-to-fix: control interface on 127.0.0.1:3090`；没有 key 时第一步就报错 |
| 真实模型跑用例 | `. src/chat-to-fix/scripts/dev-env.sh && node src/chat-to-fix/scripts/e2e/run.ts --prepare-only --cases copy-typo,ci-changeset`，再按它打印的命令跑 | 花钱，见下 | `report.md` 里每项检查和每个 bot 的花费 |

## 6. 费用

- 价目在 `src/chat-to-fix/core/task/pricing.ts`（美元每百万 token）：Sonnet 5.5 输入 2、输出 10、缓存读 0.1、缓存写 2.5。可在配置 `pricing` 里改。五个 bot 和审查者都按这张表算。
- 参考：2026-11-12 用 Claude Code 当修复 bot 的两次真实运行，整个任务 $0.30–$0.40，其中修复 bot $0.11–$0.16（报告在 `~/chat-to-fix-runs/e2e-20261112-*/report.md`）。DSH 原生的修复 bot 还没实测，估计整个任务 $0.4–$1.0（修复 bot 的回合更多、审查者另算）。
- 每个任务的花费：调试页（`node src/chat-to-fix/scripts/flow-page.ts --dir <运行目录>`）、`node src/chat-to-fix/scripts/show-task.ts T-1 --dir <运行目录>`、控制接口 `GET /tasks` 的 `totalUsd`。
- 上限：任务 80 分钟、编码步 40 分钟、修复 bot 一轮 200 次工具调用、一次审查 15 分钟、最多 3 轮审查。马上停一个任务：`curl -s -X POST -H "x-chat-to-fix-token: $(cat <数据目录>/http-token)" http://127.0.0.1:3090/tasks/T-1/stop`。
