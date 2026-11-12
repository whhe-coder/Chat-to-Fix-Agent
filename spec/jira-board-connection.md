# Jira board 连接规格

状态：board 的只读连接函数、本地测试和真实读取已完成。当前个人账号 Jira token 包含 board 读取和写入 API scopes，保存在本机钥匙串；旧只读 token 已撤销。工单和评论写入接口已实现，但真实写入尚未验证，见 [写入接口规格](jira-write-server.md)。

## 目标与入口

本地 agent 通过 [`createJiraConnection()`](../src/jira/connection.js) 读取 `F2PGBA` board。连接检查只调用 Jira Software Cloud 的 `GET /rest/agile/1.0/board/{boardId}`，返回 board ID、名称和响应中可用的项目 key。该连接对象也提供写入方法；只有调用写入方法才会创建或修改 Jira 数据。

调用 board 检查时设置 `JIRA_CLOUD_ID`、`JIRA_BOARD_ID`。`JIRA_TOKEN` 优先来自环境变量；未设置时，从 Mac 钥匙串 `Chat-to-Fix-Agent/JIRA_TOKEN`（账号 `local-agent`）读取。服务账号 token 使用 Bearer；若设置 `JIRA_EMAIL`，则使用该邮箱和个人 scoped token 的 Basic 认证。请求发送到 `https://api.atlassian.com/ex/jira/{cloudId}`。`npm run check:jira` 运行一次检查并只输出 board 元数据。

## 权限与安全

读取单个 board 的 token scopes 为 `read:board-scope:jira-software` 和 `read:issue-details:jira`。身份还必须有查看该 board 的 Jira 权限。连接函数不返回 token，也不转发 Jira 错误正文。新 token 的写入 API scopes 已配置；目标项目的实际创建工单和评论权限尚未验证。

## 验证边界

本地测试覆盖服务账号 Bearer、个人账号 Basic、目标 board 路径、钥匙串读取和错误脱敏。2026-11-12 用个人账号 scoped token 成功读取目标 board 的 ID 与名称；响应未给出项目 key，返回值为 `null`。服务账号的实际权限及 Jira 写入均未验证。

## 后续扩展约束

`checkBoard()` 成功只证明当前身份能读取该 board。M2 创建工单和评论时，必须分别核对目标 API 的 scopes 与 `F2PGBA` 项目权限，并做真实写入验证。不能用 `projectKey: null` 推断 board 不属于目标项目，也不能把 board 读取成功当作工单写入验收。
