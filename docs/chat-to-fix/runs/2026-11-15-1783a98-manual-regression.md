# 当前提交模拟人工回归记录

| 字段 | 结果 |
| --- | --- |
| 执行时间 | 2026-11-15 00:10–00:28（北京时间） |
| Agent 代码提交 | `1783a98dbc58002496b81ea56154f808771d5500` |
| 执行依据 | [`manual-regression.md`](../manual-regression.md) 0.1.6 |
| 模型 | `anthropic/claude-sonnet-5-5`；五次运行合计约 $1.69 |
| 隔离条件 | 每例独立目录；Slack=`outbox`、Jira=`fake`、GitLab=`fake`；remote 为运行目录内的本地裸仓库 |
| 输入 | 各用例在 `cases.ts` 中的原文，前加 `/fix `；`needs-info` 使用该用例的既定答复 |

每例只通过本机模拟频道接口提交一次请求。以下五次运行的任务号均为 `T-1`。模拟页面的浏览器交互未执行；接口、任务文件、模拟数据和本地 Git 记录构成下面的判定依据。

| 用例 | 结果 | Jira、分支与 MR | CI 与任务终态 | 运行目录 |
| --- | --- | --- | --- | --- |
| `copy-typo` | **PASS** | `COPY-1`；`ai/COPY-1`；一个指向 `master` 的开放 Draft MR | `test` 成功；`ci.round=0`；`done/completed` | `/private/tmp/chat-to-fix-regression-1783a98.Q6BwGs` |
| `ci-changeset` | **PASS**（一轮修复） | `CICD-1`；`ai/CICD-1`；同一 Draft MR | 首条 pipeline 的 `changeset` 失败；读日志并推送 `33ecffc`；第二条通过；`ci.round=1`；`done/completed` | `/private/tmp/chat-to-fix-regression-1783a98.aHXwM6` |
| `ci-changeset` 三轮扩展 | **PASS**（三轮修复） | `CICD-1`；`ai/CICD-1`；始终同一 Draft MR | 前三条 pipeline 失败；3 次读日志、3 个新 fix commit；第四条通过；`ci.round=3`；`done/completed` | `/private/tmp/chat-to-fix-regression-3round-1783a98.YbpGoH` |
| `needs-info` | **PASS** | 第一轮无 Jira/MR；答复后建 `INFO-1`、`ai/INFO-1` 和一个 Draft MR | Jira bot 与 Main 在 `issue` 双确认；首轮 `needs_info`，第二轮 `completed`；`test` 成功 | `/private/tmp/chat-to-fix-regression-needs-1783a98.F2K7Rm` |
| `copy-typo` 加延迟可选作业 | **PASS（运行中窗口）** | `COPY-1`；`ai/COPY-1`；一个 Draft MR | `test` 成功后约 78 秒，`optional-slow` 仍运行；任务保持 `ci/pending`，无最终结果；之后主动停止 | `/private/tmp/chat-to-fix-regression-optional-1783a98.6s6id5` |

## 八步与关键证据

四个完成态运行都按 `fetch → issue → prepare → code → mr → ci → writeback → close` 完成。`needs-info` 首轮在 `issue` 暂停；第二轮读取答复后继续。延迟可选作业运行到 `ci` 后按预定观察窗口停止，因此它的 `writeback` 与 `close` **未执行**，也未计为通过。

每个目录的证据路径相同：`chat-to-fix/tasks/T-1/task.json`、`records.jsonl`、`chat-to-fix/outbox.jsonl`、`chat-to-fix/fake/jira/issues.json`、`chat-to-fix/fake/gitlab/mrs.json`、`chat-to-fix/fake/gitlab/pipelines.json` 和 `repos/<用例>/project.git`。四个完成态任务均有 `review.verdict=pass`、Draft MR 保持 `opened`、目标为 `master`；最终回写晚于对应 CI 成功作业的结束时间。隐藏测试都在工作目录副本中运行：四个完成态和延迟用例的基准版本各有失败，Agent 修复后的版本全部通过。

三轮扩展的独立链条如下。每一条失败 pipeline 的 `unit-test` 日志分别指出缺少 `ci-stage-1/2/3.md`；同 pipeline 的自动重试仍失败，未计入修复轮数。`records.jsonl` 中 `ci_read_log` 与 `mr_push_fix` 各有 3 次，三个新提交都在 `ai/CICD-1` 上，并触发下一条 pipeline。

| Pipeline | 提交 SHA 前缀 | 作业结果 | 本轮处理 |
| --- | --- | --- | --- |
| 1 | `0e88b10` | `unit-test` 失败，要求 stage 1 | 读日志；新增 `ci-stage-1.md`；推送 `6e9df1c` |
| 2 | `6e9df1c` | `unit-test` 失败，要求 stage 2 | 读日志；新增 `ci-stage-2.md`；推送 `2b1eeed` |
| 3 | `2b1eeed` | `unit-test` 失败，要求 stage 3 | 读日志；新增 `ci-stage-3.md`；推送 `d87fbf5` |
| 4 | `d87fbf5` | `unit-test` 成功 | CI 通过后回写频道和 Jira |

`needs-info` 的首轮 `task.json` 为 `state=needs_info`、`step=issue`，`needInfo.jira` 和 `needInfo.main` 都有明确问题；频道发出 `question`。本机认证答复接口返回 `202`，同一任务重新排队，`runs` 的两个结束原因依次为 `needs_info` 与 `completed`。最终只改结算页付款按钮文案，并新增相关测试。

延迟可选作业的 `test` 于 2026-11-14 16:26:49 UTC 完成。16:27:32 和 16:28:07 的快照均为 `optional-slow=running`、任务 `ci.status=pending`，频道没有 `result` 或“CI 通过”。16:28:13 经任务停止接口主动停止，终态为 `stopped/ci`；这只通过“运行中不提前宣告成功”的检查。

## 未验证范围与收尾

- 延迟可选作业完成后的最终状态和通知未验证。
- 模拟频道的浏览器页面交互未验证；本轮使用页面对应的本机接口。
- 真实 Slack 投递、真实 Jira/GitLab API、真实 MR pipeline 和真实 F2P 仓库未验证。
- 五个运行目录均保留。每次运行结束后，Agent 与模拟频道均已关闭；端口 `39200/39201`、`39210/39211`、`39240/39241`、`39220/39221`、`39230/39231` 均无监听。

本轮没有观察到需要新建 `docs/issues/` 记录的代码缺陷。文档已补充三轮修复扩展；没有修改业务代码或测试代码。
