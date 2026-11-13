# 细分规格 5：bot 层搬运

- 日期：2026-11-11
- 覆盖的工作包：A1（全量拷入和基线测试）、A2（入口、安装顺序、门面）、A3（补位文件）、A4a 至 A4d（裁剪）、A5（原为 Claude Code 驱动，2026-11-13 改为 Coding bot 的 DSH 预设和审查，见 4.9）。
- 上位文档：[kickoff-plan.md](kickoff-plan.md) 第 2、3、4 节；[software-spec.md](software-spec.md) 5.5、6.5。
- 角色标识见规格 1；记录器、看门狗、工具对门面的用法见规格 2、3、4。
- 状态：2026-11-12 按代码（提交 192a721）更新；2026-11-13 按分支 `dsh-coding` 改了 4.9 和涉及 Claude Code 的各处（[plan-dsh-coding.md](plan-dsh-coding.md)）。最初是 2026-11-11 开工前的设计；和原设计不同的地方已直接改成现状，代码还没做到的标“未实现”。
- 用量和费用：门面有 `onUsage`（`src/task/botlayer.ts`）。五个 bot 的用量都由门面每轮读 DSH 自己的会话统计，两次读数之差就是这一轮；审查者是子会话，审查结束时读它的总数，记在 Coding bot 名下。费用按价目表算。记账见 `src/task/usage.ts`、`pricing.ts`。
- 位置：DS Bot 的拷贝是和 `src/` 并列的独立目录 `bot/`（`bot/src/host`、`bot/src/shared`、`bot/test`）；代码是 TypeScript（`.ts`）。下面的位置写文件名和函数名，不写行号，因为文件已经变了。

## 1. 范围

管：从 DS Bot 0.3.1 搬哪些文件；新的入口；任务层调用 bot 层的门面；被去掉模块留下的调用点怎么补；四个文件怎么裁剪；Coding bot 的审查者怎么起（门面的 `runReview`）。

不管：DSH 本身（原样使用，不改源码）；任务层（规格 1 至 4）；提示词的内容和 DSH 的配置补丁（规格 6）。

原则：bot 是什么、怎么建、怎么在群里互相叫，沿用 DS Bot，不另外发明。改动只有两类：去掉不用的；补上被去掉部分留下的缺口。五个 bot 都是普通的 DSH 会话，没有命令行驱动。

## 2. 数据形状

bot 层自己的状态文件、bot 记录、群记录、转交记录的形状都沿用 DS Bot，不改。

任务层给 bot 层加的只有一张内存里的绑定表：bot 编号到“任务编号和角色”的对应。它由运行器在启动一次运行时写入、结束时清除，用来从一个会话查出它属于哪个任务、哪个角色。

## 3. 接口：bot 层门面（I1）

文件：`src/task/botlayer.ts`（由 `createBotLayer(rt)` 建出，`src/bot/index.ts` 调用它）。任务层只通过它调用 bot 层。右两列是它包住的 DS Bot 函数。

| 门面函数 | 作用 | DS Bot 里的对应 | 位置 |
|---|---|---|---|
| `createBot({ name, label, instructions, model, effort, permission, preset })` | 建一个 bot，不发自动问候，返回 bot 编号。`preset` 是 DSH 的 agent 预设；`effort` 是推理强度，模型不支持时只记警告 | `createBot`，再 `updateBot` 设模型、权限和推理强度 | `roster.ts` 的 `createBot`、`updateBot` |
| `createGroup({ name, memberIds, adminId, notice })` | 建群，模式固定为“管理员”，返回群编号 | `createRoom` | `roster.ts` 的 `createRoom` |
| `setGroupWorkDir(groupId, dir)` | 只给群里的 Coding bot 设工作目录（见 4.3） | `cleanWorkDir`，再写入群记录里该成员自己的目录（`memberDirs`），再 `followFolder` | `folders.ts` 的 `cleanWorkDir`，`parts.ts` 的 `followFolder` |
| `postTask(groupId, text, requestId)` | 以用户身份往群里发一条消息 | 被去掉的 `channel.js` 里的 `sendUser`；门面直接调 `sessionController.prompt` | `botlayer.ts` |
| `askBot({ fromSessionId, toBotId, text })` | 从一个会话向另一个 bot 发私下的请求，答复回到发起的会话 | `message_bot` 内部的做法 | `tools.ts` 的 `message_bot`，`handoffs.ts` 的 `openWork` |
| `stopBot(botId)` | 停一个 bot 正在跑的回合 | `stopChat`、`stopMemberWork` | `turns.ts` 的 `stopChat`，`groups.ts` 的 `stopMemberWork` |
| `stopGroup(groupId)` | 停整群 | `stopRoomWork` | `groups.ts` 的 `stopRoomWork` |
| `deleteGroup(groupId)` | 解散群 | `deleteRoom` | `roster.ts` 的 `deleteRoom` |
| `deleteBot(botId)` | 删除 bot | `deleteBot` | `roster.ts` 的 `deleteBot` |
| `groupExists(groupId)` | 群还在不在 | 查群记录 | `store.ts` |
| `isQuiet(groupId)` | 群是否没有任何动静 | 四个条件，见 4.3 | `groups.ts` 的 `workingInRoom`、`roomBatchPending`；`turns.ts` 的 `roomProgress`、`roomInbox` |
| `status()` | 每个 bot 在做什么、在等谁 | 三个观察视图和等待视图 | `turns.ts` 的 `activityView`、`workView`、`roomWorkView`；`handoffs.ts` 的 `waitingView` |
| `onGroupLine(fn)` | 订阅群里的每一行 | `onRoomLine` | `groups.ts` 的 `onRoomLine` |
| `onSessionEvent(fn)` | 订阅会话事件 | `session/event` | `turns.ts` |
| `onToolResult(fn)` | 订阅工具返回 | `tools/result` | `turns.ts` |
| `onRoundEnd(fn)` | 订阅“一个 bot 的一轮结束”，带最终答复 | 从会话事件里的回合结束得出 | `turns.ts`（`turn/end`） |
| `onApproval(fn)`、`answerApproval(id, choice)` | 订阅审批；应答 `allow` 或 `reject` | 同名函数 | `approvals.ts` |
| `bindBot(botId, { taskId, role })`、`unbindBot(botId)` | 写入和清除绑定表。`bindBot` 还会把角色的工具挂到该 bot 自己的对话会话上，因为这个会话在能绑定之前就已建好 | 新增 | `botlayer.ts` |
| `botOfSession(sessionId)` | 从会话查出 bot 编号、任务编号、角色 | `selfOf` 加绑定表 | `store.ts` 的 `selfOf` |
| `runReview({ sessionId, prompt, preset, timeoutMs })` | 以该会话为父，起一个只读子 agent，等它答完；返回 `{ childId, text, stopReason, diagnostic? }`；子会话的用量记到父会话的 bot 名下 | DSH 的子 agent 服务 `startActivation`（DS Bot 的 `turns.ts` 也是用 `ctx.get('subagents')` 取它） | `botlayer.ts`，见 4.9 |

门面之外，bot 层只在一处回调任务层：

| 回调 | 在哪里调 | 作用 |
|---|---|---|
| `attachRoleTools(agent)` | 为一个会话准备工具时 | 挂上这个角色的工具（规格 4） |

它在 `src/app.ts` 里作为 `taskLayer` 传出。`src/bot/index.ts` 导出 `connectTaskLayer(facade, taskLayer)`（由 `src/plugin.ts` 在应用建好后调用；门面先建，因为任务层需要它）和 `runtimeOf(facade)`（把内部对象给测试用）。原来的 `bridgedToolNames` 和 `codingOptions` 只为 Claude Code 进程服务，2026-11-13 随它删除。

## 4. 行为规则

### 4.1 搬哪些文件（A1）

A1 先把 DS Bot 的 `src/host/` 和 `src/shared/` 全部拷入工程，连同测试和夹具，让 DS Bot 自己的测试在新工程里通过。拷贝没有放在 `src/bot/` 下，而是独立的目录 `bot/`（`bot/src/host`、`bot/src/shared`、`bot/test`），DS Bot 的模块就在那里原地修改。`src/bot/` 里只有 `index.ts`（入口）和 `stubs.ts`（补位）。没用到的文件随后从 `bot/` 删掉了（338 个，提交 3963783；数量和测试情况见 `rewrite/INVENTORY.md`）。拷贝的测试脚本是 `test:bot`：删除前 1828 项，删除后 136 项（134 过，2 跳过；少掉的是随模块一起删掉的测试）。

最终留下的文件：

| 类别 | 文件 |
|---|---|
| 保留 | `diagnostics`、`store`、`home-lock`、`files`、`models`、`permissions`、`turns`、`handoffs`、`requests`、`delivery`、`chat-index`、`groups`、`approvals`、`resume`、`prompt`、`time-context`、`constants`、`text`、`links`、`steward`，`shared/` 下三个文件。`local-agents/` 整个目录 2026-11-13 已删（见 4.9） |
| 部分保留 | `roster`、`folders`、`tools`、`parts`（没有裁完，见 4.5 至 4.7） |
| 因为被引用而保留 | `btw`、`schedules`（见 4.4） |
| 不搬 | 界面、浏览器、电脑操控、连接器与邮件、聊天平台桥接、办公技能、记忆与学习、目标、日程、头像库、密钥、用量统计、自更新、网页接口（`channel`、`feed`）、`local-agents/` 整个目录 |

### 4.2 入口和安装顺序（A2）

- 新入口声明依赖七个 DSH 服务：模型调用、工具、系统提示词、会话控制、会话存储、会话标题、工作区。原来的第八个“网页连接”只有被去掉的 `channel` 和 `feed` 使用，去掉。
- 安装顺序：`diagnostics`、补位文件、`store`、`models`、`permissions`、`turns`、`handoffs`、`requests`、`delivery`、`roster`、`folders`、`prompt`、`time-context`、`tools`、`chat-index`、`groups`、`approvals`、`resume`、`parts`，最后是任务层。代码里 `src/bot/index.ts` 按这个顺序装到 `parts` 为止并建出门面；任务层（`src/app.ts`）随后由 `src/plugin.ts` 建，再用 `connectTaskLayer` 交给 bot 层。入口导出 `createRuntime(ctx, config)`。
- 两条顺序上的硬要求：`diagnostics` 在 `store` 之前（`store` 安装时就取日志函数）；`resume` 在 `delivery` 之后（`resume` 包裹投递函数）。
- 内部对象建好后留给门面使用（`runtimeOf`）。

### 4.3 门面的几条规则（A2）

- `createBot` 不发自动问候：以“稍后选模型”的方式建 bot，这时问候被扣住；清掉被扣住的问候（`bot.kickoff`）；再设模型和权限。
- `createBot` 的 `preset` 决定这个 bot 的会话用哪个 DSH 预设：走 API 的 bot 用只读预设，coding bot 用 DS Bot 原来的 `standard`。
- `createGroup` 明确传入管理员，不依赖 DS Bot 的默认管理员规则。
- `postTask` 的实现来自被去掉的 `channel.js`，搬进门面时已去掉对“能力”的调用。
- `setGroupWorkDir` 只给 Coding bot 设目录：把目录写进群记录里该成员自己的目录项（`memberDirs`），不写群的工作目录，Coding bot 的群会话随之换过去。群级目录会让每个成员已有的群对话换到新的分段，每个走 API 的 bot 还要为交接说明多一次模型调用，所以四个走 API 的 bot 保持自己的目录。群里没有已绑定的 Coding bot 时什么也不设，只记一条警告。
- `isQuiet` 为真的条件：这个群没有进行中的轮次；没有成员在工作；没有未完成的批次；群收件箱为空。
- `deleteGroup` 之前先 `stopGroup`。
- 不需要 DS Bot 的“Main”角色。任务的五个 bot 都不设为 Main，主 bot 只是群管理员。DS Bot 自动创建 Chief 的函数原来只被 `channel.js` 调用，`channel.js` 不搬，`roster.ts` 里的那处调用也已去掉，所以不会有 Main 被建出来；“不能删除 Main”“团队至少要有一个 Main”这两条检查不会被触发。

### 4.4 补位（A3）

文件 `src/bot/stubs.ts` 提供下面这些函数，在 `diagnostics` 之后安装：

| 函数 | 调用方 | 补位 |
|---|---|---|
| `ensureCapabilities` | `delivery.ts`、`groups.ts`、`parts.ts` | 空函数 |
| `ownRequest`、`tagUsage` | `groups.ts`、`parts.ts`、`btw.ts` | 保留原语义：用一张弱引用表标记插件自己发出的模型请求，并据此判断归属（原实现在 `usage.js`） |
| `renewMemory` | `parts.ts` | 空函数 |
| `moveSchedules` | `parts.ts` | 空函数 |
| `archiveGroupMemory`、`archiveBotMemory` | `roster.ts` | 空函数 |
| `forgetBotSecrets` | `roster.ts` | 空函数 |
| `privateClash` | `roster.ts`、`folders.ts` | 返回无冲突 |
| `checkPrivacyChange` | `roster.ts`、`tools.ts` | 空函数 |
| `checkNoPrivate` | `roster.ts` | 空函数 |
| `imagesForGroup` | `groups.ts` | 返回空列表 |
| `uiLanguage` | `roster.ts`、`groups.ts` 里的可选调用 | 返回配置的语言（`rt.config.language`） |

设计里要内联的两个被导入的函数 `reminderText` 和 `openTurnAt`，未实现：`turns.ts` 仍从 `schedules.ts` 导入 `reminderText`，`parts.ts` 仍从 `btw.ts` 导入 `openTurnAt`。所以 `schedules.ts` 和 `btw.ts` 仍在工程里并被加载，尽管它们本来不需要。

`ownRequest` 和 `tagUsage` 不能用固定返回值代替：群聊中继靠它们分辨“插件自己发的请求”和“群消息”。

### 4.5 裁剪 tools.ts（A4a）

| 处理 | 内容 | 位置 |
|---|---|---|
| 保留 | `list_bots`、`message_bot`、`post_to_group` | `tools.ts` |
| 保留并改 | `stop_bot`：原来只有 Main 能用，改成只有“和目标 bot 同在一个群的群管理员”能用（`mayStop`） | `tools.ts` |
| 保留 | 把工具挂到会话、屏蔽不该有的工具、执行前拦截（`ctx.tools.guard`） | `tools.ts` |
| 保留 | `group_relay`、`read_own_chat`、`read_group_chat`（这三个在 `groups.ts` 里） | `groups.ts` |
| 去掉 | `create_bot`、`update_bot`、`list_bot_models`、`create_group`、`update_group`、`delete_group`、`ask_user`、`show_view` 和能力相关的工具：`tools.ts` 里已不再定义 | `tools.ts` |
| 加 | 为会话准备工具之后调用 `attachRoleTools` | `tools.ts` 的 `shareBotTools` |
| 未实现 | 团队工具名单里还没删干净已去掉的名字：`constants.ts` 的 `TEAM_TOOLS` 里仍有 `request_secret`、`list_secrets`、`remember`、`forget`、`recall`、`read_browser`、`group_goal`、`list_connectors`、`request_connector`（第一批去掉的工具，`create_bot` 到 `show_view`，名字已不在里面）。`groups.ts` 用这个名单（`QUICK_TOOLS`），`src/tools/register.ts` 抄了一份（`TEAM_TOOL_NAMES`）来避免角色工具重名，所以多余的名字无害，但应该删掉 | `constants.ts`、`groups.ts`、`src/tools/register.ts` |
| 未实现 | 已去掉的工具还有残留的提及：`tools.ts` 里拦截时的拒绝文字仍写着“Ask with ask_user”，`parts.ts` 和 `turns.ts` 里还在判断 `ask_user`、`show_view` | `tools.ts`、`parts.ts`、`turns.ts` |

### 4.6 裁剪 roster.ts（A4b）

| 处理 | 内容 | 位置 |
|---|---|---|
| 改 | 建会话时用调用方指定的预设，不再固定用 `standard`（`botPreset`、`createSession`） | `roster.ts` |
| 保留 | “稍后选模型”和问候的扣住，门面用它来不发问候 | `roster.ts` |
| 去掉 | 自动创建 Chief（原处只留了一行注释） | `roster.ts` |
| 未实现 | 头像、私密 bot、浏览器授权、复制 bot 仍在 `roster.ts` 里：`cleanAvatar` 和 `avatar` 字段、`private` 和 `privateArchives`、`cleanBrowserGrants` 和 `browserGrants`、`duplicateBot`。私密 bot 的检查调用的是补位函数，所以不起作用 | `roster.ts` |
| 不动 | Main 相关的检查 | `roster.ts` |

### 4.7 裁剪 parts.ts（A4c）

- 保留长对话的分段和切换。`turns`、`roster`、`groups`、`chat-index` 都直接调用它，不能整个去掉。
- 对被去掉模块的调用走补位（`renewMemory`、`ensureCapabilities`、`moveSchedules`、`ownRequest`、`tagUsage`）。已做。
- 未实现：从 `btw.ts` 导入 `openTurnAt` 的地方没有内联（见 4.4）；界面用的四个函数仍在并被导出：`displayItems`、`earlierPage`、`chatPage`、`switchPart`。

### 4.8 删除其余模块，改提示词文字（A4d）

- 按 4.1 的表删掉不搬的文件，`btw` 和 `schedules` 除外（见 4.4）。已做（提交 3963783）；删完后跑过测试。
- `prompt.ts` 里的团队规则（`TEAM_RULES`，以及 Coding bot 用的 `LOCAL_RULES`）已重写：只写存在的工具，没有提到记忆、电脑操控、`ask_user`、`show_view`、`update_bot`、密钥、网页搜索的句子；保留关于派活的规则（只在对方必须行动时才发消息；不等待、不轮询、不重发；不给正在等你结果的 bot 发消息）。
- Main 规则已删。
- 管理员说明（`groups.ts` 的 `adminNote`）已不提群目标。`groups.ts` 里的群目标代码仍在，只是通过可选调用去找已被去掉的目标模块，所以不起作用。
- 自动的建群问候不会触发：没有任何地方调用 `greetRoom`（`groups.ts`）；群由系统建，第一条消息是任务。这个函数和它的文字 `roomKickoff` 仍留在文件里。

### 4.9 Coding bot：DSH 预设和审查（A5，2026-11-13 重写）

原来的 4.9 写的是 Claude Code 驱动（命令行参数、无人值守配法、MCP 桥、个人指令隔离、空闲关闭后的重放、V0 实验结论）。这条路线已删，那些内容在 git 历史里（提交 `0d80fd3` 的本文件）。现在 Coding bot 和其他四个 bot 是同一种东西：

| 项 | 做法 | 在哪里 |
|---|---|---|
| 模型 | 注册表 `model: 'codingModel'`，默认 `anthropic/claude-sonnet-5-5`，和四个流程 bot 走同一条 DSH 线路、同一个 key | `core/registry/bots.ts`、`config/cordis.patch.yml` 第 1 组 |
| 推理强度 | 注册表 `effort: 'codingEffort'`（默认 `high`），`createBot` 用 `updateBot` 设上；审查者继承父会话的强度 | `core/task/botlayer.ts` `createBot` |
| 工具集 | 注册表 `preset: 'coding'`：DSH 的 `read`、`read_image`、`glob`、`grep`、`write`、`edit`，没有 shell、网络、子 agent 等工具；四个流程 bot 是 `readonly` | `config/cordis.patch.yml` 第 6b 组 |
| 写文件的边界 | 权限预设 `workspace-write`：写只能落在会话的工作目录（`setGroupWorkDir` 设的代码目录）和临时目录；审批策略 `never` | `config/cordis.patch.yml` 第 3 组；`@deepseek-ai/dsh-fs-sandbox` |
| 角色工具 | 和其他 bot 一样由 `attachRoleTools` 注册进会话，没有 MCP 桥 | `core/tools/register.ts` |
| 跑测试 | 角色工具 `run_tests`（任务层执行，见规格 4） | `core/tools/tests.ts` |
| 审查 | 角色工具 `request_review` 拼好材料，调门面 `runReview` | `core/tools/review.ts` |
| 用量 | 和其他 bot 一样从 DSH 的会话统计取差值；审查者的子会话在 `runReview` 结束时读一次总数，记在 Coding bot 名下 | `botlayer.ts` `roundUsage`、`reportChildUsage` |
| 指令文件 | 预设里有 `agent-instructions`：读代码目录到仓库根（以 `.git` 为界）的 `AGENTS.md`、`CLAUDE.md`；全局的读 `$DSH_HOME`、`$DSH_AGENTS_HOME`，启动脚本把这两个指到数据目录 | `@deepseek-ai/dsh-agent-instructions` |

`runReview` 的做法（`botlayer.ts`）：

- `ctx.get('subagents').startActivation({ provider: 'spawn', label: 'review', delivery: 'caller', signal, request: { prompt, parent, agentPreset } })`。`parent` 是该会话的活 agent（`ctx.get('agents').get(sessionId)`，没有时 `rt.resolveAgent`），子 agent 服务要求它就是那个活对象。
- `spawn` 起一个看不到当前对话的新子会话，继承父会话的模型、强度、工作目录；`agentPreset` 定它的工具（注册表 `reviewer.preset`，即 `readonly`）。
- `delivery: 'caller'`：结果直接交回来，不往父会话发通知，所以审查在 Coding bot 这一次工具调用里完成，不会出现“这一轮先结束、审查结果下一轮才到”。
- 等 `result`，最长 `timeoutMs`；到时 `abort` 再 `dispose`，并报错。返回文字取子 agent 最后一条非空回答。
- 无论成败，结束时读子会话的 `tokenUsage`、`sessionStats`，作为一条 `usage` 记到 Coding bot 名下。

还没有真实运行验证的：真实 DSH 里 `startActivation` 的这组参数、子会话的用量投影能否读到（冒烟没有触发审查，见 plan-dsh-coding.md 第 10 节）。

## 5. 代码参考

本节列的是上面各表之外的位置：`DSB:` 是原版 DS Bot 0.3.1（`.js` 文件名和行号都是原仓库的，2026-11-11 核对，不是本工程的）。本工程里对应的代码按函数名找。

| 位置 | 看什么 |
|---|---|
| `DSB:index.js:53`、`:60`、`:66` | 原入口的依赖列表、模块安装顺序、内部对象的建立 |
| `DSB:src/host/store.js:25` | `store` 安装时取日志函数 |
| `DSB:src/host/resume.js:168` | `resume` 包裹投递函数 |
| `DSB:src/host/roster.js:148` | `buildBot` 的全部参数 |
| `DSB:src/host/roster.js:503` | `buildRoom`：群自己的中继会话 |
| `DSB:src/host/groups.js:1149` | 默认管理员和管理员模式下的开场 |
| `DSB:src/host/groups.js:814`、`:876` | 什么算“干了活”；群里直接 @ 之后主 bot 不被自动叫到 |
| `DSB:src/host/channel.js:195`、`:283` | 自动创建 Chief 的函数只在这两处被调用 |
| `DSB:src/host/store.js:419` | Main 角色的判断 |
| `DSB:test/fake-ctx.js` | 假的 DSH 上下文（本工程里是 `bot/test/fake-ctx.ts`） |
| `@deepseek-ai/dsh-subagent` `lib/types/types.d.ts`（`SubagentActivationSpec`、`SubagentStartRequest`、`SubagentResult`） | `runReview` 用的 `startActivation` 的参数和结果 |

## 6. 实现清单

状态按提交 192a721。`[x]` 是已做；`[ ]` 是未实现。

A1：

- [x] 拷入 DS Bot 的 `src/host/`、`src/shared/`、测试和夹具（作为独立目录 `bot/`）。
- [x] 配好测试命令（`test:bot`）和测试用的 DSH 依赖。
- [x] DS Bot 的测试作为基线全部通过；删除之后 134 过、2 跳过。

A2：

- [x] 新入口 `src/bot/index.ts`：七个依赖；4.2 的安装顺序；保留内部对象。
- [x] 门面的全部函数，如第 3 节的表。
- [x] `createBot` 不发问候；支持指定预设。
- [x] `postTask` 从 `channel.js` 搬入。
- [x] `isQuiet` 的四个条件。
- [x] 绑定表和 `botOfSession`。
- [x] `onRoundEnd` 带出最终答复。

A3：

- [x] 补位文件（`src/bot/stubs.ts`）里的全部函数。
- [x] `ownRequest` 和 `tagUsage` 按原语义实现。
- [ ] 两个导入的函数内联（`reminderText`、`openTurnAt`）：未实现。

A4a 至 A4d：

- [ ] `tools.ts`：去掉的工具、`stop_bot` 的权限判断、`attachRoleTools` 的调用点已做；团队工具名单没有裁（4.5）。
- [ ] `roster.ts`：预设可指定、自动建 Chief 已去掉；头像、私密 bot、浏览器授权、复制没有去掉（4.6）。
- [ ] `parts.ts`：调用点走补位已做；四个界面函数没有去掉（4.7）。
- [x] 删掉不搬的文件（338 个）；改提示词文字。`btw` 和 `schedules` 留下（4.4）。
- [x] 删除之后测试通过；随模块一起删掉的测试见 `rewrite/INVENTORY.md`。

A5（2026-11-13 重写）：

- [x] 注册表加 `preset`、`effort`；`coding` 预设；`createBot` 设推理强度。
- [x] `run_tests`、`request_review`、门面 `runReview` 和审查用量。
- [x] 删掉 Claude Code 路线：`bot/src/host/local-agents/`、`core/engine/`、`reportEngineUsage`、记录器的推理行解析、`bridgedToolNames`、`codingOptions`，以及它们的测试。
- [ ] 真实运行验证 `runReview`（待批准的对比运行）。

## 7. 验收

- 只装保留的模块和补位文件，测试里用门面建五个 bot 和一个群、发一条消息，群里跑完一轮，过程中没有“函数不存在”的错误。
- 建 bot 不产生自动问候。
- 一次运行结束后，五个 bot 和群都能删掉，bot 层的状态文件里没有残留。
- coding bot 的会话有 DSH 的读写改工具和它的角色工具，没有 shell、网络、子 agent 工具（冒烟检查）；`run_tests` 运行的命令的环境里没有 Slack、Jira、GitLab、Anthropic 的令牌。
- 审查者的会话是 `readonly` 预设，只有读和搜索的工具，不能改文件。
- 走 API 的 bot 的工具列表里没有写文件、命令行、网页工具，也没有被去掉的 DS Bot 工具。
- 提示词里搜不到任何已去掉的工具名。
