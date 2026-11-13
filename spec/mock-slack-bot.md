# 模拟 Slack Bot 规格

状态：本机模拟频道已实现并通过自动测试；旧版模拟私信入口仍保留。模拟频道不连接真实 Slack，但它将任务交给当前 Agent。

## 本机模拟频道

在仓库根目录运行 `npm start`。它先启动 Agent，再在后台启动模拟页面，打印 `http://127.0.0.1:4001/` 后返回；不会自动打开浏览器。重复启动不会创建第二个页面进程。运行 `npm stop` 停止两者；`npm run stop:agent` 只停止 Agent，`npm run stop:mock-slack` 只停止模拟页面。`npm run start:mock-slack` 仍可单独在前台启动页面。打开页面并输入 `/fix 问题描述`。模拟 Bot 在内存中创建任务消息和讨论串，用 `POST /events`（`source: "fix"`）将问题正文、模拟发送者、频道和讨论串 ID 交给 Agent。页面每两秒读取 Agent 的 `/outbox` 和 `/tasks`，把回传消息和状态显示在对应讨论串。

页面顶部的“清空记录”按钮删除模拟频道当前内存中的消息和讨论串。它不停止 Agent 任务，也不删除 Jira 工单或 GitLab MR。清空后可继续提交新的 `/fix`。

Agent 已在本机运行时，`npm start` 先用数据目录中的 token 验证 `/health`，成功后继续启动页面。若 4001 端口被其他进程占用，启动命令报错并打印可检查的地址；它不会接管或停止该进程。页面地址显示在 `npm start` 的终端输出中，不写入 Agent 的运行日志。

`npm stop` 只停止有 PID 记录且能确认归属的后台进程。若旧服务仍在监听但 PID 文件缺失，命令会报错；它不会把“无法管理”当作“已经停止”。

默认频道是 `CLOCAL`，与未配置真实 Slack 频道时 Agent 的绑定一致；若设置 `CHAT_TO_FIX_SLACK_CHANNEL`，模拟频道使用同一 ID。`MOCK_SLACK_PORT` 默认是 `4001`，`MOCK_SLACK_AGENT_URL` 默认是 `http://127.0.0.1:3090`，只能指向本机。Agent 使用其他数据目录时，给模拟 Bot 设置相同的 `CHAT_TO_FIX_DATA`。模拟页面的后台进程使用独立的 PID 和日志，默认位于 `src/slackBot/.data/run/`；可用 `MOCK_SLACK_STATE_DIR` 指定状态目录。

模拟 Bot 在服务端读取 Agent 的 `http-token` 文件，或使用 `CHAT_TO_FIX_HTTP_TOKEN`。浏览器不会收到 token，模拟 Bot 也无需 Slack token。Agent 尚未启动时，页面显示连接失败；启动 Agent 后会自动重试。命令转发失败时，点击该讨论串的“重试发送”会保留原 `eventId` 和讨论串 ID。

Agent 收到命令时先在自己的日志输出事件 ID、频道、发送者和问题正文，然后才将任务入队。运行 `npm run logs:agent` 可在终端实时查看；日志文件位于 Agent 数据目录的 `run/chat-to-fix.log`。日志不输出接口 token。

**发送 `/fix` 会让当前 Agent 执行真实任务。** 如果 Agent 使用真实 Jira 和 GitLab 配置，它可能创建真实工单、推送代码和创建 Draft MR。自动测试使用本机假接口，不会触发这些写入。

| 请求 | 用途 |
| --- | --- |
| `GET /` | 模拟频道页面 |
| `POST /api/messages` | 提交 `{ "text": "/fix 问题描述", "eventId": "可选重试 ID" }` |
| `DELETE /api/messages` | 清空模拟频道内存中的消息和讨论串 |
| `GET /api/channel` | 读取频道、讨论串、Agent 连接和任务状态 |

只接受非空的 `/fix` 正文，命令最长 4000 字。相同 `eventId` 的并发或再次提交只转发一次；同一 ID 携带不同命令时返回 `409`。服务只监听 `127.0.0.1`，拒绝跨站来源和非 JSON 提交。页面以纯文本显示回传消息，仅把 HTTP(S) 链接变为可点击链接。

频道消息、讨论串、游标和事件映射只保存在模拟 Bot 进程内存。重启后页面不恢复旧讨论串；Agent 自己的任务和发件箱仍保留。这是本机验证工具的边界。

## 旧版模拟私信接口

运行 `npm run start:mock-dm`。服务仅监听 `127.0.0.1`，默认端口为 `4001`。可用 `MOCK_SLACK_PORT` 修改端口；变量来源见 [本地环境变量配置](../config/local-env/README.md)。无需 Slack token。两个模拟服务使用同一默认端口，应分别启动。

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

真实 Slack 的当前目标见 [固定频道 `/fix` 入口规格](slack-fix-command.md)。旧版私信入口不能代替新入口的验收。
