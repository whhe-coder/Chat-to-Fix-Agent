# Chat-to-Fix 文档

这里保存 Agent 的设计资料和早期研究。它们不是统一的待执行计划。

- 当前运行方式见 [Agent 上手说明](../../src/chat-to-fix/README.md)；怎么配（一个 Anthropic API key 给五个 bot、模型、上限、怎么确认能用）见 [Agent 配置说明](configuration.md)；代码怎么连起来见 [架构说明](architecture.md)。
- 当前里程碑和验收标准见 [实施计划](../../plans/chat-to-fix-agent.md)。
- `/fix` 的当前入口要求见 [固定频道规格](../../spec/slack-fix-command.md)。
- 按当前代码执行本机模拟人工回归，见[模拟人工回归指导](manual-regression.md)；人工测试员和 AI 助手均可使用。

| 内容 | 适用状态 | 入口 |
| --- | --- | --- |
| 架构说明：分层、五个 bot 怎么定义、一次 `/fix` 怎么走、常见改动去哪改 | 按 2026-11-13 的 `main`（`0d80fd3`）核对；看代码前先读这份 | [架构说明](architecture.md) |
| 软件说明、工具上限、细分规格 1–7 | 2026-11-12 的设计与实现快照；修改功能前仍需核对代码 | [设计文档索引](design/README.md) |
| 选型依据 | 已做决定的记录，不是待执行计划 | [决策记录](design/decision-record.md)；2026-11-13 改为 DSH 原生编码：[plan-dsh-coding.md](design/plan-dsh-coding.md) |
| 最初的开工方案和工作包指南 | 历史文档；目录、接口和进度已变化 | [开工方案](design/kickoff-plan.md)、[实现指南](design/implementation-guide.md) |
| CI 循环和 `/fix` 入口研究 | 历史调研；部分建议已被后续决定取代 | [CI 研究](notes/ci-loop-design.md)、[入口研究](notes/fix-slash-entry.md) |
| 每次实际跑 `/fix` 的过程、结果和卡点 | 运行记录，每次一个文件；跑通的流程照此复现 | [运行记录](runs/README.md) |
| Agent 与 Slack Bot 的 HTTP 和发件箱接口 | Agent 一侧已实现；真实 Slack Bot 尚未接入 | [接口说明](slack/slackbot.md) |
| Slack 入口交接、对比和参考代码 | 历史交接材料；其中的讨论串二次修改不属于当前范围 | [入口旧方案](slack/slackenter.md)、[交接记录](slack/handover.md)、[设计对比](slack/vs-logan.md)、[参考代码](slack/reference/README.md) |
