# 结果说“仓库没有测试命令”，实际是没配置 `testCommands`

- 状态：已确认，待修复
- 发现日期：2026-11-14
- 关联任务：真实 Slack `T-5` / [F2PGBA-411](https://xsolla.atlassian.net/browse/F2PGBA-411)、`T-8` / [F2PGBA-412](https://xsolla.atlassian.net/browse/F2PGBA-412)；模拟 `T-4`

## 现象与证据

- Slack 结果汇总：T-5 `……仓库无测试命令，未运行测试。`；T-8 `……仓库没有测试命令，未运行测试。`
- MR 描述（!380、!381）：`no tests were run, because the repository has no usable test command` / `the repository has no test commands`。
- 目标仓库 `free-to-play-pc` 的 CI 有 `unit-test`、`eslint`、`type-check` 等 job，本地有测试命令。
- [`connected.ts`](../../src/chat-to-fix/scripts/connected.ts) 生成的 binding 没有 `testCommands`，所以 `run_tests` 无命令可跑。

## 影响

- 用户和评审人会以为仓库本身没有测试。
- 修复 bot 改完不能先在本地跑测试，CI 修复循环里每一轮都要推上去等 CI（一轮 4–6 分钟）。

## 验收

- [ ] 没配 `testCommands` 时，文案写“没有配置测试命令，本地没跑测试”，不说仓库没有。
- [ ] 决定是否给 `free-to-play-pc` 的 binding 配 `testCommands`（例如单元测试）。
