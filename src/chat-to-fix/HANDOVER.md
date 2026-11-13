# Chat-to-Fix 交接文档

> 历史快照：本文记录 2026-11-12 迁移前的目录和运行方式。当前代码位于仓库的 `src/chat-to-fix/`，文档位于 [根目录的文档区](../../docs/chat-to-fix/README.md)，依赖与命令由根目录 `package.json` 管理。请以 [当前上手说明](README.md) 为准。

写于 2026-11-12。给接手的人和接手的 Claude 会话看：新会话看不到之前的对话，需要知道的都在这里。

## 1. 现状一句话

在绑定的 Slack 频道里提一个小修复，五个 bot 跑在 DeepSeek Harness 上，按八步把它做成一个 Draft MR。用真实模型（Claude Sonnet 5.5）加模拟的 Slack / Jira / GitLab，整条流程能跑通；真实的 Slack、Jira、GitLab 还没接。

## 2. 东西在哪

| 内容 | 位置 |
|---|---|
| 代码 | 本机 `~/Documents/mywork/chat-to-fix/chat-to-fix/`，git 分支 `main`，没有远程 |
| 设计文档（工作副本） | 本机 `~/Documents/mywork/chat-to-fix/chat-to-fix-design-2026-11-11/`，从 `README.md` 进；不在 git 里 |
| 设计文档（随代码的快照） | `docs/design/`（中文版）和 `docs/notes/`（研究笔记：`ci-loop-design.md`、`fix-slash-entry.md`）。每次推送前从工作副本同步一次 |
| 从 DS Bot 裁掉了什么 | `rewrite/INVENTORY.md` |
| 上手说明 | `README.md` |
| 公司仓库 | `whhe-coder/Chat-to-Fix-Agent`（公开），我们的代码在分支 `AIINITIATIVES-5450_chat-to-fix` 的 `chat-to-fix/` 子目录，PR #1 到 `main`，等 Logan review，**还没合并**。`main` 上是 Logan 的另一套实现（JavaScript，私信入口），只作参考 |
| Jira | Epic AIINITIATIVES-5447（描述已改成 Chat-to-Fix）；任务 AIINITIATIVES-5450"first reviewable version"，正在进行。CI 循环和 `/fix` 还没单独开工单 |

## 3. 架构

- 五个 bot：主 bot（推进八步）、Slack bot、Jira bot、Git Pipeline bot（代码里角色叫 `pipeline`，群里叫 `Pipeline-1`）、修复 bot（Claude Code 命令行，内置只读评审）。
- 八步：取讨论 → 建工单 → 准备代码 → 写代码 → 开 Draft MR → CI → 回写 → 结束。
- 流程和状态归系统，内容和判断归 bot；推进要有记录在案的证据；没有 `step_done` 工具。
- 每个任务一个群、一批新 bot，系统建、系统解散。DSH 整包使用、不改；`bot/` 是从 DS Bot 0.3.1 裁剪来的 bot 层。
- 全部 TypeScript，Node 24 直接运行，不编译；`npm run typecheck` 查类型（宽松配置）。

## 4. 做到哪了

| 内容 | 状态 |
|---|---|
| 七步主流程（真实模型 + 模拟三方） | 真实跑通多次 |
| CI 修复循环（spec-7，最小版，Git Pipeline bot 专职负责） | 代码完成，模拟 CI 上 9 个端到端场景全过；**没在真实运行里看过** Git Pipeline bot 叫修复 bot 的交接和 `@Pipeline-N` 路由 |
| `/fix` 斜杠命令主入口 | 已实现，只在本机模拟服务上测过（转发程序处理 `slash_commands`；服务端先开讨论串再建任务；拒绝只回临时消息）。@ 保留为讨论串里的补充信息入口。设计见 `docs/notes/fix-slash-entry.md` |
| 真实 Slack / Jira / GitLab 适配器 | 代码已写，只在本机模拟服务上测过；等 token 和权限 |
| 计费 | API bot 用 DSH 自带的 token 和速度统计 × 价目表；修复 bot 用 Claude Code 自报的花费。一次文案用例约 $0.30 |
| 调试页 | `scripts/flow-page.ts`：左边时序图，右边竖屏群聊，页头花费和速度 |
| 端到端测试集 | `scripts/e2e/`：7 个前端修复用例，带隐藏测试；CI 失败的真实用例还没加 |
| 模型 | 全部 Sonnet 5.5，修复 bot 和评审 effort high |
| 测试基线 | `npm test` 627、`test:layer` 43、`test:bot` 505 + 2 跳过、冒烟 24、类型检查 0 错 |

## 5. 怎么跑

```bash
. scripts/dev-env.sh                       # 本机路径写在 scripts/dev-env.local.sh（不进 git）
npm test && npm run test:layer && npm run test:bot && npm run smoke
node scripts/e2e/run.ts --prepare-only --cases copy-typo   # 准备一次真实运行，再按打印的命令跑（花钱）
node scripts/flow-page.ts --dir <运行目录>                 # 调试页 http://127.0.0.1:3092/
```

Anthropic key 存在 macOS 钥匙串（服务名 `chat-to-fix-anthropic`），脚本只在启动时读，不打印。真实运行要花钱，跑之前先说一声。

## 6. 待办

1. `/fix` 在真 Slack 上联调（要先有我们能用的 Slack 应用和 token，见第 3 条）。
2. 两个小代码问题：配置检查不接受字符串形式的 `ciJobs[].downstream`；`task.ci.lastPollAt` 只写不读。
3. Slack 应用：公司那个 Chat-to-Fix 应用被 Logan 缩到只有 `commands`、`chat:write`，事件全关。我们还需要 `app_mentions:read`、`channels:history`、`groups:history` 和 `app_mention` 事件，要赶在安装审批通过前和 Logan、管理员说。同一个应用同一时间只能有一个程序连。
4. 加一个 CI 失败的真实用例，看 Git Pipeline bot → 修复 bot 的交接和 `@Pipeline-N` 路由。
5. 拿到 token 后在真 Slack / Jira / GitLab 上联调；`retryJobs` 和下游 pipeline 的项目 id 要在真实 GitLab 上验证。
6. 给 CI 循环和 `/fix` 开 Jira 工单（挂 5447 下）。
7. PR 合并后把 AIINITIATIVES-5450 改成完成。

## 7. 约定（Zihui 定的）

- 中文回答，直白简短；文档只写中文，不再写英文版。
- 能自己判断的就做，不要一步一问；设计上的事交给 Zihui 定，已定的不要重提。
- 先查现成实现（DSH、DS Bot、公司代码）再派活，不要重复造。
- 写代码用 Sonnet 5.5 子 agent 并行，每个只拥有列出的文件；验证和调查用 Opus；主会话整合并亲自复跑测试。
- 本地页面在 Zihui 自己的 Chrome 里看，不用应用内浏览器。
- 公司规则：每个 MR 对应挂在 Epic 下的工单；先有工单号再拉分支；分支名 `<工单号>_<主题>`，提交和 MR 标题带工单号；开工改"正在进行"，做完改"完成"。
- 推到公司仓库只走我们自己的分支和 PR；绝不强推。将来如果要往 `main` 强推，先备份 Logan 的 `main`、先确认。
- 凭据由 Zihui 自己输入，不经过对话。

## 8. 已知的坑

- 群公告不能超过 2000 字（DS Bot 的上限），有测试守着。
- `bot/.npmrc`（`legacy-peer-deps=true`）不能删：它让 npm 不在 `bot/` 里另装一份 DSH 包。
- 运行目录在家目录下时，Claude Code 会沿父目录读到个人的 `~/.claude/CLAUDE.md`；启动参数里已用 `claudeMdExcludes` 排除。
- 修复 bot 的测试命令按"精确 + 带参数前缀"放行，要求它原样执行；被拒和失败的命令会记成 `refusal` / `tool_error`。
