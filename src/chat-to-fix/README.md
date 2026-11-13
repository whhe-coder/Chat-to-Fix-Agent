# Chat-to-Fix

在绑定的 Slack 频道里用 `/fix 问题描述` 提一个小问题（文案、样式、表单这类前端小修），系统就组一个机器人群，把它一路做成一个待审查的 Draft MR。系统先在频道里发一条开头消息，之后的进度和结果都回在这条消息的讨论串里。本期不接收用户在讨论串中的二次修改。`/fix` 已实现，但只在本机模拟服务上测过；真实 Slack 应用和 token 还没到位。

## 怎么工作

每个任务建一个群、一批新的 bot，任务结束就解散：

| bot | 负责 |
|---|---|
| 主 bot | 推进八步，检查每步结果 |
| Slack bot | 读讨论、回复"已收到"和结果 |
| Jira bot | 建单、写评论、改状态 |
| Git Pipeline bot | 准备代码目录和分支、开 Draft MR；负责整个 CI 步骤：读失败日志、叫修复 bot 修、追加提交 |
| 修复 bot | 用 Claude Code 改代码、跑测试；内置一个只读的评审子 agent |

八步：取讨论 → 建工单 → 准备代码（工作目录，分支 `ai/<单号>`）→ 写代码 → 开 Draft MR → CI（读 pipeline，失败就在同一个 MR 上修，最多 3 轮）→ 回写 Slack 和 Jira → 结束。

- 流程和状态归系统，内容和判断归 bot。每一步要有记录在案的证据才能推进，没有评审通过就不能开 MR。
- 提交是一行的 Conventional Commit；MR 一直是 Draft，bot 从不合并、批准或部署。
- 运行在 DeepSeek Harness（DSH，由仓库根目录安装，整包使用、不修改）上；bot 层从 DS Bot 0.3.1 裁剪而来（`bot/`，裁掉了什么见 `rewrite/INVENTORY.md`）。全部是 TypeScript，Node 24 直接运行，不用编译。

## 现在做到哪（2026-11-12）

- 用真实模型（Claude Sonnet 5.5）、模拟的 Slack / Jira / GitLab，主流程能整条跑通（真实运行都在加 CI 步骤之前；加了 CI 之后只在模拟 CI 上测过）。
- 一次跑通的端到端测试集：7 个前端修复用例，每个带一份隐藏测试；第一个真实运行的用例（圆角）17 项检查全过，用时 2 分 15 秒。
- 调试页：左边是 bot 之间的实时时序图，右边是竖屏群聊；每个任务、每个 bot 的花费和速度。
- 真实的 Slack、Jira、GitLab 适配器已经写好，只在本机模拟服务上测过，还没有接真实服务（等 token 和权限）。
- CI 修复循环已实现（Git Pipeline bot 负责），只在本机模拟 CI 上测过；`/fix` 入口已实现，只在本机模拟服务上测过。

## 运行

以下命令都从仓库根目录执行。需要 Node 24 和 Claude Code 命令行；设置 `ANTHROPIC_API_KEY` 时，四个流程 bot 使用 Anthropic API；未设置时，它们使用已登录的 Claude Code。修复 bot 始终使用 Claude Code。更改认证方式后，先运行 `npm stop`，再重新启动 Agent。

```bash
npm ci
```

运行其他脚本前，在项目根目录加载本机的 Node 24 和 Claude Code 路径。`npm start` 会自动加载：

```bash
. src/chat-to-fix/scripts/dev-env.sh
```

本机路径（node 或 claude 不在 PATH 上时）写在 `src/chat-to-fix/scripts/dev-env.local.sh`，这个文件不进 git，写法见 `dev-env.sh` 开头。

| 做什么 | 命令 |
|---|---|
| 启动 Agent 和模拟 Slack 页面（后台） | `npm start`，页面地址 `http://127.0.0.1:4001/`；不自动打开浏览器 |
| 启动两者并在当前终端查看 Agent 日志 | `npm run start:dev`；按 Ctrl+C 只结束日志查看，服务继续运行 |
| 停止两者 | `npm stop` |
| 只停止 Agent | `npm run stop:agent` |
| 查看 Agent 实时日志 | `npm run logs:agent`；收到 `/fix` 时先输出频道、发送者和问题正文 |
| 启动旧 Slack 私信测试 Bot（获批后才有 token） | `npm run start:slack` |
| 单独在前台启动模拟 Slack 频道 | `npm run start:mock-slack` |
| 测试 | `npm test`（根目录连接模块与模拟 Bot、Agent、Agent 层、Bot） |
| 类型检查 | `npm run typecheck` |
| 冒烟（本机假模型，不花钱） | `npm run smoke:agent` |
| 准备一次真实运行（只生成目录和命令，不启动） | `node src/chat-to-fix/scripts/first-run.ts` |
| 端到端测试集（真实模型，花钱） | `node src/chat-to-fix/scripts/e2e/run.ts --prepare-only`，再按它打印的命令运行 |
| 调试页 | `node src/chat-to-fix/scripts/flow-page.ts --dir <运行目录>`，打开 http://127.0.0.1:3092/ |
| 终端里看一个任务 | `node src/chat-to-fix/scripts/watch.ts --dir <运行目录>` |

## 接入现有 GitLab、Jira、Slack 配置

根目录的 `.env.local` 保存现有连接的 token，并需设置 `CHAT_TO_FIX_LOCAL_REPO` 为本机 F2P 仓库路径。`npm start` 复用这些变量，生成不含 token 的 Agent 配置，建立隔离的 F2P 仓库，然后先启动 Agent、再启动本机模拟 Slack 页面。两个进程独立运行。Agent 的配置和隔离仓库放在 `src/chat-to-fix/.data/connected/`。迁移前保存在旧目录的本地数据可通过 `CHAT_TO_FIX_DATA` 指向原路径。

```bash
npm run check:agent-connections
npm start
```

第一条命令只读检查 GitLab 分支和 Jira board。第二条命令启动 Agent 和本机模拟页面，不启动真实 Slack Bot。Slack 尚未接入且 `CHAT_TO_FIX_SLACK_CHANNEL` 为空时，Agent 暂用本机频道 `CLOCAL`；此时它不能接收真实 `/fix` 命令。获得真实频道 ID 后，将它写入 `.env.local`，运行 `npm stop`，再运行 `npm start`。公司的 Slack Bot 位于 `src/slackBot/`，后续单独接入。

本机模拟入口随 `npm start` 在后台启动；需要单独运行页面时，用 `npm run start:mock-slack` 在前台启动。它会用 `CLOCAL` 或已配置的频道 ID 将 `/fix` 转发给 Agent，并显示发件箱回传；它不会连接真实 Slack。若当前 Agent 使用真实 Jira 和 GitLab，模拟入口提交的任务也会使用这些真实连接。见 [模拟 Bot 规格](../../spec/mock-slack-bot.md)。

Agent 使用现有 `GITLAB_TOKEN` 和 `JIRA_TOKEN`，不再需要 Slack 令牌。Jira scoped token 走 REST v3；浏览器链接使用 Jira 站点地址。若无法自动查出站点地址，设置 `CHAT_TO_FIX_JIRA_SITE_URL`。当前配置不执行 Jira 状态迁移，因为现有 token 的迁移权限尚未验证。

## 和 Slack Bot 对接

`adapters.slack: "outbox"` 是和公司 Slack Bot 一起用的模式（`connected.ts` 生成的配置就是它）：Slack Bot 是唯一连 Slack 的程序，Chat-to-Fix 不持有 Slack 令牌；`slack.mentions` 当前为 `false`。Slack Bot 把 `/fix` 用 `POST /events`（`source: "fix"`）送进来，再每隔几秒用 `GET /outbox?after=<seq>&limit=<n>` 拉取要发给用户的消息；消息存在 `<数据目录>/outbox.jsonl`。接口、字段和状态码见 [Slack 接口说明](../../docs/chat-to-fix/slack/slackbot.md) 第 4.2、4.3 节。Slack 一侧的早期设计记录见 [入口文档](../../docs/chat-to-fix/slack/slackenter.md)；本期不接收讨论串里的二次修改。`adapters.slack: "real"`（服务端自己连 Slack，用 `scripts/slack-forwarder.ts`）仍可用，但不能和 Slack Bot 同时连同一个 Slack 应用。

真实 Slack 安装、GitLab 写入和三方完整链路仍待验证。

Anthropic key 只从环境变量 `ANTHROPIC_API_KEY` 读；`first-run.ts` 也能从 macOS 钥匙串读（服务名 `chat-to-fix-anthropic`）。代码、配置和日志里都没有凭据。

## 目录

| 目录 | 内容 |
|---|---|
| `core/` | Agent 主代码；`app.ts` 和 `plugin.ts` 是应用与 DSH 入口 |
| `core/task/` | 监听、队列、建群和收尾、监控、记录、任务存储、门禁、计费 |
| `core/flow/`、`core/registry/` | 八步流程表、五个 bot 的注册表 |
| `core/tools/`、`core/adapters/` | bot 的工具；Slack、Jira、GitLab 适配器（模拟和真实） |
| `core/engine/`、`core/prompts/` | Claude Code 驱动与各 bot 的指令 |
| `bot/src/` | 从 DS Bot 裁剪并保留内部结构的 Bot 层，由 `core/bot/` 接入 Agent |
| `scripts/` | 启动停止、冒烟、首跑、调试页、端到端测试集 |
| `config/` | DSH 配置补丁和说明 |
