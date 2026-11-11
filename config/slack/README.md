# Slack 应用配置：Chat-to-Fix

本文记录 2026-11-11 在目标 Slack 工作区核对和修改的应用配置。本文不保存任何 token、secret、工作区 ID、App ID、回调地址或验证码。

## 打开配置页面

1. 用有权管理目标工作区应用的 Slack 账号打开 <https://api.slack.com/apps>。
2. 选择 `Chat-to-Fix`，在 Slack 页面核对 App ID。文档用 `SLACK_APP_ID` 表示该值。
3. 在左侧菜单进入 `App Home`、`Socket Mode`、`Event Subscriptions`、`OAuth & Permissions` 或 `Install App`。

文档用 `SLACK_WORKSPACE_ID` 表示工作区 ID。不要把实际 ID 或带有实际 ID 的应用设置链接写入公开仓库。

## 当前配置

| 页面 | 已核对的状态 | 用途 |
| --- | --- | --- |
| `App Home` | `Messages` 标签页已开启；允许用户在此发送消息 | 用户直接私信 Bot |
| `Socket Mode` | 已开启 | Bot 通过 WebSocket 接收 Slack 事件，无需公开 HTTP 接收地址 |
| `Event Subscriptions` | 已开启；Bot 事件仅有 `message.im` | 接收发给 Bot 的私信 |
| `OAuth & Permissions → Bot Token Scopes` | 仅有 `im:history`、`chat:write` | 读取 Bot 所在的私信，并以 Bot 身份回复 |
| `OAuth & Permissions → User Token Scopes` | 无 | Bot 不代表用户访问 Slack |
| `Install App` | 已显示 `Request to Workspace Install Submitted` | 安装申请已提交，等待工作区管理员批准；Bot OAuth token 尚未取得 |

频道 `@提及` 不属于当前入口。已删除 `app_mention` 事件和 `app_mentions:read` 权限。也已删除早期配置中的频道、群组、反应、用户资料和用户身份权限。

`Event Subscriptions` 页面仍保留一个未响应的旧 Request URL，本文记为 `SLACK_EVENT_REQUEST_URL`。当前已启用 Socket Mode，因此不使用这个 URL。`OAuth & Permissions` 页面还保留旧的 OAuth Redirect URL，本文记为 `SLACK_OAUTH_CALLBACK_URL`。这两个 URL 未在本次配置中修改；如果以后改用 HTTP 或 OAuth 回调，必须先配置可用地址。

## Token 与 OAuth

| 凭据 | 取得位置与权限 | 当前状态 | 程序变量 |
| --- | --- | --- | --- |
| App-level token，前缀 `xapp-` | `Basic Information → App-Level Tokens`，只选 `connections:write` | 已生成，存于本机 Mac 登录钥匙串 | `SLACK_APP_TOKEN` |
| Bot User OAuth Access Token，前缀 `xoxb-` | 工作区批准并完成安装后，在 `OAuth & Permissions` 查看 | 等待安装批准，尚未取得 | `SLACK_BOT_TOKEN` |

`connections:write` 是 App-level token 的权限，不属于 Bot Token Scopes。当前不需要 User OAuth token。本地程序优先读取环境变量；在 Mac 上也可读取登录钥匙串中账号为 `local-agent`、名称为 `Chat-to-Fix-Agent/SLACK_APP_TOKEN` 或 `Chat-to-Fix-Agent/SLACK_BOT_TOKEN` 的条目。不要把真实值写入仓库、日志、Slack 消息或计划文档。

## 本次操作记录

1. 核对原有应用 `Chat-to-Fix`、Socket Mode 和 Events API 的状态。
2. 从原有配置移除多余的 Bot Token Scopes 和全部 User Token Scopes。
3. 将 Bot 事件调整为仅 `message.im`。Slack 同时添加了该事件所需的 `im:history`。
4. 删除 `app_mention` 事件和 `app_mentions:read`。保留发送进度消息所需的 `chat:write`。
5. 再次核对：Bot 权限仅为 `im:history`、`chat:write`；User 权限为空；Bot 事件仅为 `message.im`。

上述初次配置没有生成 token 或提交安装申请。后续已生成仅带 `connections:write` 的 App-level token，保存到本机 Mac 登录钥匙串，并提交工作区安装申请。Slack 页面确认申请已提交。尚未取得 Bot OAuth token，也没有运行 Bot 或发送测试私信。

## 接下来的配置与验证

1. 等待工作区管理员批准安装，然后在 `OAuth & Permissions` 取得 Bot OAuth token，并保存到名称为 `Chat-to-Fix-Agent/SLACK_BOT_TOKEN`、账号为 `local-agent` 的 Mac 登录钥匙串条目。
2. 在仓库运行 `npm ci` 和 `npm start`。程序使用两个 token 连接 Socket Mode；需要 Node.js 18 或更新版本。也可通过同名环境变量提供 token。
3. 给 `Chat-to-Fix` 发送一条测试私信。确认 Bot 只在原私信 thread 回复一次。当前回复会明确说明这是接入测试，不创建 Jira 工单或 GitLab MR。
4. M0 验收通过后，在 M1 对接本地 agent 或服务；之后再验证工单、MR 和 CI 结果回到原 thread。

## 参考

- [Slack：Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Slack：App Home Messages 标签页](https://docs.slack.dev/surfaces/app-home/)
- [Slack：`message.im` 事件](https://docs.slack.dev/reference/events/message.im/)
