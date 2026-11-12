# 模拟 Slack Bot 规格

状态：旧版模拟私信入口已实现并通过自动测试。它尚未模拟新的 `/fix` 命令；改造后才能用于新任务链路验收。模拟入口不会访问 Slack、Jira 或 GitLab。

## 启动与接口

运行 `npm run start:mock-slack`。服务仅监听 `127.0.0.1`，默认端口为 `4001`。可用 `MOCK_SLACK_PORT` 修改端口；变量来源见 [本地环境变量配置](../config/local-env/README.md)。无需 Slack token。

| 请求 | 用途 | 结果 |
| --- | --- | --- |
| `POST /messages` | 提交一条模拟私信 | 返回事件 ID、频道、thread 时间戳和当前 thread 消息 |
| `GET /threads/:threadTs` | 查询默认模拟私信频道的 thread | 返回该 thread 的消息 |

提交内容为 JSON。`text` 必填，长度为 1 到 10000 个字符。`userId`、`channelId`、`threadTs` 和 `eventId` 可选；默认发送者为 `U-MOCK`，默认私信频道为 `D-MOCK`。若指定 `threadTs`，该 thread 必须已存在。查询其他频道时附加 `?channelId=<频道 ID>`。

```sh
curl -sS -X POST http://127.0.0.1:4001/messages \
  -H 'Content-Type: application/json' \
  -d '{"text":"请修复登录问题"}'
```

响应中的 `threadTs` 可用于查询。以下示例中的时间戳需要替换为实际值：

```sh
curl -sS 'http://127.0.0.1:4001/threads/1760000000.000001'
```

## 行为边界

- 模拟 Bot 使用与当前真实 Bot 相同的私信处理器。它在原 thread 回复一条接入测试说明，不创建工单或 MR。
- 相同 `eventId` 代表同一事件。并发重试只记录一条用户消息和一条 Bot 回复。同一 ID 若带不同内容，返回 `409`。
- 模拟消息和 thread 只保存在当前进程的内存中。重启后清空。后续任务处理器可通过 `createHandler` 注入，不需要改变模拟输入格式。
- 服务拒绝非本机 Host、跨站 Origin、非 JSON 请求及超过 16 KiB 的请求体。错误响应不包含 token。

真实 Slack 的当前目标见 [固定频道 `/fix` 入口规格](slack-fix-command.md)。本模拟入口仍使用旧私信处理器，不能代替新入口的验收。
