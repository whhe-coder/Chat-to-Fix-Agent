# 固定频道 `/fix` 入口规格

状态：Slack 应用权限已调整；`/fix` 命令、固定频道、Bot 处理代码和真实调用尚未实现。旧私信入口的已实现代码见 [历史规格](slack-dm-entry.md)。

## 目标行为

- 用户在指定频道输入 `/fix 问题描述`。命令正文必须非空。频道类型和 ID 尚未确定。
- Bot 仅接受指定频道的 `/fix`。其他频道的调用只向发起者返回拒绝说明，不启动任务。
- Bot 在 Slack 要求的时间内确认命令，再在指定频道发布一条任务消息。后续 Jira、Draft MR 和 CI 进度回复到该消息的 thread。
- 相同命令重试不得重复启动任务。完整的持久去重在任务接入里程碑实现。
- 普通频道消息、私信和 thread 回复不启动任务。

## Slack 配置与权限

| 项目 | 目标 | 当前状态 |
| --- | --- | --- |
| Bot Token Scopes | `commands`、`chat:write` | 已在应用页面核对 |
| User Token Scopes | 无 | 已核对 |
| Event Subscriptions | 不订阅消息事件 | 已移除 `message.im`，页面显示 Off |
| Socket Mode | 开启 | 已开启 |
| Slash Commands | 注册 `/fix` | 未创建 |
| 固定频道 | 确定频道 ID 并让 Bot 加入；代码只接受其 ID | 未完成 |
| 工作区安装与 Bot token | 使用新权限完成审批和安装 | 待审批；新权限是否已进入待审记录尚未证实 |

`commands` 接收命令载荷；`chat:write` 用于发布任务消息和长期进度。当前不申请频道历史读取权限。Slack App-level token 的 `connections:write` 保持不变。实际配置操作见 [Slack 配置记录](../config/slack/README.md)。

## 验收

在指定频道调用一次 `/fix`，只创建一个任务消息；重复投递不重复启动任务；其他频道调用被拒绝；Bot 在任务消息的 thread 回报结果。真实 Slack 安装获批前，只能用模拟入口测试任务处理器。
