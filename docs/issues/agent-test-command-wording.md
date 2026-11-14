# 结果说“仓库没有测试命令”，实际是没配置 `testCommands`

- 状态：文案已修复 by commit `92584ca`（#23），真实 Slack `T-10` 复测通过；是否配 `testCommands` 待定
- 发现日期：2026-11-14
- 关联任务：真实 Slack `T-5` / [F2PGBA-411](https://xsolla.atlassian.net/browse/F2PGBA-411)、`T-8` / [F2PGBA-412](https://xsolla.atlassian.net/browse/F2PGBA-412)；模拟 `T-4`

## 复现

1. 起 Agent 和 Bot，在指定频道发一条能建单的 `/fix`。
2. 等任务结束，看讨论串的结果汇总和 MR 描述里关于测试的说法。

## 现象与证据

- Slack 结果汇总：T-5 `……仓库无测试命令，未运行测试。`；T-8 `……仓库没有测试命令，未运行测试。`
- MR 描述（!380、!381）：`no tests were run, because the repository has no usable test command` / `the repository has no test commands`。
- 目标仓库 `free-to-play-pc` 的 CI 有 `unit-test`、`eslint`、`type-check` 等 job（见 [T-4 记录](../chat-to-fix/runs/2026-11-13-T-4.md)的 job 表）。
- [`connected.ts`](../../src/chat-to-fix/scripts/connected.ts) 生成的 binding 没有 `testCommands`，所以 `run_tests` 无命令可跑。

## 影响

- 用户和评审人会以为仓库本身没有测试。
- 修复 bot 改完不能先在本地跑测试，CI 修复循环里每一轮都要推上去等 CI（T-5、T-8 的 MR 流水线各约 4–5 分钟）。

## 验收

- [x] 没配 `testCommands` 时，文案写“没有配置测试命令，本地没跑测试”，不说仓库没有。（#23；T-10 复测：MR !382 描述写 `the repository has no test commands configured, so no tests were run`）
- [ ] 决定是否给 `free-to-play-pc` 的 binding 配 `testCommands`（例如单元测试）。
