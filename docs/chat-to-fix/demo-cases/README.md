# CI 修复循环演示用例

## 为什么有这些用例

2026-11-14 Logan 要几个稍复杂的例子：MR 流水线的单元测试先失败，Agent 再修第二轮。修好了，MR 留着不合并，用来演示；修不好，记成问题。用例都放在这一个目录里。

真实频道的绑定没有配 `testCommands`，Coding bot 在本地跑不了测试，MR 流水线就是第一次跑测试。下面的需求都不提测试，让 CI 来发现问题。修复循环怎么走见 [spec-7](../design/spec-7-ci-loop.md)：job 失败后系统先自动重跑一次；重跑还失败才算一轮，Git Pipeline bot 读日志，Coding bot 修，再追加一个提交；最多修 3 轮，之后交给人。

目标仓库是 GitLab `account-platform/free-to-play-pc`。MR 流水线里的必需 job 有 commitlint、eslint、stylelint、type-check、complexity 和 unit-test（`pnpm run test:coverage`，带覆盖率门槛）。sonar 和两条 e2e 下游流水线是 `allow_failure`，不影响结论。

## 用例

| # | 用例 | 预计失败的 job | 预期 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | [文档链接按入口带来源参数](01-docs-link-utm.md) | unit-test（可能还有 type-check） | 修 1 轮后通过 | 未跑 |
| 2 | [Creator Campaign 封面图上限改成 10 MB](02-cover-image-10mb.md) | unit-test（两个文件里各有一个测试） | 修 1～2 轮后通过 | 未跑 |
| 3 | [受众要求加上 Instagram](03-audience-instagram.md) | type-check 和 unit-test | 修 1～2 轮后通过；也看 bot 会不会指出后端限制 | 未跑 |
| 4 | [Give game keys 加「下载 CSV 模板」](04-keys-csv-template.md) | complexity | 难修，很可能交给人 | 未跑 |

状态写：未跑 / 通过（修了 N 轮）/ 交给人 / 没触发修复（第一次流水线就过了）/ 失败（已记问题）。

## 跑之前先查

这些用例是对着本机公司仓库副本 `/Users/zihuifan/Documents/ChatGPT/f2p-work/dsh-worl/free-to-play-pc-company-20261009` 的 `origin/master`（`1a846c2`，2026-11-04）核对的。T-4 用的 main 已经到了 `c4704cad`（2026-11-13），本机没有这个提交。所以跑之前要在最新 main 上确认：

1. 每个用例“依赖的代码”一节列出的文件和测试名还在，断言没变。每个用例都附了 `git grep` 命令。
2. `.gitlab-ci.yml` 里的 `unit-test` 还是跑 `pnpm run test:coverage`，`complexity` 还是跑 `pnpm run lint:complexity`，两个都不是 `allow_failure`。
3. 频道绑定还是没有 `testCommands`，`ciMaxRounds` 还是 3。

## 怎么跑

- 在绑定 `free-to-play-pc` 的 Slack 频道里，把用例里的 `/fix` 文本原样贴进去。
- 一次只跑一个。等讨论串出了结果汇总、任务结束，再跑下一个。
- MR 一律保持 Draft，不合并、不关。Jira 单也先留着，演示完再关。
- 每轮失败都要等两次流水线（系统会自动重跑一次），一轮大约 12 分钟，所以一个用例要 15～45 分钟。
- 跑完把结果填进用例文件末尾的“结果”一节，再改上表的“状态”。完整的运行记录照常写到 [`../runs/`](../runs/)。

## 跑失败了怎么办

按 Logan 的规则，失败的运行记成问题：在 [`docs/issues/`](../../issues/README.md) 新建一个文件，写明证据、影响和验收条件，并加进那里的 README 表格，再在本用例的“结论”里链过去。下面这些都算失败：

- Agent 自己出错，比如没读日志就停了、推送出错、Slack 或 Jira 回写不对。
- 修法不对：CI 变绿了，但办法是删测试、改弱断言、抬高复杂度基线，或者把需求改没了。
- 该交给人时没交。

修了 3 轮还不过、正常交给人（`completed_ci_failed`），或者 bot 用 `ci_stop` 说清了原因，这是用例 4 想演示的结果，不算失败。

如果 Coding bot 第一次就把测试一起改了，流水线第一次就过了，这不算 Agent 的问题，状态写“没触发修复”。这时可以换下一个用例。
