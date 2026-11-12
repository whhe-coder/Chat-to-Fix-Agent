# 细分规格 3：看门狗

- 日期：2026-11-11
- 覆盖的工作包：B4（监听口和控制接口）、B2（队列）、B5（运行器）、B7（监控）。
- 上位文档：[software-spec.zh.md](software-spec.zh.md) 5.8、5.9、5.10、7.1 至 7.3、7.7、7.8；[tools-and-limits.zh.md](tools-and-limits.zh.md) 第 4 节。
- 角色标识、步骤标识见规格 1；任务字段、结束原因见规格 2；bot 层门面见规格 5。
- 状态：2026-11-12 按代码（提交 192a721）更新。最初是 2026-11-11 开工前的设计；和原设计不同的地方已直接改成现状，代码还没做到的标“未实现”。
- CI 修复循环（提交 192a721）：流程现在是八步，监控多了等 pipeline 的检查和“CI”这一步的计时与通知。本文只写监控的接口和各项检查；CI 循环本身（轮次、判定、工具、通知细节）见 [spec-7-ci-loop.zh.md](spec-7-ci-loop.zh.md)。

## 1. 范围

管：接收 @ 事件；排队；启动和解散一次运行；监控上限并采取动作；系统通知；进程重启后的处理；查任务和停止任务的接口。

不管：步骤的规则（规格 1）；任务怎么存（规格 2）；工具（规格 4）；bot 和群内部怎么运转（bot 层）。

看门狗全部是代码，不调用模型。

## 2. 数据形状

### 2.1 @ 事件

`POST /events` 的请求体：

```json
{
  "eventId": "Ev0123",
  "channel": "C0456",
  "threadTs": "1731377400.000100",
  "messageTs": "1731377400.000100",
  "user": { "id": "U0789", "name": "tester" },
  "text": "登录页的按钮点了没反应",
  "files": [{ "name": "screenshot.png", "url": "https://example.com/f/1" }],
  "permalink": "https://example.slack.com/archives/C0456/p1731377400000100"
}
```

必填：`eventId`、`channel`、`threadTs`、`messageTs`、`user.id`、`text`。字段名要和负责 Slack 的同事约定；约定之前用这一版，@ 事件由假事件命令提交（规格 4）。

### 2.2 上限的配置键

数值的依据见 tools-and-limits 第 4 节。所有键都在配置的 `limits.*` 下（见 `config.example.json`）。表里没有的键会被悄悄忽略；值不是正数则配置无效。

| 键 | 初值 | 含义 |
|---|---|---|
| `taskMinutes` | 80 | 一次运行的总时限 |
| `stepMinutes.fetch`、`.issue`、`.mr`、`.writeback` | 5 | 这几步各自的时限 |
| `stepMinutes.ci` | 30 | CI 一轮修复的时限，从该轮 pipeline 失败时算起；等 pipeline 期间不计（见 4.5 和规格 7） |
| `stepMinutes.prepare` | 10 | 备代码的时限 |
| `stepMinutes.code` | 40 | 编码（含内部审查）的时限 |
| `quietMinutes` | 3 | 群安静多久算停滞 |
| `quietNudges` | 2 | 停滞时最多催几次 |
| `engineSilentMinutes` | 10 | Claude Code 多久没有任何输出算无响应 |
| `maxConcurrent` | 1 | 同时运行的任务数 |
| `queueMax` | 20 | 队列长度上限 |
| `queueWaitHours` | 4 | 排队等待上限 |
| `worktreeKeepDays` | 7 | 任务结束后代码目录保留的天数（用到它的清理未实现，见 4.4） |
| `engineMaxTurns` | 200 | 作为 `--max-turns` 传给 Claude Code |
| `reviewMaxRounds` | 3 | 键存在，但没有任何代码读它；三轮只写在 `src/prompts/coding.md` 里 |
| `toolTimeoutSeconds` | 30 | 一次工具调用的时限 |
| `toolRetries` | 2 | 工具调用的重试次数，间隔 250 毫秒，只重试标为可重试的错误 |
| `diffMaxFiles` | 20 | 一次改动最多改几个文件，超过就拒绝开 MR |
| `diffMaxLines` | 500 | 一次改动最多多少行（增加加删除），超过就拒绝开 MR |
| `replyMaxChars` | 600 | Slack bot 一条回复的长度上限 |
| `ciPollSeconds` | 15 | 等 pipeline 时多久查一次 CI 结果 |
| `ciWaitMinutes` | 30 | 对同一个提交最多等多久（没触发 pipeline 或一直没结论） |
| `ciTotalMinutes` | 90 | 各轮合计最多等多久 |
| `ciMaxRounds` | 3 | CI 最多修几轮（整数） |
| `ciLogMaxChars` | 12000 | `ci_read_log` 返回的日志最多多少字符（整数） |

另有顶层配置键 `pricing`，不在 `limits` 下：覆盖或补充价格表（每百万 token 的美元价），见 3.1 末尾。

## 3. 接口

### 3.1 HTTP（I6）

文件：`src/task/http.ts`。只监听 `127.0.0.1`，端口是配置项 `httpPort`。每个请求带请求头 `x-chat-to-fix-token`，值是环境变量 `CHAT_TO_FIX_HTTP_TOKEN`（不是配置键）；不带或不对返回 401，`{ error: "unauthorized" }`。

| 请求 | 成功时返回 | 其他情况 |
|---|---|---|
| `POST /events` | 202，`{ taskId, state: "queued", position }` | 见 4.1 |
| `GET /tasks/:id` | 200，任务；带 `?records=1` 时附执行记录 | 404，`{ error: "task_not_found" }` |
| `GET /tasks?state=` | 200，`{ tasks: [...] }`，任务的简表：编号、状态、当前步骤、Jira 单号、MR 链接、`totalUsd`（本任务累计费用，美元）、`unpriced` | 状态值未知时 400，`{ error: "invalid_state" }` |
| `POST /tasks/:id/stop` | 200，`{ stopped: true }` | 任务不存在时 404，`{ error: "task_not_found" }`；任务不在排队或运行中时 409，`{ error: "not_stoppable", state }` |
| `GET /health` | 200，`{ up: true, queued, running, maxConcurrent }` | — |

其他错误：400 `invalid_json`（请求体不是 JSON）；413 `body_too_large`（超过 1,000,000 字节）；404 `not_found`（路径不存在）；500 `internal_error`。缺字段时返回 400，字段名写在错误文字里：`{ error: "missing_fields: eventId, user.id" }`。

每个任务的 token 和费用统计已提交（31b386d）：`src/task/usage.ts` 把每次模型调用或 Claude Code 回合记成一条 `usage` 记录，并经 `store.addUsage` 汇总到任务的 `usage`（总额、按角色、按模型、按运行次数）；价格表在 `src/task/pricing.ts`，可被配置键 `pricing` 覆盖或补充。Coding bot 的费用用 Claude Code 自己报的数。模型没有价格时该条标 `unpriced`，不计入总额，也不猜价。`GET /tasks` 的 `totalUsd` 和 `unpriced` 取自这份汇总。

### 3.2 内部函数

| 组件 | 文件 | 函数 |
|---|---|---|
| 队列 | `src/task/queue.ts` | `enqueue(taskId)`、`dispatch()`、`release(taskId)`、`expire()`、`full()`、`position(taskId)` |
| 运行器 | `src/task/runner.ts` | `start(taskId)`、`end(taskId, state, endReason)`、`restore()`、`cleanupWorktrees()`、`codingOptions(taskId)` |
| 监控 | `src/task/monitor.ts` | `watch(taskId)`、`unwatch(taskId)`、`notify(task, kind)` |

依赖：任务库（I2）；步骤把关的 `close` 结束后回调 `end`；bot 层门面（I1）；bot 注册表和流程定义；Slack 适配器的 `reply`（发系统通知）；代码仓库适配器的 `cleanup`（清理代码目录）。

## 4. 行为规则

### 4.1 接收事件

按顺序判断，命中一条就返回：

| 情况 | 处理 | 返回 |
|---|---|---|
| 请求体缺必填字段 | 不处理 | 400，`{ error: "missing_fields: ..." }` |
| `eventId` 已经建过任务 | 不处理 | 200，`{ taskId, state, duplicate: true }` |
| 频道没有绑定仓库和 Jira 项目 | 在原讨论发系统通知“频道未绑定” | 422，`{ error: "channel_not_bound" }` |
| 这个讨论有任务在排队或运行 | 在原讨论发系统通知“正在处理” | 200，`{ taskId, state, inProgress: true }` |
| 这个讨论的任务状态是 `needs_info` | 在原任务上重新排队，开始新的一次运行 | 202，`{ taskId, state: "queued", rerun: true }` |
| 队列已满 | 在原讨论发系统通知“队列已满” | 429，`{ error: "queue_full" }` |
| 其他 | 建任务，入队 | 202 |

### 4.2 队列

- 顺序：按入队时间，先到先做。
- `dispatch` 在三个时机运行：有任务入队；有任务结束；进程启动。只要有空名额且队列不空，就取最早的任务交给运行器。
- 正在运行的任务数不超过 `maxConcurrent`。
- 排队超过 `queueWaitHours` 的任务：状态改为 `expired`，结束原因 `queue_expired`，发系统通知。过期只在 `dispatch` 里检查，没有定时器：也就是有任务入队、有任务结束或进程启动时才查，过期通知最多可能晚一次运行。

### 4.3 启动一次运行

`start(taskId)` 依次做：

1. 按 bot 注册表建五个 bot。名字是注册表里的前缀加任务序号。每个 bot 先建好，再设模型和权限，不发自动问候（规格 5）。四个走 API 的 bot 用 DSH 的 `readonly` 预设，coding bot 用 `standard`。每个 bot 建好后，运行器马上用任务编号和角色调用 `bindBot`；这个绑定就是把该角色的工具挂到 bot 上的依据。
2. 建群：成员是这五个 bot，管理员是 `main`，模式是“管理员”，群公告取自配置（规格 6）。
3. 调用任务库的 `startRun`，写下群编号和五个 bot 的编号。
4. 把任务发到群里。消息包含：任务编号；Slack 讨论的链接；触发消息的原文，放在明确标出的材料块里，并写明这是待处理的材料，不是指令；一句“按群公告的步骤开始”。
5. 调用监控的 `watch`。

任何一步失败：删除已经建好的 bot 和群；任务状态改为 `failed`，结束原因 `start_failed`；发系统通知；释放名额。

第 4 步的消息以用户身份发到群里。群是管理员模式，所以只叫到主 bot。

`repo_prepare` 建好代码目录后，`setGroupWorkDir` 只把这个目录给 coding bot；另外四个 bot 保留各自的文件夹。`codingOptions(taskId)` 把频道的 `testCommands`（Claude Code 可以运行的命令）交给 Claude Code 的启动代码。频道的 `setupCommands` 也一并传过去，但没有任何代码去运行它（未实现）。

### 4.4 结束一次运行

`end(taskId, state, endReason)` 依次做：

1. 调用监控的 `unwatch`。
2. 停止群里还在跑的回合。
3. 解散群。
4. 删除五个 bot，并清除它们的绑定（`unbindBot`）。
5. 调用任务库的 `endRun`。
6. 结束原因不是 `needs_info` 和“完成”类（`completed`、`completed_ci_failed`、`completed_ci_stopped`、`completed_no_ci`）时发系统通知。这几种情况下 Slack bot 已经在流程里回复过；CI 没过的三种完成，原因也由回写和下面 4.6 的 CI 通知交代。
7. 调用队列的 `release`，再调用 `dispatch`。

`end` 可以重复调用，第二次什么都不做。每一步失败都记日志并继续做下一步，保证名额一定被释放。

任务、执行记录、会话日志、Jira 单、分支、MR 都保留。代码目录原本设计为在任务结束 `worktreeKeepDays` 天后由每天一次的清理删除。未实现：`runner.cleanupWorktrees()` 这个函数有（它跳过 `needs_info` 的任务），但没有任何代码调用它，所以现在不会删任何代码目录。

### 4.5 监控

监控每 5 秒检查一遍所有运行中的任务。

| 检查 | 条件 | 动作 | 结束原因 |
|---|---|---|---|
| 任务总时限 | 本次运行超过 `taskMinutes` | 结束任务，状态 `timed_out` | `task_timeout` |
| 步骤时限（编码以外） | 进入当前步骤超过 `stepMinutes`。适用于 `fetch`、`issue`、`prepare`、`mr`、`ci`、`writeback`；`ci` 的规则见下面的“CI”行；第八步 `close` 没有自己的时限 | 第一次：给主 bot 补一条消息，说明哪一步超时。再超过一个时限：结束任务，状态 `failed`。`prepare` 也是这样，共 2 个 10 分钟 | `step_timeout` |
| 编码时限 | 进入 `code` 超过 `stepMinutes.code` | 不催：直接停止 coding bot 的回合并结束任务，状态 `timed_out` | `coding_timeout` |
| 群安静 | 群连续 `quietMinutes` 没有任何动静，任务没结束 | 给主 bot 补一条消息，最多 `quietNudges` 次；再发生则结束任务，状态 `failed` | `stalled` |
| 空转暂停 | 群里出现“因连续空转而暂停”的系统通知 | 结束任务，状态 `failed` | `idle_relay` |
| Claude Code 无输出 | coding bot 的回合在跑，但 `engineSilentMinutes` 内没有任何事件 | 第一次：停止 coding bot 的回合，给主 bot 补一条消息让它重新叫 coding bot。第二次：结束任务，状态 `failed` | `engine_silent` |
| CI（任务在 `ci` 步） | 监控按 `ciPollSeconds` 查 MR 当前提交的 pipeline，通过、失败（先自动重跑失败的 job 一次）或等太久（`ciWaitMinutes`、`ciTotalMinutes`）时定案，细节见规格 7。等 pipeline 期间（状态 pending）：跳过步骤时限和“群安静”两项检查，等待的时间也不算进任务总时限。某轮失败后，Git Pipeline bot 负责修，步骤时限、安静次数和空转检查都从这次失败重新计，催促发给 Git Pipeline bot，不发给主 bot。定案后给主 bot 补一条消息让它推进到回写，只发一次（记在任务的 `ci.mainNotified`，重启也不会重发） | 无新结束原因；结果由 `completed_ci_failed`、`completed_ci_stopped`、`completed_no_ci`（状态 `done`）体现 |
| 审批 | 出现审批请求 | 拒绝，并记一条执行记录 | — |

说明：

- “给主 bot 补一条消息”就是以用户身份往群里发一条消息。群是管理员模式，所以由主 bot 接手。
- “群没有任何动静”用门面的 `isQuiet` 判断，条件是：没有进行中的轮次，没有成员在工作，没有未完成的批次，群收件箱为空。
- 群内成员 240 秒不回复由 bot 层自己处理（记为错过，主 bot 继续），监控不介入。这 240 秒（`ROOM_REPLY_TIMEOUT_MS`）和空转上限 6 次都是 DS Bot 里的常量，不是配置键。
- 空转暂停靠正则匹配 DS Bot 那条通知的英文原文来识别（`monitor.ts` 里的 `IDLE_RELAY_NOTICE`）。DS Bot 改了措辞，这一项就失效。
- coding bot 内部的修改和审查最多三轮只写在它的说明里（`src/prompts/coding.md`）；配置键 `reviewMaxRounds` 没有任何代码读它。系统用编码时限兜底。
- 每次触发都记一条 `limit` 类型的执行记录，写明是哪一项、当时在第几步、采取了什么动作。
- 在 `ci` 步，“给主 bot 补一条消息”里的步骤超时、群安静和 Claude Code 无输出的催促改发给 Git Pipeline bot（它在带领修复），措辞也改成 CI 的版本（`NUDGE.ciQuiet`、`NUDGE.ciEngineSilent`）。
- 判断步骤时限要用进入当前步骤的时间，记在任务的 `stepAt` 字段（规格 2）。

### 4.6 系统通知

任务由系统结束或被系统拒绝时，系统直接在原讨论发一条说明，不经过 bot。通过 Slack 适配器发，用途是 `system`。

| 种类 | 什么时候发 |
|---|---|
| 正在处理 | 同一讨论重复 @ |
| 队列已满 | 入队被拒 |
| 频道未绑定 | 频道没有配置 |
| 已超时 | 结束原因 `task_timeout`、`coding_timeout` |
| 未能完成 | 状态 `failed` |
| 已过期 | 结束原因 `queue_expired` |
| 已停止 | 有人调用了停止 |

通知的文字是固定模板，带任务编号；有 Jira 单号和分支时一并带上。上面这七种通知和发给 bot 的催促消息只有英文，不管配置项 `language` 是什么。每条属于某个任务的通知也会作为 `system` 类型写进该任务的执行记录（“队列已满”和“频道未绑定”没有任务，不记录）。以 `needs_person` 结束的任务状态是 `failed`，所以发的是“未能完成”。

CI 通知另算（`monitor.ts` 的 `ciNoticeText`，不在上表里）：在 `ci` 步发到原讨论，只带链接和 job 名，不带日志。文字跟配置项 `language`：`zh` 发中文，其他发英文。种类：`ci_passed`（CI 通过）、`ci_failed`（第几轮失败，附没过的 job）、`ci_rounds_exhausted`（修满轮数仍未通过）、`ci_no_pipeline`（没拿到 CI 结果：没触发或等超时）。同一次定案只发一次。发给主 bot 和 Git Pipeline bot 的 CI 催促消息仍是英文。细节见 [spec-7-ci-loop.zh.md](spec-7-ci-loop.zh.md)。

### 4.7 手工停止

`POST /tasks/:id/stop`：排队中的任务直接改为 `stopped`；运行中的任务调用 `end(taskId, "stopped", "stopped")`。

### 4.8 进程重启

启动时：

- 状态是 `queued` 的任务留在队列里。
- 状态是 `running` 的任务：群还在，`restore()` 就重新 `watch`，等 bot 层的恢复逻辑把被打断的回合续跑一次；各项时限从重启时刻重新计，任务总时限仍从本次运行的开始时间计。群不在了，就调用 `end(taskId, "failed", "restart")`。
- 然后运行 `dispatch`。

已知缺口（未实现）：`restore()` 不会再次调用 `bindBot`。绑定只存在内存里（`src/task/botlayer.ts`），所以重启后，恢复的任务的 bot 没有了绑定：角色工具调用会失败，记录器也不会为它们写工具调用、工具返回或一轮结束的记录（群里的行仍会记录）。这样的任务做不了有用的事，最后靠时限或 `stalled` 结束。

## 5. 代码参考

`DSB:` 指本仓库里的 DS Bot 副本 `bot/src/host/*.ts`（这些引用原来写的是原版的 `.js`）。行号于 2026-11-11 按原版核对；只有标了“2026-11-12 复核”的行重新看过。`SA:` 的行指向 dsh-superagent 仓库，它不在本仓库里，没有复核。

| 位置 | 看什么 |
|---|---|
| `DSB:src/host/local-agents/mcp.ts`（`LoopbackMcp`，第 30 行） | 在进程里开一个只监听本机、带令牌的 HTTP 服务 |
| `SA:docs/006-deployment.md` “Management API” | 管理接口的设计和错误返回 |
| `SA:src/executor/dsh.ts:171` | 名额管理 |
| `SA:docs/003-execution.md` | 并发名额、失败和恢复、重启 |
| `DSB:src/host/roster.ts:140`、`:148` | 建 bot 及其参数 |
| `DSB:src/host/roster.ts:316` | 建好后设模型和权限 |
| `DSB:src/host/roster.ts:493`、`:503` | 建群：成员、管理员、模式、群公告 |
| `DSB:src/host/roster.ts:649`、`:701` | 删群、删 bot |
| `src/task/botlayer.ts` 的 `postTask`（第 159 行） | 以用户身份往群里发消息（原版的 `channel.js` 在这里已不存在） |
| `DSB:src/host/groups.ts:1149` | 管理员模式下一条消息先叫到谁 |
| `DSB:src/host/groups.ts:1378`、`:1353` | 停整群；停一个成员 |
| `src/task/botlayer.ts` 的 `isQuiet`（第 223 行），`DSB:src/host/groups.ts:1401` | “群已安静”的判断条件（原版的 `goals.js` 在这里已不存在） |
| `DSB:src/host/groups.ts:723`、`:90`、`:630`（2026-11-12 复核） | 空转暂停写进群里的那条系统提示（`reason: paused`、`idle: true`）；这条提示的文字；被暂停的调用放在哪 |
| `DSB:src/host/constants.ts:38`、`:79`（2026-11-12 复核） | 成员回复超时 240 秒；空转上限 6 次 |
| `DSB:src/host/local-agents/claude-engine.ts`（`session.interrupt()`，第 47 行） | 中断 Claude Code |
| `DSB:src/host/approvals.ts:15`、`:100` | 订阅审批；应答审批（`allow` 或 `reject`） |
| `DSB:src/host/resume.ts:21`、`:168` | 重启 3 秒后开始恢复；恢复逻辑包裹了投递 |
| `SA:src/limits.ts:2` | 把上限集中成一张表 |

## 6. 实现清单

B4：

- [x] 只监听本机；校验令牌。
- [x] `POST /events` 按 4.1 的顺序判断。
- [x] `GET /tasks/:id`、`GET /tasks`、`POST /tasks/:id/stop`、`GET /health`。
- [x] 错误返回带明确的 `error` 字段。

B2：

- [x] 入队、取任务、释放名额。
- [x] 并发上限。
- [x] 队列长度上限和排队超时（只在 `dispatch` 里检查，见 4.2）。

B5：

- [x] `start` 的五步和失败时的清理。
- [x] 任务消息的模板，原文放在材料块里。
- [x] `end` 的七步，可重复调用，保证释放名额。
- [ ] 每天一次清理过期的代码目录（未实现：函数有，没有任何代码调用）。

B7：

- [x] 4.5 表里的八项检查（含 CI），各自的动作和结束原因。
- [x] 催促消息的模板。
- [x] 系统通知的七种模板，加四种 CI 通知（中英文）。
- [x] 每次触发记一条 `limit` 或 `approval` 记录。
- [ ] 重启时按 4.8 处理（未实现：重启后不会重新绑定 bot）。
- [x] 所有上限从配置读取，4.5 里说的两个 DS Bot 常量除外。

## 7. 验收

- 同一个事件提交两次，第二次返回 `duplicate`，只有一个任务。
- `maxConcurrent` 为 1 时，第二个任务在第一个结束后才启动；改为 2 时两个同时运行。
- 启动中途失败后，bot 层里没有残留的 bot 和群，名额已释放。
- 把某一步的时限调到很短：第一次超时主 bot 收到催促，第二次任务以 `step_timeout` 结束，原讨论收到通知。
- 运行中调用停止：群被解散，任务状态 `stopped`。
- 运行中杀掉进程再启动：任务要么接着跑完，要么以 `restart` 结束，不会一直停在 `running`。（有 4.8 的缺口，群还在的任务用不了角色工具，会靠时限结束。）
- 任意一种结束方式之后，`GET /health` 里的运行数回到 0。
