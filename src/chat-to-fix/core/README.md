# core/

Chat-to-Fix 自己写的全部代码：系统层（任务、流程、工具）和接 DS Bot 的 bot 层入口。

| 文件 / 目录 | 放的是什么 |
|---|---|
| `plugin.ts` | DSH 插件入口（`apply`、`createChatToFix`）：装 bot 层，再装系统层 |
| `app.ts` | 系统层组装（`createApp`）：把 store、queue、runner、monitor、gate、http、工具接在一起 |
| `config.ts` | 读配置（`loadConfig`）、默认上限 `DEFAULT_LIMITS`、key 只从环境变量取 |
| `task/` | 系统层：任务存储、队列、运行、监控、检查、HTTP 接口 |
| `flow/` | 八步流程定义（数据） |
| `registry/` | 五个 bot 的注册表 |
| `prompts/` | 各角色的提示词（`.md`） |
| `tools/` | bot 能调用的工具 |
| `adapters/` | Jira / GitLab / Slack 的模拟和真实实现 |
| `bot/` | bot 层入口：装 `../bot/`（DS Bot 裁剪版）并接上系统层 |

谁调它：DSH 通过 `config/cordis.patch.yml` 加载 `plugin.ts`；`test/` 和 `scripts/` 直接用这里的函数。改行为改这里，不要改 `../bot/`。
