# core/task/

系统层：管任务的状态、排队、运行、时限和每步检查。流程和状态归这里，内容和判断归 bot。

| 文件 | 放的是什么 |
|---|---|
| `contracts.ts` | 各部分之间的数据形状和常量（`ROLES`、`STEP_IDS`、`TASK_STATES` 等）；改接口先改这里 |
| `store.ts` | 任务、运行、执行记录写在文件系统（`createStore`） |
| `queue.ts` | 排队，先到先做，最多同时跑几个（`createQueue`） |
| `runner.ts` | 开始一次运行（五个 bot、群、任务消息）、结束、重启后接上（`createRunner`） |
| `monitor.ts` | 时限、催促安静的群、系统通知、CI 等待（`createMonitor`） |
| `gate.ts` | 每步要有证据才能推进（`createGate`），规则来自 `flow/steps.ts` |
| `recorder.ts` | 把 bot 层事件记成执行记录、留下每步结果（`createRecorder`） |
| `botlayer.ts` | bot 层门面：系统层只通过它调 DS Bot（`createBotLayer`） |
| `http.ts` | 本机 HTTP 接口：`/events`、`/health`、`/outbox`、`/tasks`（`createHttp`） |
| `outbox.ts` | 要发到 Slack 的消息的追加文件 `outbox.jsonl`（`createOutbox`） |
| `usage.ts` | 每轮用量记录和任务汇总（`summarize`、`usageLine`） |
| `pricing.ts` | 价格表和费用计算（`DEFAULT_PRICING`、`costOf`） |

谁调它：`app.ts` 组装，`tools/` 和 `scripts/` 读它。不要在这里直接碰 DS Bot 或 DSH 对象，只走 `botlayer.ts`。
