# core/tools/

bot 能调用的工具（角色工具）。每个工具只定义一次，按角色发给对应 bot，调用都经过同一个包装（检查任务、步骤、重试、超时）。

| 文件 | 放的是什么 |
|---|---|
| `register.ts` | 框架：`createToolRegistry`（里面有 `defineRoleTool`、`attachRoleTools`） |
| `index.ts` | `registerAllTools`：把下面所有工具登记进注册表 |
| `task.ts` | 任务工具：读任务和记录、推进步骤、结束任务、确认缺失信息 |
| `slack.ts` | Slack 工具：只能读写这个任务的讨论 |
| `jira.ts` | Jira 工具：只能动这个任务的一张单 |
| `repo.ts` | 代码仓库工具：只能动这个任务的代码目录和分支 |
| `ci.ts` | CI 工具：`ci_read_log`、`mr_push_fix`、`ci_stop` |
| `request-code.ts` | `request_code`：修复 bot 向 Pipeline bot 要仓库里的内容 |
| `tests.ts` | `run_tests`：只跑频道配好的测试命令 |
| `review.ts` | `request_review`：请系统起只读评审者 |
| `material.ts` | 公用小函数：截断文本、把外部文本标成"材料" |

谁调它：`app.ts` 登记，`bot/` 层把工具挂到各 bot 的会话上。谁有哪个工具由 `registry/bots.ts` 定；不要给工具加目录或频道参数。
