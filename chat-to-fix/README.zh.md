# Chat-to-Fix

在绑定的 Slack 频道里用 `/fix 问题描述` 提一个小问题（文案、样式、表单这类前端小修），系统就组一个机器人群，把它一路做成一个待审查的 Draft MR。系统先在频道里发一条开头消息，之后的进度和结果都回在这条消息的讨论串里；bot 追问时，在讨论串里 @ 机器人回答。（`/fix` 已实现，只在本机模拟服务上测过；真实 Slack 应用和 token 还没到位。）

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
- 运行在 DeepSeek Harness（DSH，`runtime/`，整包使用、不修改）上；bot 层从 DS Bot 0.3.1 裁剪而来（`bot/`，裁掉了什么见 `rewrite/INVENTORY.zh.md`）。全部是 TypeScript，Node 24 直接运行，不用编译。

## 现在做到哪（2026-11-12）

- 用真实模型（Claude Sonnet 5.5）、模拟的 Slack / Jira / GitLab，主流程能整条跑通（真实运行都在加 CI 步骤之前；加了 CI 之后只在模拟 CI 上测过）。
- 一次跑通的端到端测试集：7 个前端修复用例，每个带一份隐藏测试；第一个真实运行的用例（圆角）17 项检查全过，用时 2 分 15 秒。
- 调试页：左边是 bot 之间的实时时序图，右边是竖屏群聊；每个任务、每个 bot 的花费和速度。
- 真实的 Slack、Jira、GitLab 适配器已经写好，只在本机模拟服务上测过，还没有接真实服务（等 token 和权限）。
- CI 修复循环已实现（Git Pipeline bot 负责），只在本机模拟 CI 上测过；`/fix` 入口已实现，只在本机模拟服务上测过。

## 运行

需要：Node 24、Claude Code 命令行、Anthropic API key。

```bash
npm ci                                     # TypeScript（类型检查用）
cd bot && npm ci --ignore-scripts && cd ..    # 只装 deep-view；bot/.npmrc 让 npm 不在这里装 @deepseek-ai/*，它们来自 runtime/
cd runtime && npm install --legacy-peer-deps=false --no-package-lock --no-fund --no-audit && cd ..   # DSH 0.2.2-rc.1，约 930 MB
```

每次运行前在项目根目录：

```bash
. scripts/dev-env.sh
```

本机路径（node 或 claude 不在 PATH 上时）写在 `scripts/dev-env.local.sh`，这个文件不进 git，写法见 `scripts/dev-env.sh` 开头。

| 做什么 | 命令 |
|---|---|
| 测试 | `npm test`、`npm run test:layer`、`npm run test:bot` |
| 类型检查 | `npm run typecheck` |
| 冒烟（本机假模型，不花钱） | `npm run smoke` |
| 准备一次真实运行（只生成目录和命令，不启动） | `node scripts/first-run.ts` |
| 端到端测试集（真实模型，花钱） | `node scripts/e2e/run.ts --prepare-only`，再按它打印的命令运行 |
| 调试页 | `node scripts/flow-page.ts --dir <运行目录>`，打开 http://127.0.0.1:3092/ |
| 终端里看一个任务 | `node scripts/watch.ts --dir <运行目录>` |

## 接入现有 GitLab、Jira、Slack 配置

根目录的 `.env.local` 保存现有连接的 token。`scripts/connected.ts` 复用这些变量，生成不含 token 的 Agent 配置。配置和隔离的 F2P 仓库放在 `chat-to-fix/.data/connected/`。

```bash
node scripts/connected.ts --check
node scripts/connected.ts --channel C频道ID --repo /本机/F2P仓库路径
node scripts/connected.ts --start
```

第一条命令只读检查 GitLab 分支和 Jira board，并报告 Slack Bot token 是否存在。第二条命令在取得频道 ID 后准备配置和隔离仓库；也可以在根目录 `.env.local` 中设置 `CHAT_TO_FIX_SLACK_CHANNEL` 与 `CHAT_TO_FIX_LOCAL_REPO`。第三条命令启动 Agent 和 `/fix` Socket Mode 转发器；需要获批安装后的 `SLACK_BOT_TOKEN`，以及现有的 `SLACK_APP_TOKEN`。本机使用 Node 24 运行这些命令。

Agent 使用现有 `GITLAB_TOKEN`、`JIRA_TOKEN`、`SLACK_BOT_TOKEN` 和 `SLACK_APP_TOKEN`。Jira scoped token 走 REST v3；浏览器链接使用 Jira 站点地址。若无法自动查出站点地址，设置 `CHAT_TO_FIX_JIRA_SITE_URL`。当前配置不执行 Jira 状态迁移，因为现有 token 的迁移权限尚未验证。

当前 Slack 应用只有 `commands` 和 `chat:write` Bot scopes。`/fix` 正文可直接交给 Agent；讨论串里的追问回复需要额外的消息事件和读取权限，当前尚未接通。真实 Slack 安装、GitLab 写入和三方完整链路仍待验证。

Anthropic key 只从环境变量 `ANTHROPIC_API_KEY` 读；`first-run.ts` 也能从 macOS 钥匙串读（服务名 `chat-to-fix-anthropic`）。代码、配置和日志里都没有凭据。

## 目录

| 目录 | 内容 |
|---|---|
| `src/task/` | 监听、队列、建群和收尾、监控、记录、任务存储、门禁、计费 |
| `src/flow/`、`src/registry/` | 七步流程表、五个 bot 的注册表 |
| `src/tools/`、`src/adapters/` | bot 的工具；Slack、Jira、GitLab 适配器（模拟和真实） |
| `src/engine/` | Claude Code 驱动 |
| `src/prompts/` | 各 bot 和评审的指令 |
| `bot/` | 从 DS Bot 裁剪来的 bot 层 |
| `scripts/` | 启动停止、冒烟、首跑、调试页、端到端测试集 |
| `config/` | DSH 配置补丁和说明 |
