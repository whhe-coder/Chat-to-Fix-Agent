# Slack 入口：`/fix` 与讨论串里的补充

> 本文保留 PR #5 的设计与交接背景。目录已迁至 `src/chat-to-fix/`；本期只接受 `/fix` 首次提交和 Agent 自动 CI 修复，不启用用户在讨论串中的二次修改。

- 日期：2026-11-12
- 状态：2026-11-12。Chat-to-Fix 一侧已实现（PR #5）；Slack Bot 一侧只有参考实现（[reference/](reference/README.md)），归 Yuzhao。
- 关系：以 [固定频道 `/fix` 规格](../../../../spec/slack-fix-command.md) 为准，本文只补它没写的三件事：
  - 任务消息发出后，怎么交给 Chat-to-Fix；
  - 用户在讨论串里怎么回答追问；
  - 为此要加的一项权限。
- 接口细节见 [slackbot.md](slackbot.md)。

## 1. 问题

[固定频道 `/fix` 规格](../../../../spec/slack-fix-command.md) 定了 `/fix`、指定频道、`commands` 加 `chat:write`，但还缺：

1. 没写命令交给谁、怎么交。
2. Bot 在讨论串里追问后，用户的回答收不到：应用不订阅任何消息事件。
3. 没写讨论串里的进度和结果从哪来。

## 2. 方案：Slack Bot 的入口行为

### 2.1 `/fix`

| 情况 | Slack Bot 做什么 |
|---|---|
| 正文为空 | 回临时消息：`用法：/fix 问题描述，例如：/fix 登录页的“忘记密码”链接点了没反应。` |
| 在私信或不是指定频道里用 | 回临时消息：`请在指定频道里用 /fix。`，不启动任务 |
| 同一个 `trigger_id` 重复送达 | 不再处理（进程内去重，保留一小时） |
| 通过上面几条后 | 1. 3 秒内确认命令。<br>2. 调 `GET /health`。 |
| `/health` 连不上、超时或不是 200 | 回临时消息：`Chat-to-Fix 服务暂时连不上，这次请求没有开始处理，请稍后再用 /fix 提交。`，频道里不发任何东西 |
| `/health` 的 `queueFull` 为真 | 回临时消息：`修复队列已满，这次请求没有接收，请稍后再试。`，频道里不发任何东西 |
| `/health` 正常 | 1. 在频道发任务消息：`<@发起人> 提交了修复请求：<原文>`，先去掉原文里的广播式提及。<br>2. 调 `POST /events`：`source: "fix"`，`eventId` 填 `slash:<trigger_id>`，`threadTs` 和 `messageTs` 都填任务消息的 `ts`。 |
| 健康检查之后 `POST /events` 才连不上、超时或返回 5xx（极少） | 在任务消息的讨论串里回：`Chat-to-Fix 服务暂时连不上，这次请求没有开始处理，请稍后再用 /fix 提交。` |
| `POST /events` 返回 4xx | Slack Bot 不另外说话，说明已经由 Chat-to-Fix 放进发件箱 |

先问 `/health` 是照 Logan 规格的“拒绝只给发起人看”：服务没开或队列满时，频道里不留一条没人处理的任务消息。

### 2.2 讨论串里的 @（补充信息）

- **处理**：只处理指定频道里、在讨论串中（事件带 `thread_ts`）的 `app_mention`。
  - 去掉开头的 @机器人，调 `POST /events`。
  - 字段：`source: "mention"`，`eventId` 填 Slack 的 `event_id`，`threadTs` 填事件的 `thread_ts`，`messageTs` 填事件的 `ts`。
- **不在讨论串里的 @**：回临时消息 `新问题请用 /fix 提交。`，不启动任务。
- **Chat-to-Fix 连不上、超时或返回 5xx**：在讨论串里回 `Chat-to-Fix 服务暂时连不上，这条补充没有送达，请稍后再 @ 我一次。`
- **去掉 @机器人 后正文为空**：不送，也不回话。
- **忽略**：bot 自己的消息、编辑过的消息、带 `subtype` 的消息。
- **结果**：讨论串里有在等补充信息的任务时，它会带着这句话重跑。讨论串里没有任务或任务已结束时，不会建新任务，用户会在讨论串里看到“新问题请用 /fix 提交”。规则见 [slackbot.md](slackbot.md) 第 4.2(1) 节。

### 2.3 回报

讨论串里的所有进度和结果都来自 Chat-to-Fix 的发件箱，见 [slackbot.md](slackbot.md) 第 4.2(2) 节。

- Slack Bot 不自己写进度文案。
- 唯一的例外是 2.1 和 2.2 里那两句“服务暂时连不上”。

## 3. Slack 应用配置（相对 [固定频道 `/fix` 规格](../../../../spec/slack-fix-command.md) 的变化）

| 项 | 固定频道 `/fix` 规格 | 本文 |
|---|---|---|
| Bot Token Scopes | `commands`、`chat:write` | 再加 `app_mentions:read` |
| Event Subscriptions | 不订阅 | 只订阅 `app_mention` |
| 其他 | — | 不变：不要频道历史，不要私信，不要 `users:read`，Socket Mode 照旧 |

为什么加：

- 讨论串里的补充信息是追问流程的另一半。
- 没批下来之前，Chat-to-Fix 用 `slack.mentions: false`：追问之后任务以“缺信息”结束，再提示用户补全后重新 `/fix`。流程不卡在审批上。
- `app_mention` 只送来提到 bot 的那一条消息，不给读频道历史的权限。

## 4. 和固定频道 `/fix` 规格不冲突的地方

- 频道、`/fix` 的确认时限、去重、任务消息加讨论串的回报方式：都照固定频道规格。
- “普通频道消息、私信和 thread 回复不启动任务”仍然成立：讨论串里的 @ 只给已有任务补充信息，不启动任务。
- 唯一的变化是第 3 节那一项权限和那一个事件，要和管理员、Logan 确认后加进安装申请。

## 5. 待定

- 指定频道的 ID：同固定频道规格的 M0。
- 加 `app_mentions:read` 和 `app_mention` 是否赶得上这次安装审批。推荐一起提交；赶不上的话，讨论串里的补充先不可用，其余照常。
