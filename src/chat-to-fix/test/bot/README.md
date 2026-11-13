# test/bot/

系统层在真实 bot 层（DS Bot 模块，跑在 DS Bot 的假 DSH 环境里，模型由测试手动驱动）上的测试。运行：`npm run test:agent-layer`。

| 文件 | 测什么 |
|---|---|
| `host.ts` | 共用：装好 `core/bot/index.ts` 的假 DSH 环境 |
| `botlayer.test.ts` | `core/task/botlayer.ts` 门面在真实 bot 层上的行为 |
| `app-on-botlayer.test.ts` | 整个 `core/app.ts` 在真实 bot 层上：Slack 事件进来，建五个 bot 和群 |
| `plugin.test.ts` | `core/plugin.ts` 一次装好两层，控制接口能回应 |
| `role-tools.test.ts` | 角色工具按角色挂到各 bot 的会话上 |

什么时候来改：改 `core/bot/`、`task/botlayer.ts` 或工具挂载方式时。注意这里的测试用 `bot/test/harness-resolve.ts`，和 `test/` 根目录的跑法不同。
