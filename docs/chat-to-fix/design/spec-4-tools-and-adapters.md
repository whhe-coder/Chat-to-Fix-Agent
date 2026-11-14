# 细分规格 4：工具和适配器

- 日期：2026-11-11
- 覆盖的工作包：C0（工具注册框架）、C2（Slack）、C3（Jira）、C4（代码仓库）、C5（`request_code`）、E1（假适配器和端到端测试台）、R1（真实适配器和 Slack 转发器）。
- 上位文档：[tools-and-limits.md](tools-and-limits.md) 第 2 节；[software-spec.md](software-spec.md) 5.6、7.5。
- 角色标识、步骤、放行规则见规格 1；任务字段见规格 2；bot 层门面见规格 5。任务工具（`task_read` 等六个）在规格 1 第 5 节。加上本规格的十六个工具（含 CI 的三个），注册表里共定义 25 个工具。
- 状态：2026-11-12 按代码（提交 192a721）更新。最初是 2026-11-11 开工前的设计；和原设计不同的地方已直接改成现状，代码还没做到的标“未实现”。
- 2026-11-12 起入口改为 Slack 斜杠命令 `/fix`（已实现）：见第 2.2 节的 `startThread` 和第 4.9 节。
- CI 修复循环（流程第 6 步 `ci`，由 Git Pipeline bot 负责）的细节在 [spec-7-ci-loop.md](spec-7-ci-loop.md)；本文只写它在工具和适配器上的部分（4.5、4.7、4.9）。

## 1. 范围

管：工具怎么按 bot 注册表挂到各个 bot 的会话上；工具执行时的统一包装；Slack、Jira、代码仓库的十五个工具（含 CI 的三个）；`request_code`；三个适配器的接口；三个适配器的假实现和真实实现；Slack 转发器；端到端测试台。

不管：任务工具（规格 1）；工具被调用后的记录（规格 2 的记录器）。真实适配器已经写好，先对着本地的桩服务测过；2026-11-13、11-14 在真实 Slack、Jira、GitLab 上各跑通一次（4.9 节）。

## 2. 数据形状

### 2.1 工具定义（I4）

文件：`src/tools/register.ts`。各工具的定义在 `src/tools/slack.ts`、`jira.ts`、`repo.ts`、`request-code.ts`、`ci.ts`、`task.ts`；`src/tools/index.ts` 把它们全部登记。

| 字段 | 含义 |
|---|---|
| `name` | 工具名。不能出现在 DS Bot 的团队工具名单里 |
| `roles` | 哪些角色有这个工具；`all` 表示所有 bot |
| `write` | 是不是写工具。写工具执行前要过步骤把关的 `allow` |
| `purpose` | 可选。从参数里取出“用途”的函数，传给 `allow` |
| `description` | 给模型看的说明 |
| `parameters` | 参数表。每个参数有 `type`（`string`、`number`、`integer`、`boolean`），可选 `required` 和 `enum` |
| `run(ctx, args)` | 执行。返回给模型看的文字 |

`ctx` 的内容：`task`（执行时从任务库现读）、`role`、`botId`、`store`、`gate`、`adapters`、`config`、`botlayer`、`sessionId`（发起这次调用的会话）。

### 2.2 适配器（I5）

文件：`src/adapters/slack.ts`、`jira.ts`、`repo.ts`（由 `src/adapters/index.ts` 一起创建）。配置项 `adapters.<名字>` 取 `fake`（默认）或 `real`，两者接口相同。名字是 `slack`、`jira`、`gitlab`。`repo` 是例外：它的 git 部分任何模式下都跑真实的 git，只有 MR 部分按 `adapters.gitlab` 切换。

| 适配器 | 函数 | 返回 |
|---|---|---|
| `slack` | `readThread(origin)` | 消息列表，每条有 `user`（`id`、`name`）、`at`、`text`、`files` |
| `slack` | `reply(origin, purpose, text)` | 发出的消息的标识。`purpose` 取 `ack`、`question`、`result`，或 `system`（系统自己发的通知；bot 的工具不提供它） |
| `slack` | `startThread(channel, text)` | `{ ts, permalink }`。在频道发一条开头消息，它的 `ts` 就是 `/fix` 任务的讨论串；只给服务端用，bot 的工具不提供它。设计已定，实现中 |
| `jira` | `createIssue(binding, { title, description, acceptance, permalink })` | `key`、`url` |
| `jira` | `getIssue(key)` | `key`、`title`、`description`、`status`、`comments`，另有一些额外字段（两种实现都返回 `url`、`project`、`type`、`labels`、`createdAt`；假实现还有 `acceptance`、`permalink`） |
| `jira` | `addComment(key, text)` | 无 |
| `jira` | `transition(key, status)` | 无 |
| `repo` | `prepare(binding, jiraKey, taskNo)` | `dir`、`branch`、`base` |
| `repo` | `diff(dir, base)` | `files`（每个有 `path`、`added`、`removed`）、`patch`、`totalFiles`、`totalLines` |
| `repo` | `readFile(dir, path, ref)` | 文件内容 |
| `repo` | `log(dir, path, n)` | 提交列表（`sha`、`author`、`date`、`subject`） |
| `repo` | `openDraftMR(binding, dir, branch, { title, description, jiraKey, commitMessage })` | `url`、`iid`、`sha`（推上去的提交） |
| `repo` | `getMR(binding, branch)` | `state`、`pipeline`，另有额外字段（`url`、`draft`、`title`；真实实现还有 `pipelineUrl`）。分支没有 MR 时抛出 `mr_not_found` |
| `repo` | `getChecks(binding, iid)` | `status`（`pending`、`passed`、`failed`）、`sha`、`pipelineUrl`、`failedJobs`（每个有 `id`、`name`、`url`、`pipelineId`、`projectId`）。只看 MR 当前提交的 pipeline |
| `repo` | `getJobLog(binding, job, { maxChars })` | 日志的末尾（纯文字） |
| `repo` | `retryJobs(binding, jobs)` | `retried`（重跑的 job 标识） |
| `repo` | `pushFix(binding, dir, branch, { message })` | `sha`。把目录里的全部改动提成一个新提交，普通推送 |
| `repo` | `cleanup(dir)` | 无 |

适配器出错时抛出 `AdapterError`（`src/adapters/errors.ts`），带 `code`、`message`、`retryable`。推送被远端拒绝（分支上有别人的提交）时的错误码是 `push_rejected`。后四个 CI 函数的用法见规格 7 第 4.5 节。

### 2.3 假实现用的文件

```
<dataDir>/fake/
  slack/threads/<channel>-<threadTs>.json   一个讨论的消息列表
  slack/replies.jsonl                       系统和 bot 发出的回复，一行一条
  jira/issues.json                          全部假单，键是单号
  gitlab/mrs.json                           全部假 MR，键是分支
  gitlab/pipelines.json                     假 CI 的 pipeline 和 job 记录
```

## 3. 接口

工具注册框架对外提供：

| 函数 | 作用 |
|---|---|
| `defineRoleTool(def)` | 登记一个工具定义 |
| `attachRoleTools(agent)` | 把属于这个会话的工具注册到它自己的范围里 |
| `detachRoleTools(sessionId)` | 把一个会话的工具再摘掉（会话结束或换了 agent） |
| `toolsFor(role)` | 一个角色拥有的工具定义 |
| `call(name, sessionId, args)` | 经统一包装（4.2 节）执行一个工具；总是返回文字 |
| `validate()` | 启动时的校验：bot 注册表列出的每个工具都有定义，角色一致。报出问题时应用不启动 |

依赖：bot 注册表（规格 1）决定谁有什么；bot 层门面的 `botOfSession` 从会话查出任务和角色；步骤把关的 `allow`；任务库。

## 4. 行为规则

### 4.1 挂载

- bot 层每次为一个会话准备工具时，调用 `attachRoleTools`。
- `attachRoleTools` 用 `botOfSession` 查这个会话属于哪个任务、哪个角色。查不到就什么都不做。
- 把 `roles` 含这个角色（或为 `all`）的工具注册到这个会话自己的范围里，用的是 DS Bot 注册团队工具的同一个调用。
- coding bot 和其他 bot 一样，工具只注册到会话范围。它的两个长工具有自己的时限、不重试：`run_tests`（`limits.testMinutes`）和 `request_review`（`limits.reviewMinutes`）；定义里用 `timeoutMs(config)` 和 `retries` 两个可选字段。
- 走 API 的四个 bot 没有 DSH 自带的写文件、命令行、网页工具，这由只读预设保证（规格 5、6）。

### 4.2 执行的统一包装

每个工具被调用时，框架先检查：会话属于某个任务；工具存在且这个会话的角色拥有它；参数符合参数表（是对象、必填的都有、类型对、取值在 `enum` 内）。检查不过就返回“工具失败”和原因。然后依次做：

1. 从任务库读出最新的任务，组出 `ctx`。
2. 是写工具时调用 `gate.allow`。被拒绝时把原因作为工具的错误结果返回，不执行。
3. 执行 `run`。适配器的可重试错误最多重试 `toolRetries` 次；每次尝试超过 `toolTimeoutSeconds` 算超时。包装只是不再等，并不会中止那次调用；所以真实适配器自己的时限都设得比它短，写操作也从不重发（4.9 节）。
4. 成功时返回一段简短的文字。失败时返回“工具失败”、原因和错误码，不抛出异常，让 bot 能在最终答复里说明受阻。

工具不自己写执行记录；记录器从 bot 层的工具事件生成（规格 2）。

外来的文字一律当数据。读类工具返回的、来自系统之外的内容（Slack 讨论、Jira 单、仓库文件、补丁、提交历史）都先按长度上限截断，再包进以 `-----BEGIN MATERIAL-----` 开头、以 `-----END MATERIAL-----` 结尾的块里，块前有一句话说明这是数据、不是指令。文字里若自带结束标记，会被改掉，所以从里面关不掉这个块。工具函数在 `src/tools/material.ts`；各上限见下面的工具表。runner 组的任务消息用同样的标记。

### 4.3 Slack 的工具（C2）

| 工具 | 参数 | 规则 | 写入任务 |
|---|---|---|---|
| `slack_read_thread` | 无 | 读 `origin` 指向的那个讨论。返回每条消息的发言人、时间、文字、附件名和链接。整体过长（超过 8000 个字符）时截断并注明 | `slack.readAt` |
| `slack_reply` | `purpose`（`ack`、`question`、`result`）、`text` | 写工具，`allow` 时带上 `purpose`。该用途已经发过时不再发，返回“已发过”。`text` 为空或超过 `limits.replyMaxChars`（默认 600）时拒绝 | `slack.sent.<purpose>` 为真 |

工具的 `purpose` 只有这三个取值。Slack 的工具只能访问 `origin` 里的那一个讨论，参数里没有频道和讨论。

### 4.4 Jira 的工具（C3）

| 工具 | 参数 | 规则 | 写入任务 |
|---|---|---|---|
| `jira_assess_request` | `sourceQuote`、`problem`、`outcome` | 写工具。引用 Slack 讨论中的原文，登记具体问题和可检查的结果。只有问候或测试字样的内容，以及找不到引用原文的内容，不能通过。只有 Jira bot 确认过信息不足（主 bot 没有）时可以再次调用，通过后撤回 `needsInfo.jira`；两方都确认后拒绝 | `issueAssessment` |
| `jira_create_issue` | `title`、`description`、`acceptance` | 写工具。任务已有 `jira.key` 时直接返回它；否则必须先通过 `jira_assess_request`。项目、类型、标签取自 `binding`。描述末尾由工具附上 Slack 讨论的链接。三个参数都不能为空 | `jira.key`、`jira.url` |
| `jira_get_issue` | 无 | 读本任务的单：标题、状态、描述、评论。文字超过 6000 个字符时截断，评论只显示最近 20 条 | — |
| `jira_add_comment` | `text` | 写工具。在步骤 `writeback` 调用时，工具在文字后附上 MR 链接（任务还没有 MR 时失败） | `jira.commentedMr` 为真 |
| `jira_transition` | `status` | 写工具。`status` 必须在配置项 `jiraTransitions` 允许的范围内（默认 `In Review`；比较时不分大小写） | `jira.status` |

Jira 的工具只能访问 `jira.key` 那一张单。新建的单不带现有自动化规则用的标题前缀，避免触发现有的修复流程。

### 4.5 代码仓库的工具（C4）

| 工具 | 参数 | 规则 | 写入任务 |
|---|---|---|---|
| `repo_prepare` | 无 | 写工具。任务已有 `repo.dir` 时直接返回。要求已有 `jira.key`。完成后把代码目录设为群里 coding bot 的工作目录（只设它，不设整个群：改整个群的目录会把每个成员的对话都挪走） | `repo.dir`、`repo.branch`、`repo.base` |
| `repo_diff` | 无 | 返回改动的文件列表、增删行数和补丁；补丁过长（超过 12000 个字符）时截断并注明；最多列出 100 个文件 | — |
| `repo_read_file` | `path`、`ref`（可选） | `path` 必须是仓库内的相对路径，不能跳出仓库。`ref` 必须是普通的分支、标签或提交名。内容过长（超过 12000 个字符）时截断并注明；适配器拒绝超过 5 MB 的文件 | — |
| `repo_log` | `path`（可选）、`n`（默认 20，最多 50） | 返回提交列表 | — |
| `mr_open_draft` | `title`、`description`、`commit_message`（可选） | 写工具。`allow` 只检查步骤、审查是否通过、改动规模（`diffMaxFiles`、`diffMaxLines`），别的不查。`commit_message` 是一行 Conventional Commit（`type(scope): summary`，scope 可省，后面可带 `!`，type 取 feat、fix、chore、refactor、test、docs、perf、build、ci、style、revert，没有正文）；默认是 `fix: <title>`（按下面的长度上限截断）。工具在末尾加任务的 Jira 单号，提交信息是 `<type(scope): summary> (<KEY>)`（例如 `fix(price): subtract the discount instead of adding it (F2PGBA-12)`），整行不超过 100 个字符；超长、带别的单号或任务没有单号时拒绝，自己写了本任务单号会先去掉。单号放末尾是因为公司 GitLab 推送规则要带单号，而 commitlint 要 type 在最前面。适配器接受带或不带末尾 ` (KEY-n)` 的 Conventional Commit，整行 ≤ 100，并按给定的信息原样提交。标题和描述里都没有 Jira 单号时，工具在描述末尾附上 `Jira: <单号>`。任务已有 `mr.url` 时复用并返回它，新改动作为又一个提交加到分支上；推送被拒时失败（`push_rejected`），提示向人报告（`task_close needs_person`）。`mr.iid` 和 `mr.sha` 也一并记下，给 CI 步骤读 | `mr.url`、`mr.iid`、`mr.sha` |
| `mr_get` | 无 | 返回本任务 MR 的状态和流水线状态；分支没有 MR 时直接说没有（适配器的 `mr_not_found` 是一个答案，不算失败） | — |
| `ci_read_log` | `job`（失败 job 的 id 或名字） | 只读。读一个失败 job 的日志末尾（不超过 `limits.ciLogMaxChars`，默认 12000 个字符），按外来材料包装。读过日志是 `ci_stop` 的前提 | `ci.logRead` |
| `mr_push_fix` | `commit_message` | 写工具。把代码目录的改动提成一个新提交、普通推送到任务分支。CI 没失败、轮数到 `limits.ciMaxRounds`（默认 3）、循环已结束时拒绝；没有改动时拒绝；推送被拒时不拉取、不覆盖，记 `branch_changed` 并结束 CI 循环 | `ci`（新一轮，待定）、`mr.sha` |
| `ci_stop` | `reason`（`not_locatable`、`out_of_scope`、`not_fixable`）、`note` | 写工具。停止 CI 循环并记原因。要求 CI 已失败且本轮读过日志；`not_fixable` 还要求 Coding bot 本轮的审查结论是 `cannot_fix` | `ci.settled`、`ci.outcome` |

后三个只有 Git Pipeline bot 有，只在步骤 `ci` 用；等 pipeline、自动重跑和轮数由监控管（规格 7 第 4.4、4.6 节）。

代码目录的做法（假实现和真实实现相同）：

- 每个频道绑定一个本地的仓库副本，路径在 `binding.localRepo`。
- `prepare`：把默认分支从绑定的 `remote`（没有就用本地副本的 `origin`）取到私有引用 `refs/chat-to-fix/base/<分支>`，这样并行的任务互不冲突；没有远端时用本地的默认分支。用 git worktree 在 `<worktreesDir>/T-<序号>` 建一个独立目录，分支是 `ai/<Jira 单号>`，起点是上面那个提交。如果分支 `ai/<单号>` 已经存在（上次清理时留下的），就接着在它上面干，不重置。`base` 是这个分支和默认分支最新提交的共同祖先（merge-base）。
- `diff`：先把未跟踪的文件登记为“待添加”，再取相对 `base` 的改动，这样新建的文件也算在内。
- `openDraftMR`：把目录里的全部改动提交成一个提交，提交说明是那一行，作者和提交者都用配置项 `commitAuthor`；推分支；开 Draft MR，目标是频道绑定里的默认分支（`binding.defaultBranch`）；不支持在 Slack 里指定目标分支。对同一分支再次调用时，追加一个新提交（不修订上一个）、普通推送（不强推），MR 复用，链接不变。分支只增不减，别人推到 `ai/<单号>` 上的提交不会被冲掉；推送被拒（远端有本目录没有的提交）时报 `push_rejected`，不拉取，主 bot 以 `needs_person` 结束任务。没有可提交的改动、且分支相对默认分支没有领先的提交时，以适配器错误 `nothing_to_commit` 失败；放行检查不查“没有改动”。
- `pushFix`：CI 修复的一轮。规则和上一条一样（一个新提交、普通推送、没有改动报 `nothing_to_commit`、被拒报 `push_rejected`）；另外，目录里没有改动但有一个远端没有的提交（上次推送因网络失败）时，推那个提交。
- `cleanup`：删除这个 worktree。分支保留。
- git 的安全措施（`src/adapters/git.ts`）：每次 git 调用都用 `execFile`，带超时和一个很小的环境变量集。用户的全局和系统 git 配置关闭，钩子关闭（`core.hooksPath=/dev/null`、`--no-verify`），不许弹出提问，作者和提交者取自 `commitAuthor`。代码目录必须在 `<worktreesDir>` 里面（按真实路径检查；`prepare` 建的总是 `<worktreesDir>/T-<序号>`），别的路径一律拒绝。路径必须是相对路径，不能含 `..`，不能指向 `.git`；引用名不能以 `-` 开头。GitLab 令牌只通过子进程的环境变量交给 git（`http.<主机>/.extraHeader`），而且只用于配置的 GitLab 主机上的 https 远端；它不会出现在远端地址或配置文件里，报错文字里也会被抹掉。推送一律是普通推送；被拒时错误码是 `push_rejected`。
- 清理旧的代码目录：设计是每天清理一次，删掉结束已超过 `worktreeKeepDays`（默认 7）天的任务的目录。函数 `runner.cleanupWorktrees` 已有且有测试，但没有任何地方调用它：每日清理未实现，代码目录会一直留着，要手工删。

### 4.6 `request_code`（C5）

| 项 | 规则 |
|---|---|
| 谁有 | `coding` |
| 参数 | `what`：要什么，例如另一个分支上的某个文件、某段历史 |
| 什么时候可以调 | 步骤 `code` 和 `ci` |
| 做什么 | 以 coding bot 当前会话的名义，向本任务的 Git Pipeline bot 发一个私下的请求 |
| 返回 | “已发给 Git Pipeline bot，答复会作为新消息到达” |

过程：

1. 工具通过门面的 `askBot` 发出请求。请求进 Git Pipeline bot 自己的私聊，不进群。
2. Git Pipeline bot 在私聊里用 `repo_read_file`、`repo_log` 找到内容，给出答复。
3. 答复自动回到 coding bot 发出请求的那个会话，作为新的输入，coding bot 接着做。
4. 这次往来在 bot 层里是一件转交的活。coding bot 不能给正在等它结果的 bot 发请求，这条由 bot 层原有的检查保证。

它不用 DS Bot 的 `message_bot`，原因有两个：`message_bot` 在团队工具名单里，调用它不算“干了活”；在群里对同群成员用 `message_bot` 会变成一次群内的 @。

### 4.7 假实现（E1）

| 适配器 | 假实现的行为 |
|---|---|
| `slack.readThread` | 读 `slack/threads/<channel>-<threadTs>.json` |
| `slack.reply` | 往 `slack/replies.jsonl` 追加一行：时间、频道、讨论、用途、文字 |
| `jira.createIssue` | 在 `jira/issues.json` 里加一条，单号是 `<jiraProject>-<自增序号>`，链接是 `fake://jira/<单号>` |
| `jira.getIssue`、`addComment`、`transition` | 读写同一个文件 |
| `repo.prepare`、`diff`、`readFile`、`log`、`cleanup` | 真实的 git 操作，对象是本地的测试仓库（和真实 GitLab 时是同一份代码） |
| `repo.openDraftMR` | 真实提交；推到本地的裸仓库；在 `gitlab/mrs.json` 里记一条，链接是 `fake://gitlab/<仓库>/mr/<自增序号>`；同一分支再调用时更新那一条；返回 `iid` 和 `sha` |
| `repo.getMR` | 从 `gitlab/mrs.json` 读；分支不存在时抛出 `mr_not_found` |
| `repo.getChecks`、`getJobLog`、`retryJobs`、`pushFix` | 假 CI（`src/adapters/fake/ci.ts`）：每次推送后为该提交记一条 pipeline 到 `gitlab/pipelines.json`，绑定里的 `ciJobs` 每项（`name`、`command`，可选 `delaySeconds`、`allowFailure`、`flaky`、`downstream`、`timeoutSeconds`）在该提交的临时检出里用 `sh -c` 真跑，输出就是日志。`ciNone: true` 表示推送不产生 pipeline。没有 `ciJobs` 时 pipeline 没有 job，立刻通过。`flaky` 的 job 第一次直接失败，重跑才真跑 |

配套的两个脚本：

- 假事件命令（`scripts/fake-event.ts`）：接受频道和文字，写出讨论文件（第一条消息就是这段文字），再向 `POST /events` 提交。
- 建测试仓库的脚本（`scripts/make-test-repo.ts`）：建一个带几份示例代码的本地仓库和它的裸仓库。

### 4.8 端到端测试台（E1）

文件：`test/e2e.test.ts`。下表三个基本场景加 CI 的场景，全部用假适配器，git 是本地测试仓库上的真实 git。bot 层是内存里的假实现，测试自己扮演五个 bot，去调用它们的工具；工具到文件之间的一切都是真的（监听器、队列、runner、工具注册表、步骤把关、适配器、记录器）。

| 场景 | 预期 |
|---|---|
| 正常 | 任务走完八步，状态 `done`；假 Jira 里有一张单并带 MR 链接；裸仓库里有分支 `ai/<单号>`；回复文件里有“ack”和“result” |
| 建单前信息不足 | Jira bot 和主 bot 都确认后，回复文件里有“question”；状态 `needs_info`；假 Jira 没有新单 |
| 编码时信息不足 | coding bot 和主 bot 都确认后，回复文件里有“question”；状态 `needs_info`；同一讨论再次提交事件后开始第二次运行，不产生第二张单 |
| 审查未通过 | `request_review` 记下 `fail`；`mr_open_draft` 被拒绝；状态 `failed`；分支保留 |

另有 CI 修复循环的场景（`ci 1` 至 `ci 9`：一次通过、失败后读日志修复、flaky 重跑、允许失败的 job、三轮仍失败、`ci_stop` 的前提、没有 pipeline、别人推了提交导致推送被拒、补信息重跑时追加提交不强推），见规格 7。设计里的超时场景不在端到端文件里。规格 3 的时限规则由 `test/monitor.test.ts` 测；一次因超时结束并向原讨论发系统通知的端到端运行未实现。

coding bot 的两个工具有自己的测试 `test/coding-tools.test.ts`（真实的存储和门禁，假的 bot 层和仓库）；门面的 `runReview` 在 `test/bot/botlayer.test.ts` 里用假的子 agent 服务测。假 bot 层（`test/helpers/fake-botlayer.ts`）的 `runReview` 默认答“pass”，可以改成别的回答。

另有第二套测试 `scripts/e2e/`，用真实模型跑（五个 bot 都走真实模型，Slack、Jira、GitLab 仍是假的）。运行：`node scripts/e2e/run.ts`。每个用例是绑定的 Slack 频道里的一条缺陷报告，对着一个小的临时前端仓库（纯 Node，没有浏览器）。默认跑七个用例：文案错别字、圆角、按下效果、表单校验、价格显示（要补一个单元测试）、跨文件改动、提示注入（讨论里有恶意指令和假令牌）；另外三个可以按名字单独跑。每个用例带隐藏测试，隐藏测试在基准代码上必须失败、修好后必须通过。检查项（`scripts/e2e/checks.ts`）要求：一次跑通（八步、没有 `needs_info`、没有重跑、没有被拒绝的调用），只改允许的文件，只有一个提交且提交说明是一行，Jira 单、Slack 回复和 MR 都正确，并且里面没有密钥样式的字符串。报告写到运行目录里。`test/e2e-real.test.ts` 测的是这套测试本身，不调用模型。

### 4.9 真实实现（R1）

由 `adapters.<名字>: "real"` 选用。真实适配器缺令牌时，配置在启动时就报错。令牌只从环境变量读；名字像凭据的配置键会被拒绝。三个适配器都把自己的请求时限设得比 `toolTimeoutSeconds` 短（已知问题：GitLab 适配器读的是 `config.toolTimeoutSeconds`，不是 `config.limits.toolTimeoutSeconds`，所以总按默认 30 秒算，改了这项配置 GitLab 不跟着变，见 `src/adapters/gitlab-http.ts:61`），写操作只发一次，写操作的错误只在请求不可能到达服务器时才标为可重试（只有 Slack：连接被拒或 DNS 失败），所以统一包装不会造成第二条消息、第二张单或第二个 MR。状态：已写好，只对着本地的桩服务测过；没有对真实的 Slack、Jira、GitLab 跑过。

Slack（`src/adapters/slack.ts`、`slack-http.ts`）：Slack Web API。令牌在 `CHAT_TO_FIX_SLACK_TOKEN`；权限范围 `channels:history`、`groups:history`、`chat:write`；`users:read` 可选。加上 `/fix` 入口后（设计已定，实现中），整个 Slack 应用需要：Bot 权限 `commands`（斜杠命令）、`chat:write`（开头消息和所有回复）、`app_mentions:read`（讨论串里 @ 补充信息）、`channels:history` 和 `groups:history`（读讨论），可选 `users:read`（显示名字）；Bot 事件 `app_mention`；应用级令牌 `connections:write`（Socket Mode）。同一个应用同一时间只能有一个程序用 Socket Mode 连，否则消息会被随机分给各个连接。配置里的 `slack.apiBase` 可以换掉 API 主机（测试用）。`readThread` 用 `conversations.replies`（最多 25 页、每页 200 条），用 `users.info` 把 `<@U..>` 提及和发言人标识换成名字并缓存；没有 `users:read` 时显示用户标识，并记一次警告。读操作会重试（网络错误、超时、5xx、带 `Retry-After` 的 HTTP 429）。`reply` 用 `chat.postMessage` 发到讨论串里（只试一次，不展开链接预览）。发送前会把广播式提及（`<!channel>`、`<!here>`、`<!everyone>`、用户组、直接写的 `@channel`）处理掉，bot 因此不能@整个频道；超过 4000 个字符的文字会被截断。Slack 返回的 `{ ok: false }` 会映射成适配器错误码并带提示（例如 bot 不在这个频道里）。

Jira（`src/adapters/jira.ts`、`jira-http.ts`）：Jira REST API v2。配置 `jira.baseUrl`（必填）、`jira.email`（可选）、`jira.fields`（可选）；令牌在 `CHAT_TO_FIX_JIRA_TOKEN`，邮箱也可来自 `CHAT_TO_FIX_JIRA_EMAIL`。有邮箱时用 Basic 认证（`邮箱:令牌`，Jira Cloud），没有则用 Bearer。`createIssue` 发送项目（`binding.jiraProject`）、问题类型（`binding.issueType`，默认 `Bug`；纯数字按 id 处理）、摘要、描述，以及来自 `binding.labels` 的标签；然后依次把 `jira.fields`、`binding.jiraFields` 叠上去，后面的覆盖前面的。验收标准写进描述，放在“Acceptance criteria:”下面。`getIssue` 会翻页取评论（最多再取 10 页、每页 100 条）。`transition` 按目标状态找迁移，再核对一次 `jiraTransitions`，已经在目标状态也算成功。只有 GET 会重试。

GitLab（`src/adapters/gitlab-http.ts`，配合 `repo.ts`）：REST API v4，只管 MR 部分。配置 `gitlab.baseUrl`（必填）；令牌在 `CHAT_TO_FIX_GITLAB_TOKEN`（请求头 `PRIVATE-TOKEN`；同一个令牌也交给 git，用于这个主机上的 https 远端）。绑定里的 `repo` 是项目路径。MR 标题始终带前缀 `Draft:`（只带一个）。`upsertDraft` 先找这个源分支上已打开的 MR，有就更新，没有才创建。GitLab 回 HTTP 409（这期间分支上又出现了一个打开的 MR）时，找到那个 MR 并更新它。`getMR` 取该分支最近更新的 MR（不论状态），再读它的流水线状态。不跟随重定向，令牌不会跟着跑出去。

GitLab 的 CI 部分（同一个文件）：`getChecks` 按 MR 的当前提交找 pipeline（旧提交的忽略，同一提交有几个取编号最大的），读主 pipeline 和下游 pipeline（最深四层，下游读不了按失败算），`allow_failure` 的 job 不算（主 pipeline 里还在跑的会把“通过”最多拖 10 分钟，见 spec-7）；还在跑算 `pending`，全部结束且有失败 job 算 `failed`，已取消也算失败。`getJobLog` 读 job 的 trace，去掉颜色码和折叠标记，只留末尾 `maxChars`。`retryJobs` 对每个 job 发一次重试，不重发，出错就停，报错里列出已重跑的 job；还没有在真实 GitLab 上验证过。

入口（2026-11-12 定，已实现；见 decision-record 第 2.11 节第 5 条）：主入口是在绑定的频道里用斜杠命令 `/fix 问题描述`（命令名可配置，`slack.slashCommand`，默认 `/fix`），@ 机器人只用于任务讨论串里的补充信息。转发器收到 `/fix` 先确认，再以 `source: 'slash'` 转给 `POST /events`；服务端先查绑定和队列，没绑定回 422、队列满回 429，这两种情况频道里不发任何东西；通过后用 `startThread` 在频道发开头消息（`<@发起人>` 加原文，先去掉广播式提及），它的 `ts` 就是讨论串，之后所有回复都在这里；发不出开头消息回 502。转发器按结果用 `response_url` 给发起人发中文临时消息。命令正文为空、或在和 bot 的私信里用，转发器直接回用法说明，不转给服务端（第一版不支持私信）。

Slack 转发器（`scripts/slack-forwarder.ts`）：它开一条 Slack Socket Mode 连接（不需要公网地址），每个信封立刻确认，把 `/fix` 命令和真人的 `app_mention`（任务讨论串里的补充）转成 `POST /events` 要的请求体，带请求头 `x-chat-to-fix-token` 发过去。bot 的消息、编辑过的消息、自己的消息都忽略。连接断了会退避重连。环境变量：`CHAT_TO_FIX_SLACK_APP_TOKEN`（应用级令牌，权限 `connections:write`；必填）、`CHAT_TO_FIX_SLACK_TOKEN`（可选；有它时转发器还会尽力取消息的永久链接和发言人名字）、`CHAT_TO_FIX_URL`、`CHAT_TO_FIX_HTTP_TOKEN`。

已知的过时代码注释（代码是对的，注释不对）：`src/adapters/index.ts` 开头说选 `real` 会抛“尚未实现”；`src/tools/request-code.ts`（`sessionId` 那行附近）说注册表的 `ctx` 还不带 `sessionId`，实际已经带了。


### 4.10 Coding bot 的两个工具（2026-11-13）

`run_tests`（`core/tools/tests.ts`，coding，读工具，`code` 和 `ci` 步）：参数 `command` 必须和任务绑定里的某条 `testCommands` 完全相同（去掉首尾空白后比较），否则拒绝并列出能跑的命令；没有测试命令时报错。在 `task.repo.dir` 里 `sh -c <命令>` 运行，单独一个进程组，`limits.testMinutes` 到时杀掉整组；环境变量只有白名单（`PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`LANG`、`TERM`、`TMPDIR`、`LC_*`）；返回退出码、用时和输出最后 8000 个字符（标成材料）。不重试。

`request_review`（`core/tools/review.ts`，coding，写工具，`code` 和 `ci` 步）：参数 `summary`。先查轮数（任务上 `review.rounds`，`cannot_fix` 不算），到了 `limits.reviewMaxRounds` 就拒绝；代码目录对基准提交没有改动也拒绝。然后拼审查材料（`reviewer.md`、Slack 原文和摘要、Jira 步的结果、CI 步的失败摘要、`summary`、真实 diff，外来文字都标成材料），调门面 `runReview`（规格 5 第 4.9 节）。审查没有正常结束（`stopReason` 不是 `completed`）就报错、不记、不算一轮。否则按回答第一行定结论（`pass` 或 `not pass`，看不出的按不通过记），写 `review: { verdict, comments, rounds, at, by: 'reviewer' }`，把结论和审查者的回答返回给 coding bot。不重试。

`review_report` 只剩一种用法：CI 步记 `cannot_fix`（`verdict` 只能是它，`comments` 写原因）；轮数沿用当前的 `review.rounds`，`by: 'coding'`。`repo_diff` 也给了 coding，用来看自己改了什么。

## 5. 代码参考

`DSB:` 是 DS Bot 参考实现，现在也在代码仓库里，目录是 `bot/`（文件是 `.ts`）。2026-11-11 的行号已经不对；给出行号的条目已在 2026-11-12 重新核对，其余只写函数名或文件名。`DSH:` 和 `SA:` 在代码仓库之外，没有重新核对。

| 位置 | 看什么 |
|---|---|
| `DSB:src/host/tools.ts` 开头用 `defineTool` 的地方 | 一个工具定义的写法：`name`、`description`、`parameters`、`output`、`execute(args, exec)` |
| `DSB:src/host/tools.ts:466` | `shareBotTools`：为一个会话准备工具的入口 |
| `DSB:src/host/tools.ts:527` | 它在这里调用 `rt.taskLayer.attachRoleTools(agent)` |
| `DSB:src/host/tools.ts:664` | 工具执行前的拦截：`ctx.tools.guard`，从 `exec.agent` 得到会话 |
| `DSB:src/host/constants.ts:65` | 团队工具名单（`TEAM_TOOLS`）；新工具不加进去。`test/tools.test.ts` 检查 `register.ts` 里的 `TEAM_TOOL_NAMES` 和它一致 |
| `DSB:src/host/tools.ts` 里的 `message_bot`（约第 152 行） | `message_bot` 的实现，`request_code` 的样板 |
| `DSB:src/host/handoffs.ts:101`、`:224` | `openWork`：开一件转交的活；`answerText`：把结果拼成答复 |
| `DSB:src/host/turns.ts:40` | `answerSender`：一轮结束后把答复送回请求方 |
| `DSB:src/host/delivery.ts:58` | `deliver`：把消息投进某个会话 |
| `DSB:src/host/folders.ts:29` | `workDirOf`：成员在群里的工作目录怎么定（`room.memberDirs`） |
| `src/task/botlayer.ts` 的 `setGroupWorkDir` 和 `askBot` | `repo_prepare` 和 `request_code` 调用的就是它们；`setGroupWorkDir` 只设 coding bot 的目录 |
| `DSH:docs/cookbook/adding-a-tool.md` | 定义工具的最小写法；用 `timeoutMs` 声明时限 |
| `DSH:docs/subsystems/tools.md` | 工具的执行管线和拦截点 |
| `SA:docs/003-execution.md` “Preparing a Ticket directory” | 用 git worktree 给每张单建独立目录 |
| `DSB:test/fake-ctx.ts`；`test/helpers/fake-botlayer.ts`（chat-to-fix 的，不在 `bot/` 里） | 假的 DSH 上下文；端到端测试用的内存 bot 层 |
| `DSB:test/group-work.test.ts`、`rounds.test.ts`、`handoff-results.test.ts` | 群里干活、轮次、转交结果的测试写法 |
| `~/Documents/ChatGPT/ba-fix-bot/research/phase-1/README.md` | 现有流程的分支命名、同一分支复用 MR、现有 Jira 自动化的触发条件 |

## 6. 实现清单

C0：

- [x] `defineRoleTool`、`attachRoleTools`（另有 `detachRoleTools`、`toolsFor`、`call`、`validate`）。
- [x] 启动时校验：工具名不在团队工具名单里；注册表里列出的每个工具都有定义。
- [x] 统一包装的四步，前面先查会话、角色和参数；写工具过 `allow`。
- [x] 失败以错误结果返回，不抛出。
- [x] 超时和重试从配置读取。

C2：

- [x] `slack_read_thread`、`slack_reply`。
- [x] 每种用途只发一次；长度上限。
- [x] `src/adapters/slack.ts` 按配置选假实现或真实实现。

C3：

- [x] 四个 Jira 工具。
- [x] 重复建单返回已有单号；状态只能改到允许的范围。
- [x] `jira_add_comment` 在回写步骤附上 MR 链接。

C4：

- [x] 六个仓库工具。
- [x] `repo_prepare` 完成后设群里 coding bot 的工作目录。
- [x] `repo_read_file` 的路径检查。
- [x] `diff` 把新建的文件算在内。
- [x] `mr_open_draft` 重复调用返回已有 MR；追加提交、普通推送，被拒报 `push_rejected`。
- [x] CI 的三个工具 `ci_read_log`、`mr_push_fix`、`ci_stop`；适配器的 `getChecks`、`getJobLog`、`retryJobs`、`pushFix`；假 CI（`ciJobs`、`ciNone`）。重跑 job 对真实 GitLab 未验证。
- [ ] 每日清理旧代码目录：未实现（没有地方调用 `runner.cleanupWorktrees`）。

C5：

- [x] `request_code` 通过门面的 `askBot` 发私下请求。
- [x] 只在步骤 `code` 和 `ci` 可用。

E1：

- [x] 三个假适配器和四个文件。
- [x] 假事件命令；建测试仓库的脚本。
- [x] 三个基本端到端场景（正常、信息不足、审查未通过）和 CI 的九个场景（规格 7）。
- [ ] 超时的端到端场景：未实现。

R1：

- [x] 真实的 Slack、Jira、GitLab 适配器和 Slack 转发器（已写好；只对着本地桩服务测过）。
- [ ] 对着真实的 Slack、Jira、GitLab 试跑：未做。

## 7. 验收

- Jira bot 的会话里有五个 Jira 工具和 `needs_info_confirm`，没有 Slack 和仓库的工具；coding bot 的会话里有 `task_read`、`repo_diff`、`run_tests`、`request_review`、`request_code`、`review_report`、`needs_info_confirm` 和 DSH 的读写改工具，没有 shell。
- 在错误的步骤调用任何写工具都被拒绝，bot 收到的是原因，任务不受影响。
- 同一个任务调两次 `jira_create_issue`，假 Jira 里只有一张单；调两次 `mr_open_draft`，只有一条 MR 记录。
- coding bot 新建一个文件后，`repo_diff` 的列表里有它。
- `repo_read_file` 传入跳出仓库的路径被拒绝。
- coding bot 调用 `request_code` 后，Git Pipeline bot 的答复回到 coding bot，群里没有多出发言。
- 端到端场景全部通过，过程中没有访问真实的 Slack、Jira、GitLab。
