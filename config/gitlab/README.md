# GitLab 接入记录

目标项目：`https://gitlab.loc/account-platform/free-to-play-pc/`。本文不保存 token、SSH 私钥或其他凭据。

## 当前已接通：只读 API

Agent 的连接准备脚本直接调用 [`createGitlabConnection()`](../../src/gitlab/connection.js) 检查目标项目的 `master` 分支，不需要外围 HTTP 服务。它使用 `GITLAB_TOKEN`，不读取 `glab` 的凭据配置。变量来源和本机保存方式见 [本地环境变量配置](../local-env/README.md)。

```sh
npm run check:agent-connections
```

Agent 执行任务时使用自己的 GitLab 适配器。此前用于验证连接的本地服务已删除；其接口记录保存在 [历史规格](../../docs/archive/legacy-local-server/gitlab-readonly-server.md)。连接函数和验证范围见 [连接规格](../../spec/gitlab-connection.md)。

## 完整任务所需权限

| Agent 动作 | GitLab 授权要求 |
| --- | --- |
| 读取代码、MR、pipeline、失败 job 日志 | `api` 已包含 API 读取；仓库拉取由 `write_repository` 覆盖。 |
| 创建 Draft MR；修改 MR 标题和描述 | `Developer` 角色和 `api` scope。 |
| 在任务分支推送初始代码及后续修复 commit | 通过 Git-over-HTTPS 时需要 `write_repository` scope；`Developer` 可推非保护分支。 |

若使用一个项目 access token 执行完整任务，选择 `Developer`、`api`、`write_repository`。无需另选 `read_api`、`read_repository`、runner、registry、`self_rotate` 或管理权限。产品只创建和修改 Draft MR，不提供合并功能；当前项目的 `master` 保护规则仍允许 Developer 凭据合并 MR。这是凭据能力，不是产品功能。部署前需评估是否将合并权限收紧到 Maintainer。GitLab 文档还指出，内部用户创建的项目 token 可能读取其他 `Internal` 可见项目；不能把项目 token 当作严格的单项目读取隔离。

## 新项目 token 状态

2026-11-11 已在目标项目创建名为 `chat-to-fix-agent` 的项目 token：角色 `Developer`，scopes 为 `api`、`write_repository`，到期日为 2026-12-11。当前凭据保存位置见 [本地环境变量配置](../local-env/README.md)。

首次保存时遗漏了 token 点号后的后缀，读取验证返回 `401`；随后已修正钥匙串条目。使用修正后的 token，仓库分支、MR 列表、pipeline 列表、jobs 列表及一条 job trace 的只读请求均返回 `200`。尚未尝试 Git push、创建 Draft MR 或修改 MR；这些写入能力仍待对应功能实施时验证。不要把 token 值写入仓库或聊天记录。

已删除的过渡服务曾通过一个现有 MR 做只读验证：它能读取主 pipeline、下游 E2E pipeline 和失败 job。即使 pipeline 总状态为 `success`，失败 job 仍会使严格检查状态为 `failed`。详情见 [GitLab MR 客户端规格](../../spec/gitlab-mr-client.md)。

## 写入方式与验证状态

| 方法 | 用途 | 状态 |
| --- | --- | --- |
| 独立服务身份的 SSH 写入密钥 + Git push options | 推任务分支，并在首次 push 时创建 Draft MR。 | 备选方案；尚未配置或验证。 |
| 项目级 access token，Developer 角色，`api` 与 `write_repository` | 通过 API 创建和修改 Draft MR、读取 CI；通过 Git-over-HTTPS 推送代码。 | 当前选择；token 已创建，客户端 MR 写入方法通过本地测试，真实写入待验证。 |

GitLab 的 push options 支持 `merge_request.create`、`merge_request.target=master` 和 `merge_request.draft`。不能仅凭本次只读验证断言当前身份可推送或创建 MR。后续应使用独立服务身份，保留 Draft MR，由团队审查和合并。

## 参考

- [GitLab：push options](https://docs.gitlab.com/topics/git/commit/)
- [GitLab：access token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)
- [GitLab：project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/)
- [GitLab：角色和权限](https://docs.gitlab.com/user/permissions/)
