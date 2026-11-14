# `/fix` 显示“应用未响应”，疑与 Socket Mode 心跳超时重连有关

- 状态：现象已确认，原因为推断，待修复
- 发现日期：2026-11-14
- 关联：真实 Slack 首次 `/fix`（10:53，没有建任务）

## 复现

不稳定。当时 Bot 刚启动，在频道里发第一条 `/fix`。

## 现象与证据

- Slack 回 `由于应用未响应，/fix执行失败`（只有发起人可见）。Agent 没有新任务。
- Bot 终端在这之前打印两次 `[WARN] socket-mode:SlackWebSocket:1 A pong wasn't received from the server before the timeout of 5000ms!`，之后没有其他输出。
- 用 Ctrl+C 重启 Bot 后，下一条 `/fix`（T-5）正常。

## 原因（推断）

`@slack/socket-mode` 2.0.7 默认 5 秒收不到 pong 就断开 WebSocket 并自动重连。[`slack-bot.js`](../../src/slackBot/slack-bot.js) 用默认设置，也不监听连接状态。重连期间到达的 `/fix` 没人 `ack()`，Slack 3 秒后判定应用未响应。没有日志能证明那条命令正好落在重连窗口里。

## 验收

- [ ] Bot 记录 Socket 的断开、重连、恢复，能看出某次失败是否落在重连期间。
- [ ] 评估是否调大 ping 超时（`clientPingTimeout`）。
- [ ] 在 [Slack Bot 文档](../chat-to-fix/slack/slackbot.md) 写明：连接重连期间的 `/fix` 会失败，用户需要重发。
