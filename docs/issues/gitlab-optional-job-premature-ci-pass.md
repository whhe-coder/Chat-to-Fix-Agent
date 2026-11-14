# 可选作业运行时提前报告 CI 通过

- 状态：部分修复（#21，`bd9b853`），待真实复测；下游不等的取舍待 Logan 确认
- 发现日期：2026-11-13
- 关联任务：真实 Slack 联调 `T-1` / [F2PGBA-410](https://xsolla.atlassian.net/browse/F2PGBA-410)
- 关联 MR：[!379](https://gitlab.loc/account-platform/free-to-play-pc/-/merge_requests/379)

## 现象与证据

在 `#ai-intern-logan-team` 提交一次 `/fix` 后，Bot 在原任务讨论串报告 Jira 工单、Draft MR 和 CI 结果。Agent 在 23:08:18（北京时间）将 [MR pipeline 1937953](https://gitlab.loc/account-platform/free-to-play-pc/-/pipelines/1937953) 标为 `passed`，在 23:08:21 向 Slack 报告“CI 通过”，随后向 Jira 写入相同结论并结束任务。

此时 GitLab API 返回同一提交 `ab36a04ff9c38ca6a08495b3605aa86745718c85` 的 MR pipeline 状态为 `running`。`unit-test`、`complexity`、`type-check`、`stylelint`、`eslint`、`commitlint` 和 `install dependencies` 均为 `success`；`sonar` 仍为 `running`，且 `allow_failure: true`。GitLab 在 23:09:19 才将该 pipeline 标为 `success`，`sonar` 最终也成功。因此，这次最终结果正确，但对外宣告早于 pipeline 结束约一分钟。23:11 在原 Slack 讨论串补发了带时间点的联调说明。

## 原因

[`evaluate()`](../../src/chat-to-fix/core/adapters/gitlab-http.ts) 遇到运行中的 `allow_failure` 作业时，将它计入 `sawActive`，随后跳过该作业，不将它计入 `pending`。当其他作业已成功时，`getChecks()` 返回 `passed`，即使主 pipeline 仍为 `running`。CI monitor 随即结束任务，并将“CI 通过”发往 Slack 和 Jira。

## 后续证据（2026-11-14）

另外三次运行同样在 pipeline 结束前就报告了“CI 通过”：

| 任务 | Agent 报告通过（北京时间） | pipeline 结束 | 还在跑的 |
| --- | --- | --- | --- |
| 模拟 `T-4` | 2026-11-13 18:08:04 | 未记录（[1936131](https://gitlab.loc/account-platform/free-to-play-pc/-/pipelines/1936131)）：`sonar` 18:10 后成功，e2e-smoke 下游 18:10:57 成功，e2e-persona 下游之后仍在排队 | `sonar`、两条 `allow_failure` 的 e2e 下游 |
| 真实 Slack `T-5` | 2026-11-14 11:39:35 | 11:40:42（[1939813](https://gitlab.loc/account-platform/free-to-play-pc/-/pipelines/1939813)） | 未逐个核对 job |
| 真实 Slack `T-8` | 2026-11-14 14:39:32 | 14:40:37（[1940014](https://gitlab.loc/account-platform/free-to-play-pc/-/pipelines/1940014)） | 未逐个核对 job |

T-5、T-8 的结束时间取自 GitLab MR 接口的 `head_pipeline.finished_at`，两条最终都是 `success`。[T-4 运行记录](../chat-to-fix/runs/2026-11-13-T-4.md)当时把这种情况写成了预期行为，已按本问题改正。

## 影响与验收

如果可选作业稍后失败，Slack 和 Jira 已发出的“CI 通过”不会自动更正。即使可选作业最终成功，用户也会在 pipeline 仍运行时收到完成通知。

- [ ] 主 MR pipeline 或下游 pipeline 仍为活动状态时，不报告整个 pipeline 已通过。（#21：主 pipeline 里正在跑或排队的非阻塞 job 会拖住“通过”，最多到必需 job 结束后 10 分钟；非阻塞的下游 pipeline 不等，因为 T-3 等它等到超时。待确认这个取舍。）
- [ ] 明确区分“必需检查已通过”和“pipeline 已结束”；如果允许前者提前通知，消息必须说明仍有哪些作业在运行，任务不能按最终结果关闭。
- [x] 增加一个可选作业仍运行、其他必需作业已成功的测试，确认不会提前写回最终结论。（#21，`test/adapters-ci.test.ts`、`test/monitor-ci.test.ts`）
- [ ] 用真实 MR pipeline 复核 Slack 与 Jira 的最终通知时机。
