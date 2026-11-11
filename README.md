# Chat-to-Fix Agent

**在 Slack 描述问题，由 Bot 创建 F2P 工单和 MR，并以 MR 的 pipeline 全部通过为目标持续修复。**

Chat-to-Fix Agent 是一个以 Slack 为入口的修复 Bot。用户发送包含问题描述的消息后，Bot 在 Jira 的 `F2PGBA` 项目创建工单，在 GitLab 的 `account-platform/free-to-play-pc` 仓库修改代码并创建 Draft MR。Bot 继续观察该 MR 的 CI/CD pipeline：若检查失败，它读取具体错误日志，针对失败原因修改代码，并在**原 MR 分支**追加新 commit。新 pipeline 完成后，Bot 再次检查结果，目标是让当前 MR 的相关检查全部通过。

## 目标流程

```mermaid
flowchart LR
    A[Slack 问题消息] --> B[创建 F2PGBA Jira 工单]
    B --> C[修改 F2P 仓库代码和相关单元测试]
    C --> D[创建 GitLab Draft MR]
    D --> E{检查该 MR 的 CI/CD pipeline}
    E -->|失败| F[读取错误日志并定位原因]
    F --> G[在原 MR 追加修复 commit]
    G --> E
    E -->|全部通过| H[向 Slack 和 Jira 报告结果]
    E -->|无法自动修复或已修复 3 轮仍失败| H
    H --> I[团队审查 MR]
```

## 项目交付物

| 交付物 | 作用 |
| --- | --- |
| Slack Bot | 接收问题消息，展示工单、MR 和修复进度，并把最终结果发回原对话。 |
| Chat-to-Fix Agent | 创建 `F2PGBA` 工单，修改 F2P 代码，创建 Draft MR，读取 CI 失败日志，并在原 MR 持续修复。 |
| 配置文档 | 说明 Slack、Jira、GitLab 和 CI 的接入步骤、权限与变量配置、启动方法，以及如何验证整条流程。文档不保存密钥值。 |

## Bot 每次任务的输出

- 根据 Slack 消息创建的 `F2PGBA` Jira 工单。
- 位于 GitLab F2P 仓库的 Draft MR，包含修复代码和相关单元测试。
- 原 MR 中每轮修复的 commit，以及对应的 pipeline 结果。
- 发回 Slack 和 Jira 的最终结果：全部通过，或明确说明尚未解决的阻塞。

Bot 以当前 MR commit 对应的最新 pipeline 为准。它不能用旧 pipeline 的成功结果宣称修复完成。同一个 MR 最多自动修复 3 轮，每轮追加一个修复 commit 并检查新 pipeline。如果失败无法从日志定位、超出工单范围、无法自动修复，或 3 轮后仍未通过，Bot 停止循环并报告原因。MR 由团队审查和合并。

## 开发原则

当前先打通最小业务闭环。非阻断的细节问题记录后处理，不让局部优化打断主链路。
