# 自动修复 Bot：开工方案

- 日期：2026-11-11
- 前提：方案和选型依据见 [decision-record.md](decision-record.md)。
- 状态：本文的文件清单、函数签名和行号来自阅读 DS Bot 0.3.1 源码（`~/Documents/mywork/ds-bot/upstream/DS-Bot-0.3.1`），没有运行过。第 9 节列出需要运行确认的项。
- 2026-11-12 注：本文已是历史文档，记录开工前的计划。之后代码改成了 TypeScript，bot 层放在 `bot/`，结构和本文不同；现状以 software-spec 和 spec-1 至 spec-6 为准。第 6 节的容器镜像还没做，仍可当部署待办看。
- 2026-11-13：Coding bot 改为 DSH 原生，五个 bot 共用一个 Anthropic API key，Claude Code 路线已删，见 [plan-dsh-coding.md](plan-dsh-coding.md)。本文里关于 Claude Code、MCP 桥、`--agents` 审查子 agent 的部分都只是历史。

## 1. 工程结构

新建一个工程，包含三部分，部署在同一个容器里。

| 部分 | 内容 |
|---|---|
| bot 层 | 从 DS Bot 搬来的文件，作为 DSH 的一个插件加载 |
| 任务层 | 新写：任务表、队列、看门狗监听、步骤把关、各 bot 的专属工具、提示词 |
| 镜像 | 照 DS Bot 的 `docker/` 改：DSH `0.2.2-rc.1`、Claude Code、本工程的插件 |

看门狗和 bot 层在同一个 DSH 进程里。看门狗自己开一个只供内部调用的 HTTP 端口接收 Slack 事件，做法与 DS Bot 给 Claude Code 开本机 MCP 端口相同（`node:http`）。进程崩溃时两者一起重启，由搬来的重启恢复逻辑接续。

## 2. 从 DS Bot 搬的文件

路径都在 `ds-bot/src/host/` 下。

### 2.1 保留

| 文件 | 行数 | 作用 |
|---|---|---|
| diagnostics.js | 257 | 日志和告警；`store` 安装时就要用它，必须最先安装 |
| store.js、home-lock.js、files.js | 684 | 状态文件的读写、加锁、会话到 bot 和群的索引 |
| models.js | 314 | 模型目录、给会话选模型 |
| permissions.js | 117 | 每个 bot、每个群的权限预设 |
| turns.js | 1149 | 回合跟踪、把做完的答复送回派活方、失败处理、停止 |
| handoffs.js | 330 | 派活树 |
| requests.js | 141 | 请求去重 |
| delivery.js | 172 | 把消息投进某个 bot 的会话 |
| chat-index.js | 293 | 读自己的历史对话 |
| groups.js | 1508 | 群记录、成员的群内会话、轮次与 @、往群里发言 |
| approvals.js | 116 | 群内隐藏会话的审批应答 |
| resume.js | 445 | 重启后重发和续跑；它包裹 `deliver`，必须在 delivery 之后安装 |
| prompt.js | 73 | 团队规则和身份提示词（文字要改） |
| time-context.js | 46 | 给 bot 注入当前时间 |
| local-agents/ 下的 index、adapter、claude、mcp、discover、engines | 1241 | Claude Code 接入；去掉对 Codex 和 ACP 驱动的引用 |
| constants.js、text.js、links.js、steward.js、shared/ 下三个文件 | 约 580 | 公共常量和辅助函数 |

### 2.2 部分保留

| 文件 | 行数 | 保留 | 去掉 |
|---|---|---|---|
| roster.js | 789 | 建会话、建 bot、改 bot、删 bot、建群、改群、删群 | 头像、私密 bot、自动创建 Chief、复制 bot |
| folders.js | 230 | 工作目录和目录检查 | 界面用的目录选择 |
| tools.js | 1187 | `list_bots`、`message_bot`、`stop_bot`、`post_to_group`，以及把工具挂到各会话的机制 | 能力相关的五个工具、`ask_user`、`show_view`、连接器屏蔽、目标相关的拦截 |
| parts.js | 1632 | 长对话的分段和切换 | 界面分页 |

### 2.3 不搬

界面（`src/client`，约 2.25 万行）、浏览器、电脑操控、连接器与邮件、聊天平台桥接、办公技能、记忆与学习、目标、日程、头像库、密钥界面、用量统计、自更新、网页接口（`channel.js`、`feed.js`）。

搬过来的代码合计约 1.1 万至 1.2 万行。

## 3. 去掉模块后必须补上的调用点

保留的文件里有下列对被去掉模块的直接调用，缺了会在运行时报错。新工程里用一个补位文件提供它们。

| 调用方 | 被调用的函数 | 原属模块 | 补位做法 |
|---|---|---|---|
| delivery.js:84，groups.js:290、318，parts.js:817、1109 | `ensureCapabilities` | 能力 | 空函数 |
| groups.js:1464，parts.js:1385、645 | `ownRequest`、`tagUsage` | 用量统计 | 必须保留原语义：用一张弱引用表标记插件自己发出的模型请求并判断归属。返回固定值会让群聊中继把这些请求当成群消息拦截 |
| parts.js:695、980 | `renewMemory` | 记忆 | 空函数 |
| parts.js:982 | `moveSchedules` | 日程 | 空函数 |
| roster.js:653、706 | `archiveGroupMemory`、`archiveBotMemory` | 记忆 | 空函数 |
| roster.js:741 | `forgetBotSecrets` | 密钥 | 空函数 |
| roster.js:161、585，folders.js:140 | `privateClash` | 私密 bot | 返回无冲突 |
| roster.js:331，tools.js:429 | `checkPrivacyChange` | 私密 bot | 空函数 |
| roster.js:486 | `checkNoPrivate` | 私密 bot | 空函数 |
| groups.js:932 | `imagesForGroup` | 图片识别 | 返回空列表 |
| turns.js:12（导入） | `reminderText` | 日程 | 把这个函数内联进来 |
| parts.js:19（导入） | `openTurnAt` | 旁支对话 | 把这个函数内联进来 |

另外，`uiLanguage` 缺失时，建群问候语和 bot 的首条问候会默认要求用中文（groups.js:174，roster.js:12），需要提供这个函数。

## 4. 对搬来代码的改动

| 位置 | 改动 | 原因 |
|---|---|---|
| 入口文件 | 新写安装顺序；依赖列表去掉“网页连接”；把内部对象保留下来给任务层使用 | 原入口建好内部对象后不对外提供；网页连接只有被去掉的 `channel.js` 和 `feed.js` 使用 |
| local-agents/claude.js:82 | `this.engine.env` 改为 `this.engine.engine.env` | 原代码读错了对象，Claude 驱动的额外环境变量配置不生效（Codex 和 ACP 驱动是对的） |
| local-agents/engines.js | 给 `claude-code` 加上额外环境变量，把公司的 Anthropic API 密钥传进去 | 原代码在 discover.js:11–14 特意删掉了这个变量 |
| local-agents/discover.js 的 `cleanEnv` | 从“删掉指定变量”改成“只放行指定变量” | 原实现只删掉几个指定变量和 `DS_BOT_`、`DSH_` 开头的变量，其余全部传给 Claude Code。Slack、Jira、GitLab 的令牌若放在进程环境里，会被 Claude Code 继承 |
| roster.js 的 `botPreset` | 把固定的 `standard` 预设换成我们自己的只读预设 | 走 API 的四个 bot 不应该有写文件、命令行、网页工具 |
| prompt.js、groups.js:170 | 删掉提到已去掉工具的句子（记忆、电脑操控、`ask_user`、`show_view`、`create_bot`、`group_goal` 等） | 否则 bot 会尝试调用不存在的工具 |

只读预设用 DSH 的配置补丁定义（文件工具关闭写和改，保留搜索；不含命令行和网页工具），不改 DSH 源码。

## 5. 新写的模块

### 5.1 任务表与队列

- 字段：任务编号、Slack 讨论的位置、发起人、群编号、当前步骤、Jira 单号、分支、MR 链接、状态、每次运行的起止时间和结束原因。
- 执行记录：每一步由哪个 bot 做、调用了哪些工具、结果、耗时。由系统从群里的每一行发言（`onRoomLine`）和会话的工具调用事件自动生成，bot 不用另外上报。主 bot 可以读全部记录。
- 队列：按到达顺序执行；并发数是配置项，默认 1。
- Slack 事件按事件编号去重，同一个 @ 只建一个任务。

### 5.2 看门狗监听

- 接收同事那边转来的 Slack @ 事件，建任务，入队。
- 接口的字段需要和负责 Slack 的同事约定（见第 8 节）。

### 5.3 任务运行

用到的 DS Bot 函数都已存在：

| 动作 | 函数 | 说明 |
|---|---|---|
| 建 bot | `createBot`（roster.js:140） | 传名字、角色、说明、模型、工作目录。先以“稍后选模型”方式创建并清掉待发的问候，再设置模型和权限，可以避免自动问候 |
| 建群 | `createRoom`（roster.js:493） | 传成员、管理员、模式、群公告。管理员指定为本任务的主 bot，模式用“管理员”模式 |
| 设群目录和权限 | `updateRoom`（roster.js:579） | 工作目录指向本任务的代码目录 |
| 把任务交给群 | `sendUser`（channel.js:670） | 这个函数在被去掉的文件里，需要搬进任务层。它以用户身份向群发一条消息，管理员模式下由主 bot 接手 |
| 观察进度 | `activityView`、`workView`、`roomWorkView`、`waitingView`、`statusOf`、`onRoomLine` | 每个 bot 在做什么、在等谁；群里每一行发言和系统通知 |
| 判断群已安静 | 无进行中的轮次、无成员在工作、无待完成的批次、群收件箱为空 | DS Bot 的目标功能用的是同一组条件（goals.js:613–615） |
| 停止 | `stopRoomWork`（groups.js:1378） | 停掉整群 |
| 收尾 | `deleteRoom`（roster.js:649）、`deleteBot`（roster.js:701） | 删群前要先停止；见下面关于 Main 的说明 |

两个要绕开的限制：

- `deleteBot` 不允许删除 Main 角色的 bot，并且团队里必须始终保留至少一个 Main。每个任务的主 bot 只做群管理员，不设为 Main，和工人一样由系统新建和删除。这条遗留限制在搬来的代码里处理：去掉这项检查，或保留一个不参与任务的 Main。第 2 天搬代码时定。
- 群规则里，被叫的 bot 调用过团队工具名单（constants.js:65）之外的工具才算“干了活”，叫它的 bot 才会被自动唤醒（groups.js:814–819、871–889）。我们新加的工具不在这份名单里，调用它们算干了活。coding bot 向 Git Pipeline bot 要代码也做成一个新工具，并加进递给 Claude Code 的工具里（local-agents/index.js:96–100 目前只递团队工具）。Claude Code 在自己进程里读写文件不经过 DSH，不计入；`message_bot` 在名单里，也不计入。

### 5.4 步骤把关

- 步骤写在任务上，只有 `推进步骤` 这个工具能改。
- 每一步有完成条件，由代码检查：有摘要才能进入建单；有 Jira 单号才能进入备代码；代码目录里有改动并且记有“审查通过”才能进入开 MR；有 MR 链接才能进入回写。完整的步骤表见 [software-spec.md](software-spec.md) 5.2 节。
- “待补充信息”需要任务上同时记有主 bot 和coding bot 的确认。

### 5.5 各 bot 的专属工具

- 在每个 bot 的会话建立时，按角色把工具注册到该会话自己的范围里，做法与 DS Bot 的 `shareBotTools`（tools.js:793）相同。
- 工具是进程内函数，令牌由工具从配置里读取，不出现在任何 bot 的对话或环境里。
- coding bot 走 Claude Code 线路时只能拿到团队工具（local-agents/index.js:96–100），这符合“coding bot 只调用 Claude Code”。

工具清单的逐项评估见 [tools-and-limits.md](tools-and-limits.md) 第 2 节。

### 5.6 提示词

| 写在哪 | 内容 |
|---|---|
| 每个 bot 的说明 | 只负责自己的系统；做完自己这一轮后说明结果，由系统交回主 bot |
| 群公告 | 步骤顺序；步骤经主 bot 推进；步骤内可以直接互相 @；信息不足的处理办法 |
| 团队规则（prompt.js） | 保留 DS Bot 关于派活的规则，删掉已去掉功能的句子 |

群公告会加进每个成员在群里的提示词（groups.js:334）。

### 5.7 审批

- 镜像里把权限预设设为完全访问、审批设为不询问，与 DS Bot 的 Docker 配置相同。
- 审批由任务层统一管理：它监听审批事件（`onApproval`），出现时按规则应答并记到任务上。没人应答的审批会让回合一直等下去（approvals.js:26–95）。

## 6. 镜像

照 DS Bot 的 `docker/Dockerfile` 和 `docker/entrypoint.sh`：

1. 构建阶段安装固定版本的 DSH（`0.2.2-rc.1`），把本工程的插件打包并装进一份模板配置。
2. 运行阶段安装固定版本的 Claude Code。
3. 首次启动时把模板配置拷到数据目录，之后以 `dsh --profile web` 启动，只监听本机。
4. 配置补丁里写：权限预设、bot 的工作目录、Anthropic 的模型线路（密钥用环境变量引用）、默认模型、只读预设。
5. 设置 `DSH_TELEMETRY_DISABLED=1`。
6. 数据目录和代码目录各挂一个卷。

网页界面保留，只监听本机，用来看每个群里 bot 的对话。

模板配置只在数据目录为空时拷贝。升级插件后，已有的数据目录需要重新执行一次插件安装。

## 7. 开工顺序

演示阶段在本机 Mac 上运行，Claude Code 用本机已登录的账号，调通即可。这是 DS Bot 默认的用法，所以第 4 节里密钥传递的两处改动（claude.js:82、engines.js）和第 6 节的镜像不是演示的前提，放到部署到公司机器时做。本机运行没有容器边界，Claude Code 以当前用户的权限运行，演示使用测试仓库。

| 天 | 做什么 | 完成标准 |
|---|---|---|
| 第 1 天 | 在本机 Mac 上用未改动的 DS Bot 接本机已登录的 Claude Code；手工建一个走 Claude Code 的 bot 和一个走 API 的 bot；在一份代码目录里给它一张已修复的历史工单 | Claude Code 通过 bot 改了文件；启动参数确定下来；API bot 能回复 |
| 第 2 天 | 新工程：先把 DS Bot 的 host 文件全部拷入并跑通它的测试，再按 2.3 的清单逐个去掉模块，每去一个跑一遍测试；写入口和补位文件 | 从代码里建 bot、建群、投一条消息，群里跑完一轮 |
| 第 3 天 | 任务表、队列、步骤把关、专属工具（Slack、Jira、GitLab 三边都先用假响应）、提示词 | 一张历史工单走完七步，本地仓库里有改动和一条 MR 记录 |
| 第 4 天 | 接上同事的 Slack 事件和 Jira 接口；收尾和重启恢复；跑 5 到 10 张历史工单，改提示词 | 真实的 @ 能走完全程；重启后任务能接续或明确失败 |
| 第 5 天 | 部署到公司机器，只开一个频道和一个仓库，观察 | 第一个真实任务产出 MR |

Slack、Jira、GitLab 三边先用假响应，因为同事还没有给接入方案。第 4、5 天里接真实接口的部分，以方案到达为前提；方案没到时，这两天继续在假响应下跑历史工单和调提示词。工作包的并行拆解见 [implementation-guide.md](implementation-guide.md)。

第 2 天的做法是先全量拷入再逐个删除。最终留下的文件与第 2 节一致，区别是每一步都有测试对照。DS Bot 的集成测试依赖完整的模块列表和网页接口，直接挑文件搬的话这些测试用不上。

两个备用方案：

- 第 1 天如果双向逐行 JSON 在当前 Claude Code 版本上不通，先加 `-p` 参数；仍不通则改用 Claude Agent SDK 驱动 Claude Code，上层不变。
- 第 2 天如果删模块的进度落后，保留完整的 DS Bot 模块列表，只把任务层作为新模块加进去，裁剪放到上线之后。

## 8. 开工前要定的事

| 事项 | 状态 |
|---|---|
| 和负责 Slack 的同事约定事件接口：谁把 @ 事件转给看门狗，字段有哪些，Slack 和 Jira 的 API 调用由谁封装 | 问题已整理在 [questions-for-colleagues.md](questions-for-colleagues.md)，由用户去问 |
| 试点用哪个频道和哪个仓库 | 同上 |
| 部署机器 | 试用阶段用用户的这台 Mac；正式机器性能更好，另行安排（用户，2026-11-11） |
| Claude Code 的版本 | 演示阶段用本机已安装的版本；部署到公司机器时锁定 |
| 工具清单 | 评估见 [tools-and-limits.md](tools-and-limits.md) 第 2 节，当前基线 |
| 运行上限 | 初值见 [tools-and-limits.md](tools-and-limits.md) 第 4 节，当前基线，跑过历史工单后校准；含一个手工停止任务的入口 |

## 9. 需要运行确认的项

1. 不带 `-p` 的双向逐行 JSON 是否可用。DS Bot 的测试用的是假的 claude 程序（`test/fixtures/fake-claude.mjs`），没有覆盖真实命令行。
2. Claude Code 做完后，群规则是否把它算作“干了活”并唤醒主 bot。
3. 没有压缩服务和 token 计量服务时，parts.js 的长对话分段是否正常。
4. DS Bot 的集成测试在去掉模块后的通过情况。
5. 走 Anthropic 线路的 bot 在 DSH 里的表现。
6. 只读预设能否被 DS Bot 的建会话逻辑选用。
7. `request_code` 的答复是否回到coding bot 发起请求的那个会话。
8. 群的工作目录在第 3 步设置后，coding bot 的 Claude Code 是否在该目录下启动。
