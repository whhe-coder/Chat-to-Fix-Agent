# Jira 工单和评论接口规格

状态：本地 Node.js 服务和 Jira 连接函数已实现。模拟请求测试通过。现有 Jira token 仅获 board 读取授权；真实工单和评论写入尚未验证。

## 接口

服务只监听 `127.0.0.1`，默认端口为 `4000`。所有写入请求都需要 `Content-Type: application/json`，请求体上限为 64 KiB。

| 请求 | JSON 输入 | 成功结果 |
| --- | --- | --- |
| `GET /jira/board` | 无 | `200`，board ID、名称和可用的项目 key。 |
| `POST /jira/issues` | `summary`、`description`、`issueTypeName`，均为非空文本。 | `201`，工单 `id` 和 `key`。 |
| `POST /jira/issues/F2PGBA-123/comments` | `body`，非空文本。 | `201`，工单 key 和评论 ID。 |
| `PUT /jira/issues/F2PGBA-123/comments/456` | `body`，非空文本。 | `200`，工单 key 和评论 ID。 |

工单创建固定使用 `F2PGBA` 项目。调用方必须明确提供 `issueTypeName`；该类型须在目标项目中可创建。服务不接受其他项目的评论路径。Jira Cloud v3 的描述和评论正文使用 Atlassian Document Format；服务将普通文本的每一行转成一个段落。

“创建在 F2PGBA 项目”不保证工单出现在特定 board。真实验收须核对该 board 的筛选规则、可用 issue type 和创建时的必填字段。

## 凭据与安全

Jira 连接从 `JIRA_TOKEN` 环境变量或本机钥匙串 `Chat-to-Fix-Agent/JIRA_TOKEN`（账号 `local-agent`）取得 token。连接需要 `JIRA_CLOUD_ID`；只有 board 检查还需要 `JIRA_BOARD_ID`。个人 scoped token 使用 `JIRA_EMAIL` 和 Basic 认证；服务账号 token 不设置该邮箱，使用 Bearer。凭据设置见 [Jira 接入记录](../config/jira/README.md)。

写入接口只接受 `Host: 127.0.0.1:<port>`。若请求带 `Origin`，它必须与该本机地址相同。服务拒绝跨站、非 JSON、无效输入和非 F2PGBA 工单路径。服务不返回 token 或 Jira 错误正文。没有 token 时，Jira 接口返回 `503`。Jira 拒绝写入时，服务返回 `502` 和上游状态码，不返回上游正文。

## 验证边界

本地测试覆盖工单 payload、ADF 转换、评论路径、输入限制、跨项目拒绝、跨站拒绝和错误脱敏。真实 Jira 写入需要新的授权，并验证账号在 `F2PGBA` 项目具备 Browse projects、Create issues、Add comments，以及修改自身评论所需的 Edit own comments 权限。只有要修改其他人的评论时才需要 Edit all comments；当前目标是修改 agent 自己发布的评论。

现有只读 token 不具备写入能力。本规格不表示 M2 已通过验收；还需真实创建工单和评论、确认 board 展示、接入 Slack 消息与任务去重。

## 参考

- [Atlassian：Create issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post)
- [Atlassian：Issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
