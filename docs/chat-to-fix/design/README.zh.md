# 自动修复 Bot：设计文档

- 日期：2026-11-11
- 只写中文（`.zh.md`）。2026-11-12 起不再写英文版（Zihui 定）；已有的英文 `.md` 不删，也不再同步，内容以中文版为准。
- 项目名称：Chat-to-Fix（2026-11-12 改名，原名 BA Fix Bot，2026-11-11 定名）。早期交接文档作为 [历史快照](../../../src/chat-to-fix/HANDOVER.zh.md) 保留。

| 文档 | 讲什么 | 先读谁 |
|---|---|---|
| [software-spec.zh.md](software-spec.zh.md) | 软件说明：整体架构、运行流转、分工边界、各部分规格 | 想了解这个软件是什么的人，从这里开始 |
| [decision-record.zh.md](decision-record.zh.md) | 讨论结果和选型依据：为什么是这个方案，否定了哪些方案 | 想知道为什么这么选的人 |
| [tools-and-limits.zh.md](tools-and-limits.zh.md) | 19 个工具的逐项说明；运行上限的初值和依据 | 实现工具和监控的人 |
| [implementation-guide.zh.md](implementation-guide.zh.md) | （历史）开工实现初稿指南：31 个可并行的工作包、接口约定、每个包精确到行号的代码参考 | 想对照代码注释里包名和接口名（C0、I5 等）的人 |
| `spec-1` 至 `spec-6`（六个文件，列表见 implementation-guide 第 6 节） | 六份细分规格：注册表和流程层、状态和存储、看门狗、工具和适配器、bot 层搬运、配置提示词验证。每份有数据形状、接口、行为规则、代码参考、实现清单、验收。2026-11-12 已按代码更新 | 改对应部分代码的人 |
| [spec-7-ci-loop.zh.md](spec-7-ci-loop.zh.md) | 细分规格 7：CI 修复循环（最小版）。在"开 MR"和"回写"之间加 CI 步骤：系统在监控里等 pipeline、自动重跑一次不稳定的 job，CI 步骤由 Git Pipeline bot 专职负责：读日志、叫 Coding bot 修、追加修复提交，最多 3 轮。已实现（提交 192a721） | 改 CI 修复循环的人 |
| [kickoff-plan.zh.md](kickoff-plan.zh.md) | （历史）开工方案：从 DS Bot 搬哪些文件、要改哪里、五天的顺序 | 想了解最初计划的人；第 6 节镜像仍是待办 |
| [questions-for-colleagues.zh.md](questions-for-colleagues.zh.md) | 要问同事的问题，两段可以直接发的消息 | 用户 |

状态：设计文档最初写于 2026-11-11 开工前。software-spec、tools-and-limits、spec-1 至 spec-7 都已按代码（提交 192a721，八步、CI 修复循环、计费）更新，代码还没做到的标“未实现”。入口改为 `/fix` 是 2026-11-12 定的，代码还在实现，相关文字标了“实现中”。implementation-guide 和 kickoff-plan 是历史文档；decision-record 和 questions-for-colleagues 开头加了说明。

目录说明：本文档组中指向 Agent 源码的旧 `src/...` 路径，在当前仓库对应 `src/chat-to-fix/core/...`。历史方案的路径保留原文。

## 已知缺口（2026-11-12）

文档里标“未实现”的地方中，下面几项 Zihui 已经定了处理方式：

| 缺口 | 在哪写 | 处理 |
|---|---|---|
| 重启后接着跑的任务不重新绑定 bot，角色工具失效 | spec-3 第 4.8 节 | 本阶段不管 |
| 代码目录的定期清理写好了没人调用 | spec-3 第 4.4 节 | 不是本阶段的任务 |
| `reviewMaxRounds` 没人读，`setupCommands` 只校验不执行 | tools-and-limits 第 4 节、spec-6 | 先放着 |
| 开 MR 的强推在重跑时可能冲掉别人推到 `ai/<单号>` 上的提交 | spec-4 第 4.5 节、spec-7 第 4.5 节 | 2026-11-12 定，已实现（提交 192a721）：只追加提交、普通推送，被拒就停 |
| 入口：Slack 斜杠命令 `/fix 问题描述` 为主，@ 只用于讨论串里的补充信息；需要的 Slack 权限随之变化 | software-spec 的监听口和入口、spec-4 的 Slack 适配器和权限表、decision-record 第 2.11 节第 5 条 | 2026-11-12 定，实现中（代码还没提交） |

还没定的：GitLab 适配器读错了超时配置的位置（spec-4 第 4.9 节）。
