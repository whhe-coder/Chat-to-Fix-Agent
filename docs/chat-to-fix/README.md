# Chat-to-Fix 文档

这里保存 Agent 的设计资料和早期研究。它们不是统一的待执行计划。

- 当前运行方式见 [Agent 上手说明](../../src/chat-to-fix/README.zh.md)。
- 当前里程碑和验收标准见 [实施计划](../../plans/chat-to-fix-agent.md)。
- `/fix` 的当前入口要求见 [固定频道规格](../../spec/slack-fix-command.md)。

| 内容 | 适用状态 | 入口 |
| --- | --- | --- |
| 软件说明、工具上限、细分规格 1–7 | 2026-11-12 的设计与实现快照；修改功能前仍需核对代码 | [设计文档索引](design/README.zh.md) |
| 选型依据 | 已做决定的记录，不是待执行计划 | [决策记录](design/decision-record.zh.md) |
| 最初的开工方案和工作包指南 | 历史文档；目录、接口和进度已变化 | [开工方案](design/kickoff-plan.zh.md)、[实现指南](design/implementation-guide.zh.md) |
| CI 循环和 `/fix` 入口研究 | 历史调研；部分建议已被后续决定取代 | [CI 研究](notes/ci-loop-design.zh.md)、[入口研究](notes/fix-slash-entry.zh.md) |
| Agent 与 Slack Bot 的 HTTP 和发件箱接口 | Agent 一侧已实现；真实 Slack Bot 尚未接入 | [接口说明](slack/slackbot.md) |
| Slack 入口交接、对比和参考代码 | 历史交接材料；其中的讨论串二次修改不属于当前范围 | [入口旧方案](slack/slackenter.md)、[交接记录](slack/handover.md)、[设计对比](slack/vs-logan.md)、[参考代码](slack/reference/README.md) |
