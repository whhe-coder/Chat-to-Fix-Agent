# Jira 接入记录

目标：Jira Cloud 的 `F2PGBA` board。仓库不保存 Jira Cloud ID、board ID、账号邮箱或 token 值。

## 当前实现

[`src/jira/connection.js`](../../src/jira/connection.js) 提供独立的 `createJiraConnection()`。`npm run check:jira` 读取一个 board 的元数据；`npm run start:server` 启动本地 HTTP 服务，提供 board 读取、`F2PGBA` 工单创建、评论新增和评论修改接口。写入方法已实现，尚未进行真实写入验证。执行前需在本地提供以下配置：

| 变量 | 用途 |
| --- | --- |
| `JIRA_CLOUD_ID` | Atlassian Cloud ID。 |
| `JIRA_BOARD_ID` | 目标 board ID；只在读取 board 时需要。 |
| `JIRA_TOKEN` | scoped API token；未设置时从 Mac 钥匙串 `Chat-to-Fix-Agent/JIRA_TOKEN`（账号 `local-agent`）读取。 |
| `JIRA_EMAIL` | 使用个人账号 token 时填写；服务账号 Bearer token 不填写。 |

scoped token 必须通过 `https://api.atlassian.com/ex/jira/{cloudId}` 调用 API。浏览器里的 board 页面地址不能直接用作 API 地址。不要把 token 写入仓库、命令参数、日志或聊天记录。

## 当前最小只读权限

`GET /rest/agile/1.0/board/{boardId}` 需要 `read:board-scope:jira-software`、`read:issue-details:jira`，以及该身份查看目标 board 的权限。2026-11-12 已在个人 Atlassian 账号下创建 `Chat-to-Fix-Board-Read` scoped token，应用仅选 Jira，权限仅选上述两项，到期日为 2027-02-09。token 已保存到本机钥匙串，值未写入仓库。它不能用于写入。

## 写入接口与待配置权限

本地服务只监听 `127.0.0.1:4000`，可用 `PORT` 修改端口。接口说明见 [Jira 写入接口规格](../../spec/jira-write-server.md)。示例请求只说明格式，使用真实授权前不应向生产项目发送测试数据：

```sh
curl -X POST http://127.0.0.1:4000/jira/issues -H 'Content-Type: application/json' -d '{"summary":"Fix checkout","description":"Problem details","issueTypeName":"Bug"}'
curl -X POST http://127.0.0.1:4000/jira/issues/F2PGBA-123/comments -H 'Content-Type: application/json' -d '{"body":"Investigation started"}'
curl -X PUT http://127.0.0.1:4000/jira/issues/F2PGBA-123/comments/456 -H 'Content-Type: application/json' -d '{"body":"Investigation updated"}'
```

Jira 账号需要 `F2PGBA` 的 Browse projects、Create issues、Add comments 和 Edit own comments 项目权限。当前只计划修改该账号自己创建的评论。Atlassian 官方 OpenAPI 对创建工单、新增评论和修改评论三个接口列出的 granular OAuth scope 并集如下；它属于接口文档中的 Beta granular 清单，创建 scoped API token 时仍需核对管理页面实际提供的选项：

| 写入 | 读取 |
| --- | --- |
| `write:issue:jira`、`write:comment:jira`、`write:comment.property:jira`、`write:attachment:jira` | `read:issue:jira`、`read:comment:jira`、`read:comment.property:jira`、`read:group:jira`、`read:project:jira`、`read:project-role:jira`、`read:user:jira`、`read:avatar:jira` |

这些 scopes 不限制到单一项目；实际访问范围还取决于账号的 Jira 项目权限。不要把 `write:jira-work` 当作最小权限。新 token 还包含原有的 `read:board-scope:jira-software` 和 `read:issue-details:jira`，共 14 项 scopes。

2026-11-12 已在个人 Atlassian 账号下创建仅限 Jira 的 `Chat-to-Fix-Jira-Issues-Comments` scoped token，到期日为 2027-02-09。Atlassian 创建前确认页列出上述 14 项 scopes。新值仍停留在一次性复制页面，尚未确认保存到本机钥匙串或通过 API 验证。旧 `Chat-to-Fix-Board-Read` token 仍有效。用户要求以后使用新 token，并在新 token 保存及验证后撤销旧 token。F2PGBA 的可用 issue type、必填字段和 board 筛选规则仍待核对。

## 真实连接验证

2026-11-12 用本机钥匙串 token 执行 `npm run check:jira`。请求成功返回目标 board 的 ID 和名称 `F2PGBA board`。响应没有项目 key，因此连接函数返回 `projectKey: null`。这次检查只验证了 board 读取；没有创建工单或验证写入权限。新增的 HTTP 写入路由只通过本地模拟测试。Cloud ID、board ID 和个人邮箱只在本地执行时提供，仓库不记录其值。

复测时，从 `https://<site>.atlassian.net/_edge/tenant_info` 读取 Cloud ID，从目标 board 页面 URL 读取 board ID。个人 token 需要该 Atlassian 账号的邮箱。仓库不记录这些实际值。运行：

```sh
env JIRA_CLOUD_ID='<cloud-id>' JIRA_BOARD_ID='<board-id>' JIRA_EMAIL='<account-email>' npm run check:jira
```

命令从钥匙串读取 token，只输出 board 元数据。使用服务账号 token 时，不设置 `JIRA_EMAIL`；服务账号路径尚未做真实验证。

## 后续授权

优先使用只能访问目标项目的专用服务账号。当前登录的个人账号无法从已访问的组织管理入口管理该组织的服务账号；是否可使用现有 `F2P Jira Fix Agent` 身份仍待核实。用户已选择在专用账号不可用时，先用个人 scoped token 验证只读连接。该 token 的 scopes 不能限制到单一项目；它可读取个人账号有权访问的其他 board 和 issue。此验证不代表最终 agent 身份或写入权限已经配置。

## 参考

- [Atlassian：Get board](https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/)
- [Atlassian：Create issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post)
- [Atlassian：Issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
- [Atlassian：Jira Cloud v3 OpenAPI](https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json)
- [Atlassian：管理 scoped API token](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)
- [Atlassian：服务账号 API token](https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/)
