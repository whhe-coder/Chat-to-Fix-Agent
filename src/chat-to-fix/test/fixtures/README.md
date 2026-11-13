# test/fixtures/

测试用的数据：两次真实运行的裁剪副本，和调试页的样例记录。

| 文件 / 目录 | 放的是什么 |
|---|---|
| `e2e-run1/`、`e2e-run2/` | 两次真实跑完的任务：`task.json`、`records.jsonl`、`fake/`（模拟 Jira、GitLab、Slack 的留存）、`worktree/`（改后的代码） |
| `chat-run1-records.jsonl`、`chat-run2-records.jsonl` | 调试页群聊用的执行记录（`debug-ui-chat.test.ts`） |
| `flow-t1-records.jsonl`、`flow-t1-task.json` | 时序图用的任务和记录（`flow-page.test.ts`） |

谁调它：`e2e-real.test.ts`、`debug-ui-chat.test.ts`、`flow-page.test.ts`。这些是真实运行的记录，不要手改；要新样例就重新裁剪一份。
