# 细分规格 5：bot 层搬运

- 日期：2026-11-11
- 覆盖的工作包：A1（全量拷入和基线测试）、A2（入口、安装顺序、门面）、A3（补位文件）、A4a 至 A4d（裁剪）、A5（Claude Code 驱动修正）。
- 上位文档：[kickoff-plan.zh.md](kickoff-plan.zh.md) 第 2、3、4 节；[software-spec.zh.md](software-spec.zh.md) 5.5、6.5。
- 角色标识见规格 1；记录器、看门狗、工具对门面的用法见规格 2、3、4。
- 状态：2026-11-12 按代码（提交 192a721）更新。最初是 2026-11-11 开工前的设计；和原设计不同的地方已直接改成现状，代码还没做到的标“未实现”。
- 用量和费用：门面有 `onUsage`（`src/task/botlayer.ts`）。API bot 的用量由门面每轮读 DSH 自己的会话统计，两次读数之差就是这一轮；Coding bot 的由适配器的 `reportUsage` 经 `index.ts` 交给门面的 `reportEngineUsage`，每个模型一条（审查子 agent 的模型单独一条），费用取命令行报的 `costUSD`。记账见 `src/task/usage.ts`、`pricing.ts`。
- 位置：DS Bot 的拷贝是和 `src/` 并列的独立目录 `bot/`（`bot/src/host`、`bot/src/shared`、`bot/test`）；代码是 TypeScript（`.ts`）。下面的位置写文件名和函数名，不写行号，因为文件已经变了。

## 1. 范围

管：从 DS Bot 0.3.1 搬哪些文件；新的入口；任务层调用 bot 层的门面；被去掉模块留下的调用点怎么补；四个文件怎么裁剪；Claude Code 驱动和审查子 agent。

不管：DSH 本身（原样使用，不改源码）；任务层（规格 1 至 4）；提示词的内容和 DSH 的配置补丁（规格 6）。

原则：bot 是什么、怎么建、怎么在群里互相叫，沿用 DS Bot，不另外发明。改动只有三类：去掉不用的；补上被去掉部分留下的缺口；让 Claude Code 的接入符合无人值守。

## 2. 数据形状

bot 层自己的状态文件、bot 记录、群记录、转交记录的形状都沿用 DS Bot，不改。

任务层给 bot 层加的只有一张内存里的绑定表：bot 编号到“任务编号和角色”的对应。它由运行器在启动一次运行时写入、结束时清除，用来从一个会话查出它属于哪个任务、哪个角色。

## 3. 接口：bot 层门面（I1）

文件：`src/task/botlayer.ts`（由 `createBotLayer(rt)` 建出，`src/bot/index.ts` 调用它）。任务层只通过它调用 bot 层。右两列是它包住的 DS Bot 函数。

| 门面函数 | 作用 | DS Bot 里的对应 | 位置 |
|---|---|---|---|
| `createBot({ name, label, instructions, model, permission, preset })` | 建一个 bot，不发自动问候，返回 bot 编号 | `createBot`，再 `updateBot` 设模型和权限 | `roster.ts` 的 `createBot`、`updateBot` |
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

门面之外，bot 层还要在三处回调任务层：

| 回调 | 在哪里调 | 作用 |
|---|---|---|
| `attachRoleTools(agent)` | 为一个会话准备工具时 | 挂上这个角色的工具（规格 4） |
| `bridgedToolNames(sessionId)` | 组出递给 Claude Code 的工具名单时 | 把这个角色的工具并进去（规格 4） |
| `codingOptions(taskId)` | 组 Coding bot 的 Claude Code 进程参数时 | 给出该任务绑定里的测试命令（`runner.codingOptions`）；没有时用插件级的 `testCommands` |

三个回调都在 `src/app.ts` 里作为 `taskLayer` 传出。`src/bot/index.ts` 导出 `connectTaskLayer(facade, taskLayer)`（由 `src/plugin.ts` 在应用建好后调用；门面先建，因为任务层需要它）和 `runtimeOf(facade)`（把内部对象给测试和 Claude Code 启动代码用）。

## 4. 行为规则

### 4.1 搬哪些文件（A1）

A1 先把 DS Bot 的 `src/host/` 和 `src/shared/` 全部拷入工程，连同测试和夹具，让 DS Bot 自己的测试在新工程里通过。拷贝没有放在 `src/bot/` 下，而是独立的目录 `bot/`（`bot/src/host`、`bot/src/shared`、`bot/test`），DS Bot 的模块就在那里原地修改。`src/bot/` 里只有 `index.ts`（入口）和 `stubs.ts`（补位）。没用到的文件随后从 `bot/` 删掉了（338 个，提交 3963783；数量和测试情况见 `rewrite/INVENTORY.zh.md`）。拷贝的测试脚本是 `test:bot`：删除前 1828 项，删除后 136 项（134 过，2 跳过；少掉的是随模块一起删掉的测试）。

最终留下的文件：

| 类别 | 文件 |
|---|---|
| 保留 | `diagnostics`、`store`、`home-lock`、`files`、`models`、`permissions`、`turns`、`handoffs`、`requests`、`delivery`、`chat-index`、`groups`、`approvals`、`resume`、`prompt`、`time-context`、`constants`、`text`、`links`、`steward`，`shared/` 下三个文件，`local-agents/` 下的 `index`、`adapter`、`claude-engine`、`launch`、`mcp`、`discover`、`engines`（驱动本身是 `src/engine/claude.ts`，见 4.9） |
| 部分保留 | `roster`、`folders`、`tools`、`parts`（没有裁完，见 4.5 至 4.7） |
| 因为被引用而保留 | `btw`、`schedules`（见 4.4） |
| 不搬 | 界面、浏览器、电脑操控、连接器与邮件、聊天平台桥接、办公技能、记忆与学习、目标、日程、头像库、密钥、用量统计、自更新、网页接口（`channel`、`feed`）、`local-agents/` 下的 `acp`、`codex`、`jsonrpc`、`claude`（最后一个由 `src/engine/claude.ts` 取代） |

### 4.2 入口和安装顺序（A2）

- 新入口声明依赖七个 DSH 服务：模型调用、工具、系统提示词、会话控制、会话存储、会话标题、工作区。原来的第八个“网页连接”只有被去掉的 `channel` 和 `feed` 使用，去掉。
- 安装顺序：`diagnostics`、补位文件、`store`、`models`、`permissions`、`turns`、`handoffs`、`requests`、`delivery`、`roster`、`folders`、`prompt`、`time-context`、`tools`、`chat-index`、`groups`、`approvals`、`resume`、`parts`、`local-agents`，最后是任务层。代码里 `src/bot/index.ts` 按这个顺序装到 `local-agents` 为止并建出门面；任务层（`src/app.ts`）随后由 `src/plugin.ts` 建，再用 `connectTaskLayer` 交给 bot 层。入口导出 `createRuntime(ctx, config)`；`config` 还带着 Claude Code 启动代码要读的内容（见 4.9）。
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

### 4.9 Claude Code 驱动（A5）

DS Bot 自己的 `local-agents/claude.js` 已删。驱动是 `src/engine/claude.ts` 里的 `ClaudeSession`；参数由 `src/engine/args.ts`（`claudeArgs`、`codingArgs`）组出，环境变量由 `src/engine/env.ts` 组出。在 `bot/src/host/local-agents/` 里，`claude-engine.ts` 为每个 DSH 会话持有一个 `ClaudeSession`，`launch.ts`（`launchFor`）为每个进程组出参数和环境。

| 改动 | 内容 | 在哪里 |
|---|---|---|
| 修环境变量 | 原代码读错了对象（`this.engine.env` 应为 `this.engine.engine.env`），额外环境变量不生效。这段代码已不存在：环境变量由 `claude-engine.ts` 交给 `ClaudeSession.start` | `claude-engine.ts`、`src/engine/claude.ts` |
| 环境变量只放行指定的 | `childEnv` 只放行一个名单：`PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`LANG`、`TERM`、`TMPDIR` 和 `LC_*`，加上调用方明确给的额外变量。其余一律不放行，所以 Slack、Jira、GitLab、Anthropic 的令牌不会误传给子进程 | `src/engine/env.ts` |
| 认证方式可配 | 配置项 `engineAuth`（`src/config.ts`，`src/plugin.ts` 的 `engineSettings`）：`login` 时不传任何密钥，Claude Code 用本机已登录的账号（演示阶段）；`apiKey` 时以 `ANTHROPIC_API_KEY` 传入（部署阶段；密钥从环境变量读，不放配置文件） | `src/engine/env.ts` 的 `authEnv`、`launch.ts` |
| 去掉其他驱动 | 只创建 Claude 引擎。`engines.ts` 很小：只有一项 `claude-code`，没有模式 | `local-agents/index.ts`、`engines.ts` |
| 递给 Claude Code 的工具 | `bridgedToolNames(sessionId)` 的结果并入经 MCP 桥传过去的名单 | `launch.ts` 的 `bridgeNames`、`index.ts` 的 `toolsFor` |
| 启动参数 | 由一个函数组出；增加了什么、Coding bot 用什么，见本节末尾的参数表 | `src/engine/args.ts` |
| 权限模式 | Coding bot 用 V0 确定的无人值守配法（本节末尾的参数表）。DSH 权限预设的映射（`CLI_MODES`）只用于其他 Claude 会话 | `args.ts` 的 `codingArgs`、`launch.ts` |
| 权限请求 | 按无人值守配法，不应再出现。万一出现，仍按原来的方式变成一条审批（`approve_agent_action`），由监控拒绝；拒绝一定带原因文字；没人应答的请求由驱动在 `permissionTimeoutMs`（默认 5 分钟）后拒绝，因为命令行自己不会超时 | `adapter.ts`、`src/engine/claude.ts`、`launch.ts` |
| 测试命令 | 每条配置的测试命令生成两条放行规则：精确的 `Bash(<命令>)` 和前缀的 `Bash(<命令>:*)`；命令本身是复合的（`&&`、`;`、`|`、重定向）或带通配符时，只给精确规则。同一份命令清单也写进系统文字，并要求原样运行。清单来自任务的绑定（`codingOptions(taskId)`），没有时用插件级的 `testCommands` | `args.ts` 的 `testRules`、`launch.ts` 的 `withTestCommands` |
| 和机器主人的指令文件隔离 | 只靠 `--setting-sources project` 不够：命令行还会读工作目录所有上级目录里的 `CLAUDE.md` 和 `.claude/rules/`，而工作树在主人的主目录下面，主人的 `~/.claude/CLAUDE.md` 和规则就被读进去了（2026-11-12 的真实运行里发现）。现在每个进程加 `--settings {claudeMdExcludes: [...]}`，排除工作目录以上的指令文件和用户的配置目录，仓库自己的文件保留。另外设 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`。`engineAuth` 为 `apiKey` 时每个会话还有自己的 `CLAUDE_CONFIG_DIR`；`login` 时做不到（登录信息属于用户的配置目录） | `env.ts` 的 `isolationSettings`、`launch.ts` 的 `engineIsolation` |
| 进程空闲 | 命令行进程最后一次输出后 10 分钟没有动静就被关掉（时间可由运行时配置 `idleCloseMs` 改，测试用）。一轮还在跑（状态 `running`，比如一段很久没输出的测试）时不关，计时器重新计时；只有等桥接工具调用或权限回答的轮次可以被关。Coding bot 的会话不保存（`--no-session-persistence`），所以下一条消息会启动新进程，适配器把对话重放给它：系统文字，加最近最多 12 条消息（不超过 24 KB），并且一定带最新的输入。`test/bot/idle-replay.test.ts` 用假命令行验证了重放，见规格 7 第 4.11 节 | `adapter.ts`（`arm`、`idleCloseOf`、`closeLive`、`renderReplay`） |
| 推理强度 | 配置项 `codingEffort`（默认 `high`，可取 `low`、`medium`、`high`、`xhigh`、`max`）作为 `--effort` 传给 Coding bot 的命令行；审查子 agent 的定义里也写明同样的模型和强度 | `args.ts` 的 `EFFORT_LEVELS`、`launch.ts` |
| 模型目录 | `listModels` 除别名外还列出有价格的完整模型名和配置的 Coding 模型，否则固定到某个完整名的 bot 会被当成“目录里没有”而退回默认 | `claude-engine.ts` |

其他 Claude 会话（没有绑定到 Coding 角色的会话）用 `claudeArgs` 启动，MCP 服务名是 `dsbot`；Coding bot 的服务名是 `chat-to-fix`，它的工具名是 `mcp__chat-to-fix__<工具名>`。本项目里只有 Coding bot 跑在 Claude Code 上，所以任务中不会走 `dsbot` 这条路。

审查子 agent：

- 只在角色在 bot 注册表（`src/registry/bots.ts`）里带 `reviewer` 的会话里传，即 `coding`。
- 用 Claude Code 启动时定义子 agent 的参数传入一段 JSON：名字 `reviewer`，它的描述，它的提示词（`src/prompts/reviewer.md`，由 bot 注册表里 coding 的 `reviewer` 指定），它可用的工具（只有读和搜索：`Read`、`Grep`、`Glob`）。
- 限定工具的字段是 `tools`，值是工具名数组（V0 已在命令行 2.1.321 上确认，见下表）。

V0（本机演示验证）已在 2026-11-11 用本机的 Claude Code 命令行 2.1.321 做完。命令行没有登录，所以验证到的是启动参数和收发格式；需要真实模型回答的部分列在表后。

| 结论 | 内容 |
|---|---|
| 必须加 `-p` | 不加 `-p`，双向逐行 JSON 不工作 |
| 就绪信号 | 以 `initialize` 控制请求的应答为准。`system/init` 要等第一条用户消息发出后才出现，而且每一轮都会再出现一次，不能当作就绪信号 |
| 失败的判断 | 看 `result` 里的 `is_error` 是否为真。失败时 `subtype` 仍可能是 `success` |
| 打断 | 打断的控制请求必须带 `request_id` |
| 权限请求 | 加 `--permission-prompt-tool stdio` 后，权限请求以控制请求的形式从标准输出送来 |
| 隔离本机个人设置 | 用 `--setting-sources project`，本机用户级的 MCP 和技能不会被加载 |
| 子 agent 的字段 | `--agents` 的 JSON 接受 `description`、`prompt`、`tools`（工具名数组）、`model` |
| 内置工具的筛选 | `--tools`、`--disallowedTools` 生效。开着 Bash 时内置工具里没有 Glob 和 Grep |
| 输入格式 | 标准输入里只要有一行不是 JSON，进程就退出 |
| DS Bot 的驱动 | 原样不能驱动 2.1.321：它等 `system/init` 后才发第一条消息，把失败结果当成功，不加 `-p`，打断不带编号。我们的驱动（`src/engine/claude.ts`）已按上面各条改好，并对真实命令行跑通了收发 |

命令行登录后，同一天又用真实模型做了 18 次实验（都在临时目录的小仓库里），结论如下。

| 结论 | 内容 |
|---|---|
| 真实一轮的消息顺序 | `initialize` 的应答；用户消息发出后的 `system/init`；每次工具调用是一条带 `tool_use` 的 `assistant` 和一条带 `tool_result` 的 `user`；最后是文字和 `result`。文件确实被改了 |
| 权限请求的应答格式 | 允许是 `{behavior:"allow", updatedInput}`；拒绝必须带文字 `{behavior:"deny", message}`。不带 `message` 的拒绝被命令行判为无效 |
| 不应答的后果 | 这一轮一直卡住，没有超时。所以驱动要给权限请求加超时 |
| 接受编辑模式下还会问的 | 运行脚本、`curl`、写目录外的文件、网页抓取、向用户提问。目录内的编辑和只读的 git 命令不问 |
| 无人值守的配法 | `--permission-mode acceptEdits` 加 `--permission-prompts none`，再用 `--allowedTools` 只列出具体的项目命令和我们的工具。这样完全不出现权限请求；目录外的写入、网络访问、没列出的命令被直接拒绝，模型收到拒绝原因后继续 |
| 两个不能用的配法 | 在 `--allowedTools` 里写不带范围的 `Read`、`Edit`、`Write`，目录外的写入会被放行；`--permission-mode dontAsk` 会连目录内的编辑也拒绝 |
| reviewer | 主 agent 通过 `Agent` 工具调起它。它的消息带 `parent_tool_use_id`；它的最终结论只出现在这次工具调用的结果里，不作为单独的回答出现。`tools` 写成 `["Read","Grep","Glob"]` 时它只有这三个工具；不写 `tools` 时它继承全部工具，包括我们的工具 |
| 我们的工具（经 MCP） | 模型看到的名字是 `mcp__<服务名>__<工具名>`。要先被 `ToolSearch` 加载，所以 `--tools` 里要留 `ToolSearch`。不列进 `--allowedTools` 就会触发权限请求 |
| 轮数上限 | 到上限时收到 `result`，`subtype` 是 `error_max_turns`，`is_error` 为真，没有 `result` 文字，原因在 `errors` 里。进程还活着，可以接下一条消息 |
| 打断 | 工具运行中被打断：工具进程被杀掉，`result` 的 `terminal_reason` 是 `aborted_tools`；模型输出中被打断是 `aborted_streaming`。同一个进程可以接着收新消息 |
| 第二轮和会话文件 | 同一进程的第二条消息保留上下文。会话文件写在 `~/.claude/projects/<工作目录>/` 下；`--no-session-persistence` 不写会话文件，但目录和里面的 `memory/` 仍会创建 |
| 默认模型 | 不指定时是 `claude-opus-5-5`；`--model` 可以改 |
| 内置工具 | 默认列表里有提问、定时、网页等工具，用 `--tools` 收窄；在 `--tools` 里写上 `Glob`、`Grep`，主 agent 就有这两个工具 |

Coding bot 的启动参数由此确定为：

```
-p --input-format stream-json --output-format stream-json --verbose
--permission-prompt-tool stdio --permission-prompts none
--setting-sources project
--settings {"claudeMdExcludes": [...]}
--append-system-prompt <系统文字，含测试命令>
--permission-mode acceptEdits
--tools Read,Edit,Write,Bash,Glob,Grep,Agent,ToolSearch
--allowedTools <我们的工具>,Bash(git status:*),Bash(git diff:*),Bash(<测试命令>),Bash(<测试命令>:*)
--no-session-persistence
--mcp-config <只含我们的 MCP 服务> --strict-mcp-config
--max-turns <上限>
--agents <reviewer 的定义，tools 为 Read、Grep、Glob>
```

上面是 `codingArgs` 实际组出的参数；相比实验确定的那一组，增加了 `--settings`、`--append-system-prompt`、`--no-session-persistence` 和测试命令的前缀规则，其中 `--settings` 和前缀规则来自 2026-11-12 的真实运行。V0 那组参数实测：没有出现权限请求；改文件、`git diff`、测试命令、reviewer、我们的工具都执行了；目录外的写入和 `curl` 被拒绝。

驱动接进 bot 层之后（同一天），又在 bot 层里用真实模型跑了 Coding bot 的一轮，补充三条：

| 结论 | 内容 |
|---|---|
| MCP 走 HTTP 可用 | bot 层的本机 HTTP MCP 服务被真实命令行连上，`task_read` 和 `review_report` 都经它调用成功，审查结论写进了任务。DS Bot 原代码在这里有一个缺陷（工具列表请求一律返回 500），已修 |
| 子 agent 默认在后台运行 | 不处理的话，这一轮会在 reviewer 回答之前结束。给 Coding bot 的进程设环境变量 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 后，reviewer 在这一轮内运行并返回结论 |
| 我们的工具要先加载 | 模型不会自己想到去加载。Coding bot 的指令里写明了用工具搜索按全名加载；写明之后，只靠指令它就完成了读任务、改代码、跑测试、调 reviewer、上报结论 |

此后代码里已经处理的：

- 带参数的测试命令的匹配写法：一条精确规则加一条前缀规则 `:*`，因为 2026-11-12 的真实运行里，只给精确规则时模型跑测试被拒绝了。
- 进程空闲关闭后重新启动并续上对话：适配器把对话重放给新进程（见上表）。已修一个错误：原来计时器到点就关，哪怕这一轮还在跑。重放和这个修法用假命令行测过（`test/bot/idle-replay.test.ts`）；空闲关闭再重启还没有对真实命令行跑过。
- `memory/` 目录让两次任务互相带入内容：自动记忆已关（`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`），`apiKey` 方式下命令行的状态放在私有目录里。效果是读命令行代码得出的，没有实测。
- 主人的 `CLAUDE.md` 被读进去：2026-11-12 的真实运行里发现，已用 `claudeMdExcludes` 处理（见上表）。

还没有验证的：后台任务关掉后，是否还会有迟到的事件混进下一轮；用 API 密钥方式登录（`engineAuth` 为 `apiKey`，含私有配置目录）的真实运行。

## 5. 代码参考

本节列的是上面各表之外的位置：`DSB:` 是原版 DS Bot 0.3.1（`.js` 文件名和行号都是原仓库的，2026-11-11 核对，不是本工程的），`CC:` 是 Claude Code 的参数。本工程里对应的代码按函数名找。

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
| `DSB:src/host/local-agents/index.js:82` | 权限预设的取法：群的预设优先，其次 bot 的，默认 `workspace-write` |
| `DSB:src/host/local-agents/claude.js:129`、`:164` | 权限请求；中断指令 |
| `DSB:src/host/local-agents/mcp.js:30` | 本机 MCP 服务（本工程里是 `bot/src/host/local-agents/mcp.ts` 的 `LoopbackMcp`） |
| `DSB:test/fake-ctx.js`、`test/fixtures/fake-claude.mjs` | 假的 DSH 上下文（本工程里是 `bot/test/fake-ctx.ts`）；假的 Claude Code（本工程里是 `test/fixtures/fake-claude.ts`） |
| `CC:` `--agents` | 启动时用 JSON 定义子 agent |
| `CC:` `--strict-mcp-config`、`--setting-sources`、`--max-turns`、`--tools`、`--disallowedTools` | 只加载指定的 MCP 配置；指定设置来源；回合数上限；限定内置工具 |

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
- [x] 删除之后测试通过；随模块一起删掉的测试见 `rewrite/INVENTORY.zh.md`。

A5：

- [x] 环境变量：放行名单（原来的错误随 `claude.js` 一起没了）。
- [x] `engineAuth` 两种方式。
- [x] 去掉 ACP 和 Codex 驱动。
- [x] 工具名单并入角色工具。
- [x] 启动参数：审查子 agent、只加载指定 MCP 配置、回合数上限，以及 `--no-session-persistence`、`--settings`、`--append-system-prompt`。
- [x] 按 V0 的结论改驱动：加 `-p` 和 `--setting-sources project`；就绪信号、失败判断、打断编号、权限请求按 4.9 的表处理。
- [x] 测试命令的精确规则加前缀规则；和主人指令文件的隔离；空闲关闭后的重放。

## 7. 验收

- 只装保留的模块和补位文件，测试里用门面建五个 bot 和一个群、发一条消息，群里跑完一轮，过程中没有“函数不存在”的错误。
- 建 bot 不产生自动问候。
- 一次运行结束后，五个 bot 和群都能删掉，bot 层的状态文件里没有残留。
- coding bot 的 Claude Code 进程的环境里没有 Slack、Jira、GitLab 的令牌；`engineAuth` 为 `login` 时也没有 Anthropic 的密钥。
- coding bot 的 Claude Code 里能调用它的四个角色工具；审查子 agent 只有读和搜索的工具，不能改文件。
- 走 API 的 bot 的工具列表里没有写文件、命令行、网页工具，也没有被去掉的 DS Bot 工具。
- 提示词里搜不到任何已去掉的工具名。
