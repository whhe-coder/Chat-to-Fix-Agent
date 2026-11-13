# Slack 应用配置：Chat-to-Fix

本文记录 2026-11-12 在目标 Slack 工作区核对和修改的应用配置。本文不保存任何 token、secret、工作区 ID、App ID、回调地址或验证码。

## 打开配置页面

1. 用有权管理目标工作区应用的 Slack 账号打开 <https://api.slack.com/apps>。
2. 选择 `Chat-to-Fix`，在 Slack 页面核对 App ID。文档用 `SLACK_APP_ID` 表示该值。
3. 在左侧菜单进入 `App Home`、`Socket Mode`、`Event Subscriptions`、`OAuth & Permissions` 或 `Install App`。

文档用 `SLACK_WORKSPACE_ID` 表示工作区 ID。不要把实际 ID 或带有实际 ID 的应用设置链接写入公开仓库。

## 当前配置

| 页面 | 已核对的状态 | 用途 |
| --- | --- | --- |
| `App Home` | `Messages` 标签页仍开启 | 待关闭；新入口不使用私信 |
| `Socket Mode` | 已开启 | Bot 通过 WebSocket 接收 Slack 事件，无需公开 HTTP 接收地址 |
| `Event Subscriptions` | 页面显示 Off；无 Bot 事件 | `/fix` 使用 Slash Commands，不订阅普通消息 |
| `OAuth & Permissions → Bot Token Scopes` | 仅有 `commands`、`chat:write` | 接收 slash command，并以 Bot 身份回报 |
| `OAuth & Permissions → User Token Scopes` | 无 | Bot 不代表用户访问 Slack |
| `Slash Commands` | `/fix` 尚未创建 | 下一个配置步骤 |
| `Install App` | 工作区和组织申请仍显示 `Request ... Submitted`；链接列出新 scopes | 等待审批；待审记录是否同步更新为新 scopes 尚未证实，Bot OAuth token 尚未取得 |

目标入口改为指定频道内的 `/fix 问题描述`。频道类型和 ID 尚未确定。频道 `@提及`、普通频道消息和私信都不启动任务。应用不申请频道历史读取权限。完整目标行为见 [固定频道命令规格](../../spec/slack-fix-command.md)。

在关闭事件订阅前，`Event Subscriptions` 页面保留过未响应的旧 Request URL，本文记为 `SLACK_EVENT_REQUEST_URL`。当前使用 Socket Mode，不使用该地址。`OAuth & Permissions` 页面还保留旧的 OAuth Redirect URL，本文记为 `SLACK_OAUTH_CALLBACK_URL`。这两个 URL 未在本次配置中修改；如果以后改用 HTTP 或 OAuth 回调，必须先配置可用地址。

## Token 与 OAuth

| 凭据 | 权限 | 当前状态 | 程序变量 |
| --- | --- | --- | --- |
| App-level token，前缀 `xapp-` | 仅有 `connections:write` | 已生成并配置在本机 | `SLACK_APP_TOKEN` |
| Bot User OAuth Access Token，前缀 `xoxb-` | `commands`、`chat:write` | 等待安装批准，尚未取得 | `SLACK_BOT_TOKEN` |

`connections:write` 是 App-level token 的权限，不属于 Bot Token Scopes。当前不需要 User OAuth token。变量来源和本机保存方式见 [本地环境变量配置](../local-env/README.md)。

## 本次操作记录

1. 核对原有应用 `Chat-to-Fix`、Socket Mode 和 Events API 的状态。
2. 从原有配置移除多余的 Bot Token Scopes 和全部 User Token Scopes。
3. 将 Bot 事件调整为仅 `message.im`。Slack 同时添加了该事件所需的 `im:history`。
4. 删除 `app_mention` 事件和 `app_mentions:read`。保留发送进度消息所需的 `chat:write`。
5. 再次核对：Bot 权限仅为 `im:history`、`chat:write`；User 权限为空；Bot 事件仅为 `message.im`。

上述是 2026-11-11 的私信配置历史，不代表当前状态。后续已生成仅带 `connections:write` 的 App-level token，保存到本机 Mac 登录钥匙串，并提交工作区安装申请。

2026-11-12，用户决定改为固定频道 `/fix`。在用户确认后，增加 Bot scope `commands`，删除 `message.im` 订阅并保存；刷新后 Events 页面显示 Off、无事件。随后删除 `im:history`。OAuth 页面核对到 Bot scopes 仅有 `commands` 和 `chat:write`，User scopes 仍为空；安装页仍显示工作区和组织申请已提交，链接中的 scopes 已变为新组合。页面没有证明审批人看到的待审记录已经更新。尚未创建 `/fix` 命令，也未取得 Bot OAuth token。

## 接下来的配置与验证

1. 创建 `/fix` Slash Command，确定固定频道并让 Bot 加入。只允许该频道 ID 启动任务。
2. 核对待审申请确实包含 `commands`、`chat:write`，如需重新提交则按新权限办理。等待管理员批准安装，然后按 [本地环境变量配置](../local-env/README.md) 提供 `SLACK_BOT_TOKEN`。
3. 真实 Bot 的 `/fix` 处理代码和发件箱转发已实现，`npm run start:slack` 启动它；取得 Bot token 后再做真实验收。`npm start` 启动 Agent 和本机模拟页面，不连接真实 Slack。
4. 在指定频道调用 `/fix`，验证只启动一次任务并在同一任务 thread 回报。

旧私信测试 Bot 的行为保留在 [历史规格](../../spec/slack-dm-entry.md)。

## 参考

- [Slack：Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Slack：Slash Commands](https://docs.slack.dev/interactivity/implementing-slash-commands/)
