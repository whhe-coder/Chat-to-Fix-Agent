# GitLab 拒绝缺少 Jira key 的提交

- 状态：部分修复，待真实验证
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

2026-11-13 合入的 GitHub PR #8（提交 `64be8fd`）已让工具给首次 MR 提交和 CI 修复提交追加任务的 Jira key，并增加了本地测试。该改动尚未通过真实 GitLab 推送与 MR pipeline 验证。T-11 已关闭，不会因代码更新而自动继续。

## 修复与验收

- [x] 工具给首次 MR 提交和后续 CI 修复提交追加任务的 Jira key，并检查单行 Conventional Commit 格式和长度；缺少任务 Jira key 时拒绝提交。代码已在 PR #8 合入。
- [ ] 推送失败时向用户保留经过凭据脱敏的 GitLab 服务端拒绝原因。
- [ ] 用独立的模拟 `/fix` 任务验证分支推送、Draft MR 创建和 pipeline 读取；通过后再更新计划中的 M3/M5 状态。
