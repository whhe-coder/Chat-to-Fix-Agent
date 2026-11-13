# Smartcat push pipeline 被误报为 MR CI 通过

- 状态：修复已加载到本机 Agent，端到端复测待完成
- 发现日期：2026-11-13
- 关联任务：T-12 / `F2PGBA-408`
- 关联 MR：[!377](https://gitlab.loc/account-platform/free-to-play-pc/-/merge_requests/377)

## 现象与证据

T-12 在 17:29 向模拟频道报告“CI 通过”，附上 [pipeline 1935894](https://gitlab.loc/account-platform/free-to-play-pc/-/pipelines/1935894)，随后将任务标记为完成，并在 Jira 回写通过结果。

GitLab API 显示，同一 MR 当前提交 `ec1db59486a8a457e24b6849748e12f09b624fc2` 有两条 pipeline：

| Pipeline | 来源 | 检查时状态 | 内容 |
| --- | --- | --- | --- |
| [1935894](https://gitlab.loc/account-platform/free-to-play-pc/-/pipelines/1935894) | `push` | `skipped` | 只有三个 Smartcat 手动作业，均为 `allow_failure`。 |
| [1935896](https://gitlab.loc/account-platform/free-to-play-pc/-/pipelines/1935896) | `merge_request_event` | `running` | 包含 `unit-test`、`type-check`、`eslint`、`commitlint` 等检查。 |

因此，T-12 的“CI 通过”没有证明 MR 的单元测试通过。任务结束过早，模拟频道和 Jira 的结论也不正确。

修复后的只读复查选择了 [MR pipeline 1935896](https://gitlab.loc/account-platform/free-to-play-pc/-/pipelines/1935896)，而非 Smartcat pipeline。复查时 `unit-test`、`type-check`、`eslint`、`commitlint` 等必需作业已成功。原通知的结论后来碰巧与必需作业结果一致，但通知时机和链接仍是错误的；旧消息和 Jira 评论不会由代码修改自动更正。

## 原因

`getChecks` 从 MR pipeline 列表筛选 `merge_request_event`，但又无条件加入同一提交的 `head_pipeline`。在 MR pipeline 尚未创建时，`head_pipeline` 指向 Smartcat 的 `push` pipeline。该 pipeline 没有必须执行的检查，现有判定把它当成通过。

## 修复与验收

- [x] 只用当前 MR 提交的 `merge_request_event` pipeline 判定 MR CI；`push` / Smartcat pipeline 不得给出通过结果。
- [x] MR pipeline 尚未出现时保持等待；出现后读取其必需作业，直到通过或失败才发送结论。
- [x] 用包含“先出现 push pipeline，后出现 MR pipeline”的测试复现并验证；21 项相关测试和类型检查通过。
- [x] 用 MR !377 的真实数据验证新选择结果：返回 pipeline 1935896，必需作业成功。
- [x] 重启默认 Agent，使后续任务加载修复；3090 端口及模拟频道连接已验证。
- [ ] 用新模拟任务验收用户可见回报。T-12 已完成，不能把旧结论当作修复后的验收。
