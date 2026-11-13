# scripts/debug-ui/

调试页右侧的 bot 群聊窗格（竖屏、像手机 IM）。

| 文件 | 放的是什么 |
|---|---|
| `chat.ts` | 把任务的执行记录变成群聊消息（`buildChat`），并带上页面用的 `CHAT_CSS`、`CHAT_JS` |
| `chat-client.js` | 浏览器端代码（渲染、高亮、Markdown），由调试页内联，没有 import |
| `chat.css` | 群聊窗格样式 |

谁调它：`../flow-page.ts` 组页面，`test/debug-ui-chat.test.ts` 测 `buildChat`。只改调试显示；不要在这里读写任务状态。
