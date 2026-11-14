# 可选作业运行时提前报告 CI 通过

- 状态：已确认，待修复
- 发现日期：2026-11-13
- 关联任务：真实 Slack 联调 `T-1` / [F2PGBA-410](https://xsolla.atlassian.net/browse/F2PGBA-410)
- 关联 MR：[!379](https://gitlab.loc/account-platform/free-to-play-pc/-/merge_requests/379)

## 现象与证据

在 `#ai-intern-logan-team` 提交一次 `/fix` 后，Bot 在原任务讨论串报告 Jira 工单、Draft MR 和 CI 结果。Agent 在 23:08:18（北京时间）将 [MR pipeline 1937953](https://gitlab.loc/account-platform/free-to-play-pc/-/pipelines/1937953) 标为 `passed`，在 23:08:21 向 Slack 报告“CI 通过”，随后向 Jira 写入相同结论并结束任务。

此时 GitLab API 返回同一提交 `ab36a04ff9c38ca6a08495b3605aa86745718c85` 的 MR pipeline 状态为 `running`。`unit-test`、`complexity`、`type-check`、`stylelint`、`eslint`、`commitlint` 和 `install dependencies` 均为 `success`；`sonar` 仍为 `running`，且 `allow_failure: true`。GitLab 在 23:09:19 才将该 pipeline 标为 `success`，`sonar` 最终也成功。因此，这次最终结果正确，但对外宣告早于 pipeline 结束约一分钟。23:11 在原 Slack 讨论串补发了带时间点的联调说明。

## 原因

[`evaluate()`](../../src/chat-to-fix/core/adapters/gitlab-http.ts) 遇到运行中的 `allow_failure` 作业时，将它计入 `sawActive`，随后跳过该作业，不将它计入 `pending`。当其他作业已成功时，`getChecks()` 返回 `passed`，即使主 pipeline 仍为 `running`。CI monitor 随即结束任务，并将“CI 通过”发往 Slack 和 Jira。

## 影响与验收

如果可选作业稍后失败，Slack 和 Jira 已发出的“CI 通过”不会自动更正。即使可选作业最终成功，用户也会在 pipeline 仍运行时收到完成通知。

- [ ] 主 MR pipeline 或下游 pipeline 仍为活动状态时，不报告整个 pipeline 已通过。
- [ ] 明确区分“必需检查已通过”和“pipeline 已结束”；如果允许前者提前通知，消息必须说明仍有哪些作业在运行，任务不能按最终结果关闭。
- [ ] 增加一个可选作业仍运行、其他必需作业已成功的测试，确认不会提前写回最终结论。
- [ ] 用真实 MR pipeline 复核 Slack 与 Jira 的最终通知时机。
