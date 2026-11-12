# Jira 接入记录

目标：Jira Cloud 的 `F2PGBA` board。仓库不保存 Jira Cloud ID、board ID、账号邮箱或 token 值。

## 当前实现

[`src/jira/connection.js`](../../src/jira/connection.js) 提供独立的 `createJiraConnection()`。`npm run check:jira` 读取一个 board 的元数据。执行前需在本地提供以下配置：

| 变量 | 用途 |
| --- | --- |
| `JIRA_CLOUD_ID` | Atlassian Cloud ID。 |
| `JIRA_BOARD_ID` | 目标 board ID。 |
| `JIRA_TOKEN` | scoped API token；未设置时从 Mac 钥匙串 `Chat-to-Fix-Agent/JIRA_TOKEN`（账号 `local-agent`）读取。 |
| `JIRA_EMAIL` | 使用个人账号 token 时填写；服务账号 Bearer token 不填写。 |

scoped token 必须通过 `https://api.atlassian.com/ex/jira/{cloudId}` 调用 API。浏览器里的 board 页面地址不能直接用作 API 地址。不要把 token 写入仓库、命令参数、日志或聊天记录。

## 当前最小只读权限

`GET /rest/agile/1.0/board/{boardId}` 需要 `read:board-scope:jira-software`、`read:issue-details:jira`，以及该身份查看目标 board 的权限。2026-11-12 已在个人 Atlassian 账号下创建 `Chat-to-Fix-Board-Read` scoped token，应用仅选 Jira，权限仅选上述两项，到期日为 2027-02-09。token 已保存到本机钥匙串，值未写入仓库。创建工单、读取工单与添加评论所需 scopes 应按对应接口另行确定；不能把 `write:jira-work` 称为最小权限。

## 真实连接验证

2026-11-12 用本机钥匙串 token 执行 `npm run check:jira`。请求成功返回目标 board 的 ID 和名称 `F2PGBA board`。响应没有项目 key，因此连接函数返回 `projectKey: null`。这次检查只验证了 board 读取；没有创建工单或验证写入权限。Cloud ID、board ID 和个人邮箱只在本地执行时提供，仓库不记录其值。

复测时，从 `https://<site>.atlassian.net/_edge/tenant_info` 读取 Cloud ID，从目标 board 页面 URL 读取 board ID。个人 token 需要该 Atlassian 账号的邮箱。仓库不记录这些实际值。运行：

```sh
env JIRA_CLOUD_ID='<cloud-id>' JIRA_BOARD_ID='<board-id>' JIRA_EMAIL='<account-email>' npm run check:jira
```

命令从钥匙串读取 token，只输出 board 元数据。使用服务账号 token 时，不设置 `JIRA_EMAIL`；服务账号路径尚未做真实验证。

## 后续授权

优先使用只能访问目标项目的专用服务账号。当前登录的个人账号无法从已访问的组织管理入口管理该组织的服务账号；是否可使用现有 `F2P Jira Fix Agent` 身份仍待核实。用户已选择在专用账号不可用时，先用个人 scoped token 验证只读连接。该 token 的 scopes 不能限制到单一项目；它可读取个人账号有权访问的其他 board 和 issue。此验证不代表最终 agent 身份或写入权限已经配置。

## 参考

- [Atlassian：Get board](https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/)
- [Atlassian：管理 scoped API token](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)
- [Atlassian：服务账号 API token](https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/)
