# scripts/

启停、接真实服务、调试页、模拟运行、端到端回归脚本。运行时和调试时用，不是 Agent 本体。

| 文件 | 放的是什么 |
|---|---|
| `dev-env.sh` | 设本机 Node 24 路径等（机器相关的写在 git 忽略的 `dev-env.local.sh`）；跑任何 npm 命令前先 `.` 它 |
| `start-chat-to-fix.sh` / `stop-chat-to-fix.sh` | 后台启动 / 停止 DSH 里的 Agent（按进程组，不按名字杀） |
| `logs-chat-to-fix.sh` | 看 Agent 日志 |
| `isolation-snapshot.sh` | 列出 DSH 默认会碰的外部目录的名字和时间，用于运行前后对比 |
| `connected.ts` | 接真实服务：检查连接、生成配置（`connectedConfig`、`checkConnections`），`npm start` 用它 |
| `first-run.ts` | 准备第一次真实模型运行（模拟 Slack/Jira/GitLab）；只准备，不启动 |
| `smoke.ts` | 冒烟：用 `mock-llm.ts` 的假模型跑整个系统，不用 key（`npm run smoke:agent`） |
| `mock-llm.ts` | 最小的 Anthropic Messages 假模型，给冒烟用 |
| `make-test-repo.ts` | 建一个带明显 bug 和测试命令的小仓库（`createTestRepo`） |
| `fake-event.ts` | 在没接 Slack 时代替 Slack 发事件（`sendFakeEvent`、`sendFakeSlash`） |
| `slack-forwarder.ts` | 真实 Slack 事件转发器：把 @ 和斜杠命令转成 `/events`（`createForwarder`） |
| `show-task.ts` | 在终端打印任务状态和执行记录 |
| `watch.ts` | 全屏只读的终端视图，看任务运行 |
| `flow-page.ts` | 调试页：bot 之间的实时时序图，右边嵌群聊 |
| `debug-ui/` | 调试页右侧的群聊：`chat.ts`（`buildChat`）、`chat-client.js`（浏览器端）、`chat.css` |
| `e2e/` | 端到端回归套件，见 `e2e/README.md` |
| `lib/` | 公用小函数：`launch-detached.ts` 在独立进程组里启动命令 |

谁调它：`package.json` 的 `start`/`stop`/`smoke:agent` 等脚本，和人手动运行。不要把 token 写进这里生成的配置；`dev-env.local.sh` 不进 git。
