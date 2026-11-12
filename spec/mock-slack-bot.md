# 模拟 Slack Bot 规格

状态：旧版模拟私信入口已实现并通过自动测试；2026-11-12 起增加 `/fix`、讨论串 @ 和发件箱转发的模拟，规格见 [slackbot.md](slackbot.md) 4.4 和 [slackenter.md](slackenter.md) 第 2 节。模拟入口不会访问 Slack、Jira 或 GitLab，只访问本机的 Chat-to-Fix 接口。

## 启动与接口

运行 `npm run start:mock-slack`。服务仅监听 `127.0.0.1`，默认端口为 `4001`。可用 `MOCK_SLACK_PORT` 修改端口；变量来源见 [本地环境变量配置](../config/local-env/README.md)。无需 Slack token。

| 请求 | 用途 | 结果 |
| --- | --- | --- |
| `POST /messages` | 提交一条模拟私信 | 返回事件 ID、频道、thread 时间戳和当前 thread 消息 |
| `GET /threads/:threadTs` | 查询 thread | 返回该 thread 的消息；不带 `channelId` 时在所有模拟频道里找 |
| `POST /fix` | 模拟在频道里输入 `/fix` | 返回 `acked`、`threadTs`、临时消息 `ephemeral` 和任务讨论串的消息 |
| `POST /mentions` | 模拟在讨论串里 @ bot | 返回本次产生的临时消息和讨论串消息 |
| `POST /relay/tick` | 立即拉一次发件箱，发进模拟讨论串 | 返回 `delivered`（发出的条数） |
| `GET /ephemerals` | 查看所有临时消息 | 返回列表 |

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

## 新入口：`/fix`、@ 和发件箱

- `/fix` 的 JSON：`text`（可为空，用来试“用法”提示）；可选 `userId`、`userName`、`channelId`（默认指定频道 `C-MOCK-FIX`）、`triggerId`（重复同一个 ID 代表同一次投递）。
- `/mentions` 的 JSON：`text`；可选 `threadTs`（必须已存在，不带就是“不在讨论串里”）、`userId`、`channelId`、`eventId`。
- 模拟 Bot 用与真实 Bot 相同的 `/fix` 和 @ 处理器，Slack 换成内存里的假频道；任务消息、发件箱消息和 Bot 的“服务暂时连不上”都进讨论串，临时消息单独记录。
- Chat-to-Fix 接口地址和令牌读 `CHAT_TO_FIX_API_URL`（默认 `http://127.0.0.1:3090`）和 `CHAT_TO_FIX_API_TOKEN`；指定频道读 `CHAT_TO_FIX_SLACK_CHANNEL`，没有就用 `C-MOCK-FIX`。`npm run start:mock-slack` 启动后每 3 秒自动拉发件箱，游标只在内存里。
- 用法示例：`curl -sS -X POST http://127.0.0.1:4001/fix -H 'Content-Type: application/json' -d '{"text":"购买按钮拼错了"}'`，再用返回的 `threadTs` 查 `/threads/<threadTs>`。

## 行为边界

- 私信接口仍使用旧私信处理器（真实 Bot 已不再挂它）。它在原 thread 回复一条接入测试说明，不创建工单或 MR。
- 相同 `eventId` 代表同一事件。并发重试只记录一条用户消息和一条 Bot 回复。同一 ID 若带不同内容，返回 `409`。
- 模拟消息和 thread 只保存在当前进程的内存中。重启后清空。后续任务处理器可通过 `createHandler` 注入，不需要改变模拟输入格式。
- 服务拒绝非本机 Host、跨站 Origin、非 JSON 请求及超过 16 KiB 的请求体。错误响应不包含 token。

真实 Slack 的当前目标见 [固定频道 `/fix` 入口规格](slack-fix-command.md)。模拟入口不能代替真实 Slack 的验收（真实的 3 秒确认、权限和事件投递都不在模拟里）。
