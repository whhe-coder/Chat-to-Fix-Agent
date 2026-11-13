# core/bot/

bot 层入口：把 `../../bot/`（DS Bot 0.3.1 裁剪版）的模块按顺序装进 DSH，再接上系统层。

| 文件 | 放的是什么 |
|---|---|
| `index.ts` | `apply`、`createRuntime`、`connectTaskLayer`：按顺序装 DS Bot 模块 |
| `stubs.ts` | 少量替身：代替我们没装的 DS Bot 模块（`install`） |

谁调它：`core/plugin.ts`。很少需要改；要改 DS Bot 本身的行为先看 `rewrite/INVENTORY.md`，不要直接改 `../../bot/`。
