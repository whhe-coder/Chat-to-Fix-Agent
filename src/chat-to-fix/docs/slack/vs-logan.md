# 我们的 Slack 设计怎么基于 Logan 的延展

> 本文保留 PR #5 的设计与交接背景。目录已迁至 `src/chat-to-fix/`；本期只接受 `/fix` 首次提交和 Agent 自动 CI 修复，不启用用户在讨论串中的二次修改。

- 日期：2026-11-12。
- 对照的 Logan 文档和代码（`main`，`7b600dc`）：
  - 文档：[spec/slack-fix-command.md](../../../../spec/slack-fix-command.md)、[spec/slack-dm-entry.md](../../../../spec/slack-dm-entry.md)、[spec/mock-slack-bot.md](../../../../spec/mock-slack-bot.md)、[config/slack/README.md](../../../../config/slack/README.md)、[plans/chat-to-fix-agent.md](../../../../plans/chat-to-fix-agent.md)、根目录 [README.md](../../../../README.md)；
  - 代码：`src/slackBot/`、`src/server/`。
- 我们这边：[slackbot.md](slackbot.md)、[slackenter.md](slackenter.md)、`chat-to-fix/` 的实现（PR #5）。
- 一句话：以 Logan 的为底，他定了的照搬，他没写的我们补上，只有 2 处要他点头改（另加 1 项权限）。他的文件我们一个没动；要改的都列在第 3 节，由他改。

## 1. 照搬的（他定了，我们完全按他的来）

| Logan 定的 | 出处 | 我们怎么落地 |
|---|---|---|
| 分工：Slack Bot 收 `/fix`、交任务、发进度；本地 agent 管 Jira、GitLab、改代码、CI | plans“整体目标”、README | Slack Bot 只管 Slack，Chat-to-Fix 不连 Slack、不持有 Slack 令牌 |
| 指定频道 `/fix 问题描述`；正文不能空；其他频道和私信只回拒绝说明，不启动任务 | slack-fix-command.md“目标行为” | slackenter.md 2.1 写了每种情况的文案 |
| 在 Slack 时限内确认，再在频道发一条任务消息，后续都回在它的 thread | slack-fix-command.md | Slack Bot 发任务消息，它的 `ts` 就是任务的讨论串，发件箱的每条消息都带这个 `ts` |
| 相同命令重试不重复启动任务 | slack-fix-command.md | Slack Bot 按 `trigger_id` 去重；Chat-to-Fix 按 `eventId` 持久去重 |
| 普通频道消息、私信和 thread 回复不启动任务 | slack-fix-command.md | 讨论串里的 @ 只给已有任务补充信息；没有进行中的任务就回 409，不建新任务 |
| 拒绝只给发起人看 | slack-fix-command.md | `/fix` 先问 `/health`；服务没开、队列满，只回临时消息，频道里不留东西 |
| 回报五个节点：已接收、工单已创建、MR 已创建、CI 检查与修复（含新 commit 链接）、结束 | README“目标 Slack 回传” | 五个都有：“已收到”；`jira_created`；`mr_opened`；CI 每轮失败、`ci_fix_pushed`（带 commit 链接）、通过；结果 |
| 只用当前 MR commit 的最新 pipeline 判定；最多修 3 轮；修不了就停并报告 | README、plans 执行规则 | CI 修复循环本来就是这样；停的时候说明原因 |
| 回复只给链接和结论，不贴完整日志或凭据 | plans 执行规则 | 发件箱的文字只有链接、job 名、结论；去掉广播式提及 |
| 只接受一个频道：`CHAT_TO_FIX_SLACK_CHANNEL` | `.env.example`、config/local-env | 同一个变量：Slack Bot 只认它，Chat-to-Fix 用它绑定仓库 |
| 同一个 Slack 应用只用一个程序连 Socket Mode | config/slack | 连的只有 Slack Bot；Chat-to-Fix 自己的转发程序不和它同时跑 |
| 用户看到的话用中文 | 他的全部文案 | 默认 `language: zh` |

## 2. 补上的（他没写，我们在他的基础上加）

| 他留的空 | 我们补的 | 在哪 |
|---|---|---|
| plans M1：“本地 agent 的调用方式：进程、HTTP 服务或任务队列”待定 | 本机 HTTP：`POST /events` 送事件，`GET /outbox` 拉要发的消息。理由见第 4.1 节 | slackbot.md 4.2 |
| 回报的文字由谁写 | Chat-to-Fix 写好放进发件箱，Slack Bot 原样发；Slack Bot 只自己写“服务暂时连不上” | slackbot.md 4.2(2) |
| 用户描述不清怎么办 | 追问；用户在讨论串里 @ 补充，原任务带着补充接着跑。权限没批时，提示补全后重新 `/fix` | slackbot.md 场景 4，slackenter.md 2.2 |
| 修不了、需要人处理时说什么 | 用中文说明原因，由主 bot 写给发起人看；“需要人处理”单独一种 | slackbot.md 场景 6 |
| `/fix` 时服务没开、队列满怎么办 | 先问 `/health`，只回临时消息 | slackenter.md 2.1 |
| 任务消息的格式 | `<@发起人> 提交了修复请求：<原文>`，先去掉广播式提及 | slackenter.md 2.1 |
| 模拟入口改成 `/fix`（他 M1 的计划） | 参考实现里的模拟 Bot：`/fix`、@、发件箱转发 | [reference/](reference/README.md) |

## 3. 要他点头改的（2 处，加 1 项权限）

1. **plans M1 的调用方式**：改成“本机 HTTP + 发件箱拉取”，指向 [slackbot.md](slackbot.md)。
2. **`src/server/` 不承接 Bot 任务**：
   - README 里“后续承接 Bot 任务”那句改掉。
   - `src/server/` 留作 GitLab、Jira 的连通检查工具；Bot 任务只走 Chat-to-Fix 的 3090。
3. **权限加 `app_mentions:read` 和 `app_mention` 事件**：
   - 这和他配置记录里“不订阅事件”不同，要和管理员一起办。
   - 没批下来之前，我们用 `slack.mentions: false`，流程不卡。

这三条都是他的文件，由他改。我们这边已经按改完的样子做好了。他的规格文档怎么并进我们的内容，见 [handover.md](handover.md) 第 5 节。

## 4. 为什么这么延展（我的判断）

### 4.1 调用方式：本机 HTTP + 发件箱拉取

- **两个进程，不合一**：
  - Slack Bot 是根目录的 JavaScript，Chat-to-Fix 是 `chat-to-fix/` 里的 TypeScript，跑在 DSH 上，依赖和启动方式完全不同。
  - 合进一个进程，等于回到 PR #4 那种“合并依赖”，已经否了。
- **拉，不推**：
  - Slack Bot 用 Socket Mode，本来不开端口。
  - 拉的话，它重启后从游标接着发，消息不丢。
  - 代价是几秒延迟，对几分钟的任务无所谓。
- **不用任务队列**：两个进程在同一台机器上，多一个队列只多一个要部署的东西。
- **状态只存一份**：
  - plans 执行规则里写着 Bot 要“保存 Slack 命令、任务、Jira 工单和 MR 的对应关系”。按这个接口，这些都在 Chat-to-Fix 的任务里。
  - Slack Bot 只记一个发件箱游标，不会出现两份状态对不上。

### 4.2 Bot 任务只走 3090

- 建单、开 MR、CI 循环都已经在 Chat-to-Fix 里，用的就是他在 PR #3 里接好的 GitLab、Jira 配置。
- `src/server/` 再承接任务，就是两套业务逻辑、两份任务状态。
- 它现在只有健康检查、只读 GitLab、Jira 写入几个口，本来就是验证连通用的。

### 4.3 讨论串补充：要，但不卡在权限上

- **要的理由**：
  - 重新 `/fix` 会开新任务、新 Jira 单，前一轮的单和分支成了孤儿。
  - 讨论串里补一句，原任务接着跑。
  - `app_mentions:read` 只读提到 bot 的那一条，不读频道历史，是最小的权限。
- **不卡的理由**：
  - 安装正在审批，改 scope 可能要重新排队。
  - 所以加开关 `slack.mentions`：关着时，追问之后任务以“缺信息”结束，再提示补全后重新 `/fix`。

### 4.4 进度节点由系统发

- 单号、MR 链接、提交号都是确定的事实。工具写进任务的同时由系统发，不花模型调用，也不会漏。
- 每个只发一次，重跑不重复。

## 5. 他写了、我们没碰的

- `spec/slack-dm-entry.md`：私信入口，他自己标了“历史”。
- `config/slack/README.md` 里 11 日的配置记录。
- `src/server/` 的代码。
- 根目录的一切：参考实现只在 [reference/](reference/README.md)，对他已有文件的改动存成补丁，要用时在自己的分支上套。

## 6. 留着的小缝

- **任务消息可能多发一条**：
  - Slack Bot 进程内按 `trigger_id` 去重。它重启后 Slack 重投同一条命令，会多发一条任务消息；任务本身不会重复，Chat-to-Fix 有持久去重。
  - 他也写了“完整的持久去重在任务接入里程碑实现”，第一版接受。
- **健康检查后的竞争**：`/health` 正常后、`POST /events` 前，恰好队列满或服务停了。这时在讨论串里说明，极少见。
