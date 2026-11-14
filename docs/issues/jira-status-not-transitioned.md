# Jira 状态不流转，文档却写回写时“改状态”

- 状态：已确认，待定（要不要申请流转权限）
- 发现日期：2026-11-14
- 关联任务：真实 Slack `T-5`、`T-8`；模拟 `T-4`

## 现象与证据

- 执行记录里 `jira_transition {"status":"In Review"}` 返回 `No Jira status transition is configured; the issue status was left unchanged.`；F2PGBA-411/412 建单后一直是“待办”。
- [`connected.ts`](../../src/chat-to-fix/scripts/connected.ts) 第 100 行：当前 Jira token 只能写单和评论，流转要另外授权，所以 `jiraTransitions: []`。
- [Agent 架构](../chat-to-fix/architecture.md) 第 4 节第 7 步写的是“Jira 评论、改状态”。

## 验收

- [ ] 决定是否申请流转权限、流转到哪个状态（F2PGBA 的可用转换有 To Do、In Progress、Done、Blocked、Testing）。
- [ ] 不流转的话，改文档；流转的话，配置 `jiraTransitions` 并实测一次。
