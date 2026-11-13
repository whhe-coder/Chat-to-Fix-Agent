# 问题与改进事项

本目录记录实际运行中确认的问题和已静态复核的改进事项。每项单独成文，写明证据、影响和验收条件。计划与里程碑状态保留在 [`plans/chat-to-fix-agent.md`](../../plans/chat-to-fix-agent.md)。

| 问题 | 状态 |
| --- | --- |
| [GitLab 拒绝缺少 Jira key 的提交](gitlab-push-missing-jira-key.md) | 修复已验证；后续 CI 误判单独跟踪 |
| [Smartcat push pipeline 被误报为 MR CI 通过](gitlab-smartcat-pipeline-misclassified.md) | 修复已加载，端到端复测待完成 |
| [抽取四处重复逻辑，并补齐材料块边界测试](shared-helper-extraction.md) | 待处理；重构建议，含一处测试缺口 |
