# 自动修复 Bot：设计文档

- 日期：2026-11-11
- 中文是 `.md`，英文版是 `.en.md`。2026-11-12 起不再写英文版（Zihui 定），内容以中文版为准。
- 项目名称：Chat-to-Fix（2026-11-12 改名，原名 BA Fix Bot，2026-11-11 定名）。早期交接文档作为 [历史快照](../../../src/chat-to-fix/HANDOVER.md) 保留。

| 文档 | 讲什么 | 先读谁 |
|---|---|---|
| [software-spec.md](software-spec.md) | 软件说明：整体架构、运行流转、分工边界、各部分规格 | 想了解这个软件是什么的人，从这里开始 |
| [decision-record.md](decision-record.md) | 讨论结果和选型依据：为什么是这个方案，否定了哪些方案 | 想知道为什么这么选的人 |
| [tools-and-limits.md](tools-and-limits.md) | 19 个工具的逐项说明；运行上限的初值和依据 | 实现工具和监控的人 |
| [implementation-guide.md](implementation-guide.md) | （历史）开工实现初稿指南：31 个可并行的工作包、接口约定、每个包精确到行号的代码参考 | 想对照代码注释里包名和接口名（C0、I5 等）的人 |
| `spec-1` 至 `spec-6`（六个文件，列表见 implementation-guide 第 6 节） | 六份细分规格：注册表和流程层、状态和存储、看门狗、工具和适配器、bot 层搬运、配置提示词验证。每份有数据形状、接口、行为规则、代码参考、实现清单、验收。2026-11-12 已按代码更新 | 改对应部分代码的人 |
| [spec-7-ci-loop.md](spec-7-ci-loop.md) | 细分规格 7：CI 修复循环（最小版）。在"开 MR"和"回写"之间加 CI 步骤：系统在监控里等 pipeline、自动重跑一次不稳定的 job，CI 步骤由 Git Pipeline bot 专职负责：读日志、叫 Coding bot 修、追加修复提交，最多 3 轮。已实现（提交 192a721） | 改 CI 修复循环的人 |
| [plan-dsh-coding.md](plan-dsh-coding.md) | Coding bot 从 Claude Code 改为 DSH 原生（2026-11-13）：问题、结论、DSH 自带什么、改了什么、删了什么、风险、验证 | 想知道 Coding bot 为什么、怎么换的人 |
| [kickoff-plan.md](kickoff-plan.md) | （历史）开工方案：从 DS Bot 搬哪些文件、要改哪里、五天的顺序 | 想了解最初计划的人；第 6 节镜像仍是待办 |
| [questions-for-colleagues.md](questions-for-colleagues.md) | 要问同事的问题，两段可以直接发的消息 | 用户 |

状态：设计文档最初写于 2026-11-11 开工前。software-spec、tools-and-limits、spec-1 至 spec-7 曾按提交 192a721 的代码更新（八步、CI 修复循环、计费）。`/fix` 的 Agent 入口和本机模拟页面现已实现；真实 Slack Bot 的 `/fix` 接入仍未实现。部分正文沿用实现时的状态说明，当前入口以 [固定频道 `/fix` 规格](../../../spec/slack-fix-command.md) 和 [模拟 Bot 规格](../../../spec/mock-slack-bot.md) 为准。implementation-guide 和 kickoff-plan 是历史文档；decision-record 和 questions-for-colleagues 开头加了说明。

目录说明：本文档组中指向 Agent 源码的旧 `src/...` 路径，在当前仓库对应 `src/chat-to-fix/core/...`。历史方案的路径保留原文。

## 已知缺口（2026-11-12）

文档里标“未实现”的地方中，下面几项 Zihui 已经定了处理方式：

| 缺口 | 在哪写 | 处理 |
|---|---|---|
| 重启后接着跑的任务不重新绑定 bot，角色工具失效 | spec-3 第 4.8 节 | 本阶段不管 |
| 代码目录的定期清理写好了没人调用 | spec-3 第 4.4 节 | 不是本阶段的任务 |
| `reviewMaxRounds` 没人读，`setupCommands` 只校验不执行 | tools-and-limits 第 4 节、spec-6 | `reviewMaxRounds` 2026-11-13 随 `request_review` 生效；`setupCommands` 先放着 |
| 开 MR 的强推在重跑时可能冲掉别人推到 `ai/<单号>` 上的提交 | spec-4 第 4.5 节、spec-7 第 4.5 节 | 2026-11-12 定，已实现（提交 192a721）：只追加提交、普通推送，被拒就停 |
| 入口：Slack 斜杠命令 `/fix 问题描述`；本期不接收讨论串里的二次修改 | software-spec 的监听口和入口、spec-4 的 Slack 适配器和权限表、decision-record 第 2.11 节第 5 条 | Agent 的 `/fix` 入口和本机模拟页面已实现；真实 Slack Bot 尚未接入。`@` 补充信息是历史方案，不属本期范围 |

还没定的：GitLab 适配器读错了超时配置的位置（spec-4 第 4.9 节）。
