# GitLab 拒绝缺少 Jira key 的提交

- 状态：修复已验证；后续 CI 误判单独跟踪
- 发现日期：2026-11-13
- 关联任务：T-11 / `F2PGBA-406`；T-10 / `F2PGBA-405`

## 现象与证据

T-11 已创建 Jira 工单并完成 README 修改和评审。Agent 在分支 `ai/F2PGBA-406` 生成的提交标题是：

```text
docs(readme): document pnpm test:all for running all local checks
```

推送时 GitLab 的 pre-receive hook 拒绝该提交。使用 Agent 的同一 GitLab 凭据重试推送现有提交，得到完整的服务端提示：

```text
remote: GitLab: No Jira issue found in commit message
```

分支名和准备提交的 MR 描述包含 `F2PGBA-406`，但提交信息没有该 key。T-10 的提交信息也没有 `F2PGBA-405`，并在同一步收到 `pre-receive hook declined`；当时没有保留完整的服务端提示。

## 原因与影响

T-11 运行时的 [`pipeline.md`](../../src/chat-to-fix/core/prompts/pipeline.md) 告诉 Pipeline bot，提交信息无需 Jira key；当时的 [`checkCommitMessage`](../../src/chat-to-fix/core/tools/repo.ts) 只检查 Conventional Commit 格式和长度。Agent 因此允许提交不符合目标 GitLab 项目服务端规则的信息。

T-11 已被关闭为 `needs_person`。该分支没有成功推送；Draft MR 和 pipeline 均未创建。这个问题阻止 M3 的真实推送验收，也阻止 M5 的模拟入口端到端验收。Agent 的错误摘要只保留 Git 输出的最后几行，未向用户显示 GitLab 给出的具体原因。

2026-11-13 合入的 GitHub PR #8（提交 `64be8fd`）已让工具给首次 MR 提交和 CI 修复提交追加任务的 Jira key，并增加了本地测试。合入时尚未通过真实 GitLab 推送与 MR pipeline 验证。T-11 已关闭，不会因代码更新而自动继续。

2026-11-13，`runGit` 的推送失败摘要改为保留 Git 服务端的 `remote:` 拒绝原因，并继续对摘要和完整 stderr 脱敏。本地 `pre-receive` hook 测试复现了原先丢失 `GitLab: No Jira issue found in commit message` 的情况；修复后错误摘要保留该原因，且不含模拟凭据。相关 93 项测试和 TypeScript 类型检查通过。没有故意对真实 GitLab 发起失败推送。

独立模拟频道任务 T-1 创建了 [`F2PGBA-407`](https://xsolla.atlassian.net/browse/F2PGBA-407)。Agent 推送了 `43d755c6f1d924a027fbce7451b36c7b8d4302ba`，提交标题以 `(F2PGBA-407)` 结尾，并创建了 [Draft MR !376](https://gitlab.loc/account-platform/free-to-play-pc/-/merge_requests/376)。模拟频道收到 Jira 和 MR 链接。该 MR 的 [pipeline 1935838](https://gitlab.loc/account-platform/free-to-play-pc/-/pipelines/1935838) 来源为 `merge_request_event`，最终为 `success`，`unit-test` 成功；T-1 已完成模拟讨论串回报和 Jira 回写。随后 T-12 暴露了另一种同一提交的 `push` / Smartcat pipeline 误判，见[独立问题记录](gitlab-smartcat-pipeline-misclassified.md)。

## 修复与验收

- [x] 工具给首次 MR 提交和后续 CI 修复提交追加任务的 Jira key，并检查单行 Conventional Commit 格式和长度；缺少任务 Jira key 时拒绝提交。代码已在 PR #8 合入。
- [x] 推送失败时保留经过凭据脱敏的 GitLab 服务端拒绝原因；本地 hook 已复现并验证。
- [x] 用独立的模拟 `/fix` 任务验证分支推送、Draft MR 创建和当前提交的 pipeline 读取。
- [x] 确认 T-1 的 CI 最终结果、模拟讨论串最终回报和 Jira 回写。M5 仍需排除 T-12 暴露的 pipeline 误判。
