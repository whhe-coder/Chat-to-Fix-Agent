# Slack 应用配置：Chat-to-Fix

本文记录截至 2026-11-13 在目标 Slack 工作区核对和修改的应用配置。除用户提供的应用市场地址外，本文不保存任何 token、secret、工作区 ID、App ID、回调地址或验证码。

应用市场地址（用户提供）：[Chat-to-Fix](https://xsolla.slack.com/marketplace/A0CGR1RE6EN-chat-to-fix)。

## 打开配置页面

1. 用有权管理目标工作区应用的 Slack 账号打开 <https://api.slack.com/apps>。
2. 选择 `Chat-to-Fix`，在 Slack 页面核对 App ID。文档用 `SLACK_APP_ID` 表示该值。
3. 在左侧菜单进入 `App Home`、`Socket Mode`、`Event Subscriptions`、`OAuth & Permissions` 或 `Install App`。

文档用 `SLACK_WORKSPACE_ID` 表示工作区 ID。除上面的应用市场地址外，不要把实际 ID 或带有实际 ID 的应用设置链接写入公开仓库。

## 当前配置

| 页面 | 已核对的状态 | 用途 |
| --- | --- | --- |
| `App Home` | `Messages` 标签页已关闭 | 新入口不使用私信 |
| `Agents → Slack MCP Server` | 已关闭 | `/fix` 工作流不调用 Slack MCP 工具 |
| `Socket Mode` | 已开启 | Bot 通过 WebSocket 接收 Slack 事件，无需公开 HTTP 接收地址 |
| `Event Subscriptions` | 页面显示 Off；无 Bot 事件 | `/fix` 使用 Slash Commands，不订阅普通消息 |
| `OAuth & Permissions → Bot Token Scopes` | `commands`、`chat:write`、`users:read`、`users:read.email` | 接收 slash command、以 Bot 身份回报，并为读取发起人邮箱准备权限 |
| `OAuth & Permissions → User Token Scopes` | 无 | Bot 不代表用户访问 Slack |
| `Slash Commands` | `/fix` 已创建；说明为 `Report an issue and track its fix` | 接收指定频道的命令；真实 Bot 处理代码已实现，尚未完成真实 Slack 验收 |
| `Install App` | 用户报告工作区已批准；本机 Bot token 通过 Slack `auth.test`，响应列出四项当前 scopes | 审批人视图和旧待审记录的处理情况尚未核对 |

目标入口改为指定频道内的 `/fix 问题描述`。目标频道 ID 已确定，写入本机 `.env.local` 和 `.env.example`；Bot 已成功发送接入测试消息。频道 `@提及`、普通频道消息和私信都不启动任务。应用不申请频道历史读取权限。完整目标行为见 [固定频道命令规格](../../spec/slack-fix-command.md)。

在关闭事件订阅前，`Event Subscriptions` 页面保留过未响应的旧 Request URL，本文记为 `SLACK_EVENT_REQUEST_URL`。当前使用 Socket Mode，不使用该地址。`OAuth & Permissions` 页面还保留旧的 OAuth Redirect URL，本文记为 `SLACK_OAUTH_CALLBACK_URL`。这两个 URL 未在本次配置中修改；如果以后改用 HTTP 或 OAuth 回调，必须先配置可用地址。

## Token 与 OAuth

| 凭据 | 权限 | 当前状态 | 程序变量 |
| --- | --- | --- | --- |
| App-level token，前缀 `xapp-` | 仅有 `connections:write` | 已配置在本机；Slack `apps.connections.open` 返回可用的 Socket URL | `SLACK_APP_TOKEN` |
| Bot User OAuth Access Token，前缀 `xoxb-` | `commands`、`chat:write`、`users:read`、`users:read.email` | 已配置在本机；Slack `auth.test` 返回 `ok: true` 和四项 scopes | `SLACK_BOT_TOKEN` |

`connections:write` 是 App-level token 的权限，不属于 Bot Token Scopes。当前不需要 User OAuth token。变量来源和本机保存方式见 [本地环境变量配置](../local-env/README.md)。

## 本次操作记录

1. 核对原有应用 `Chat-to-Fix`、Socket Mode 和 Events API 的状态。
2. 从原有配置移除多余的 Bot Token Scopes 和全部 User Token Scopes。
3. 将 Bot 事件调整为仅 `message.im`。Slack 同时添加了该事件所需的 `im:history`。
4. 删除 `app_mention` 事件和 `app_mentions:read`。保留发送进度消息所需的 `chat:write`。
5. 再次核对：Bot 权限仅为 `im:history`、`chat:write`；User 权限为空；Bot 事件仅为 `message.im`。

上述是 2026-11-11 的私信配置历史，不代表当前状态。后续已生成仅带 `connections:write` 的 App-level token，保存到本机 Mac 登录钥匙串，并提交工作区安装申请。

2026-11-12，用户决定改为固定频道 `/fix`。在用户确认后，增加 Bot scope `commands`，删除 `message.im` 订阅并保存；刷新后 Events 页面显示 Off、无事件。随后删除 `im:history`。OAuth 页面核对到 Bot scopes 仅有 `commands` 和 `chat:write`，User scopes 仍为空；安装页仍显示工作区和组织申请已提交，链接中的 scopes 已变为新组合。页面没有证明审批人看到的待审记录已经更新。当时尚未创建 `/fix` 命令，也未取得 Bot OAuth token。

2026-11-13，在 Socket Mode 下创建 `/fix`，无需配置 Request URL。Short Description 为 `Report an issue and track its fix`；Usage Hint 为 `Describe the issue (e.g. login button does not respond)`。保存后命令列表显示 `/fix` 和英文说明。工作区及组织安装申请仍显示待审批；申请链接列出 `chat:write,commands`，但未核对审批人看到的待审记录。

2026-11-13，在用户确认后，为 Bot 增加 `users:read` 与 `users:read.email`。OAuth 页面核对到四项 Bot scopes，User scopes 仍为空；安装页仍显示工作区和组织申请已提交，申请链接已列出四项 scopes。页面没有证明待审记录已同步更新。当前 Bot 代码尚未调用 `users.info` 读取发起人邮箱。

2026-11-13，审批同事报告旧待审申请仍显示 `im:history`、`chat:write`，缺少 `commands`，并指出 Slack MCP 已开启。再次核对应用页面：Bot scopes 是 `commands`、`chat:write`、`users:read`、`users:read.email`；User scopes 为空；Event Subscriptions 为 Off。已关闭 `Agents → Slack MCP Server` 和 `App Home → Messages` 标签页。应用配置及安装页链接已更新，但旧待审申请没有得到更新证据。不能请审批人按旧记录直接批准。

2026-11-13，重新提交工作区安装申请。申请说明列出四项当前 Bot scopes、各自用途，并说明发起人邮箱读取尚未实现；同时说明不申请频道历史或 Slack MCP 访问。Slack 显示 `Success submitting the request!`。刷新后，工作区和组织安装链接均显示 `Submitted`，两个链接都列出四项当前 scopes。本次没有单独提交组织申请；尚未核对审批人端的待审记录，也未确认旧记录已取消。

2026-11-13，用户报告 Slack 应用已获批准。本机 `.env.local` 已有 `SLACK_BOT_TOKEN`；用它调用 Slack `auth.test` 返回 `ok: true`，响应头列出 `commands`、`chat:write`、`users:read`、`users:read.email`。验证未输出 token 值。尚未核对审批人视图和旧待审记录的处理情况。

同日，用本机 `SLACK_APP_TOKEN` 调用 Slack `apps.connections.open` 返回 `ok: true` 和 Socket URL。验证只核对是否返回 URL，未输出 URL 或 token，也未启动长期连接。

用户提供目标频道链接后，已将频道 ID 写入本机 `.env.local` 和 `.env.example`。用户允许发送一条接入测试消息；首次 `chat.postMessage` 返回 `channel_not_found`，没有发出消息。加入应用后重试返回 `ok: true`，响应频道与配置一致，并取得消息时间戳和永久链接。

## 将应用加入指定频道

工作区批准应用后，还需要把 `Chat-to-Fix` 加到要接收 `/fix` 的频道。当前指定频道为 `#ai-intern-logan-team`。

1. 在 Slack 打开目标频道，点击顶部的频道名称。
2. 进入 `Agents & apps`。点击 `Add Agent or App`；若已有其他应用，入口可能显示为 `Add more`。
3. 搜索 `Chat-to-Fix`，点击 `Add`，再核对应用出现在该频道的 `Agents & apps` 列表。也可以在频道输入 `/invite @Chat-to-Fix`。
4. 从频道链接的 `/archives/C…` 路径中取出以 `C` 开头的频道 ID，作为 `CHAT_TO_FIX_SLACK_CHANNEL` 的值。本项目已把目标频道 ID 写入 `.env.example` 和本机 `.env.local`；换频道时两处必须同步。

加入频道不等于启动任务。当前 Bot 只处理指定频道的 `/fix 问题描述`；普通消息、`@Chat-to-Fix` 和其他频道的 `/fix` 都不会启动任务。若 Bot 发信返回 `channel_not_found`，先核对应用是否已加入该频道、频道 ID 是否匹配。Slack 的 [应用频道管理说明](https://slack.com/help/articles/360001537467-Guide-to-apps-in-Slack) 和 [频道中添加应用的步骤](https://slack.com/help/articles/33076000248851-Work-with-AI-agents-in-Slack)可供对照。

## 接下来的验证

1. 当前运行中的 Agent `/health` 仍绑定旧的本机频道。实际接入前要按新配置重启 Agent，并核对它返回目标频道。
2. 真实 Bot 的 `/fix` 处理代码和发件箱转发已实现，`npm run start:slack` 启动它；读取发起人邮箱还需实现 `users.info` 调用。`npm start` 启动 Agent 和本机模拟页面，不连接真实 Slack。
3. 在指定频道调用 `/fix`，验证只启动一次任务并在同一任务 thread 回报。
4. 审批人端的旧待审记录是否取消尚未核对；已安装 token 的权限验证不依赖该记录。

旧私信测试 Bot 的行为保留在 [历史规格](../../spec/slack-dm-entry.md)。

## 参考

- [Slack：Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Slack：Slash Commands](https://docs.slack.dev/interactivity/implementing-slash-commands/)
