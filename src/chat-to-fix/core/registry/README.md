# core/registry/

五个 bot（主、Slack、Jira、Git Pipeline、修复）的注册表：名字、角色、提示词、模型、权限、DSH agent 预设、各自能用的工具。

| 文件 | 放的是什么 |
|---|---|
| `bots.ts` | `allBotDefs`、`botDef`、`toolsOfRole`、`validateRegistry`；配置键和默认值 `CONFIG_KEYS`、`CONFIG_DEFAULTS` |

谁调它：`task/botlayer.ts` 建 bot 时读，`tools/register.ts` 按角色发工具。加一个 bot 就在这里加一项；改完要保证 `validateRegistry()` 没有问题（`test/registry.test.ts` 会查）。
