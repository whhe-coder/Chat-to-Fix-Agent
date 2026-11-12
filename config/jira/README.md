# Jira 接入记录

目标：Jira Cloud 的 `F2PGBA` board。仓库不保存 Jira Cloud ID、board ID、账号邮箱或 token 值。

## 当前实现

[`src/jira/connection.js`](../../src/jira/connection.js) 提供独立的 `createJiraConnection()`。`npm run check:jira` 读取一个 board 的元数据；`npm run start:server` 启动本地 HTTP 服务，提供 board 读取、`F2PGBA` 工单创建、评论新增和评论修改接口。写入方法已通过真实调用验证。执行前需在本地提供以下配置：

| 变量 | 用途 |
| --- | --- |
| `JIRA_CLOUD_ID` | Atlassian Cloud ID。 |
| `JIRA_BOARD_ID` | 目标 board ID；只在读取 board 时需要。 |
| `JIRA_TOKEN` | scoped API token；未设置时从 Mac 钥匙串 `Chat-to-Fix-Agent/JIRA_TOKEN`（账号 `local-agent`）读取。 |
| `JIRA_EMAIL` | 使用个人账号 token 时填写；服务账号 Bearer token 不填写。 |
| `JIRA_WORK_TYPE_FIELD_ID` | `F2PGBA` 的必填 `Work type` 单选字段 ID，格式为 `customfield_<数字>`；创建工单时需要。 |

scoped token 必须通过 `https://api.atlassian.com/ex/jira/{cloudId}` 调用 API。浏览器里的 board 页面地址不能直接用作 API 地址。不要把 token 写入仓库、命令参数、日志或聊天记录。

## Board 读取权限

`GET /rest/agile/1.0/board/{boardId}` 需要 `read:board-scope:jira-software`、`read:issue-details:jira`，以及该身份查看目标 board 的权限。这两项已包含在当前 `Chat-to-Fix-Jira-Issues-Comments` token 中。此前的 `Chat-to-Fix-Board-Read` 只读 token 已于 2026-11-12 撤销。

## 写入接口与权限

本地服务只监听 `127.0.0.1:4000`，可用 `PORT` 修改端口。接口说明见 [Jira 写入接口规格](../../spec/jira-write-server.md)。以下示例会在目标项目真实创建工单和评论，运行时须使用实际任务内容：

```sh
curl -X POST http://127.0.0.1:4000/jira/issues -H 'Content-Type: application/json' -d '{"summary":"Fix checkout","description":"Problem details","issueTypeName":"Task","workType":"Tech Research"}'
curl -X POST http://127.0.0.1:4000/jira/issues/F2PGBA-123/comments -H 'Content-Type: application/json' -d '{"body":"Investigation started"}'
curl -X PUT http://127.0.0.1:4000/jira/issues/F2PGBA-123/comments/456 -H 'Content-Type: application/json' -d '{"body":"Investigation updated"}'
```

Jira 账号需要 `F2PGBA` 的 Browse projects、Create issues、Add comments 和 Edit own comments 项目权限。当前只计划修改该账号自己创建的评论。Atlassian 官方 OpenAPI 对创建工单、新增评论和修改评论三个接口列出的 granular OAuth scope 并集如下；它属于接口文档中的 Beta granular 清单，创建 scoped API token 时仍需核对管理页面实际提供的选项：

| 写入 | 读取 |
| --- | --- |
| `write:issue:jira`、`write:comment:jira`、`write:comment.property:jira`、`write:attachment:jira` | `read:issue:jira`、`read:comment:jira`、`read:comment.property:jira`、`read:group:jira`、`read:project:jira`、`read:project-role:jira`、`read:user:jira`、`read:avatar:jira` |

这些 scopes 不限制到单一项目；实际访问范围还取决于账号的 Jira 项目权限。不要把 `write:jira-work` 当作最小权限。新 token 还包含原有的 `read:board-scope:jira-software` 和 `read:issue-details:jira`，共 14 项 scopes。

2026-11-12 已在个人 Atlassian 账号下创建仅限 Jira 的 `Chat-to-Fix-Jira-Issues-Comments` scoped token，到期日为 2027-02-09。Atlassian 创建前确认页列出上述 14 项 scopes。用户已将新值保存到本机钥匙串；本地 API 检查后，Atlassian 列表显示新 token 被访问。旧 `Chat-to-Fix-Board-Read` 已撤销；刷新后的列表只保留新的 Chat-to-Fix Jira token。已确认 `F2PGBA` 的 `Task` 类型可创建，`Work type` 为必填字段，测试工单可进入目标 board。

## 真实连接验证

2026-11-12 用新 token 执行 `npm run check:jira`，成功读取目标 board。初次创建请求返回 `400`，Jira 指明 `Work type` 必填。通过 Jira 页面确认该字段为单选，并从字段元数据取得 ID；该 ID 只在本地配置，仓库不记录实际值。补齐 `Task` 类型和 `Tech Research` 值后，本地服务真实创建一张标明为验证用途的工单，返回 `201`。服务新增评论返回 `201`，修改自身评论返回 `200`。新 token 回读到修改后的评论；目标 board 的 issue 查询返回该工单。完整本地测试 28 项通过。Cloud ID、board ID、个人邮箱、字段 ID 和测试工单编号均不写入仓库。

同一 token 调用项目元数据、字段查询和单个工单读取接口时返回 `401 scope does not match`。这不影响已验证的创建、评论和 board 查询，但后续若需要动态发现字段或读取完整工单，须先查明这些读取接口的授权差异。不能把已选的 scope 清单直接等同于所有读取 API 均可用。

复测时，从 `https://<site>.atlassian.net/_edge/tenant_info` 读取 Cloud ID，从目标 board 页面 URL 读取 board ID。个人 token 需要该 Atlassian 账号的邮箱。仓库不记录这些实际值。运行：

```sh
env JIRA_CLOUD_ID='<cloud-id>' JIRA_BOARD_ID='<board-id>' JIRA_EMAIL='<account-email>' npm run check:jira
```

命令从钥匙串读取 token，只输出 board 元数据。创建工单时另需设置 `JIRA_WORK_TYPE_FIELD_ID`。可在已登录的 Jira 浏览器会话中查询 `/rest/api/3/field/search?query=Work%20type`，选取名称精确等于 `Work type` 的字段 ID。使用服务账号 token 时，不设置 `JIRA_EMAIL`；服务账号路径尚未做真实验证。

## 后续授权

优先使用只能访问目标项目的专用服务账号。当前登录的个人账号无法从已访问的组织管理入口管理该组织的服务账号；是否可使用现有 `F2P Jira Fix Agent` 身份仍待核实。用户已选择暂用个人 scoped token，且真实 Jira 写入已通过。该 token 的 scopes 不能限制到单一项目；实际读写范围取决于个人账号在各项目的权限。当前本地服务在代码中把写入目标限制到 `F2PGBA`，但这不限制 token 本身在其他客户端中的用途。服务账号路径尚未验证。

## 参考

- [Atlassian：Get board](https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/)
- [Atlassian：Create issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post)
- [Atlassian：Issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
- [Atlassian：Jira Cloud v3 OpenAPI](https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json)
- [Atlassian：管理 scoped API token](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)
- [Atlassian：服务账号 API token](https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/)
