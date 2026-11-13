# core/prompts/

每个角色的提示词（英文，给模型读的），加一份所有成员都看到的群公告。

| 文件 | 放的是什么 |
|---|---|
| `main.md` | 主 bot：推进八步、检查结果、结束任务 |
| `slack.md` | Slack bot：读讨论、回复 |
| `jira.md` | Jira bot：建单、评论、改状态 |
| `pipeline.md` | Git Pipeline bot：代码目录、分支、Draft MR、CI |
| `coding.md` | 修复 bot：写代码、`run_tests`、`request_review` |
| `reviewer.md` | 只读评审者（由系统起，不是常驻 bot） |
| `group-notice.md` | 群公告，每个成员都看到 |
| `index.ts` | `loadPrompt(name)`、`groupNotice()`；文件名在它的 `FILES` 表里写死 |

谁调它：`registry/bots.ts` 引用文件名，`tools/review.ts` 用 `reviewer.md`。改提示词直接改 `.md`；新增文件要同时登记到 `index.ts` 的 `FILES`，否则读不到。
