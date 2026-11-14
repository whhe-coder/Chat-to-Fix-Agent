# Jira 状态不流转，文档却写回写时“改状态”

- 状态：设计已定（CI 通过后流转到 In Review），往后放、另开票（Zihui 2026-11-14）
- 发现日期：2026-11-14
- 关联任务：真实 Slack `T-5`、`T-8`；模拟 `T-4`

## 复现

1. 起 Agent 和 Bot，在指定频道发一条能建单的 `/fix`，等 CI 通过、任务结束。
2. 看 Jira 单状态，以及执行记录里的 `jira_transition`。

## 现象与证据

- 执行记录里 `jira_transition {"status":"In Review"}` 返回 `No Jira status transition is configured; the issue status was left unchanged.`；F2PGBA-411/412 建单后一直是“待办”。
- [`connected.ts`](../../src/chat-to-fix/scripts/connected.ts) 第 100–101 行：当前 Jira token 只能写单和评论，流转要另外授权，所以 `jiraTransitions: []`。
- 设计里 CI 通过后流转到 In Review：[`ci-loop-design.md`](../chat-to-fix/notes/ci-loop-design.md) 第 143 行、[`spec-6`](../chat-to-fix/design/spec-6-config-prompts-verification.md) 第 51 行；[Agent 架构](../chat-to-fix/architecture.md) 第 4 节第 7 步写“Jira 评论、改状态”。

## 验收

- [ ] 申请 Jira 流转权限（F2PGBA 的可用转换，2026-11-14 Jira 接口返回：To Do、In Progress、Done、Blocked、Testing；没有名为 In Review 的转换，要确认目标状态）。
- [ ] 不流转的话，改文档；流转的话，配置 `jiraTransitions` 并实测一次。
