# Slack Bot 与 Chat-to-Fix 的业务接口

> 本文保留 PR #5 的设计与交接背景。目录已迁至 `src/chat-to-fix/`；本期只接受 `/fix` 首次提交和 Agent 自动 CI 修复，不启用用户在讨论串中的二次修改。下文关于讨论串 `@`、`app_mentions:read` 和真实 Slack Bot 的内容是历史方案，尚未按当前入口实现；当前行为以 [固定频道 `/fix` 规格](../../../spec/slack-fix-command.md) 和 [模拟 Bot 规格](../../../spec/mock-slack-bot.md) 为准。

- 日期：2026-11-12
- 状态：2026-11-12 Chat-to-Fix 一侧已实现（PR #5）；只在本机测试和模拟入口上验证过，没连过真 Slack。Chat-to-Fix 一侧见 `src/chat-to-fix/core/task/outbox.ts`、`http.ts`、`core/adapters/slack.ts` 的 `createOutboxSlack`；Slack Bot 一侧只有参考实现，在 `docs/chat-to-fix/slack/reference/`，没有放进 `src/slackBot/`，见第 4.4 节。基于提交 `e6f6094`。
- 相关：Slack 入口一侧的补充见 [slackenter.md](slackenter.md)；入口的基础规格是 [固定频道 `/fix` 规格](../../../spec/slack-fix-command.md)，本文在它和 [实施计划](../../../plans/chat-to-fix-agent.md)、根目录 [README](../../../README.md)“目标 Slack 回传”上延展，怎么延展见 [vs-logan.md](vs-logan.md)；Chat-to-Fix 内部设计见 [设计文档](../design/README.md)。

## 1. 问题

- 两个东西都叫“Slack bot”：根目录 `src/slackBot/`（连 Slack 应用的程序，下文叫 **Slack Bot**），和 `chat-to-fix/` 里五个 bot 之一（角色 `slack`，下文叫 **内部沟通角色**）。改代码时容易混。
- [实施计划](../../../plans/chat-to-fix-agent.md) M1 的“本地 agent 的调用方式”没定：Slack Bot 怎么把 `/fix` 交给 Chat-to-Fix，怎么拿到要回给用户的进度，都没有接口。
- `chat-to-fix/` 现在自己连 Slack（转发程序 `chat-to-fix/scripts/slack-forwarder.ts`，适配器直接调 `chat.postMessage`）。同一个 Slack 应用同一时间只能有一个程序用 Socket Mode 连，和 Slack Bot 冲突。
- 用户在讨论串里补充的信息到不了 bot：只有 `commands`、`chat:write` 时收不到讨论串的消息；任务重跑时也只读 `/fix` 原文。
- 修不了或需要人处理时，回给用户的只有一句英文模板；“需要人处理”的原因没有存下来。

## 2. 方案

分两层，各管各的：

| 层 | 程序 | 管什么 | 不管什么 |
|---|---|---|---|
| Slack 接入 | `src/slackBot/`（Bolt，Socket Mode，唯一连 Slack 应用的程序） | 收 `/fix` 和讨论串里的 @；发任务消息；把发件箱里的消息发到讨论串 | 不判断问题，不碰 Jira 和 GitLab，不决定对用户说什么 |
| 业务逻辑 | `chat-to-fix/` 服务（本机 HTTP 控制接口） | 建任务；五个 bot 跑八步和 CI 循环；决定对用户说什么，放进发件箱 | 不连 Slack，不持有 Slack 令牌 |

接口就是 Chat-to-Fix 现有的本机 HTTP 控制接口，加一个发件箱。Slack Bot 往里送事件，再从发件箱拉消息去发。

## 3. 场景

1. 用户在指定频道输入 `/fix 购买按钮拼错了`。Slack Bot 确认命令，先调 `GET /health`：服务没开或队列满，只给发起人回临时消息，频道里不发任何东西。正常的话在频道发任务消息，以它的 `ts` 作为讨论串，调 `POST /events`（`source: "fix"`）。Chat-to-Fix 回 202 和任务号。
2. 内部沟通角色回“已收到”，这句话进发件箱。Slack Bot 拉到后发进讨论串。
3. 建好 Jira 单、开出 Draft MR 时，系统各往发件箱放一条（单号和链接）。
4. 主 bot 判断缺信息，内部沟通角色发追问，经发件箱出现在讨论串里。
   - 开了讨论串补充（`slack.mentions` 为真）：任务停在“待补充信息”。用户在讨论串里写 `@Chat-to-Fix 改成 Add to cart`，Slack Bot 调 `POST /events`（`source: "mention"`，同一个 `threadTs`）。Chat-to-Fix 把这句存进任务、重新排队，发件箱出“收到补充信息，重新开始处理”。重跑时内部沟通角色读到的讨论是原文加补充，同一张 Jira 单、同一个分支。
   - 没开（Slack 应用还没有 `app_mentions:read`）：任务以“缺信息”结束，发件箱再放一条“补全后请用 /fix 重新提交”。
5. CI：每轮失败、每轮修复推送（带提交号和 commit 链接）、通过，各一条。最后是结果（Jira、Draft MR、CI 结论）。
6. 修不了或太难：发件箱出“没能自动修好：原因”或“需要人来处理：原因”。
7. 健康检查之后 `POST /events` 才失败（极少）：Slack Bot 在讨论串里说服务暂时连不上。这和 @ 补充送不到时那一句，是 Slack Bot 仅有的自己写的业务文案（见 [slackenter.md](slackenter.md)）。

## 4. 实现决定

### 4.1 现成实现和取舍

- **控制接口沿用，不另起服务**：Chat-to-Fix 已有 `POST /events`、`GET /tasks`、`GET /tasks/<号>`、`POST /tasks/<号>/stop`、`GET /health`，令牌头是 `x-chat-to-fix-token`（`src/chat-to-fix/core/task/http.ts` 的 `route`）。
- **适配器加一种，bot 不用改**：适配器层已经把读讨论、回复、开讨论串抽成 `readThread`、`reply`、`startThread`（`src/chat-to-fix/core/adapters/slack.ts`）。新加一种 `outbox`，五个 bot 的工具和提示词都不用改。
- **讨论内容不读 Slack 历史**：讨论 = `/fix` 原文，加上存在任务上的补充。`commandDiscussion` 和 `store.addFollowUp` 已写，未提交。
- **Slack Bot 侧照搬现成写法**：Logan 的 `createDmHandler`（`src/slackBot/slack-message.js`）里的去重办法可以照搬，按事件编号、保留一小时；用 Bolt 的 `app.command` 和 `app.event('app_mention')`。
- **出站选“拉”，不选“推”**：
  - Slack Bot 是 Socket Mode，本来不开端口。
  - Chat-to-Fix 不需要知道 Slack Bot 在哪。
  - Slack Bot 重启后从游标接着拉。
  - 代价是几秒延迟。以后要推，在发件箱上加回调就行，消息格式不变。

### 4.2 接口（Chat-to-Fix 提供）

`outboxId`、`lastSeq`、`channels` 三个字段的来由见 [架构文档第 5 节](architecture.md)。

- **地址**：`http://127.0.0.1:<httpPort>`，默认端口 3090，只监听本机。
- **鉴权**：每个请求都带头 `x-chat-to-fix-token`。令牌是 Chat-to-Fix 启动时写在 `<数据目录>/http-token` 里的值，Slack Bot 从环境变量 `CHAT_TO_FIX_API_TOKEN` 读。
- **格式**：请求和返回都是 JSON。

**(1) `POST /events`：新请求和讨论串里的补充走同一个口，用 `source` 区分**

```json
{
  "source": "fix",
  "eventId": "slash:<trigger_id>",
  "channel": "C0123",
  "threadTs": "1731377400.000100",
  "messageTs": "1731377400.000100",
  "user": { "id": "U0456", "name": "alice" },
  "text": "购买按钮拼错了",
  "files": [],
  "permalink": "https://….slack.com/archives/C0123/p1731377400000100"
}
```

- **字段**：
  - `source`：`fix` 表示新请求，`mention` 表示讨论串里的 @。
  - `eventId`：`fix` 用 `slash:<trigger_id>`；`mention` 用 Slack 的 `event_id`。同一编号只处理一次。
  - `threadTs`：任务消息的 `ts`。
  - `messageTs`：这句话所在消息的 `ts`。`fix` 就填任务消息的 `ts`。
  - `user.name`：可选。`/fix` 载荷里有 `user_name`；@ 事件只有用户 ID。
  - `text`：去掉开头 @ 机器人之后的正文。
  - `files` 和 `permalink`：可选。
- **必填**：`source`、`eventId`、`channel`、`threadTs`、`messageTs`、`user.id`、`text`。

按顺序判断，命中一条就返回：

| 情况 | Chat-to-Fix 做什么 | 返回 |
|---|---|---|
| 缺字段 | 不处理 | 400 `missing_fields` |
| `source` 不是 `fix`、`mention`（或 `slash`，Chat-to-Fix 自己的转发程序用） | 不处理 | 400 `invalid_source` |
| `eventId` 处理过 | 不再处理 | 200 `{ taskId, duplicate: true }` |
| 频道没有绑定仓库 | 发件箱放一条“频道未接入” | 422 `channel_not_bound` |
| `mention`，讨论串里有排队中或运行中的任务 | 这句存进任务；发件箱放“正在处理” | 200 `{ taskId, inProgress: true }` |
| `mention`，讨论串里的任务在等补充信息 | 存进任务，重新排队；发件箱放“收到补充信息，重新开始处理” | 202 `{ taskId, rerun: true }` |
| `mention`，讨论串里没有任务，或任务已结束 | 不建任务；发件箱放“这个讨论串里没有在处理的任务，新问题请用 /fix 提交” | 409 `no_open_task` |
| `fix`，队列满 | 发件箱放“队列已满” | 429 `queue_full` |
| `fix` | 建任务，入队 | 202 `{ taskId, state: "queued", position }` |

讨论串里的 @ 不会启动新任务，和 [固定频道规格](../../../spec/slack-fix-command.md) 的“thread 回复不启动任务”一致。

**(2) `GET /outbox?after=<seq>&limit=<n>`：要发给用户的消息**

```json
{
  "messages": [
    { "seq": 12, "at": "2026-11-12T10:00:00.000Z", "taskId": "T-3", "channel": "C0123", "threadTs": "1731377400.000100",
      "purpose": "result", "kind": null, "text": "已修复：…（Jira F2PGBA-12），Draft MR：…，CI 通过。" }
  ],
  "next": 12,
  "outboxId": "6f1c2d9e-3b1a-4c55-9a53-0c7d8b2f4e11",
  "lastSeq": 12
}
```

- **字段**：
  - `outboxId`：发件箱编号，存在 `<数据目录>/outbox-id`，第一次用时生成随机 UUID，之后不变；数据目录清空会重新生成。
  - `lastSeq`：发件箱当前最大 `seq`，空时为 `0`；和本次返回的 `messages`（`after`、`limit`）无关。
  - `purpose`：`ack`（已收到）、`question`（追问）、`result`（结果）或 `system`（系统通知）。
  - `kind`：只有 `system` 才有。进度：`jira_created`、`mr_opened`、`ci_failed`、`ci_fix_pushed`、`ci_passed`、`ci_rounds_exhausted`、`ci_no_pipeline`；结束：`failed`、`needs_person`、`timed_out`、`stopped`、`interrupted`、`expired`、`needs_info_resubmit`；讨论串：`in_progress`、`resumed`、`no_open_task`；拒绝：`queue_full`、`channel_not_bound`。Slack Bot 一般不用看它，原样发 `text` 就行。
- **顺序和保存**：
  - `seq` 从 1 开始全局递增，不复用。
  - 消息存在 `<数据目录>/outbox.jsonl`，重启不丢。
- **分页**：`after` 默认 0；`limit` 默认 50，最多 200。返回的消息按 `seq` 从小到大排；`next` 是这一页最后一条的 `seq`，没有新消息时等于 `after`。
- **Slack Bot 怎么发**：
  - 把 `text` 原样发进 `channel` 里 `threadTs` 那个讨论串（`chat.postMessage`，`thread_ts` 填 `threadTs`）。
  - 每发成功一条，就把游标推到这条的 `seq` 并存盘。
- **发现发件箱被重置**：Slack Bot 把 `outboxId` 和游标一起存盘。某次返回的 `outboxId` 和存的不同，或 `lastSeq` 小于游标，就说明数据目录被清过，`seq` 重新从 1 开始：把游标重置为 0、换存新的 `outboxId`，再照常拉取。不重置的话，新消息会因为 `seq` 小于游标永远发不出去。
- **至少发一次**：发完还没存游标就崩溃的话，重启后这条会再发一次。可以接受，不做“正好一次”。
- **文字已处理好**：广播式提及（`<!channel>`、`@here` 等）已经去掉，长度不超过 4000 个字符。

**(3) 其他已有的口**

- `GET /health` 多一个 `channels: string[]`，是配置里绑定的频道 ID（`bindings[].channel`）。Slack Bot 启动时拿它和自己的频道配置比对，不一致就报错，见 [架构文档 4.3](architecture.md)。

- `GET /tasks/<号>`：查状态，字段有 `state`、`step`、`endReason`、`closeNote`、`jira`、`mr`、`ci`、`origin`。排查用，Slack Bot 平时不用调。
- `POST /tasks/<号>/stop`：停止任务（详见下面的 (4)）。
- `GET /health`：返回 `{ up, queued, running, maxConcurrent, queueMax, queueFull, channels }`。Slack Bot 每次 `/fix` 发任务消息之前先调一次：连不上或 `queueFull` 为真，就只给发起人回临时消息（Logan 规格里“拒绝只给发起人看”的做法），不发任务消息。

**(4) 任务级操作（给 Slack Bot 预留）**

这几个口 **Agent 这边已经做好并测过，Slack Bot 还没接**：团队决定 Slack Bot 暂时不收讨论串里的消息（没有 `app_mentions:read`），所以现在没人调。预留的目的是以后 Yuzhao 要接，只要在 Slack Bot 里加调用，Agent 不用再改。都带 `x-chat-to-fix-token`，按任务号操作。

| 接口 | 什么时候用 | 请求体 | 各状态下的结果 |
|---|---|---|---|
| `POST /tasks/<号>/stop`（关停后续） | 用户点“停止”按钮：不要再做后面的步骤，也不做收尾 | 无 | `queued`、`running`：停掉，200 `{ stopped: true }`，发件箱放“已停止”；其余状态：409 `not_stoppable` |
| `POST /tasks/<号>/messages`（追加信息） | 用户在讨论串里回复，补充情况；以后 Slack 侧能收到回复时用 | `{ eventId, user: { id, name? }, text, files? }`，`eventId`、`user.id`、`text` 必填 | `needs_info`：存下，重新排队，发件箱放“收到补充信息”，202 `{ taskId, state: "queued", delivered: "rerun", position }`；`queued`：存下，下次运行时读到，200 `delivered: "stored"`；`running`：存下，并立刻以一条 `[system]` 消息发进该任务的群，Main 机器人马上看到，200 `delivered: "group"`（群发不出去时退成 `"stored"`）；已结束：409 `task_ended` |
| `POST /tasks/<号>/interrupt`（打断，带新信息重来） | 用户在讨论串里又发了一次 `/fix`，或点“按新信息重来”：停掉当前这一轮，同一个任务带上新信息重跑 | 同上，`text` 可以不带 | `running`：停掉这一轮，同一个任务重新排队，Jira、仓库、MR 保留（同重跑），发件箱放“任务 T-1 已按新的信息重新开始”（`kind: "interrupted"`，不是“已停止”），202 `{ taskId, state: "queued", delivered: "rerun", interrupted: true, position }`；`queued`：只存下，200 `interrupted: false`；`needs_info`：同 messages 的重新排队，`interrupted: false`；已结束：409 `task_ended` |
| `GET /tasks?eventId=<id>` 或 `GET /tasks?thread=<频道>:<threadTs>` | `POST /events` 超时、不知道任务建没建时，重试之前先查 | 无 | 200 `{ tasks: [{ id, state, step, jiraKey, mrUrl, …, permalink }] }`，没有就是空数组；`eventId` 和 `thread` 二选一，都给或都不给返回 400 |

- **`eventId` 去重**：`messages` 和 `interrupt` 的 `eventId` 和 `/events` 一样，同一个编号只处理一次；再来一次返回 200 `{ taskId, state, duplicate: true }`，不会重复存、重复发群或重复打断。两份同时到达也只处理一份。`interrupt` 不带 `text` 时也会记下这个编号。建议用 Slack 的 `event_id`（按钮用 `trigger_id`）。
- **查任务回答 Logan 的规则 1**：`POST /events` 超时了不要直接重发，先 `GET /tasks?eventId=<同一个 eventId>`。查到就用返回的任务，没查到再用同一个 `eventId` 重发（重发本身也是安全的，同一编号只建一个任务）。讨论串里只有 `threadTs` 时用 `?thread=`。
- **Slack Bot 以后可以这样接**：
  - “停止”按钮：调 `stop`，不用再发文字，发件箱会带出“已停止”。
  - 讨论串里又发一次 `/fix`：先 `GET /tasks?thread=` 找到任务，任务还在进行就调 `interrupt`，已结束才当新任务 `POST /events`。
  - 讨论串里的回复：调 `messages`（前提是 Slack 侧收到这些回复，现在没有）。
  - 以上返回 409 `task_ended` 时，提示用户用 `/fix` 提新问题。
- **和 `source: "mention"` 的关系**：同一件事的两个入口，`mention` 按讨论串找任务，`messages` 按任务号找；区别是运行中的任务，`messages` 会马上把信息发进群，`mention` 只是存下，等下次重跑才读到。

### 4.3 Chat-to-Fix 侧的改动

- **新配置 `adapters.slack: "outbox"`**：
  - 不需要 Slack 令牌。
  - `readThread` 返回讨论：`/fix` 原文加讨论串里的补充。
  - `reply` 往发件箱追加一条。
  - `startThread` 不支持：任务消息由 Slack Bot 发，`source: "slash"`（服务端自己开讨论串）的路径在这个模式下不用。
- **新模块 `src/chat-to-fix/core/task/outbox.ts`**：`append` 分配 `seq` 并按讨论串补上 `taskId`；`read(after, limit)`。
- **`src/chat-to-fix/core/task/http.ts`**：
  - 加 `GET /outbox`。
  - `POST /events` 认 `source: "fix"` 和 `source: "mention"`。
  - 补充信息存进任务（`store.addFollowUp`，已写未提交）。
  - 不带 `source` 的旧格式照旧，测试和模拟用例在用。
- **系统通知**：`src/chat-to-fix/core/task/monitor.ts` 的 `NOTICE` 和 CI 通知都经 `reply(origin, 'system', text)` 发出，自然进发件箱，并带上 `kind`。中文模板和“需要人处理”的原因（`closeNote`）在做。
- **进度通知**：建单（`jira_create_issue`）、开 MR（`mr_open_draft`）、CI 修复推送（`mr_push_fix`）成功时，工具直接发系统通知，不经过模型。建单和开 MR 每个任务只发一次，重跑不重复（`task.notified`）。对应 Logan README“目标 Slack 回传”里的“工单已创建”“MR 已创建”和 CI 的“新 commit 链接”。
- **讨论串补充的开关 `slack.mentions`**：默认开。关的时候，任务以“缺信息”结束后系统再发一条 `needs_info_resubmit`，请用户补全后重新 `/fix`。
- **`GET /health`**：加 `queueMax`、`queueFull`。
- **`chat-to-fix/scripts/connected.ts`**：slack 改为 `outbox`，不再要 `SLACK_BOT_TOKEN`；`slack.mentions` 先设为关，`app_mentions:read` 批下来再打开。
- **`chat-to-fix/scripts/slack-forwarder.ts`**：Chat-to-Fix 自己的转发程序，留给 `adapters.slack: "real"` 单独部署时用，不和 Slack Bot 同时跑。

### 4.4 Slack Bot 侧的改动（`src/slackBot/`）

这一侧归 Yuzhao。下面这些已有一版参考实现，放在本目录的 [reference/](reference/README.md)，没有动 Logan 的代码（未审、没连过真 Slack）。交接说明见 [handover.md](handover.md)。

- **`/fix`**：用 `app.command('/fix')` 处理，行为见 [slackenter.md](slackenter.md) 第 2.1 节。先调 `GET /health`，正常才发任务消息，再调 `POST /events`。
- **讨论串里的 @**：用 `app.event('app_mention')` 处理，只认指定频道、在讨论串里的 @，见 [slackenter.md](slackenter.md) 第 2.2 节。
- **发件箱转发**：启动后每 3 秒调一次 `GET /outbox`，按 4.2(2) 发出去。游标存在 `SLACK_BOT_STATE_DIR/outbox-cursor`，默认目录 `.local/`，不进 git。
- **新文件**：
  - `chat-to-fix-api.js`：接口客户端。
  - `fix-command.js`：`/fix` 和 @ 的处理。
  - `outbox-relay.js`：发件箱转发。
- **`slack-bot.js`**：改为挂上面三样。私信处理不再挂：应用已经去掉了私信事件，见 [私信历史规格](../../../spec/slack-dm-entry.md)。
- **环境变量**：
  - `CHAT_TO_FIX_API_URL`：默认 `http://127.0.0.1:3090`。
  - `CHAT_TO_FIX_API_TOKEN`：Chat-to-Fix 的令牌。
  - `CHAT_TO_FIX_SLACK_CHANNEL`：指定频道。
- **模拟入口**：`mock-slack-bot.js` 加上 `/fix` 和发件箱转发，不连 Slack 也能端到端试。

### 4.5 实施顺序

1. Chat-to-Fix：发件箱、`outbox` 适配器、`GET /outbox`、`source`。没验证过的路径先做。
2. Slack Bot：接口客户端、发件箱转发、`/fix`、@。
3. 模拟端到端：模拟 `/fix` → Chat-to-Fix（假模型冒烟）→ 发件箱 → 模拟讨论串。
4. 真 Slack：等安装审批和令牌。

## 5. 测试决定

- **Chat-to-Fix**：
  - `chat-to-fix/test/http.test.ts`：`source`、补充信息、409、`GET /outbox`。
  - 新文件 `chat-to-fix/test/outbox.test.ts`。
  - `chat-to-fix/test/adapters-slack.test.ts`：`outbox` 适配器。
  - 照现有 http 测试的写法。
- **Slack Bot**：参考 `src/slackBot/test/slack-message.test.js`、`src/slackBot/test/mock-slack-bot.test.js` 的写法，Chat-to-Fix 接口用本机 stub HTTP 代替。
- **端到端**：模拟 `/fix` 一路走到发件箱，再发进模拟讨论串，用假模型，不花钱。

## 6. 不做

- 私信入口。
- 推送（回调）。
- 正好一次的投递。
- Slack 用户和 Jira、GitLab 账号的对应：MR 作者是服务账号，发起人只写进 Jira 和 MR 的描述。
- 讨论串里的按钮、表单等交互组件。

## 7. 待定

1. **指定频道 ID**：Logan 的 M0。推荐先用一个测试频道。
2. **讨论串里的 @ 要加权限**：需要 `app_mentions:read` 和 `app_mention` 事件，要和管理员、Logan 确认加进安装申请。推荐加，Yuzhao 也是这个意见，见 [slackenter.md](slackenter.md) 第 3 节。没批下来之前用 `slack.mentions: false`，流程不卡。
3. **部署位置**：接口只听本机，所以 Slack Bot 和 Chat-to-Fix 跑在同一台机器上。要分开部署时，再定鉴权和地址。推荐第一版同机。
4. **用户名**：推荐先不申请 `users:read`。`/fix` 带的 `user_name` 够用；@ 补充时只有用户 ID。
