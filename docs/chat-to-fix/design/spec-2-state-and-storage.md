# 细分规格 2：状态和存储

- 日期：2026-11-11
- 覆盖的工作包：B1（任务库）、B6（记录器）。
- 上位文档：[software-spec.md](software-spec.md) 3.2、3.4、7.6、8.1。
- 角色标识、步骤标识见 [spec-1-registry-and-flow.md](spec-1-registry-and-flow.md)。
- 状态：2026-11-12 按代码（提交 192a721）更新。最初是 2026-11-11 开工前的设计；和原设计不同的地方已直接改成现状，代码还没做到的标“未实现”。

## 1. 范围

管：任务、运行、执行记录存在哪、是什么形状；任务库的接口；执行记录从哪些事件生成；每一步的结果怎么写到任务上。

不管：步骤的规则（规格 1）；什么时候建任务、什么时候结束（规格 3）；bot 的完整对话（由 DSH 的会话日志保存，不重复存）。

任务库是流程的记忆。bot 之间的转交靠它：上一步的结果写在任务上，下一个 bot 用 `task_read` 读。

## 2. 数据形状

### 2.1 目录

```
<dataDir>/
  index.json                 序号、事件去重表、讨论到任务的对应
  tasks/
    T-12/
      task.json              任务
      records.jsonl          执行记录，一行一条
```

`dataDir` 是配置项（规格 6）。

### 2.2 index.json

| 字段 | 含义 |
|---|---|
| `nextNo` | 下一个任务的序号 |
| `events` | 事件编号到任务编号的对应，用于去重 |
| `threads` | “频道:讨论的 thread_ts”到任务编号的对应，一个讨论对应一个任务 |

### 2.3 task.json

```json
{
  "id": "T-12",
  "no": 12,
  "state": "running",
  "endReason": null,
  "createdAt": "2026-11-12T02:10:00Z",
  "updatedAt": "2026-11-12T02:21:30Z",
  "origin": {
    "eventId": "Ev0123",
    "channel": "C0456",
    "threadTs": "1731377400.000100",
    "messageTs": "1731377400.000100",
    "user": { "id": "U0789", "name": "tester" },
    "text": "登录页的按钮点了没反应",
    "files": [],
    "permalink": "https://example.slack.com/archives/C0456/p1731377400000100"
  },
  "binding": {
    "repo": "group/project",
    "defaultBranch": "master",
    "jiraProject": "DEMO",
    "issueType": "Bug",
    "labels": ["chat-to-fix"]
  },
  "queuedAt": "2026-11-12T02:10:00Z",
  "step": "code",
  "stepAt": "2026-11-12T02:15:20Z",
  "stepResults": {
    "fetch": { "slack": { "text": "摘要……", "at": "2026-11-12T02:12:05Z" } },
    "issue": { "jira": { "text": "已建单 DEMO-7", "at": "2026-11-12T02:13:10Z" } }
  },
  "slack": { "readAt": "2026-11-12T02:11:40Z", "sent": { "ack": true, "question": false, "result": false } },
  "jira": { "key": "DEMO-7", "url": "https://example.atlassian.net/browse/DEMO-7", "commentedMr": false, "status": null },
  "repo": { "dir": "/data/worktrees/T-12", "branch": "ai/DEMO-7", "base": "3f9c2ab" },
  "review": null,
  "mr": null,
  "ci": null,
  "needsInfo": { "main": null, "coding": null },
  "runs": [
    {
      "no": 1,
      "groupId": "session-abc",
      "bots": { "main": "session-m", "slack": "session-s", "jira": "session-j", "pipeline": "session-p", "coding": "session-c" },
      "startedAt": "2026-11-12T02:11:00Z",
      "endedAt": null,
      "endReason": null
    }
  ],
  "usage": { "totalUsd": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0, "unpriced": false, "byRole": {}, "byModel": {}, "byRun": {} }
}
```

字段说明：

| 字段 | 谁写 | 含义 |
|---|---|---|
| `id`、`no` | 任务库 | 任务编号 `T-<序号>` 和序号。bot 的名字用这个序号 |
| `state` | 任务库 | `queued`、`running`、`done`、`needs_info`、`failed`、`timed_out`、`stopped`、`expired` |
| `endReason` | 步骤把关、监控 | 结束原因，取值见 2.5 |
| `origin` | 监听口 | 触发这个任务的 @ 事件 |
| `binding` | 监听口 | 按频道查到的仓库和 Jira 项目 |
| `queuedAt` | 队列 | 最近一次入队的时间，排队顺序和排队超时都按它算 |
| `step` | 步骤把关 | 当前步骤的标识 |
| `stepAt` | 步骤把关 | 进入当前步骤的时间，步骤时限按它算 |
| `stepResults` | 记录器 | 每一步、每个负责角色最后一轮的最终答复 |
| `slack` | Slack 的工具 | 读讨论的时间；三种用途的回复是否已发 |
| `jira` | Jira 的工具 | 单号、链接、是否已写 MR 链接、当前状态 |
| `issueAssessment` | `jira_assess_request` | 建单前的判断：来源原文、具体问题、可检查的结果；新运行时清空 |
| `repo` | 仓库的工具 | 代码目录、分支、基准提交 |
| `review` | `review_report` | `verdict`、`comments`、`rounds`、`at` |
| `mr` | `mr_open_draft`、`mr_push_fix` | `url`、`iid`（MR 编号）、`sha`（当前提交） |
| `ci` | 监控、`mr_push_fix`、`ci_read_log`、`ci_stop` | CI 状态：`status`、`sha`、`round`、`retried`、`since`、`waitedMs`、`pipelineUrl`、`failedJobs`、`logRead`、`settled`、`outcome`、`note`；监控第一次在步骤 `ci` 看到任务时才建，之前是 `null`。字段含义见规格 7 的 4.3 |
| `needsInfo` | `needs_info_confirm` | `main`、`jira`、`coding` 的确认文字和时间；一次追问只需当前步骤的两方确认 |
| `runs` | 运行器 | 每次运行：序号、群编号、各角色的 bot 编号、起止时间、结束原因 |
| `usage` | 记录器（经 `store.addUsage`） | 本任务的 token 和费用汇总，见下 |

没有值的字段写 `null`，不省略（`stepResults` 和 `runs` 起始是空对象和空列表）。

`usage`（提交 31b386d）：每条 `usage` 记录（2.4）进来时，记录器调 `store.addUsage`，加到任务上的汇总里：`totalUsd`、`input`、`output`、`cacheRead`、`cacheWrite`、`calls`、`unpriced`、输出速度，以及 `byRole`、`byModel`、`byRun` 三组分桶。没有价格的模型不估价：该条费用记 `null`，汇总的 `unpriced` 置真，费用不计入合计。价格表在 `src/task/pricing.ts`，可被配置的 `pricing` 覆盖。汇总的算法和字段在 `src/task/usage.ts`。`GET /tasks` 的每个任务带 `totalUsd` 和 `unpriced`。

### 2.4 执行记录

`records.jsonl` 每行一条：

```json
{ "at": "2026-11-12T02:13:10Z", "taskId": "T-12", "run": 1, "step": "issue", "role": "jira", "botId": "session-j", "type": "tool_result", "tool": "jira_create_issue", "ok": true, "text": "DEMO-7", "ms": 840 }
```

| 字段 | 含义 |
|---|---|
| `at` | 时间 |
| `taskId`、`run`、`step` | 任务、第几次运行、当时的步骤 |
| `role`、`botId` | 哪个 bot；系统产生的记录这两项为 `null` |
| `type` | 记录的类型，见下表 |
| `tool`、`ok`、`ms` | 仅工具相关的记录有：工具名、是否成功、耗时 |
| `text` | 内容摘要，最长 2000 个字符，超出截断 |

| `type` | 来源 | 内容 |
|---|---|---|
| `line` | 群里的一行发言 | 发言文字 |
| `notice` | 群里的系统通知 | 通知的原因 |
| `tool_call` | bot 调用工具 | 工具名和参数摘要 |
| `tool_result` | 工具返回 | 结果摘要、是否成功、耗时 |
| `round_end` | 一个 bot 的一轮结束 | 最终答复 |
| `advance` | 步骤把关 | 从哪一步到哪一步 |
| `refused` | 步骤把关 | 被拒绝的操作和原因 |
| `limit` | 监控 | 触发的是哪一项上限、采取的动作 |
| `approval` | 监控 | 审批的内容和应答 |
| `refusal` | 记录器 | Claude Code 引擎的一行，说明某次工具使用被拒绝或权限请求超时 |
| `tool_error` | 记录器 | Claude Code 引擎的一行，说明某次工具使用出错 |
| `system` | 运行器、监听口 | 建任务、启动、解散、结束 |
| `usage` | 记录器 | 一次模型调用的用量：模型、各类 token、费用（`costUsd`，没价格时 `null`）、来源（`dsh` 或 `cli`）、耗时、输出速度。API bot 每一轮一条；Coding bot 每个 Claude Code 回合里每个模型一条 |
| `ci` | 监控 | CI 步骤里的变化：失败、重跑、结论、通知主 bot（规格 7） |

这里代码自己前后不一致：记录器会写 `refusal` 和 `tool_error`，但 `src/task/contracts.ts` 的 `RECORD_TYPES`（现在含 `usage`、`ci`）里仍没有它们。未实现：把它们补进那张清单。

### 2.5 结束原因

| `endReason` | 任务的状态 | 由谁写 |
|---|---|---|
| `completed` | `done` | 步骤把关 |
| `completed_ci_failed`、`completed_ci_stopped`、`completed_no_ci` | `done` | 步骤把关（`done` 时按 `ci.outcome` 选，见规格 1 的 4.4）。`DONE_END_REASONS` 列出四个 `done` 的原因；这四个运行器都不再发“结束”通知，因为 Slack bot 已在流程里汇报 |
| `needs_info` | `needs_info` | 步骤把关 |
| `needs_person` | `failed` | 步骤把关 |
| 主 bot 给的说明文字 | `failed` | 步骤把关 |
| `step_timeout`、`stalled`、`idle_relay`、`engine_silent`、`start_failed`、`restart` | `failed` | 监控、运行器 |
| `task_timeout`、`coding_timeout` | `timed_out` | 监控 |
| `store_corrupt` | `failed` | 任务库 |
| `stopped` | `stopped` | 控制接口 |
| `queue_expired` | `expired` | 队列 |

## 3. 接口

### 3.1 任务库（I2）

文件：`src/task/store.ts`。

| 函数 | 作用 |
|---|---|
| `knownEvent(eventId)` | 这个事件是否已经建过任务；有则返回任务编号 |
| `createTask(origin, binding)` | 建任务，状态 `queued`，写入 `index.json` 的两张对应表 |
| `getTask(id)` | 读任务 |
| `findByThread(channel, threadTs)` | 这个讨论对应的任务，没有则返回空 |
| `patchTask(id, patch)` | 按字段合并写入，更新 `updatedAt` |
| `startRun(id, { groupId, bots })` | 追加一次运行，状态改为 `running`，步骤回到 `fetch`，按规格 1 的 4.5 清空该清空的字段（包括 `ci`） |
| `endRun(id, state, endReason)` | 给当前运行写结束时间和原因，改任务状态。状态要和结束原因相符（按 2.5 的表），不符就抛错；没给状态时由结束原因推出；表里没有的原因（主 bot 给的说明文字）只接受 `failed` |
| `addUsage(id, record)` | 把一条 `usage` 记录加进任务的 `usage` 汇总，排在该任务的写入队列里；任务不在时记日志并跳过，不中断任务 |
| `appendRecord(id, entry)` | 追加一条执行记录 |
| `readRecords(id, { step })` | 读执行记录，可按步骤过滤 |
| `listTasks({ state })` | 按状态列任务，按建立时间排序 |

依赖：只依赖文件系统。

### 3.2 记录器

文件：`src/task/recorder.ts`。对外只有 `start`、`stop`、`flush`（`flush` 给测试用）；`createRecorder` 另收一个 `pricing` 参数（配置里的价格行，叠在默认价格表上）；`start` 订阅下面的来源，把事件转成执行记录。

| 来源 | 通过门面的哪个订阅 | 产生的记录 |
|---|---|---|
| 群里的每一行 | `onGroupLine` | `line` 或 `notice` |
| 会话事件里的工具调用 | `onSessionEvent` | `tool_call` |
| 工具返回 | `onToolResult` | `tool_result` |
| 一轮结束 | `onRoundEnd` | `round_end`，并写 `stepResults` |
| 会话事件里 Claude Code 引擎的一行 | `onSessionEvent` | `refusal` 或 `tool_error` |
| 一次模型调用的用量 | `onUsage` | `usage`，并调 `store.addUsage`；费用按价格表算，Coding bot 以命令行自带的费用为准 |

记录器不订阅审批：审批由监控拒绝并自己写那一条 `approval`，再订阅就会写两遍（规格 3）。

步骤把关、监控、运行器、监听口直接调用 `appendRecord` 写自己的记录。

依赖：bot 层门面（I1，规格 5）；任务库；`botOfSession` 用来从会话反查任务和角色。

## 4. 行为规则

### 4.1 写入

- 写 `task.json` 和 `index.json` 时先写到临时文件再改名，保证读到的总是完整的文件。
- 同一个任务的写入排队执行，后一次写入基于前一次的结果。
- `records.jsonl` 只追加，不改写。
- 只应有一个进程写任务库。未实现：任务库没有锁，不阻止第二个进程。

### 4.2 每一步的结果

- 一个 bot 的一轮结束时，记录器查它的角色是不是当前步骤的负责角色。
- 是，就把这一轮的最终答复写到 `stepResults.<当前步骤>.<角色>`，同一步同一角色以最后一轮为准。
- 不是（例如 Git Pipeline bot 在步骤 `code` 里应答 `request_code`），只记 `round_end`，不写 `stepResults`。
- 失败的一轮（`round_end` 记录带 `failed: true`）或答复为空，也不写成结果，免得它凑成这一步的证据。
- 记录器通过扫描运行中的任务、比对各自最近一次运行的群编号，找到群所属的任务，并缓存。

### 4.3 对应关系

- 一个事件编号只对应一个任务。`knownEvent` 命中时，监听口不再建任务。
- 一个讨论只对应一个任务。状态是 `queued` 或 `running` 时不建新任务；状态是 `needs_info` 时在原任务上开始新的一次运行；其他已结束的状态下，新的 @ 建一个新任务并覆盖 `threads` 里的对应。

### 4.4 读取

- `task_read` 返回的是任务的一个子集：`id`、`state`、`step`、`origin.permalink`、`origin.text`、`stepResults`、`jira.key`、`jira.url`、`repo.dir`、`repo.branch`、`review`、`mr.url`、`ci`（`status`、`sha`、`round`、`pipelineUrl`、`failedJobs`、`logRead`、`settled`、`outcome`、`note`）、`needsInfo`。不含 `origin.text` 以外的原始事件字段，不含其他任务。
- `task_records` 返回本任务的执行记录。
- 控制接口返回完整的任务和记录。

### 4.5 出错

- 读到损坏的 `task.json`：坏文件留成 `task.json.broken-<时间>`，该任务换成一个空白任务，状态 `failed`，结束原因 `store_corrupt`（`origin` 和 `binding` 为 `null`，`runs` 为空），不影响其他任务。
- 损坏的 `index.json` 没有处理：打开任务库时抛错。未实现。
- 追加记录失败：记日志，不中断任务。

### 4.6 重启

任务库启动时不改任何任务。哪些任务要接着跑由运行器决定（规格 3）。

## 5. 代码参考

行号于 2026-11-11 核对。

| 位置 | 看什么 |
|---|---|
| `DSB:src/host/store.js:18` 起 | 状态文件的加载、保存和迁移的组织方式 |
| `DSB:src/host/home-lock.js` | 防止第二个进程写同一份状态的锁 |
| `DSB:src/host/groups.js:238`–`256` | `appendRoom` 把每一行交给订阅者；`onRoomLine` 的注册和取消。一行的字段有 `seq`、`who`、`botId`、`text`、`kind`、`reason` |
| `DSB:src/host/turns.js:627` | 会话事件的订阅：回合开始和结束、工具调用 |
| `DSB:src/host/turns.js:1096` | `tools/result` 的订阅，参数是执行信息和结果 |
| `DSB:src/host/approvals.js:15` | 审批事件的订阅 |
| `DSB:src/host/store.js:494` | 从会话反查是哪个 bot |
| `SA:src/core/tickets.ts:29` | 工单的状态和规则怎么组织 |
| `SA:docs/001-domain.md` | 工单、派工、输入的关系 |

## 6. 实现清单

B1：

- [ ] 目录和三个文件的形状如第 2 节。
- [ ] `createTask` 分配序号，写 `events` 和 `threads` 两张对应表。
- [ ] `patchTask` 按字段合并，不整体覆盖。
- [ ] `startRun` 做清空和保留。
- [ ] `endRun` 按 2.5 的表写状态和结束原因。
- [ ] 临时文件加改名的写法；同一任务的写入排队。
- [ ] `readRecords` 支持按步骤过滤。
- [ ] 损坏文件的处理。`task.json` 已做；`index.json` 未实现。

B6：

- [ ] 订阅 3.2 的来源（群里的行、会话事件、工具返回、一轮结束），按 2.4 的类型表生成记录。
- [ ] `text` 截断到 2000 个字符。
- [ ] 一轮结束时按 4.2 写 `stepResults`。
- [ ] `onUsage` 写 `usage` 记录并调 `store.addUsage`。
- [ ] 用 `botOfSession` 找不到任务的事件直接丢弃（不属于任何任务的会话）。

## 7. 验收

- 进程重启后，任务、运行、执行记录都还在，内容不变。
- 同一个事件提交两次，只有一个任务。
- 一次运行结束后，`records.jsonl` 里能读出每一步由哪个 bot 做、调了哪些工具、各自的结果和耗时。
- Slack bot 的一轮结束后，`task_read` 能读到 `stepResults.fetch.slack.text`；Jira bot 不看群记录也能拿到摘要。
- `task_read` 的返回里搜不到任何凭证。
