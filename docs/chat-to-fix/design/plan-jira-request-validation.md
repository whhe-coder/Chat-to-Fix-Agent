# 建单前判断请求是否有效

- 日期：2026-11-13
- 状态：已实现并通过本地验证。
- 关联规格：[流程与门禁](spec-1-registry-and-flow.md)、[任务状态](spec-2-state-and-storage.md)、[Jira 工具](spec-4-tools-and-adapters.md)。

## 当前问题

用户在模拟 Slack 页面发送 `/fix 你好`。Agent 创建任务 T-7 和真实 Jira 单 [F2PGBA-402](https://xsolla.atlassian.net/browse/F2PGBA-402)，之后才判断没有具体修复内容，并把任务置为 `needs_info`。原流程只检查 Jira 标题、描述和验收标准非空；Jira bot 可以从问候语编出这些字段。

## 目标行为

Jira bot 使用模型，在调用 `jira_create_issue` 前判断消息和讨论内容是否包含具体缺陷或变更目标，以及可检查的结果。判断只能使用 Slack 讨论中的事实。只有问候、测试字样或无法支撑有效工单的描述时，Jira bot 和 Main bot 确认信息不足，由 Slack bot 在原讨论追问。此时不调用 Jira 创建接口，不准备代码，也不开 MR。Main bot 不同意时，Jira bot 可再判断一次并建单；两方都确认后一律拒绝。

有足够信息时，Jira bot 先登记来源原文、问题和可检查的结果，再创建一张 Jira 单。任务重跑时，已有 Jira 单继续复用；没有 Jira 单时重新判断补充后的内容。

## 实施与验收

1. 更新流程、工具、任务状态和 bot 提示词，让建单前判断成为必经步骤。
2. 加入工具级拦截：没有通过判断，`jira_create_issue` 不调用 Jira 适配器；只有“你好”等纯问候或测试字样时，判断不能通过。
3. 用假 Jira 运行端到端测试：`/fix 你好` 收到追问、任务进入 `needs_info`、Jira 创建调用次数为 0；有效缺陷仍创建一张单并继续流程。
4. 运行相关测试和类型检查，检查文档与实现一致。提交前由用户 review。

## 边界

语义判断由使用模型的 Jira bot 完成；工具校验来源原文并拦截明显无效的输入。不能用关键词列表代替模型判断，也不能用它穷尽所有无效请求。验证过程不向真实 Jira、GitLab 或 Slack 写入数据。

## 验证记录

- 假 Jira 端到端测试：`/fix 你好` 进入 `needs_info`，未生成 Jira 单。
- 真实模型、假服务的 `needs-info` 用例：首轮在建单前追问，记录中没有 `jira_create_issue`；用户补充后，第二轮创建 `INFO-1` 并完成。结果 1/1 通过，报告在 `/private/tmp/chat-to-fix-jira-precheck-review/report.md`。
- `test:agent-layer` 45/45 通过；`test:agent-bot` 505/505 通过，2 项跳过；相关任务测试和 `typecheck` 通过。
