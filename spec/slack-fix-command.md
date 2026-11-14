# 固定频道 `/fix` 入口规格

状态：Slack 应用已获工作区批准，Bot token 的四项预期 scopes 已通过 Slack `auth.test` 验证，`/fix` 命令已创建。Bot 的 `/fix` 处理代码和发件箱转发已实现（[`src/slackBot/`](../src/slackBot/)，`npm run start:slack`）。目标频道的一次真实联调已验证空正文提示、有效命令、任务消息、Jira 和 Draft MR 链接及讨论串回报。CI 在可选作业仍运行时提前报告通过，完整验收未完成。真实 Bot 读取发起人邮箱的代码尚未实现；本机模拟频道已能把配置的邮箱随 `/fix` 交给 Agent，见 [模拟 Bot 规格](mock-slack-bot.md)。旧私信入口见 [历史规格](slack-dm-entry.md)。

## 目标行为

- 用户在指定频道输入 `/fix 问题描述`。命令正文必须非空。频道 ID 已确定，Bot 发信能力已验证。
- Bot 仅接受指定频道的 `/fix`。其他频道的调用只向发起者返回拒绝说明，不启动任务。
- Bot 在 Slack 要求的时间内确认命令，再在指定频道发布一条任务消息。后续 Jira、Draft MR 和 CI 进度回复到该消息的 thread。
- 相同命令重试不得重复启动任务。完整的持久去重在任务接入里程碑实现。
- 普通频道消息、私信和 thread 回复不启动任务。
- 回报的内容来自 Chat-to-Fix 的发件箱，Bot 原样发到任务消息的 thread，不自己写进度文案，见 [Slack Bot 接口](../docs/chat-to-fix/slack/slackbot.md) 4.2(2)。

### 每种情况的处理

按表中顺序判断，命中一条即停。临时消息走 `/fix` 载荷的 `response_url`，只有发起者可见，不需要 Bot 在频道里。

| 情况 | Bot 做什么 |
| --- | --- |
| 收到任何 `/fix` | 先确认命令（Slack 要求 3 秒内），再往下判断 |
| 同一个 `trigger_id` 重复送达 | 不再处理（进程内去重，保留一小时） |
| 正文为空 | 临时消息：`用法：/fix 问题描述，例如：/fix 登录页的“忘记密码”链接点了没反应。` |
| 在私信或其他频道里用 | 临时消息：`请在指定频道里用 /fix。`，不启动任务 |
| 同一人在同一频道 5 秒内又发了 `/fix` | 只处理最后一条：前一条回临时消息 `这条 /fix 已被你后一条替代，只处理最后一条。`；最后一条静默满 5 秒才往下走 |
| 通过上面几条后 | 调 Chat-to-Fix 的 `GET /health` |
| `/health` 连不上、超时或不是 200 | 临时消息：`Chat-to-Fix 服务暂时连不上，这次请求没有开始处理，请稍后再用 /fix 提交。`，频道里不发任何东西 |
| `/health` 返回了 `channels`，但里面没有本频道 | 临时消息：`机器人配置有误（频道和服务不一致），这次请求没有开始处理，请联系维护人员。`，记日志；没有 `channels` 字段（旧版 Agent）不检查 |
| `/health` 的 `queueFull` 为真 | 临时消息：`修复队列已满，这次请求没有接收，请稍后再试。`，频道里不发任何东西 |
| `/health` 正常 | 在频道发任务消息 `<@发起者> 提交了修复请求：<原文>`（先去掉广播式提及），第二行 `要补充或修改，请重新 /fix 并写完整描述。`，再调 `POST /events`：`source: "fix"`，`eventId` 为 `slash:<trigger_id>`，`threadTs` 和 `messageTs` 都是任务消息的 `ts` |
| 任务消息发不出去（例如 Bot 不在频道里） | 临时消息：`机器人没能在频道里发出任务消息，这次请求没有开始处理。请稍后再试；一直这样请联系维护人员。`，不调 `POST /events` |
| `POST /events` 连不上、超时或返回 5xx | 隔 2 秒用同一个 `eventId` 重发一次（Chat-to-Fix 按 `eventId` 去重，不会建第二个任务），成功就不说话 |
| 重发后连接仍被拒（请求没到 Chat-to-Fix） | 在任务消息的 thread 里回 `Chat-to-Fix 服务暂时连不上，这次请求没有开始处理，请稍后再用 /fix 提交。` |
| 重发后仍超时、5xx 或其他网络错误（不知道收没收到） | 在任务消息的 thread 里回 `请求可能已经开始处理，请先看本讨论串后面的消息，不要重复提交。` |
| `POST /events` 返回 4xx | Bot 不另外说话，说明由 Chat-to-Fix 放进发件箱 |

先问 `/health`，是为了“拒绝只向发起者返回”：服务没开或队列满时，频道里不留一条没人处理的任务消息。

## Slack Bot 实现

代码在 [`src/slackBot/`](../src/slackBot/)，`npm run start:slack` 启动。Chat-to-Fix 接口的字段和返回码以 [Slack Bot 接口](../docs/chat-to-fix/slack/slackbot.md) 4.2 为准，这里不重复。

| 文件 | 作用 |
| --- | --- |
| `slack-bot.js` | Bolt Socket Mode 入口；挂 `app.command('/fix')` 和发件箱转发；没有 `CHAT_TO_FIX_SLACK_CHANNEL` 不启动；启动时 Agent 在线且 `/health` 的 `channels` 里没有本频道也不启动 |
| `fix-command.js` | 上表的 `/fix` 处理 |
| `outbox-relay.js` | 每 3 秒拉 `GET /outbox`，把每条 `text` 发到 `channel` 的 `threadTs` thread，每发成功一条把游标存进文件 |
| `chat-to-fix-api.js` | Chat-to-Fix 本机接口客户端，请求头带 `x-chat-to-fix-token` |

- **游标**：存在 `SLACK_BOT_STATE_DIR`（默认 `src/slackBot/.data/`）的 `outbox-cursor`，内容是 `{"outboxId":"…","seq":N}`（旧格式只有数字，也能读）。没有游标文件时从发件箱最新一条之后开始，不重发旧消息。`/outbox` 返回的 `outboxId` 和游标里的不同，说明发件箱被重置过，从头转发；同一个 `outboxId` 但游标大于 `lastSeq`，改为 `lastSeq`。投递是“至少一次”：发完一条还没存游标就崩溃，重启后这条会再发一次。
- **发送失败**：限流、网络错误和 `not_in_channel` 停在这一条，下一轮重发；`channel_not_found`、`is_archived`、`msg_too_long`、`no_text` 记录后跳过，不挡住后面的消息。
- **接口令牌**：`CHAT_TO_FIX_HTTP_TOKEN`，留空时每次请求读 Agent 数据目录的 `http-token`，和模拟频道相同。地址为 `CHAT_TO_FIX_API_URL`，默认 `http://127.0.0.1:3090`。
- **部署**：Bot 和 Chat-to-Fix 跑在同一台机器上，接口只听本机。同一个 Slack 应用同一时间只让 Bot 一个程序连 Socket Mode。
- **已知缺口**：Bot 重启后 Slack 重投同一条 `/fix`，可能多发一条任务消息，但不会重复建任务（Chat-to-Fix 按 `eventId` 持久去重）。游标文件丢失期间新写进发件箱的消息会漏发。防抖只在进程内：5 秒窗口内 Bot 重启，等待中的那条会丢，用户需要重发。

## Slack 配置与权限

| 项目 | 目标 | 当前状态 |
| --- | --- | --- |
| Bot Token Scopes | `commands`、`chat:write`、`users:read`、`users:read.email` | 已在应用页面核对；真实 Bot 读取发起人邮箱的代码尚未实现 |
| User Token Scopes | 无 | 已核对 |
| Event Subscriptions | 不订阅消息事件 | 已移除 `message.im`，页面显示 Off |
| App Home Messages | 关闭私信标签 | 已关闭 |
| Slack MCP Server | 关闭 | 已关闭；`/fix` 不调用 Slack MCP 工具 |
| Socket Mode | 开启 | 已开启 |
| Slash Commands | 注册 `/fix` | 已创建；说明与用法提示均为英文 |
| 固定频道 | 确定频道 ID 并让 Bot 加入；代码只接受其 ID | ID 已写入 `.env.example` 和本机配置；Bot 在该频道发信成功 |
| 工作区安装与 Bot token | 使用四项当前权限完成审批和安装 | 用户报告已获工作区批准；本机 Bot token 通过 Slack `auth.test`，响应列出四项预期 scopes。审批人视图与旧申请处理尚未核对 |

`commands` 接收命令载荷；`chat:write` 用于发布任务消息和长期进度；`users:read` 与 `users:read.email` 为后续通过 `users.info` 获取发起人邮箱准备。当前不申请频道历史读取权限。Slack App-level token 的 `connections:write` 保持不变。实际配置操作见 [Slack 配置记录](../config/slack/README.md)。

## 验收

在指定频道调用一次 `/fix`，只创建一个任务消息；重复投递不重复启动任务；其他频道调用被拒绝；服务不通、队列满时只有发起者看到提示；Bot 在任务消息的 thread 回报发件箱里的进度和结果。真实调用已验证空正文提示及一次有效任务的讨论串回报。重复投递、其他频道和服务故障路径待验收；CI 的提前结论见[已确认问题](../docs/issues/gitlab-optional-job-premature-ci-pass.md)。
