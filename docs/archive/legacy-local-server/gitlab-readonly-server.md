# GitLab 只读服务规格

> 历史记录：外围本地 HTTP 服务已删除。本文仅保留当时的接口和验证证据，不是当前运行说明。

状态：GitLab 只读接口已实现。改用独立连接函数后的服务已通过本地测试，并在 2026-11-12 使用 `.env.local` 启动后读取真实项目的 `master` 分支。当前同一 Node.js 服务还提供 Jira 接口，见 [Jira 写入接口规格](jira-write-server.md)。服务尚未接收 Slack 任务。

## 接口

| 请求 | 结果 |
| --- | --- |
| `GET /health` | 返回 `200` 和 `{"ok":true}`，不访问 GitLab。 |
| `GET /gitlab/status` | 读取配置的项目和分支，返回项目路径、分支名称与当前 commit ID。 |
| `GET /gitlab/merge-requests/:iid/checks` | 返回 MR 当前 commit 对应的主 pipeline、已发现的下游 pipeline、失败 job 和严格检查状态；不返回 job 日志正文。 |
| 其他 GitLab 路径 | 返回 `404`。 |
| 已知 GitLab 只读路径的非 `GET` 请求 | 返回 `405`。 |

服务仅监听 `127.0.0.1`。默认端口为 `4000`，可通过 `PORT` 指定。服务不接收请求参数来更换 GitLab 项目或分支。

## GitLab 凭据

- 默认 GitLab 地址为 `https://gitlab.loc`，项目为 `account-platform/free-to-play-pc`，分支为 `master`。可通过 `GITLAB_URL`、`GITLAB_PROJECT`、`GITLAB_BRANCH` 环境变量调整。
- 服务启动时调用 [`createGitlabConnection`](../../../spec/gitlab-connection.md)，并复用返回对象。凭据来源和优先级见 [本地环境变量配置](../../../config/local-env/README.md)。该 token 需要对目标项目有读取 API 的权限；新项目 token 已通过真实只读验证。
- 服务只接受 HTTPS GitLab 地址。它不输出 token，也不把 GitLab 错误正文转发给调用方。
- 找不到 token 时，GitLab 读取接口返回 `503`；GitLab 拒绝访问或连接失败时返回 `502`。

## 范围

GitLab HTTP 路径只提供上述读取接口，并把读取操作交给独立连接对象。该对象还提供 Draft MR 创建与更新、job trace 读取方法，供后续 agent 调用；HTTP 服务不开放这些 GitLab 写入方法，也不返回日志正文。客户端规则见 [GitLab MR 客户端规格](../../../spec/gitlab-mr-client.md)。实际 MR 写入尚未验证。
