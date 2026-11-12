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

## GitLab 接入准备（不代表 M1 或 M3 验收通过）

- [x] 在 [`src/server/`](../src/server/) 增加只监听本机的 Node.js 服务。`/health` 可用；`/gitlab/status` 以只读调用读取目标仓库的 `master` 分支。
- [x] 服务测试 3 项通过；本机启动服务后，真实 GitLab API 返回目标仓库的 `master` 提交信息。未验证 Git push 或创建 MR。
- [x] 创建 `chat-to-fix-agent` 项目 token：`Developer` 角色，仅选 `api` 和 `write_repository`，2026-12-11 到期。完整值已保存到本机 Mac 登录钥匙串；仓库不保存值。
- [x] 使用新 token 只读验证目标仓库分支、MR、pipeline、jobs 和一条 job trace，均返回 `200`。Git push、Draft MR 创建与标题／描述更新尚未验证。
- [x] 本地服务已从约定的 Mac 钥匙串条目读取新 token，并通过 `/gitlab/status` 返回目标仓库的 `master` 提交信息；默认端口 `4000` 已验证可用。
- [x] GitLab 客户端已实现 Draft MR 创建与标题／描述更新方法，并在本地验证分支检查和 Draft 状态保护。真实 MR 写入尚未执行。
- [x] `/gitlab/merge-requests/:iid/checks` 已通过现有 MR 的真实只读调用；它返回当前 commit、主 pipeline、已发现的下游 pipeline 和失败 jobs。尚未验证多条当前 commit pipeline 的选择规则或自动修复循环。
- [x] 将 GitLab 客户端移到 [`src/gitlab/`](../src/gitlab/)，抽出 `createGitlabConnection()` 和 `loadGitlabToken()`。服务改用该连接对象；本地测试共 14 项通过，其中 2 项验证凭据来源和独立连接。重构后的服务尚未做真实 GitLab 复测。

## Jira 接入准备（不代表 M2 验收通过）

- [x] 确认目标为 Jira Cloud 的 `F2PGBA` board，核对读取单个 board 的官方 API 和所需 scopes。
- [x] 在 [`src/jira/`](../src/jira/) 实现独立只读连接函数与检查命令。模拟服务账号 Bearer、个人账号 Basic、钥匙串读取、错误脱敏的本地测试通过；当前完整本地测试为 19 项。真实 Jira API 尚未验证。
- [x] 在个人 Atlassian 账号下创建 `Chat-to-Fix-Board-Read` scoped token；应用仅选 Jira，权限仅选 `read:board-scope:jira-software` 和 `read:issue-details:jira`，到期日为 2027-02-09。token 尚未保存到本机钥匙串，真实 board API 尚未验证。
