# Chat-to-Fix Agent 已完成事项

更新日期：2026-11-11。本文只记录已落实并核对的事项。未完成工作和里程碑验收标准见 [实施计划](chat-to-fix-agent.md)。

## M0 Slack 私信入口

- [x] `App Home` 的 `Messages` 标签页允许用户发送私信。
- [x] Socket Mode 已开启。
- [x] Events API 仅订阅 `message.im`。
- [x] Bot Token Scopes 仅有 `im:history`、`chat:write`；User Token Scopes 为空。
- [x] 生成仅带 `connections:write` 的 App-level token，并保存到本机 Mac 登录钥匙串。仓库不保存 token 值。
- [x] 提交目标工作区安装申请；Slack 页面显示 `Request Submitted`。该申请尚不代表安装已获批准。
- [x] 在 [`src/slackBot/`](../src/slackBot/) 编写最小私信测试 Bot；本地 4 项消息处理测试通过。尚未进行真实私信收发验证。
