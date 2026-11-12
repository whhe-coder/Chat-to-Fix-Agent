# Jira 工单和评论接口规格

> 历史记录：外围本地 HTTP 服务已删除。本文仅保留当时的接口和验证证据，不是当前运行说明。

状态：本地 Node.js 服务和 Jira 连接函数已实现。模拟请求测试和新 scoped token 的真实创建、评论新增、评论修改、评论回读及 board 查询均已通过。Slack 任务链路尚未接入。

## 接口

服务只监听 `127.0.0.1`，默认端口为 `4000`。所有写入请求都需要 `Content-Type: application/json`，请求体上限为 64 KiB。

| 请求 | JSON 输入 | 成功结果 |
| --- | --- | --- |
| `GET /jira/board` | 无 | `200`，board ID、名称和可用的项目 key。 |
| `POST /jira/issues` | `summary`、`description`、`issueTypeName`、`workType`，均为非空文本。 | `201`，工单 `id` 和 `key`。 |
| `POST /jira/issues/F2PGBA-123/comments` | `body`，非空文本。 | `201`，工单 key 和评论 ID。 |
| `PUT /jira/issues/F2PGBA-123/comments/456` | `body`，非空文本。 | `200`，工单 key 和评论 ID。 |

工单创建固定使用 `F2PGBA` 项目。调用方必须明确提供 `issueTypeName` 和 `workType`。项目要求 `Work type`；连接函数把它写入 `JIRA_WORK_TYPE_FIELD_ID` 指定的单选字段。已用 `Task` 和 `Tech Research` 完成测试工单。服务不接受其他项目的评论路径。Jira Cloud v3 的描述和评论正文使用 Atlassian Document Format；服务将普通文本的每一行转成一个段落。

本次测试工单通过目标 board 的 issue 查询返回。其他 issue type 和 `Work type` 值仍需按目标项目实际配置选择。

## 凭据与安全

Jira 连接需要 `JIRA_TOKEN`、`JIRA_CLOUD_ID`；创建工单还需要 `JIRA_WORK_TYPE_FIELD_ID`；board 检查需要 `JIRA_BOARD_ID`。个人 scoped token 使用 `JIRA_EMAIL` 和 Basic 认证；服务账号 token 不设置该邮箱，使用 Bearer。变量来源和保存方式见 [本地环境变量配置](../../../config/local-env/README.md)，授权设置见 [Jira 接入记录](../../../config/jira/README.md)。

写入接口只接受 `Host: 127.0.0.1:<port>`。若请求带 `Origin`，它必须与该本机地址相同。服务拒绝跨站、非 JSON、无效输入和非 F2PGBA 工单路径。服务不返回 token 或 Jira 错误正文。没有 token 时，Jira 接口返回 `503`。Jira 拒绝写入时，服务返回 `502` 和上游状态码，不返回上游正文。

## 验证边界

本地测试覆盖工单 payload、必填 `Work type`、ADF 转换、评论路径、输入限制、跨项目拒绝、跨站拒绝和错误脱敏；28 项测试通过。新 Jira token 已通过目标项目的真实创建、评论新增和自身评论修改操作。该结果证明当前账号具备这些操作所需的有效权限；没有验证修改他人评论的权限。

真实创建返回 `201`，评论新增返回 `201`，评论修改返回 `200`；随后用新 token 回读到修改后的评论，并通过目标 board 查询到该工单。本规格不表示 M2 已通过验收；仍需接入 Slack 消息、任务去重和工单链接回报。

## 参考

- [Atlassian：Create issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post)
- [Atlassian：Issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
