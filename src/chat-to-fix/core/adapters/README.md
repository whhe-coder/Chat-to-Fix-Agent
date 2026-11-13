# core/adapters/

对外部服务（Slack、Jira、GitLab 和 git）的封装。每个都有模拟（fake）和真实两种实现，由配置 `adapters.<名字>` 选。

| 文件 | 放的是什么 |
|---|---|
| `index.ts` | `createAdapters`：返回 `{ slack, jira, repo }`，选错在启动时就报错 |
| `slack.ts` | Slack 适配器：读讨论、回复；含 fake、real、outbox 三种（`createFakeSlack` 等） |
| `slack-http.ts` | 真实 Slack 的 Web API 客户端（超时、重试） |
| `jira.ts` | Jira 适配器：建单、读单、评论、改状态；fake 和 real |
| `jira-http.ts` | 真实 Jira 的 HTTP 层（认证、超时、重试） |
| `repo.ts` | 代码仓库适配器：准备目录和分支、diff、提交（`createRepoAdapter`），含模拟 GitLab |
| `gitlab-http.ts` | 真实 GitLab 合并请求（`createRealGitlab`） |
| `git.ts` | 模拟和真实共用的 git 操作（`createGit`、`runGit`、提交信息检查） |
| `errors.ts` | 统一错误 `AdapterError`（`retryable`）、`redactSecrets` |
| `fake/` | 模拟实现的帮手：`files.ts` 读写 `<dataDir>/fake/` 下的 JSON，`ci.ts` 模拟 CI 流水线 |

谁调它：`app.ts` 创建，`tools/` 调用。接真实服务时来改 `*-http.ts`；不要在这里放 bot 的判断逻辑，也不要把 token 写进错误信息。
