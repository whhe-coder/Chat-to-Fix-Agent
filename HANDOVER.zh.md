# Chat-to-Fix 交接文档

写于 2026-11-12。English version: [HANDOVER.md](HANDOVER.md)

这份文档给接手的人和接手的 Claude 会话看。之前的开发在个人 Claude 账号下进行；从接入公司 Slack 开始属于公司工作，改用公司的 Claude 账号继续。新会话看不到之前的对话和记忆，所以需要知道的都写在这里。

文档合并了两个对话的内容：主对话（设计、实现、验证）和它的分叉对话（公司的《Chat-to-Fix 项目概览》和《权限申请清单》，原本要核对两者与实际是否有出入，没做完）。核对结果在第 6、7 节。

## 1. 现状一句话

样板已经能跑：一条模拟的 Slack @ 进来，系统建五个 bot 和一个群，用假的 Slack、Jira、GitLab 和本地真实 git 走完七步；Coding bot 能用真实的 Claude Code 改代码、跑测试、让 reviewer 审查并上报结论。还没有做到的是：用真实模型把七步整条跑通，以及接上真实的 Slack、Jira、GitLab。

所有代码都在本机，2026-11-12 已在本地提交，没有远程仓库。

## 2. 名称

| 说法 | 指什么 |
|---|---|
| Chat-to-Fix | 整个系统，也是公司文档和公司仓库 `whhe-coder/Chat-to-Fix-Agent` 的叫法。2026-11-12 由 Zihui 统一改名，原名 BA Fix Bot |
| `chat-to-fix` | 代码里的短标识：项目文件夹、插件名、MCP 服务名；环境变量以 `CHAT_TO_FIX_` 开头。原来是 `fixbot`，2026-11-12 已全部改掉 |
| Coding bot | 写代码的那个 bot。不要把它叫 fix bot，会和系统名混淆 |
| DSH | DeepSeek Harness，五个 bot 所在的运行时。项目自带一份，不修改它 |
| DS Bot | DSH 的一个开源插件（0.3.1），bot 层是从它改出来的 |

## 3. 东西在哪

| 内容 | 位置 |
|---|---|
| 代码 | `~/Documents/mywork/chat-to-fix/chat-to-fix/` |
| 设计文档（中英各一份） | `~/Documents/mywork/chat-to-fix/chat-to-fix-design-2026-11-11/`，从 `README.zh.md` 进 |
| 真实 Claude Code 的验证结论和 Coding bot 的启动参数 | 设计文档里的 `spec-5-bot-layer.zh.md` 第 4.9 节 |
| DS Bot 上游原件（只读参考） | `~/Documents/mywork/ds-bot/upstream/DS-Bot-0.3.1/ds-bot` |
| 公司已有的修复流程笔记（Jira 自动化 + Rovo） | `~/Documents/ChatGPT/ba-fix-bot/research/phase-1/README.md` |

代码目录的结构：

| 目录 | 内容 |
|---|---|
| `src/task/` | 任务层：监听接口、队列、建群与收尾、监控、记录器、任务存储、步骤检查、bot 层门面 |
| `src/registry/`、`src/flow/` | bot 注册表（五个 bot 各自的名字、模型、权限、工具）和七步流程表 |
| `src/tools/` | 工具注册和全部工具：任务工具、Slack、Jira、代码仓库、`request_code` |
| `src/adapters/` | Slack、Jira、代码仓库三个适配器。现在只有假实现；真实实现的接入点已留好 |
| `src/engine/` | Claude Code 驱动：启动参数、环境变量、收发 |
| `src/prompts/` | 五个 bot 和 reviewer 的指令、群公告 |
| `src/bot/`、`src/plugin.js`、`src/app.js` | bot 层入口、DSH 插件入口、把各部分接起来的接线 |
| `bot/` | 从 DS Bot 0.3.1 改出来的 bot 层源码和它自己的测试 |
| `runtime/` | 项目自带的 DSH 0.2.2-rc.1（332 个包，约 930 MB，不进 git） |
| `config/` | DSH 配置补丁 `cordis.patch.yml` 和说明 |
| `scripts/` | 环境、启动停止、冒烟、演示、模拟 @ 事件、造测试仓库 |
| `test/` | 任务层和驱动的测试；`test/bot/` 是接真实 bot 层的测试 |

## 4. 架构速览

架构和流程是两层。

- **架构**：只有一种可注册的东西，bot。一个服务对一个 bot：主 bot 对任务流转和状态，Slack bot 对 Slack，Jira bot 对 Jira，pipeline bot 对 GitLab，Coding bot 对 Claude Code。
- **流程**：一张单独的七步表：取讨论、建工单、准备代码、写代码、开 MR、回写、结束。每一步有负责的 bot、推进前要检查的证据、这一步才允许用的写工具。

运行方式：

- 五个 bot 都跑在同一个 DSH 进程里，每个 bot 是一个 DSH 会话。看门狗（监听、排队、监控）也在这个进程里。
- Coding bot 特殊：它的“模型调用”被换成一轮 Claude Code，所以既依赖 DSH 又依赖 Claude Code。其余四个 bot 的模型调用走 Anthropic API。
- 审查是 Claude Code 里一个只读的 reviewer 子 agent，内置在 Coding bot 里，不是独立的 bot。
- 每个任务一个群、一批全新的 bot，由系统创建和解散，不是 bot 自己建群。任务串行执行，留了并发的接口。
- 流程和状态归系统，内容和判断归 bot。交接通过任务存储，不靠聊天文字。没有记录到“审查通过”就不能开 MR。

完整说明见设计文档的 `software-spec.zh.md`，决定和理由见 `decision-record.zh.md`。

## 5. 做到哪了

### 5.1 做完并且核对过

| 内容 | 证据 |
|---|---|
| 任务层全部模块和 Claude Code 驱动 | `npm test`，250 项全过 |
| 任务层接真实 bot 层（假 DSH 环境） | `npm run test:layer`，18 项全过 |
| bot 层裁剪：去掉自主建 bot、建群、问用户、展示卡片和“能力”工具；`stop_bot` 只有群管理员能用；去掉另外两个命令行的驱动；不再自动创建 Chief | DS Bot 自己的测试 1828 项，1826 过，2 跳过 |
| 角色工具注册进每个 bot 的 DSH 会话，按角色区分 | `test/bot/role-tools.test.js` |
| 三方假响应和对应的 13 个工具 | `test/e2e.test.js` 三个场景：正常七步、审查不通过、缺信息后重跑 |
| Claude Code 驱动符合真实命令行 2.1.321 的行为 | 18 次真实实验，结论在规格 5 第 4.9 节 |
| Coding bot 在 bot 层里用真实 Claude Code 完成一步 | 只靠它自己的指令：读任务、改一行、跑测试、reviewer 通过、`review_report` 把结论写进任务。8 轮，32 秒，约 0.06 美元 |

### 5.2 已交回但没有亲自核对

项目自带的 DSH 的隔离启动。以下是负责的 agent 报告的，接手后应先自己跑一遍 `npm run smoke` 核对：

- DSH 包在 `runtime/`，启动和停止脚本可用，进程写的所有数据都在项目内的 `.data/`。
- 用本地假模型的冒烟 23 项通过：DSH 进程起来，插件加载，一条模拟 @ 建出五个 bot 和一个群，主 bot 收到任务，它的工具列表里只有只读工具和自己的任务工具，停止后清干净。
- 进程只监听本机地址，没有向外的连接；用户目录下别的 DSH 和 DS Bot 数据没有变化。
- 配置补丁按真实运行时修正过：免审批、关遥测、关网页服务、只读预设、插件行。

它报告的两处遗留：

- **只读预设没有全覆盖**。bot 在群里的会话、群自己的会话、交接后的下一段会话，这三处建会话时没带预设（`bot/src/host/groups.js:293`、`roster.js:510`、`parts.js:1056`）。现在用补丁里的一行把默认预设也改成只读来顶着；正式的改法是这三处传 bot 自己的预设，然后删掉那一行。
- **一处往项目外写**。每次启动会在 `~/.npm/_logs` 留一个 npm 日志（`bot/src/host/local-agents/discover.js` 里查 npm 全局目录引起）。给了命令行绝对路径时可以跳过这一步。

### 5.3 没做

- 真实模型下七步整条跑通。四个走 API 的 bot 需要 `ANTHROPIC_API_KEY`。
- 真实的 Slack、Jira、GitLab 接入。
- 读取 MR 的 pipeline 结果并修复（见第 6 节第 7 行）。
- 测试命令按频道绑定的仓库分别配置。现在只能写在插件配置里；不配的话 Claude Code 运行测试会被拒绝。
- DS Bot 剩余的清理：没用到的模块还没删，提示词里还提到已经删掉的工具，`parts.js` 没裁。
- 用历史问题做评测；打包成容器镜像。

### 5.4 没有验证的点

- Claude Code 的后台任务关掉后，是否还会有迟到的事件混进下一轮。
- Coding bot 的进程空闲关闭后重新启动并续上对话。
- 用 API 密钥方式（`engineAuth: apiKey`）的真实运行。
- 同一工作目录下 Claude Code 的 `memory/` 目录是否会让两次任务互相带入内容。
- 带参数的测试命令在放行列表里的写法。

## 6. 与公司《Chat-to-Fix 项目概览》的出入

概览的内容来自分叉对话里贴出的文本（整理时间 2026-11-11 18:28 之后）。2026-11-12 从 Slack 读了画板当前版本（概览 `F0CHUDNP596`、权限清单 `F0CGZSQKQ7L`），和这份文本逐段一致，没有更新。下面逐条对照实际做出来的东西。哪边该改，由 Zihui 和团队决定；Zihui 已经定了的写在出入一栏和表后。

| # | 概览怎么说 | 实际情况 | 出入 |
|---|---|---|---|
| 1 | 仓库用 `whhe-coder/Chat-to-Fix-Agent` | 代码在本机文件夹，没有远程仓库，没有推到任何地方 | 有 |
| 2 | 用 TypeScript | 全部是 JavaScript。原因是 bot 层从 DS Bot 改来，DS Bot 是 JavaScript | 有。**Zihui 2026-11-12 决定：改成 TypeScript** |
| 3 | 基座是 fork 开源项目 DSH，裁剪服务端和默认 Bash 工具，通过插件扩展 | DSH 没有 fork，也没有改：从 npm 整包装进项目，用一份配置补丁关掉网页服务、给四个 bot 换成没有写文件和命令行工具的只读预设。被改动的是 DS Bot（DSH 的一个插件），概览里没有提到 DS Bot | 有。Zihui 2026-11-12 表示不计较，维持现状 |
| 4 | 第一版不内置 coding agent，调用现成的命令行，先用 Claude；bot 和 coding 层解耦 | 一致。Coding bot 通过驱动调用 Claude Code 命令行 | 无 |
| 5 | 能不用 agent 就不用；Slack、Jira、GitLab 的连接用自己写的代码工具，不做成 agent；先用最少的 agent 跑通 | 连接本身确实是代码（适配器加工具）。但调用这些工具的是三个独立的 bot：Slack bot、Jira bot、pipeline bot。加上主 bot 和 Coding bot 共五个 bot，另有一个 reviewer 子 agent | 有。这是 Zihui 的设计选择（一个服务对一个可注册的 bot），和团队“先最少”的说法不同 |
| 6 | 建群和解散、看门狗、监控、记录器、任务库都暂缓，列为 todo | 这些都已经做出来并有测试 | 有 |
| 7 | 读取 MR 最新 pipeline，失败则在同一 MR 追加修复，最多 3 轮；属于第一版范围 | 没有做。`mr_get` 只返回 MR 状态和一个 pipeline 字段，假实现里固定是“无”；没有读 job 日志，没有 CI 修复循环。现有的“最多 3 轮”指 Coding bot 内部改代码和审查的轮数，不是 CI | 有。**Zihui 2026-11-12 决定：按概览做，进第一版** |
| 8 | 七步单任务流程 | 一致 | 无 |
| 9 | Jira 项目 F2PGBA，类型“任务” | 项目和类型都是配置项，样例里是占位值 | 配置即可 |
| 10 | 分支 `ai/<Jira key>`，只开 Draft MR，不合并不部署 | 一致。指令里也写了不合并、不批准、不关闭 MR | 无 |
| 11 | MR 分支应通过 ticket 功能创建并与 ticket 绑定 | 分支是用 git 在本地建的，名字里带工单号，没有通过 Jira 的 ticket 功能创建 | 待确认是否满足 |
| 12 | 仓库规则：提交是单行的 Conventional Commit，没有正文 | 提交由适配器生成，标题用 MR 标题，MR 描述作为正文。没有按这条规则做 | 有 |
| 13 | 仓库规则：用 pnpm；只改 `src/locales/en.json`；复杂度检查不能用 `:update` | 没有专门实现。Claude Code 会读目标仓库自己的说明文件，Coding bot 的指令也要求遵守，但没有验证过 | 未验证 |
| 14 | 入口做成类似 Neuronet 的平台型入口 | 入口是本机的一个 HTTP 接口 `POST /events`，等别的程序把 Slack 事件转给它 | 概览也列为 todo |
| 15 | MR 作者用专用机器人账号 | 提交人取配置里的 `commitAuthor` | 配置即可 |

2026-11-12 Zihui 看过给团队的回复草稿后定下：第 2 行改成 TypeScript；第 3 行不计较；第 7 行的 CI 读取和最多 3 轮修复按概览做进第一版；其余各行照实际情况告知团队，不另作处理。改 TypeScript 的范围（只改 `src/`，还是连 `bot/` 里从 DS Bot 改来的部分一起改）还没定。

## 7. 《权限申请清单》核对

清单是依据概览写的。按实际代码需要逐项看：

| 清单里的项 | 实际是否用得到 | 说明 |
|---|---|---|
| Slack `app_mentions:read` | 用得到 | 任务入口 |
| Slack `channels:history`、`groups:history` | 用得到 | `slack_read_thread` 读 @ 所在的讨论 |
| Slack `chat:write` | 用得到 | “已收到”、提问、结果，以及系统通知 |
| Slack `users:read` | 可能用得到 | 现在的事件格式里直接带了用户名；如果真实事件只给用户 ID，就需要它 |
| Slack Socket Mode（`connections:write`） | 取决于接法 | 代码里没有 Socket Mode 客户端。现在的设计是别的程序把事件转成 `POST /events`。要么写一个转发程序，要么在适配器里加 Socket Mode |
| Jira 浏览、建工单、加评论 | 用得到 | `jira_create_issue`、`jira_get_issue`、`jira_add_comment` |
| Jira 流转状态（可选） | 用得到 | `jira_transition`，允许的状态由配置限定 |
| GitLab 5486 Developer、token 的 `api` 和 `write_repository` | 用得到 | 克隆、推分支、开 Draft MR、读 MR |
| GitLab sonarqube 组件 4568 Reporter | 按清单的理由需要 | 和我们的代码无关，是 pipeline 启动的前提 |
| 读 pipeline 和 job 日志 | 要用到 | 对应的功能还没做；Zihui 已定第一版要做（第 6 节第 7 行）。权限和清单写的一样，不用改 |
| Anthropic API key，用于“编码部分” | 说法不完整，清单要改 | Zihui 2026-11-12 确认。按现在的设计，四个走 API 的 bot 也用这个密钥，不只是编码部分，用途和用量要按全部 bot 算。Coding bot 在部署时也用它（`engineAuth: apiKey`）；本机演示时用的是命令行自己的登录 |

清单里的“待确认”四项仍然待确认，代码里没有任何一项依赖其中某个答案。

## 8. 怎么跑

所有命令在项目根目录下执行，先加载环境：

```bash
. scripts/dev-env.sh
```

这个脚本里的三个路径是这台 Mac 专用的：Node 24 的位置、DSH 的位置、Claude Code 命令行的位置。换机器要改。

| 做什么 | 命令 | 说明 |
|---|---|---|
| 任务层和驱动的测试 | `npm test` | 不需要 DSH，不调用真实模型 |
| 接真实 bot 层的测试 | `npm run test:layer` | 需要 `runtime/` 里的 DSH 包 |
| DS Bot 自己的测试 | `npm run test:bot` | 见下面的说明 |
| 冒烟 | `npm run smoke` | 启动项目自带的 DSH，用本地假模型，不花钱 |
| 启动和停止 | `npm start`、`npm stop` | 需要先按 `config.example.json` 建 `.data/chat-to-fix.json` |
| Claude Code 演示 | `node scripts/claude-demo.mjs --unattended --cwd <临时仓库> --prompt "…"` | 真实调用，花钱 |
| 模拟一条 Slack @ | `node scripts/fake-event.mjs --channel C1 --text "…"` | 写讨论文件并提交给监听接口 |
| 造一个带 bug 的测试仓库 | `node scripts/make-test-repo.mjs <目录>` | 输出配置里要填的两行 |

`npm run test:bot` 里有一个和时间有关的测试（`local-agents-discover.test.js`，检查“查找命令行时不等 npm”），整套并行跑时经常失败，单独跑能过。把同时运行的测试文件数限到 6 个后连跑两次都没有失败，约 21 秒：在命令里加 `--test-concurrency=6`。这个参数还没有写进 `package.json`。

真实调用的注意事项：只在临时目录的小仓库里跑，不要让 Claude Code 指向项目目录或真实仓库；每次跑前想清楚要验证什么。到目前为止真实调用共花了约 1.8 美元（命令行自报），记在个人的 Console 账号上。

## 9. 换账号、换机器要做的事

**Claude 账号**

- Claude Code 命令行现在登录的是个人的 Console 账号。换公司账号后，在自己的终端里运行命令行并重新 `/login`；选登录方式时，网页给的授权码才能粘贴到“Paste code here”，API 密钥不行。
- 部署和四个走 API 的 bot 用 `ANTHROPIC_API_KEY`。由人在自己的终端或密钥管理里设置，不要贴进对话。
- 之前的对话里曾经贴过一串 `sk-ant-` 开头的内容。如果它是长期有效的密钥，应当作废并重新生成。
- 代码和配置里没有任何凭据。

**记忆和约定**

- 个人账号下的记忆在 `~/.claude/projects/-Users-zihuifan-Documents-mywork-ba/memory/`，新会话不一定读得到。其中对后续工作有用的内容都已经写进本文第 12、13 节。

**代码去向**

- 基线提交 `2185ed7` 之后的全部工作已在 2026-11-12 本地提交（同时完成改名）。是否推到远程未定。
- 是否推到公司仓库 `whhe-coder/Chat-to-Fix-Agent`、是否改成 TypeScript，是 Zihui 和团队的决定。

**依赖**

`runtime/node_modules` 和 `bot/node_modules` 不进 git，换机器要重新装，需要联网：

```bash
cd runtime && npm install --legacy-peer-deps=false --no-package-lock --no-fund --no-audit
```

```bash
cd bot && npm ci --ignore-scripts --no-audit --no-fund
```

`bot/dev/harness/package.json` 是搬走 DSH 之后留下的空壳，可以删。

## 10. 第三方代码和许可

| 来源 | 许可 | 在项目里的情况 |
|---|---|---|
| DS Bot 0.3.1 | Apache-2.0 | 在 `bot/`，已经被修改（裁掉工具和驱动、加挂钩、修了一个缺陷）。保留了 `LICENSE.upstream` 和 `NOTICE.upstream`。Apache-2.0 要求在改过的文件里注明改动，这一点还没有系统地做 |
| DSH 0.2.2-rc.1 | 主包标的是 MIT | 在 `runtime/`，从 npm 安装，没有修改。332 个包各自的许可没有逐个查 |
| Claude Code 命令行 | Anthropic 的产品 | 不在项目里，用的是本机已安装的 |

公司使用前，应当有人确认这些许可符合公司的要求。

## 11. 下一步，按顺序

1. 决定是否推到公司仓库（已在本地提交）。
2. 自己跑一遍 `npm run smoke`，核对 5.2 节的内容，收掉两处遗留。
3. 和团队对齐第 6 节的出入，至少是这四项：语言、仓库、bot 的数量、CI 修复是否进第一版。这会决定后面是继续现有结构还是收缩。
4. 设好 `ANTHROPIC_API_KEY` 后，用假的三方加真实模型把七步整条跑通。这是第一次看到五个 bot 真正自己协作，预计会暴露提示词和时间限制上的问题。
5. 拿到同事的接入方案后，写三个适配器的真实实现。接入点是 `src/adapters/` 里的 `createRealSlack`、`createRealJira`、`createRealGitlab`。要问同事的问题已经写好，在设计文档的 `questions-for-colleagues.zh.md`。
6. 按目标仓库的规则改提交信息的格式，并把测试命令做成按仓库配置。
7. 如果第一版要 CI 修复：加读 pipeline 和 job 日志的适配器函数和工具，在“开 MR”之后加一步。
8. 清理 DS Bot 剩余部分、校准各项时间限制（现在的数值是初始估计，没有校准过）。改名已完成。

## 12. 工作方式上的约定

这些是 Zihui 在之前的对话里明确说过的：

- 用中文回答，直白，简短。
- 文档中英各一份、分开的文件：`名字.zh.md` 是中文，`名字.md` 是英文，内容同步。
- 交付物要做完整；事实要先核实再说，说得准确，不要含糊其辞。
- 不要拿实现层面的细节清单给他看和确认，那些由实现者自己决定，写在实现文档里。
- 不要一步一问。能自己判断的就做，然后说明做了什么。
- 写代码用 Sonnet 的子 agent，验证和调参数用 Opus 的子 agent，主会话负责整合并亲自复跑测试。多用子 agent 并行，每个子 agent 只拥有明确列出的文件。
- 有参照就在参照上改，不要从头写。
- 只在他要求时提交或推送。
- 凭据由他自己输入，不经过对话。

## 13. 已经定下来的设计，不要重新提

- 一个服务对一个可注册的 bot，共五个。不要提议把 Slack 和 Jira 合成一个“对接 bot”。
- 一个群一个主 bot，随任务创建和销毁。不要提议常驻的主 bot。
- 群由系统建，不是 bot 建。主 bot 没有建群的工具。
- 审查是 Coding bot 内置的子 agent，不是独立的 bot。
- DSH 整包使用，不修改。
- 没有 `step_done` 这类工具：一轮结束即交接，系统按证据判断能不能推进。
- 非必要不用 Claude 的 SDK；Coding bot 走命令行。
- MCP 打包先不做。

如果团队的要求和这些冲突（见第 6 节第 5 行），把冲突摆给 Zihui，由他决定，不要自行改设计。

## 14. 已知的坑

- DS Bot 里，只有用过“团队工具清单之外的工具”的成员才算“做了事”，做了事的成员才会被交还给叫它的 bot。所以角色工具的名字不能出现在团队工具清单里（`bot/src/host/constants.js`）。
- Claude Code 的权限请求如果没人应答，那一轮会一直卡住，它自己不超时。驱动里加了超时。
- 拒绝权限请求必须带原因文字，否则命令行判为无效。
- 放行列表里不能写不带范围的 `Read`、`Edit`、`Write`、`Bash`，目录外的写入或任意命令会被放行。参数生成函数会直接报错。
- reviewer 默认在后台运行，不处理的话这一轮会在它回答之前结束。Coding bot 的进程设了 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`。
- 我们的工具在 Claude Code 里要先用工具搜索加载，模型不会自己想到；Coding bot 的指令里写明了。
- Claude Code 不指定模型时用 `claude-opus-5-5`；由配置里的 `codingModel` 决定。
- bot 自己的私聊会话在绑定任务之前就建好了，所以绑定时要补挂角色工具；群里的会话是后建的，走正常的挂钩。
- 这台机器上还有别的 DSH 和 DS Bot 在运行（`~/Documents/mywork/dsh-worl`、`~/Documents/mywork/ds-bot`），不要碰它们的进程和数据。端口 3080 属于别的服务。
