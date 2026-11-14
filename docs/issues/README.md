# 问题与改进事项

本目录记录实际运行中确认的问题和已静态复核的改进事项。每项单独成文，写明证据、影响和验收条件。计划与里程碑状态保留在 [`plans/chat-to-fix-agent.md`](../../plans/chat-to-fix-agent.md)。

| 问题 | 状态 |
| --- | --- |
| [GitLab 拒绝缺少 Jira key 的提交](gitlab-push-missing-jira-key.md) | 修复已验证；后续 CI 误判单独跟踪 |
| [Smartcat push pipeline 被误报为 MR CI 通过](gitlab-smartcat-pipeline-misclassified.md) | 修复已加载，端到端复测待完成 |
| [可选作业运行时提前报告 CI 通过](gitlab-optional-job-premature-ci-pass.md) | 部分修复（#21），主 pipeline 已复测通过；下游取舍待确认 |
| [信息不足时“补充后重新 /fix”的提示重复，追问挤在一行](slack-needs-info-repeated-hint.md) | 已修复（#23 + #20），已复测 |
| [其他频道只发 `/fix` 时先提示用法](slack-fix-check-order.md) | 已修复（#20），单元测试覆盖 |
| [防抖窗口 5 秒，用户改写后重发拦不住](slack-fix-debounce-window.md) | 暂不处理，保留初始值；注释已加（#20） |
| [`/fix` 显示“应用未响应”，疑与 Socket 心跳超时重连有关](slack-socket-reconnect-fix-unacked.md) | 现象已确认，原因推断，待修复 |
| [结果说“仓库没有测试命令”，实际是没配置](agent-test-command-wording.md) | 文案已修复（#23），已复测；是否配置待定 |
| [MR 描述停在“CI has not run yet”](gitlab-mr-description-stale-ci.md) | 已修复（#23），已复测 |
| [Jira 报告人是 token 所有者，发起人没有映射](jira-requester-not-mapped.md) | 已确认，往后放、另开票 |
| [Jira 状态不流转，文档却写“改状态”](jira-status-not-transitioned.md) | 设计已定，往后放、另开票 |
| [抽取四处重复逻辑，并补齐材料块边界测试](shared-helper-extraction.md) | 待处理；重构建议，含一处测试缺口 |
