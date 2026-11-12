# Slack 私信入口规格（M0）

状态：本地测试 Bot 已实现并通过消息处理测试；工作区安装尚待批准，真实私信收发尚未验收。后续任务先使用[模拟 Bot](mock-slack-bot.md) 开发。Jira、GitLab 和 CI 流程见 [实施计划](../plans/chat-to-fix-agent.md)，不属于当前真实私信入口行为。

## 输入与回复

- 只处理 Slack 的普通 `message.im` 文本消息。消息必须来自用户，且具有私信频道、时间戳和非空正文。
- 忽略频道消息、Bot 消息、带 `subtype` 的消息，以及缺少必要字段或正文为空的消息。
- 在收到的私信 thread 中回复。原消息已有 `thread_ts` 时沿用它；否则以原消息的 `ts` 开始 thread。
- 当前固定回复：`已收到你的消息。当前是 Slack 接入测试，不会创建 Jira 工单或 GitLab MR。`
- M0 不把消息交给本地 agent，也不创建 Jira 工单或 GitLab MR。

## 重复事件与失败

- 在当前进程内，以 Slack `event_id` 去重；缺少该字段时使用频道和消息时间戳。相同事件并发到达时，只发送一次回复。
- 每次处理有效消息时，清理一小时以前的去重记录。进程重启后的持久去重属于 M1。
- Slack 发消息失败时，移除该事件的去重记录；同一事件再次送达时可以重新尝试。当前程序不主动重新发送。

## 凭据与运行

- Socket Mode 使用 `SLACK_APP_TOKEN` 和 `SLACK_BOT_TOKEN`。变量来源和保存方式见 [本地环境变量配置](../config/local-env/README.md)。程序不主动输出 token，Git 历史不保存 token 值。
- 启动入口是 [`src/slackBot/slack-bot.js`](../src/slackBot/slack-bot.js)。安装依赖后运行 `npm start`。工作区批准安装并取得 Bot OAuth token 后，才能连接真实 Slack 私信。

## 验收场景与状态

| 场景 | 预期结果 | 当前状态 |
| --- | --- | --- |
| 用户发送普通私信或在已有 thread 中回复 | Bot 在对应 thread 回复一次测试说明 | 本地测试通过；真实 Slack 待验证 |
| 相同事件并发送达 | Bot 只发送一次回复 | 本地测试通过 |
| 频道、Bot、编辑或空消息到达 | Bot 不回复 | 本地测试通过 |
| 回复发送失败后同一事件再次送达 | Bot 可以再次尝试回复 | 本地测试通过 |

M0 仍需完成工作区安装和真实私信测试，尚未通过验收。
