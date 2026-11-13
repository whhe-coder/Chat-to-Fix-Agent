# 细分规格 1：注册表和流程层

- 日期：2026-11-11
- 覆盖的工作包：D0（bot 注册表和流程定义）、B3（步骤把关）、C1（任务工具）。
- 上位文档：[software-spec.zh.md](software-spec.zh.md) 3.2、5.2、6；[implementation-guide.zh.md](implementation-guide.zh.md)。
- 本文定下的名字（角色标识、步骤标识、任务字段名）在其余五份细分规格里通用。
- 状态：2026-11-12 按代码（提交 192a721）更新。最初是 2026-11-11 开工前的设计；和原设计不同的地方已直接改成现状，代码还没做到的标“未实现”。
- 流程是八步：CI 修复循环（提交 192a721）在“开 MR”和“回写”之间加了第 6 步“CI”。本文只写它在流程表、门禁和任务工具上的改动；循环本身（等 pipeline、轮次、三个新工具、结束原因的来历）见 [spec-7-ci-loop.zh.md](spec-7-ci-loop.zh.md)。

## 1. 范围

管：五个 bot 的定义；八步的步骤表；每一步的完成证据；推进、结束、写工具放行的规则；六个任务工具。

不管：任务怎么存（规格 2）；谁来启动和监控（规格 3）；工具怎么挂到会话上、Slack、Jira、GitLab 的工具本身（规格 4）；bot 层的搬运（规格 5）；提示词的内容（规格 6）。

## 2. 数据形状

### 2.1 角色标识

五个 bot 各有一个固定的角色标识，全工程通用：

| 角色标识 | bot | 对应的服务 |
|---|---|---|
| `main` | 主 bot | 任务的流程和状态 |
| `slack` | Slack bot | Slack |
| `jira` | Jira bot | Jira |
| `pipeline` | Git Pipeline bot | GitLab |
| `coding` | coding bot | Claude Code |

### 2.2 bot 注册表

文件：`src/registry/bots.ts`。每个 bot 一条。前五个字段是 DS Bot 原有的 bot 字段，`tools` 是新增的。

| 字段 | 含义 | 来源 |
|---|---|---|
| `role` | 角色标识 | 新增，仅用于在注册表里定位 |
| `name` | 名字的前缀；建 bot 时拼上任务序号，例如 `Coding-12` | DS Bot 的 `name`，最长 40 个字符，全队唯一 |
| `label` | 角色标签 | DS Bot 的 `role`，最长 24 个字符 |
| `instructions` | 说明所在的文件 | DS Bot 的 `instructions` |
| `model` | 模型线路 | DS Bot 的 `model` |
| `permission` | 权限预设 | DS Bot 的 `permission` |
| `tools` | 这个 bot 独有的工具名 | 新增 |

五条定义。`model` 和 `permission` 存的是字面值或配置项的名字；`CONFIG_KEYS` 列出这些配置项（`apiModel`、`codingModel`、`codingPermission`），`CONFIG_DEFAULTS` 给默认值（`codingModel` = `claude-code/default`，`codingPermission` = `workspace-write`）。下表写的是配置项名，由 bot 层去解析。

| `role` | `name` | `label` | `model` | `permission` | `tools` |
|---|---|---|---|---|---|
| `main` | `Main` | Flow | 配置项 `apiModel` | `read-only` | `task_records`、`task_advance`、`task_close`、`needs_info_confirm` |
| `slack` | `Slack` | Slack | 配置项 `apiModel` | `read-only` | `slack_read_thread`、`slack_reply` |
| `jira` | `Jira` | Jira | 配置项 `apiModel` | `read-only` | `jira_assess_request`、`jira_create_issue`、`jira_get_issue`、`jira_add_comment`、`jira_transition`、`needs_info_confirm` |
| `pipeline` | `Pipeline` | GitLab | 配置项 `apiModel` | `read-only` | `repo_prepare`、`repo_diff`、`repo_read_file`、`repo_log`、`mr_open_draft`、`mr_get`、`ci_read_log`、`mr_push_fix`、`ci_stop` |
| `coding` | `Coding` | Claude Code | 配置项 `codingModel`，默认 `claude-code/default` | 配置项 `codingPermission`，默认 `workspace-write` | `request_code`、`review_report`、`needs_info_confirm` |

所有 bot 共有的工具不写在 `tools` 里：`task_read`，以及 DS Bot 的团队工具（`list_bots`、`message_bot`、`post_to_group`、`read_group_chat`、`read_own_chat`）。`stop_bot` 只有群管理员能用。

coding bot 的定义另带一项 `reviewer`，是审查子 agent 的定义：名字 `reviewer`、说明所在的文件、只读工具（读和搜索）。它不是注册的 bot。

### 2.3 流程定义

文件：`src/flow/steps.ts`。每一步一条。

| 字段 | 含义 |
|---|---|
| `no` | 序号，1 到 8 |
| `id` | 步骤标识 |
| `roles` | 负责的角色 |
| `evidence` | 完成证据，全部满足才算完成 |
| `writeTools` | 这一步允许调用的写工具 |

八条定义。证据里的字段名是任务上的字段，形状见规格 2。

| `no` | `id` | 名称 | `roles` | `evidence` | `writeTools` |
|---|---|---|---|---|---|
| 1 | `fetch` | 取讨论 | `slack` | `slack.readAt` 有值；`slack.sent.ack` 为真；`stepResults.fetch` 有值 | `slack_reply`（用途 `ack`） |
| 2 | `issue` | 判断并建单 | `jira` | `jira.key` 有值 | `jira_assess_request`、`jira_create_issue` |
| 3 | `prepare` | 备代码 | `pipeline` | `repo.dir`、`repo.branch`、`repo.base` 都有值 | `repo_prepare` |
| 4 | `code` | 编码 | `coding` | 代码目录相对 `repo.base` 有改动；`review.verdict` 为 `pass` | `review_report` |
| 5 | `mr` | 开 MR | `pipeline` | `mr.url` 有值 | `mr_open_draft` |
| 6 | `ci` | CI | `pipeline`、`coding` | `ci.settled` 为真 | `mr_push_fix`、`review_report`、`ci_stop` |
| 7 | `writeback` | 回写 | `jira`、`slack` | `jira.commentedMr` 为真；`slack.sent.result` 为真 | `jira_add_comment`、`jira_transition`、`slack_reply`（用途 `result`） |
| 8 | `close` | 收尾 | `main` | 任务已结束 | 无 |

第 6 步 `ci` 由 Git Pipeline bot 主导，Coding bot 被它叫来修；`ci.settled` 由监控和三个 CI 工具写，细节见规格 7。

`stepResults.<步骤标识>` 是该步负责的 bot 在这一步里最后一轮的最终答复，由系统记下（规格 2）。第 1 步的摘要就是 `stepResults.fetch`。

一个写工具可以属于多个步骤：`review_report` 在 `code` 和 `ci` 都能调（`stepsOfWriteTool` 返回所有列了它的步骤；`stepOfWriteTool` 只返回第一个，门禁不再用它判断步骤）。`writeTools` 里的一项是 `工具名` 或 `工具名:用途`（`slack_reply:ack`）。证据是一个短字符串，由步骤把关里的同一个求值函数判断：`<路径>`（该字段有值或为真）、`<路径> == <文本>`、`diff`（代码目录相对 `repo.base` 有改动）、`diff.withinLimits`（改动在 `diffMaxFiles` 和 `diffMaxLines` 之内）、`ended`（任务状态不再是 `queued` 或 `running`）。结束的规则、工具的附加证据、不绑定步骤的写工具也是 `steps.ts` 里的数据（`OUTCOME_RULES`、`CI_END_REASONS`、`TOOL_EXTRA_EVIDENCE`、`UNBOUND_WRITE_TOOLS`），不是步骤把关里的代码。

不绑定步骤的写工具：

| 工具 | 什么时候可以调 |
|---|---|
| `needs_info_confirm` | 任何步骤 |
| `slack_reply`（用途 `question`） | `needsInfo.main` 和当前步骤的确认方都有值之后；`issue` 步骤由 `jira` 确认，其余步骤由 `coding` 确认 |
| `task_advance`、`task_close` | 任何步骤，条件见第 4 节 |

## 3. 接口

步骤把关对外提供四个函数（I3），文件 `src/task/gate.ts`：

| 函数 | 作用 | 返回 |
|---|---|---|
| `advance(taskId, toStep)` | 把任务推进到 `toStep` | `{ ok: true }`，或 `{ ok: false, missing, reason }`（`missing` 是缺少的证据列表；步骤不对时给 `reason`） |
| `allow(taskId, toolName, purpose)` | 一个写工具现在能不能调 | `{ ok: true }`，或 `{ ok: false, reason }` |
| `confirmNeedsInfo(taskId, role, text)` | 记下一方对“信息不足”的确认 | `{ other }`：另一方是否已确认；`issue` 步骤只接受 `main`、`jira`，其余步骤只接受 `main`、`coding` |
| `close(taskId, outcome, note)` | 结束任务 | `{ ok: true }`，或 `{ ok: false, reason }` |

依赖：任务库（I2，规格 2）读写任务；代码仓库适配器的 `diff`（I5，规格 4）判断有没有改动；流程定义（本文 2.3）。

步骤把关不依赖 bot 层。接口 I1 到 I7 的常量和类型定义在 `src/task/contracts.ts`。

## 4. 行为规则

### 4.1 推进

- `toStep` 必须是当前步骤的下一步。跳步、回退、原地不动都拒绝。
- 当前步骤的证据必须全部满足。不满足时返回缺哪几项，任务停在原步骤。
- 推进成功后，把当前步骤改为 `toStep`，并记一条执行记录。
- 一次运行开始时，当前步骤是 `fetch`。

### 4.2 写工具放行

- 任务的当前步骤是 2.3 的 `writeTools` 里列了这个工具的步骤之一，才放行；拒绝的原因会列出工具所属的全部步骤。
- `mr_open_draft` 和 `mr_push_fix` 另外要求 `review.verdict` 为 `pass`，并且改动规模不超过上限（[tools-and-limits.zh.md](tools-and-limits.zh.md) 第 4 节）。超过上限时拒绝，原因写“改动超过规模上限”。`mr_push_fix` 的其他条件见规格 7。
- 不是已知写工具的，拒绝。
- 读工具不经过放行。
- 拒绝时把原因作为工具的错误结果返回给 bot，并记一条执行记录。

### 4.3 信息不足

- `issue` 步骤由 `jira` 和 `main` 确认信息不足；其余步骤由 `coding` 和 `main` 确认。其他角色：记一条拒绝的执行记录并抛错。
- 两条都有之后，`slack_reply`（用途 `question`）才放行。
- 新的一次运行开始时清空 `needsInfo`。
- Jira bot 使用模型判断讨论能否支持具体问题与可检查的结果；`jira_assess_request` 登记模型的肯定判断。它通过前不得调用 `jira_create_issue`。只有问候或测试字样的请求不能通过判断；信息不足时先追问，不产生 Jira 单。

### 4.4 结束

`close` 的 `outcome` 有四种。`done` 的结束原因由 `closeEndReason` 按 `task.ci.outcome` 选（`CI_END_REASONS`）：

| `outcome` | 条件 | 任务的状态 | 结束原因 |
|---|---|---|---|
| `done` | 当前步骤是 `close` | `done` | `completed`；CI 没过时是 `completed_ci_failed`（修满轮数仍失败）、`completed_ci_stopped`（`ci_stop` 或分支被别人改了）、`completed_no_ci`（没有 pipeline） |
| `needs_info` | `needsInfo.main` 与当前步骤的确认方都有值；`slack.sent.question` 为真 | `needs_info` | `needs_info` |
| `failed` | `note` 不为空 | `failed` | `note` 的内容 |
| `needs_person` | `note` 不为空 | `failed` | `needs_person` |

`close` 还会拒绝未知的 `outcome` 和已经结束的任务。条件不满足时拒绝并说明原因。成功后用 `patchTask` 写状态和结束原因，再调用 `onClosed`（在 `src/app.ts` 里接到运行器的 `end`），由它结束这次运行并解散群（规格 3）。

### 4.5 重跑

同一个任务开始新的一次运行时：当前步骤回到 `fetch`；`needsInfo`、`review`、`stepResults` 清空，`slack.readAt`、`slack.sent.question`、`slack.sent.result` 也清空（讨论要重新读，新的一次运行重新提问、重新汇报）；`jira`、`repo`、`mr`、`slack.sent.ack` 保留。`ci` 也清空：新的一次运行重新等 CI，上一次已结论的 `ci` 不能算这一步的证据。因为对应的写工具重复调用时返回已有结果，重跑不会重复建单、重复建目录、重复回复“已收到”。

## 5. 任务工具

文件：`src/tools/task.ts`。六个。工具怎么挂到会话上见规格 4。

| 工具 | 谁有 | 参数 | 做什么 | 返回 |
|---|---|---|---|---|
| `task_read` | 所有 bot | 无 | 读本任务 | 任务编号、状态、Slack 讨论的链接和原始消息文本（`origin.text`）、当前步骤、摘要、Jira 单号和链接、代码目录和分支、审查结论、MR 链接、CI 状态（状态、轮次、失败的 job、结论）、各步的结果 |
| `task_records` | `main` | `step`（可选） | 读执行记录 | 以文本行返回记录，可按步骤过滤；只显示最新的 200 条，每行截到 300 个字符 |
| `task_advance` | `main` | `to` | 调用 `advance` | 成功，或缺少的证据 |
| `task_close` | `main` | `outcome`、`note` | 调用 `close` | 成功，或拒绝的原因 |
| `needs_info_confirm` | `main`、`jira`、`coding`；按步骤限制 | `text` | 调用 `confirmNeedsInfo` | 已记下；另一方是否已确认 |
| `review_report` | `coding` | `verdict`（`pass`、`fail` 或 `cannot_fix`）、`comments`、`rounds` | 把审查结论写到任务的 `review` 上 | 已记下 |

规则：

- `task_read` 不返回令牌、不返回其他任务的内容。
- `review_report` 是写工具，在步骤 `code` 和 `ci` 放行（在 `ci` 里登记这一轮修复的审查）。`cannot_fix` 只能在 `ci` 用，别的步骤调用会报错；它表示 CI 失败修不了，`comments` 要写原因。重复调用时以最后一次为准。
- `rounds` 超过 3 时仍然记下。未实现：监控没有审查轮数上限的处理（配置里有 `reviewMaxRounds`，但没有代码读它）。

## 6. 代码参考

行号于 2026-11-11 核对。前缀含义见实现指南第 1 节。

| 位置 | 看什么 |
|---|---|
| `DSB:src/host/roster.js:140` | `createBot`：名字截到 40 个字符，重名时报错 |
| `DSB:src/host/roster.js:148` | `buildBot` 的参数：`role`、`instructions`、`model`、`effort`、`workDir`、`pickModel` 等 |
| `DSB:src/host/roster.js:316` | `updateBot(id, patch, …)`：建好后设模型、权限、工作目录 |
| `DSB:src/host/tools.js:823` | DS Bot 把同一套团队工具注册给每个 bot 会话；按 bot 分配是新增的 |
| `DSB:src/host/local-agents/engines.js:55` | 权限预设到 Claude Code 模式的对应：`read-only`、`workspace-write`、`danger-full-access` |
| `SA:src/core/stage.ts` | 用一张表从上到下判断状态的写法 |
| `SA:cordis.patch.yml:23`、`:128` | 用配置定义两个固定角色及其工具集的例子 |

## 7. 实现清单

除第 5 节的审查轮数上限外，下面各项都已实现；复选框保持原样。

D0：

- [ ] `src/registry/bots.ts` 导出五条 bot 定义，字段和值如 2.2。
- [ ] coding 的定义带 `reviewer`。
- [ ] `src/flow/steps.ts` 导出八条步骤定义和不绑定步骤的写工具表，如 2.3。
- [ ] 提供按角色标识取 bot 定义、按步骤标识取步骤定义、按工具名取所属步骤的查询函数。
- [ ] 启动时校验：角色标识不重复；步骤序号连续；`writeTools` 里的每个工具都出现在某个 bot 的工具清单里。代码还检查：名字不超过 40 个字符且不重名，标签不超过 24 个字符，各字段齐全，`coding` 带 `reviewer`，每步负责的角色都在注册表里。

B3：

- [ ] `advance`：只允许进到下一步；证据不足时返回缺少的项。
- [ ] 证据判断按 2.3 的表实现，`code` 步骤调用适配器的 `diff`。
- [ ] `allow`：当前步骤是工具所属的步骤之一就放行；`mr_open_draft`、`mr_push_fix` 的两条附加条件。
- [ ] `confirmNeedsInfo`：只接受两个角色。
- [ ] `close`：四种 `outcome` 的条件和状态映射；`done` 的结束原因按 `ci.outcome` 选。
- [ ] 重跑时的清空和保留，如 4.5。
- [ ] 每次推进、拒绝、结束都记一条执行记录。

C1：

- [ ] 六个任务工具，参数、返回和归属如第 5 节。
- [ ] `task_read` 的返回里不含凭证和其他任务。
- [ ] `review_report` 走 `allow`。

## 8. 验收

- 加一个 bot 只改 `bots.ts`；调换两步或换一步的负责角色只改 `steps.ts`；两种改动之后其他文件不用动，测试仍然通过。
- 证据不全时 `task_advance` 被拒绝，返回的列表准确指出缺哪一项。
- 在步骤 `fetch` 调用 `mr_open_draft` 被拒绝；在步骤 `mr` 且 `review.verdict` 不是 `pass` 时也被拒绝。
- 只有一方确认信息不足时，`task_close(needs_info)` 被拒绝。
- 重跑一个已有 Jira 单的任务，不产生第二张单。
