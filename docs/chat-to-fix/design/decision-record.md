# 自动修复 Bot：讨论结果与选型依据

- 日期：2026-11-11
- 范围：agent 的选型和实现方式。Slack、Jira 的 API 与 bot 接入由其他同事负责，不在本文范围内。
- 目标：产品或测试在 Slack 频道里 @ 机器人后，系统自动建 Jira 单、修改代码、向开发者提交 Draft MR。要求 5 天内上线。
- 状态：本文所有结论来自阅读源码和官方文档，没有运行过任何一环。第 3.5 节列出了需要靠运行确认的项。
- 2026-11-12 注：这里的决定和理由仍然有效。软件已经按这些决定写出来并用真实模型跑过；实现细节以 software-spec 和 spec-1 至 spec-6 为准。

## 1. 约束

| 约束 | 来源 |
|---|---|
| 5 天内上线 | 用户，2026-11-11 |
| 线上可以使用 Anthropic API | 用户，2026-11-11 |
| 一个 Slack 频道绑定一个大仓库 | 用户，2026-11-11 |
| GitLab 是公司自建实例 | 用户，2026-11-11 |
| 部署机器由他人申请和负责 | 用户，2026-11-11 |
| 第一版不做编译检查，只需要一个代码目录和文件修改能力 | 用户，2026-11-11 |
| 最终形态不是桌面应用，是 CLI 或 SDK；MCP 形态以后再做 | 用户，2026-11-11 |
| 演示阶段在本机 Mac 上调通本机部署的 Claude Code 即可 | 用户，2026-11-11 |

## 2. 讨论结果

### 2.1 总体结构

| 层 | 用什么 | 怎么用 |
|---|---|---|
| 运行时 | DeepSeek Harness（DSH） | 整体打包，不改源码 |
| bot 层 | 参照 DS Bot | 从 DS Bot 挑文件搬进新工程；群聊里 bot 互相 @ 的机制保留 |
| 编码 | Claude Code 命令行 | coding bot 把活原样转给它，对接方式照搬 DS Bot 的“本地 Agent”功能 |
| 其他 bot 的模型 | Claude，走 Anthropic API | 由 DSH 自己的 agent 循环驱动 |
| 入口 | 看门狗 | 我们自己写的后端监听服务，第一个收到 Slack 的 @ |
| 任务表、步骤把关、交付 | 自建 | 见 2.3 至 2.6 |

### 2.2 成员与职责

架构里只有 bot 这一种可注册的东西。bot 按它对应的服务来分，一个 bot 对应一个服务；谁先谁后由流程定义决定，和 bot 的定义分开。需要问人时只能经过 Slack bot。

| bot | 对应的服务 | 只负责 | 引擎 |
|---|---|---|---|
| 主 bot | 任务的流程和状态 | 在群里接手任务、叫下一步、收尾 | Claude，走 API |
| Slack bot | Slack | 取回原始讨论，往原讨论回消息 | Claude，走 API |
| Jira bot | Jira | 建 Jira 单、更新状态、写评论 | Claude，走 API |
| Git Pipeline bot | GitLab | 拉代码、建分支、推分支并开 Draft MR | Claude，走 API |
| coding bot | Claude Code | 在代码目录里定位问题、修改，并在内部完成审查 | Claude Code；内置一个只读的审查子 agent |

一个群一个主 bot。每个任务的群有这五个成员，都由系统在任务开始时新建，任务结束后删除；主 bot 不跨群。

编码和审查是 coding bot 的两面：审查由 Claude Code 自带的子 agent 在 coding bot 内部完成，返工不出 Claude Code 的对话。审查子 agent 不是注册的 bot；它的说明和工具由系统在启动时给定，只有读和搜索。

### 2.3 工具清单

逐项说明见 [tools-and-limits.md](tools-and-limits.md) 第 2 节，共 19 个新增工具，是当前基线。概要：

| bot | 工具 |
|---|---|
| 所有 bot | 读任务 |
| 主 bot | 读执行记录；推进任务步骤（代码检查完成条件）；结束任务；确认信息不足 |
| Slack bot | 读原始讨论；回复原始讨论 |
| Jira bot | 建单；读单；加评论；改状态 |
| Git Pipeline bot | 准备代码目录（拉代码、建分支）；看改动；读文件；读历史；推分支并开 Draft MR；读 MR 状态 |
| coding bot | 调用 Claude Code；向 Git Pipeline bot 要代码；报告审查结论；确认信息不足 |

### 2.4 流程

1. 看门狗收到 @，建任务，放入队列。
2. 轮到时，系统按 bot 注册表建群和成员，把任务发到群里；主 bot 在群里接手。群不是 bot 自己建的。
3. 取讨论：Slack bot 取回讨论，整理成摘要写进任务，并在原讨论回复“已收到”。
4. 建单：Jira bot 从任务里读摘要，建单，把单号写进任务。
5. 备代码：Git Pipeline bot 拉代码，建分支 `ai/<Jira 单号>`（沿用现有流程的命名）。
6. 编码：coding bot 调 Claude Code 定位并修改，在内部审查通过后汇报改动和审查结论。
7. 开 MR：Git Pipeline bot 推分支，开 Draft MR。任务上没有“审查通过”时开不了。
8. 回写：Jira bot 写上 MR 链接并更新状态；Slack bot 在原讨论回复结果。
9. 收尾：主 bot 结束任务；看门狗取队列里的下一个任务。

bot 之间的转交走存储：上一步的结果写在任务上，下一个 bot 从任务里读。

### 2.5 任务与 Jira 单

两者分开命名，分开存放。

| | 任务 | Jira 单 |
|---|---|---|
| 谁建 | 看门狗，收到 @ 时 | Jira bot，建单这一步 |
| 存在哪 | 自建的一张表 | Jira |
| 给谁看 | bot 和看门狗 | 人 |
| 内容 | Slack 讨论的位置、群编号、当前步骤、Jira 单号、分支、MR 链接、每次运行的记录 | 标题、描述、状态、评论 |

任务先于 Jira 单存在；Jira 单号是之后写入任务的一个字段。一个任务可以有多次运行（首次执行、补充信息后重跑）。dsh-superagent 模型里的 Ticket 对应这里的“任务”。

### 2.6 协作规范

- 群聊不是自由聊天。规范是步骤顺序和各 bot 的职责；步骤之内怎么配合是自由的。
- 一轮结束再转交：bot 做完自己这一轮，结果回到主 bot，由它叫下一步。一轮中途不转交。
- 执行记录对主 bot 开放：系统把每一步由谁做、调用了哪些工具、结果和耗时记到任务上，主 bot 可以读全部记录。
- 步骤之内，bot 之间可以直接互相 @。
- 信息不足以修复时：coding bot 提出缺什么，主 bot 确认；两者一致后，Slack bot 去原讨论追问，任务以“待补充信息”结束。人回复并再次 @ 后，作为同一个 Jira 单的新一次运行重新开始。

### 2.7 权限

- 只有 coding bot 能调用 Claude Code。
- 其余 bot 只能读、查看、调用定死的工具，不能修改任何东西。
- 推分支和开 MR 是 Git Pipeline bot 的一个定死的工具，令牌在工具内部，bot 本身拿不到。任务上没有“审查通过”时这个工具调不动。
- 所有可选操作都是定死的，严格按流程走。
- 部署在容器里，容器是安全边界，运行中不出现需要人点的审批。
- 运行中出现的审批由任务层（状态层）统一管理。
- bot 完成一步的判定靠新加的工具：调用我们新加的工具算干了活；coding bot 向 Git Pipeline bot 要代码也是一个工具。
- coding bot 是纯转发：Claude Code 保持默认能力，是否有命令行不单独做决定。审查子 agent 只有读和搜索。

### 2.8 并发

第一版一次只跑一个任务，其余排队。并发数做成配置项，接口预留，之后先测 2。

### 2.9 暂不做和搁置

| 事项 | 状态 |
|---|---|
| MCP 形态的打包 | 暂不做，先把东西做出来 |
| 运行上限（时限、轮数、停滞检测） | 初值见 [tools-and-limits.md](tools-and-limits.md) 第 4 节，是当前基线，跑过历史工单后校准；不照抄 DS Bot 的上限 |
| 修改 DSH 源码 | 不做 |
| 多个任务同时运行 | 第一版不做，只留接口 |

### 2.10 待确认

1. 与同事的接口、试点频道和仓库（[questions-for-colleagues.md](questions-for-colleagues.md)）。

### 2.11 2026-11-12 补充的决定（Zihui，随 CI 修复循环定下，见 [spec-7-ci-loop.md](spec-7-ci-loop.md)）

1. **系统直接碰外部服务的例外。** “一个 bot 对应一个服务”之外，系统本身可以直接碰外部服务，只限同时满足两条：机械动作，不需要判断；不产出内容。清单只有三处，新增要另行决定：
   - 系统通知直接发 Slack（现有：排队满、超时等）；
   - 系统读 pipeline 状态（CI 步骤，计划中）；
   - 系统对失败的 job 自动重跑一次（CI 步骤，计划中；唯一一处写 GitLab）。

   理由：“一个 bot 对应一个服务”是为了让读不可信 Slack 文本的 bot 和改代码的 bot 分开、令牌互不可见。系统本身不是模型，不会被注入的文本带偏，所以这三处不削弱这条理由；交给 bot 只会多一次模型调用，判断也不会更准。
2. **MR 分支只追加、不强推。** 开 MR 和 CI 修复轮次都是“追加提交、普通推送”，不 amend、不强推。推送被拒就停下报告，不覆盖别人推到 `ai/<单号>` 上的提交。
3. **`ci_stop` 不算 `step_done`。** “没有 `step_done` 这类工具”防的是 bot 笼统地宣布完成。`ci_stop` 记的是只有模型能做的、有类别有说明的判断，和“评审通过”同类；限制是这一轮看过日志才能用，“修不了”必须由 Coding bot 自己登记。
4. **CI 步骤由 Git Pipeline bot 专职负责。** 主 bot 只在进入 CI 步骤时交给 Git Pipeline bot，CI 有结论后推进到回写，中间不插手。每一轮由 Git Pipeline bot 主导：读日志、写摘要，用 `message_bot` 直接叫 Coding bot 修，再推送；`ci_stop` 也归它。系统每轮失败时通知 Git Pipeline bot，有结论时通知主 bot。这符合第 2.6 节“步骤之内怎么配合是自由的、bot 之间可以直接互相 @”；群公告里“只有主 bot 叫别人”的规则相应加上这个例外。
5. **入口：`/fix` 为主，@ 只用于补充信息。** 在绑定的频道里用斜杠命令 `/fix 问题描述` 开任务（命令名可配置，`slack.slashCommand`，默认 `/fix`）；在任务讨论串里 @ 机器人只用于补充信息（比如“待补充信息”之后回答），走现有的 @ 路径。这取代了本文前面“@ 机器人是入口”的说法。服务端先查绑定和队列，拒绝时频道里不留东西（没绑定 422、队列满 429）；通过后由服务端在频道发一条开头消息（`<@发起人>` 加原文，先防广播），它的 ts 就是任务的讨论串，之后所有回复都在这个讨论串里；发不出开头消息回 502。转发程序先确认，再转给服务端，按结果用 `response_url` 给发起人发中文临时消息；命令正文为空、或在和 bot 的私信里用时，直接回用法说明（第一版不支持私信）。理由：斜杠命令不能在讨论串里用，载荷里也没有讨论串，所以补充信息仍要靠 @；拒绝时不在频道里留痕迹，只有服务端知道绑定和队列，所以开头消息由服务端发。Socket Mode 下同一个 Slack 应用同一时间只能有一个程序连，否则消息会被随机分走。依据：研究笔记 `fix-slash-entry.md` 第 4、6 节。状态：设计已定，实现中。

## 3. 选型依据

### 3.1 候选方案与结论

| 候选 | 结论 | 原因 |
|---|---|---|
| Claude Code 无头模式加一条确定性流水线，不做多 bot | 未采用 | 用户要的是多个 bot 分工协作的团队形态，并且要能改外层框架 |
| DSH 原生 agent 接 Claude 模型，角色用预设定死 | 未采用 | 编码质量取决于 DSH 对 Claude 的第三方适配层，没有验证；用户决定编码直接交给 Claude Code |
| 以 dsh-superagent 为骨架 | 只作参考 | 只支持 github.com；硬依赖 DSH 的网页服务；执行器以完全权限运行；README 自述为研究原型 |
| CopilotKit OpenBot | 未采用 | 是工作台和治理平台，不是编码引擎；后端部署在 Kubernetes 和 PostgreSQL 上；依赖单独授权的 CopilotKit Intelligence，生产环境需要生产许可证 |
| 外层完全自建，不带 DSH | 未采用 | DS Bot 的核心路由代码贴着 DSH 的会话、收件箱和事件服务写成；抛开 DSH 等于重写这一层 |
| **DSH 整体打包，bot 层取自 DS Bot，编码交给 Claude Code** | **采用** | 每一环都有现成实现；用户熟悉 DS Bot |

### 3.2 各项目的事实

**DeepSeek Harness**（`deepseek-ai/deepseek-harness`，MIT，默认分支 master，读取的提交 `fcc0ad46`，2026-11-04；命令行版本 `0.2.2-rc.1`）

- README 写明处于开发者预览阶段，会有不兼容改动；`SAFETY.md` 写明未经安全审计。
- 一切功能都是插件，共 379 个包。一个“配置档”由若干插件行叠加而成；基础组合有 99 行。补丁只有插入和覆盖两种操作，没有删除，去掉一行的做法是把它设为禁用。
- 只有 10 个指定的插件行在激活失败时会中止启动，其余行依赖缺失时只打印警告。
- 自带无界面运行方式（`dsh --profile headless`）和 TypeScript、Python 两套 SDK；只能作为 MCP 客户端，没有 MCP 服务端。
- 没有步数、回合数、总 token、总时长的任何上限。`packages/core/agent-loop/README.md` 第 220 行写明没有内置回合预算。
- 基础组合默认带遥测行，导出地址是 DeepSeek 的收集服务；环境变量 `DSH_TELEMETRY_DISABLED` 可以关闭。
- 沙箱只限制写文件，不限制读，不限制网络。子进程环境会剔除名字里含 KEY、PASSWORD、SECRET、TOKEN 的变量和所有 `DSH_` 开头的变量。
- 无界面模式收到终止信号时退出码是 0（`apps/cli/src/profile-boot.ts` 第 304 至 308 行），成功与否要看输出里的 `final` 事件。

**dsh-superagent**（`deepseek-ai/dsh-superagent`，MIT，读取的提交 `8c32a9d`，2026-10-31；版本 0.1.0；源码约 1.5 万行）

- 领域模型：来源 → 触发 → 评估 → 工单 → 派工 → 执行器 → 渠道。来源是一等概念，自己保存读取位置和 bot 身份，决定谁能派活、往哪回消息。
- 主会话只做路由；每张工单一个执行器会话和一个目录。
- 宿主代码负责并发名额、后台工作 30 分钟时限、失败重试、重启恢复；对外动作先入库再执行。
- 两个固定角色各用一个预设定死工具集；提示词拆成带键名的部分，可逐段覆盖并带版本。
- `docs/008-cookbook.md` 有新增来源的十一步教程。

**DS Bot**（`Fei2411/DS-Bot`，Apache 2.0，社区项目，版本 0.3.1，基于 DSH 0.2.2-rc.1；本地副本 `mywork/ds-bot/upstream/DS-Bot-0.3.1`）

- 是 DSH 的插件。启动时必须拿到 DSH 的模型调用、工具、系统提示词、会话控制、会话存储、会话标题、工作区、网页连接八个服务。
- 一个 bot 是一组长期存在的 DSH 会话加状态文件里的一条记录；bot 之间不共享对话，只通过消息往来。
- 两条唤起路径：群聊里写“@名字”；私下用 `message_bot` 派活。私下派活构成一棵落盘的派活树，下游没交回时上游的答复先扣住，交回时自动唤醒上游。
- 控制规则：不许给正在等这件活结果的上游发消息；同一发件人的未读请求合并；请求带幂等名；群里连续 6 次无工具调用的空转会暂停，只有人能解除；群内回复 240 秒无动静算错过；每群最多 12 个成员。跳数和总条数上限在 2026-10-16 的设计中被删除。
- 设计笔记记录的弱点：下游不交回时上游一直等；没有看门狗；群聊轮次状态只在内存里。
- “本地 Agent”功能把 Claude Code 等命令行接成 DSH 的一条模型线路，代码 1759 行。对 Claude Code 的做法：每个会话一个 `claude` 进程，输入输出都是逐行 JSON；团队工具通过只监听本机、带一次性令牌的 MCP 服务递给它；权限请求转成审批；中断是一条控制消息。
- 代码量：核心路由文件（回合、群聊、派活树、投递、恢复、存储、花名册、请求去重、团队工具、提示词）约 6 至 9 千行；界面约 2.25 万行；浏览器、电脑操控、连接器、聊天平台桥接合计约 8500 行；测试文件 161 个。
- 自带 Docker 部署：一个 `dsh web` 服务加本插件；权限预设为完全访问、审批为不询问，以容器为边界。

**Claude Code 命令行**（官方 CLI 参考文档，2026-11-11 读取）

DS Bot 的驱动用到的参数全部在文档中：`--input-format`、`--output-format`、`--verbose`、`--resume`、`--append-system-prompt`、`--permission-mode`、`--model`、`--mcp-config`。文档中另有 `--system-prompt`、`--tools`、`--disallowedTools`、`--max-turns`、`--strict-mcp-config`、`--setting-sources`、`--bare`。

**现有流程**（`ChatGPT/ba-fix-bot/research/phase-1/README.md`，2026-11-11 采集）

- 已启用的 Jira 自动化：工单进入 In Progress 且标题带 AI-fix 前缀时，调用 Rovo 的 F2P Jira Fix Agent（已发布 V13，模型显示为 Claude Opus 5）。
- 该 Agent 通过 GitLab 工具读写仓库，在 `ai/<Jira 单号>` 分支上提交并开 Draft MR，没有本地命令执行能力。
- V13 指令中可复用的规则：信息缺失时返回受阻；每次调用最多三次修复提交；禁止合并、批准、关闭 MR；CI 结论必须对应 MR 当前的提交。

### 3.3 可行性核对

| 环节 | 依据 |
|---|---|
| 无桌面的服务器形态 | DS Bot 的 `docker/` 目录 |
| bot 把活交给 Claude Code | `ds-bot/src/host/local-agents/claude.js`；参数与官方文档一致 |
| 按 bot 限定工具和权限模式 | 官方文档的 `--tools`、`--disallowedTools`、`--permission-mode` |
| 隔离服务器上的个人配置 | 官方文档的 `--strict-mcp-config`、`--setting-sources`、`--bare` |
| 一个任务一个群一批 bot | DS Bot 的建 bot、建群、删群、停止整群工作的操作；群可以有自己的工作目录 |
| 无人值守时没有审批 | DS Bot 的 Docker 配置；`approvals.js` 对群内隐藏会话的审批由插件自己应答 |
| 互相唤起与派活树 | DS Bot 已实现并带测试 |

### 3.4 核对中发现需要改动的三处

1. DS Bot 在启动命令行前，从环境里删除 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`CLAUDE_CODE_OAUTH_TOKEN`（`local-agents/discover.js` 第 11 至 14 行），让命令行使用自己的登录。使用公司 API 密钥需要改这里。
2. 官方文档中双向逐行 JSON 的示例带 `-p` 参数，DS Bot 的驱动没有带。
3. DS Bot 的建 bot、建群函数挂在插件内部对象上，没有注册成 DSH 服务。任务模块需要写在 bot 层内部。

### 3.5 需要运行才能确认的项

1. Claude Code 在目标仓库上的修复质量。
2. 不带 `-p` 的双向逐行 JSON 在当前 Claude Code 版本上是否可用；权限请求和中断两种控制消息的格式。
3. 把公司 API 密钥传给 Claude Code 之后的认证行为。
4. 从 DS Bot 搬出部分文件后，被去掉的模块留下的调用点。
5. 一台机器能同时承载多少个任务（每个任务至少有一个 Claude Code 进程，外加四个走 API 的 bot）。

本次会话的命令行环境里没有 `claude`、`node`、`dsh` 可执行文件，以上各项均未运行。

### 3.6 讨论过程中改变的判断

| 之前的判断 | 改为 | 原因 |
|---|---|---|
| Jira、GitLab、Slack 只是工具，不该是 bot | 它们各对应一个注册的 bot | 架构里只有 bot 这一种可注册的东西，一个 bot 对应一个服务；读不可信 Slack 文本的 bot 与改代码的 bot 分开，令牌互不可见 |
| Slack 和 Jira 合并成一个 bot（讨论中短暂采用） | Slack bot 和 Jira bot 各是一个注册的 bot | 架构逻辑和流程逻辑是两回事：架构上统一注册，合并与否是流程编排的事；转交走存储，分成两个 bot 不丢信息 |
| 审查由 GitLab bot 在开 MR 前顺带核对 | 审查内置在 coding bot 里，由 Claude Code 的子 agent 完成 | 编码和审查是一体两面；返工在 Claude Code 的同一段对话里完成，不用经过主 bot 来回转交 |
| bot 的名字：GitLab bot、修复 bot | Git Pipeline bot、coding bot | 用户定名；2026-11-12 pipeline bot 再定名为 Git Pipeline bot（代码里的角色标识仍是 `pipeline`，群里的 bot 名仍是 `Pipeline-1`） |
| 管理角色用代码实现 | 主 bot 是 agent，看门狗是代码 | 用户要的是 bot 团队；步骤完成条件仍由代码检查 |
| 非必要不用 Claude Code | 编码直接交给 Claude Code | 外层框架自建后，可定制的需求落在外层；DS Bot 已有成熟接法 |
| 不带 DSH，外层完全自建 | DSH 整体打包 | DS Bot 的核心路由依赖 DSH 的服务 |
| 第一版砍掉群聊轮次，只做派活树 | 保留群聊 | 群聊代码是从 DS Bot 搬来而不是重写 |
| 工人长期存在 | 每个任务新建一批 bot | 任务之间要隔离，为并发留出空间 |

## 4. 资料位置

| 资料 | 位置 |
|---|---|
| DS Bot 0.3.1 源码 | `~/Documents/mywork/ds-bot/upstream/DS-Bot-0.3.1` |
| 现有 Jira 自动化与 Rovo Agent 的阶段一资料 | `~/Documents/ChatGPT/ba-fix-bot/research/phase-1/README.md` |
| DSH 源码 | `https://github.com/deepseek-ai/deepseek-harness` |
| dsh-superagent 源码 | `https://github.com/deepseek-ai/dsh-superagent` |
| Claude Code CLI 参考 | `https://code.claude.com/docs/en/cli-reference` |
| CopilotKit OpenBot | `https://github.com/CopilotKit/OpenBot` |
