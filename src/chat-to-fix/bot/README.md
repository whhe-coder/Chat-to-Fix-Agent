# bot/

从 DS Bot 0.3.1 裁下来的 bot 层代码（只留我们运行时用到的模块）。平时不用看，不改；要改行为改 `../core/`。

| 文件 / 目录 | 放的是什么 |
|---|---|
| `src/host/` | DS Bot 的 bot、群、会话、请求、工具、权限等模块（`roster.ts`、`groups.ts`、`turns.ts`、`tools.ts` 等） |
| `src/shared/` | 共用的小模块（`mentions.ts`、`group-replies.ts`、`im-platforms.ts`） |
| `test/` | 保留下来的 DS Bot 测试，`npm run test:agent-bot` 运行 |
| `LICENSE`、`LICENSE.upstream`、`NOTICE.upstream` | 上游许可和声明，不要删 |

谁调它：`../core/bot/index.ts` 装它。裁掉了什么、为什么，见 `../rewrite/INVENTORY.md`。不要在这里加 Chat-to-Fix 自己的逻辑。
