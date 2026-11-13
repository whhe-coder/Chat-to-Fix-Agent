# 自动修复 Bot：工具清单与运行上限初值

- 日期：2026-11-11
- 前提：软件是什么见 [software-spec.md](software-spec.md)。
- 状态：2026-11-12 按代码（提交 192a721）更新。最初是 2026-11-11 开工前的设计；和原设计不同的地方已直接改成现状，代码还没做到的标“未实现”。
- 上限的数值是初值，没有经过运行校准；第 5 节写了校准办法。每个任务的 token 和费用统计已提交（31b386d），见规格 3 第 3.1 节；价格表可用配置键 `pricing` 覆盖。

## 1. 设计理念

1. **一个群一个主 bot，各司其职。** 每个任务一个群，群里是主 bot、Slack bot、Jira bot、Git Pipeline bot、coding bot。
2. **一个 bot 对应一个服务。** Slack bot 对 Slack，Jira bot 对 Jira，Git Pipeline bot 对 GitLab，coding bot 对 Claude Code，主 bot 对任务的流程和状态。所有 bot 用同一种方式注册；谁先谁后由流程定义决定，和 bot 的定义分开。
3. **编码和审查是一个 bot 的两面。** 审查由 coding bot 内部的子 agent 完成，返工不出 Claude Code 的对话。
4. **一轮结束再转交，转交走存储。** bot 做完自己这一轮，最终答复交回主 bot，由主 bot 叫下一步。上一步的结果写在任务上，下一个 bot 从任务里读。
5. **执行记录对主 bot 开放。** 系统把每一步记到任务上，主 bot 可以读全部记录。
6. **状态由系统管。** 群和成员由系统建；步骤的推进由代码检查条件；审批由任务层统一处理。

工具的实现约定：

- 能由任务确定的参数（哪个讨论、哪个 Jira 单、哪个分支）由工具从任务里取，bot 不填。
- 令牌只在工具内部使用。
- 写操作重复调用时返回已有的结果，不重复建单或开 MR。
- 访问 Slack、Jira、GitLab 的工具通过适配器进行。每个适配器有假的和真的两种实现，先用假的。
- 我们新加的工具都不在 DS Bot 的团队工具名单里，所以 bot 调用过它们，这一轮就算“干了活”，一轮结束时主 bot 会被自动唤醒。

## 2. 工具清单

### 2.1 所有 bot 共有

| 工具 | 参数 | 做什么 | 读或写 |
|---|---|---|---|
| `task_read` | 无 | 返回本任务：Slack 讨论的链接和摘要、当前步骤、Jira 单号、分支、审查结论、MR 链接、各步的结果 | 读 |

群里发言、读群记录、读自己的历史对话沿用 DS Bot 现成的工具（`post_to_group`、`read_group_chat`、`read_own_chat`、`list_bots`）。

每个 bot 一轮结束时的最终答复由系统记到任务上，不需要 bot 另外调用工具。

### 2.2 主 bot

群和成员由系统按固定名单建好，主 bot 没有建群的工具。

| 工具 | 参数 | 做什么 | 把关 |
|---|---|---|---|
| `task_records` | 可选的步骤 | 读本任务的执行记录：每一步由哪个 bot 做、调用了哪些工具、结果、耗时 | 只有主 bot 有 |
| `task_advance` | 目标步骤 | 把任务推进到下一步 | 上一步的完成证据齐全（软件说明 5.2） |
| `task_close` | 结果（完成、待补充信息、失败、需要人工处理）；说明 | 结束任务；系统随后解散群和成员。“需要人工处理”存为状态 `failed`、结束原因 `needs_person`；“失败”把说明存为结束原因 | “完成”要求任务在 `close` 步；“待补充信息”要求任务上已有主 bot 和 coding bot 两方的确认，并且追问已发到 Slack；“失败”和“需要人工处理”要求有说明 |
| `needs_info_confirm` | 要追问的问题 | 记下主 bot 对“信息不足”的确认 | 无 |
| `stop_bot`（DS Bot 现成） | bot 名 | 停掉某个成员正在跑的回合 | 只有主 bot 有 |

### 2.3 Slack bot

| 工具 | 参数 | 做什么 | 读或写 |
|---|---|---|---|
| `slack_read_thread` | 无 | 读本任务所在讨论的全部消息：发言人、时间、文字、附件名和链接 | 读 |
| `slack_reply` | 用途（已收到、追问、结果）；文字 | 在本任务所在的讨论里回复。每种用途在一个任务里只发一次；文字有长度上限 | 写 |

Slack bot 只能读写本任务的那一个讨论，不能读其他频道。

### 2.4 Jira bot

| 工具 | 参数 | 做什么 | 读或写 |
|---|---|---|---|
| `jira_create_issue` | 标题；描述；验收条件 | 在频道绑定的 Jira 项目里建单，类型和标签固定；把单号写进任务。任务已有单号时直接返回它 | 写 |
| `jira_get_issue` | 无 | 读本任务的 Jira 单 | 读 |
| `jira_add_comment` | 文字 | 在本任务的 Jira 单上加评论 | 写 |
| `jira_transition` | 目标状态 | 把本任务的 Jira 单改到允许的几个状态之一 | 写 |

Jira bot 只能读写本任务的那一张单。

### 2.5 Git Pipeline bot

| 工具 | 参数 | 做什么 | 读或写 |
|---|---|---|---|
| `repo_prepare` | 无 | 更新仓库，为本任务建独立的代码目录和分支 `ai/<Jira 单号>`，返回目录和基准提交。同时把这个目录设为只给 coding bot 的工作目录 | 写本地 |
| `repo_diff` | 无 | 返回本任务代码目录相对基准提交的改动：文件列表、增删行数、补丁（过长时截断） | 读 |
| `repo_read_file` | 路径；可选的提交或分支 | 读仓库里的一个文件 | 读 |
| `repo_log` | 可选的路径；条数 | 读提交历史 | 读 |
| `mr_open_draft` | 标题；描述；可选的 `commit_message` | 把本任务目录里的改动提交成一个 commit，推分支，开 Draft MR；该分支已有 MR 时再追加一个 commit（不修订已有提交）、再推，并返回同一个 MR。`commit_message` 是一行 Conventional Commit（`type(scope): summary`，最多 100 个字符，没有正文）；不给就是 `fix: <标题>`。标题和描述里都没有 Jira 单号时，工具在描述末尾加 `Jira: <单号>` | 写 |
| `mr_get` | 无 | 读本任务 MR 的状态和流水线状态 | 读 |
| `ci_read_log` | 失败的 job（编号或名字） | 读 CI 失败 job 日志的末尾（最多 `ciLogMaxChars` 字符），作为材料返回；读过日志是 `ci_stop` 的前提。只在 CI 失败时可用 | 读 |
| `mr_push_fix` | `commit_message` | CI 某一轮的修复：把目录里的改动提交成一个新 commit，普通推送到任务分支（不强推）。要求：CI 已失败、轮数没到 `ciMaxRounds`、审查通过、改动规模没超限。分支上被别人推过提交时推送被拒，不拉取不覆盖，CI 循环以 `branch_changed` 结束 | 写 |
| `ci_stop` | 原因（`not_locatable`、`out_of_scope`、`not_fixable`）；说明 | 停止 CI 修复循环并记原因。要求本轮读过日志；`not_fixable` 还要求 Coding bot 在本轮记过审查结论 `cannot_fix` | 写 |

CI 步骤由 Git Pipeline bot 负责，流程见 [spec-7-ci-loop.md](spec-7-ci-loop.md)。

`mr_open_draft` 在执行前由代码检查：任务在 `mr` 步；任务上记有“审查通过”；改动规模没有超过第 4 节的上限。“有没有改动”不在这里检查，而是之后由仓库适配器在提交时拒绝（错误 `nothing_to_commit`）。因规模被拒不会让任务自己结束；系统要求主 bot 把任务以“需要人工处理”关闭（见第 4 节）。它不能合并、批准或关闭 MR。

### 2.6 coding bot

coding bot 是纯转发，Claude Code 在本任务的代码目录里用它自己的读、搜索、改文件能力。通过 DS Bot 的本机 MCP 桥递给它的工具（Claude Code 能运行的命令是频道的 `testCommands`；频道的 `setupCommands` 会从配置里读出，但没有任何代码去运行它：未实现）：

| 工具 | 参数 | 做什么 |
|---|---|---|
| `task_read` | 无 | 同 2.1 |
| `request_code` | 要什么（例如另一个分支上的某个文件、某段历史） | 私下向 Git Pipeline bot 要代码，结果回到 coding bot。只在 `code` 和 `ci` 步可用 |
| `review_report` | 结论（通过、不通过；`cannot_fix` 只在 `ci` 步可用）；审查意见；轮数 | 把内部审查的结论记到任务上。`code` 和 `ci` 步可用；在 `ci` 步记的是本轮修复的审查，`cannot_fix` 表示这次 CI 失败修不了 |
| `needs_info_confirm` | 缺什么信息 | 记下 coding bot 对“信息不足”的确认 |

`request_code` 是新工具，不用 DS Bot 现成的 `message_bot`：`message_bot` 在团队工具名单里，调用它不算干了活。

审查子 agent 不是工具，是 Claude Code 自带的子 agent。系统在启动 Claude Code 时传入它的说明，并只给它读和搜索的工具。

### 2.7 不给任何 bot 的能力

- 合并、批准、关闭 MR；改分支保护；删分支。
- 读写本任务之外的 Slack 讨论、Jira 单、代码目录。
- 建 bot、改 bot、删 bot、建群、删群（DS Bot 的 `create_bot`、`update_bot`、`create_group`、`delete_group` 不搬）。
- 走 API 的四个 bot 没有写文件、命令行、网页搜索和抓取工具。

推送不再是强制推送：分支只增不改，每次都是新 commit 加普通推送（`src/adapters/git.ts`、`src/adapters/repo.ts` 的 `openDraftMR` 不再修订提交）。远端比本地新时推送失败（`push_rejected`），不拉取不覆盖。不碰默认分支。

新增工具共 22 个（`src/tools/index.ts` 注册，按 `src/registry/bots.ts` 分给各角色；`task_read`、`needs_info_confirm` 两个由多个 bot 共用，各算一个）。其中写操作 12 个：6 个写外部系统（`slack_reply`、`jira_create_issue`、`jira_add_comment`、`jira_transition`、`mr_open_draft`、`mr_push_fix`），1 个写本地代码目录（`repo_prepare`），5 个写任务（`review_report`、`task_advance`、`task_close`、`needs_info_confirm`、`ci_stop`）。每个写工具执行前都要过步骤检查；一个写工具可以属于多个步骤（`review_report` 在 `code` 和 `ci`），任一个匹配即可。

## 3. 每个群的成员

每个任务的群有五个成员：主 bot、Slack bot、Jira bot、Git Pipeline bot、coding bot。五个都由系统在任务开始时新建，任务结束后删除。主 bot 是这个群的管理员，不跨群。系统每建好一个 bot，就把它和任务、角色绑定起来（只存在内存里）；角色的工具通过这个绑定挂上去。四个走 API 的 bot 用 DSH 的 `readonly` 预设，coding bot 用 `standard`。

## 4. 运行上限初值

| 项 | 初值 | 触发后 | 依据 |
|---|---|---|---|
| 任务总时限 | 80 分钟 | 停止整群，任务记为超时，系统在原讨论说明 | 估算：各步时限之和 70 分钟，加余量 |
| 取讨论、建单、回写，每步时限 | 5 分钟 | 催一次；再过 5 分钟则任务失败 | 估算：各是几次接口调用 |
| 拉代码时限 | 10 分钟 | 催一次；再过 10 分钟则任务失败 | dsh-superagent 的工单目录准备命令时限是 10 分钟 |
| 编码（含内部审查）时限 | 40 分钟 | 不催：停止 coding bot，任务立刻记为超时 | dsh-superagent 对一次回合后的后台工作时限是 30 分钟；加上审查的时间，估算 |
| 开 MR 时限 | 5 分钟 | 催一次；再过 5 分钟则任务失败 | 估算 |
| CI 一轮修复时限（`stepMinutes.ci`） | 30 分钟，从该轮失败时算起 | 催 Git Pipeline bot 一次；再过 30 分钟则任务失败。等 pipeline 期间不计，也跳过“群安静”检查 | 估算 |
| CI 修复轮数（`ciMaxRounds`） | 3 | 修满仍失败则定案为 `rounds_exhausted`，任务完成但写明 CI 未通过（结束原因 `completed_ci_failed`） | 公司要求最多 3 轮 |
| 等 pipeline（`ciWaitMinutes`、`ciTotalMinutes`、`ciPollSeconds`） | 对同一提交最多 30 分钟；各轮合计最多 90 分钟；每 15 秒查一次 | 没触发或超时则定案为 `no_pipeline`（结束原因 `completed_no_ci`）。等待时间不算进任务总时限 | 估算 |
| CI 日志长度（`ciLogMaxChars`） | 12000 字符 | `ci_read_log` 只返回日志末尾这么多 | 估算 |
| 第 8 步 `close` | 无 | 只受任务总时限约束 | 没有自己的时限 |
| coding bot 内部的修改和审查 | 最多 3 轮 | coding bot 报告审查未通过，主 bot 把任务以失败关闭，保留分支 | 现有 Rovo 修复 Agent V13 每次调用最多三次修复提交。这一项只写在 coding bot 的说明里，配置键 `reviewMaxRounds` 有但没有任何代码读它。系统用编码时限兜底 |
| 群内成员无回复 | 240 秒 | 该成员记为错过，主 bot 继续 | DS Bot 的 `ROOM_REPLY_TIMEOUT_MS`；是 DS Bot 里的常量，不是配置键 |
| Claude Code 无任何输出 | 10 分钟 | 中断，并让主 bot 重新叫 coding bot，只一次；再发生则任务失败 | 估算 |
| 群安静而任务未结束 | 3 分钟 | 看门狗给主 bot 补一条消息；最多 2 次，第 3 次任务失败 | 次数取自 DS Bot 目标功能的 `GOAL_IDLE_NUDGES = 2`；时长是估算 |
| bot 之间连续空转 | 6 次 | 群暂停，看门狗记为卡住并结束任务 | DS Bot 的 `ROOM_IDLE_RELAY_LIMIT`；是 DS Bot 里的常量，不是配置键。看门狗靠正则匹配 DS Bot 那条通知的英文原文来识别暂停 |
| Claude Code 单次运行的回合数 | 200（`engineMaxTurns`） | 作为 `--max-turns` 传给 Claude Code，它自己停下；代码里没有专门的处理 | 估算；作为时限之外的第二道保险 |
| 模型或网络的瞬时失败 | 重试 3 次，间隔 15、30、60 秒 | 未实现：代码里没有这种重试 | dsh-superagent 对失败回合的续跑间隔 |
| 外部接口调用 | 每次 30 秒超时（`toolTimeoutSeconds`），重试 2 次（`toolRetries`），间隔 250 毫秒，只重试标为可重试的错误 | 工具返回错误，由 bot 决定受阻或再试 | 估算 |
| 改动规模（`diffMaxFiles`、`diffMaxLines`） | 20 个文件或 500 行 | `mr_open_draft` 被拒，不开 MR；主 bot 随后把任务以“需要人工处理”关闭（状态 `failed`、结束原因 `needs_person`），保留分支，原讨论收到“未能完成”的通知 | 估算；dsh-superagent 自动合并的门槛是 200 行，这里只是开 Draft MR，放宽 |
| 同时运行的任务 | 1 | 其余排队 | 用户，2026-11-11 |
| 队列长度 | 20 | 新任务被拒，系统在原讨论说明 | 估算 |
| 排队等待 | 4 小时 | 任务过期，系统在原讨论说明。只在队列分派时检查（没有定时器），所以通知最多可能晚一次运行 | 估算 |
| 同一讨论重复 @ | 上一个任务未结束时不建新任务 | 回复“正在处理” | 估算 |

所有上限都是配置的 `limits.*` 下的配置项，只有上面两个 DS Bot 常量（240 秒、6 次空转）、三轮修改审查（只写在 coding bot 的说明里）和瞬时失败的重试（未实现）例外。代码表里没有的键会被悄悄忽略。上表没有对应行的键有两个（`ciPollSeconds` 等 CI 键在上表合并成几行）：`replyMaxChars`（Slack 回复的长度上限，600）和 `worktreeKeepDays`（代码目录保留天数，7；每天一次的清理未实现：`runner.cleanupWorktrees()` 有，但没有任何代码调用）。任何一项触发都会写进任务的执行记录，说明是哪一项、当时在第几步。每条属于某个任务的系统通知也会作为 `system` 类型写进该任务的记录（“队列已满”和“频道未绑定”没有任务，不记录）。通知和催促消息只有英文，即使配置的 `language` 是 `zh`；唯一的例外是发到原讨论的 CI 进度通知，它跟 `language`（见规格 3 第 4.6 节）。

手工停止：提供一个入口，按任务编号停止整群并把任务记为“人工停止”。

## 5. 校准办法

跑 5 到 10 张历史工单时，记录每一步的实际耗时、Claude Code 的回合数、内部审查的轮数、改动的文件数和行数。每项上限取实测最大值的 2 倍左右，再向上取整。编码时限和任务总时限按这个办法重定一次。
