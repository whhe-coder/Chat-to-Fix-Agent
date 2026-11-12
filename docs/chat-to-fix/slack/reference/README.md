# Slack Bot 参考实现（给 Yuzhao）

本参考实现包含当前不启用的讨论串 @ 入口；如使用它，须先移除该入口。

我们照 [../slackbot.md](../slackbot.md) 第 4.4 节和 [../slackenter.md](../slackenter.md) 第 2 节写的一版 Slack Bot 一侧，**只是参考**：

- 没放进仓库根目录的 `src/slackBot/`，Logan 的代码一行没动。
- 没人审过，没连过真 Slack。

哪些大概率做过头、可以直接改或删，见 [../handover.md](../handover.md) 第 4.1 节。

## 里面有什么

| 文件 | 内容 |
|---|---|
| `src/slackBot/chat-to-fix-api.js` | Chat-to-Fix 接口客户端：`postEvent`、`getOutbox`、`health` |
| `src/slackBot/fix-command.js` | `/fix` 和讨论串 @ 的处理 |
| `src/slackBot/outbox-relay.js` | 发件箱转发，带游标 |
| `test/*.test.js` | 上面三个文件的测试，加上模拟 Bot 的 `/fix` 测试 |
| `changes-to-root-files.patch` | 要改的根目录已有文件：`src/slackBot/slack-bot.js`（挂上 `/fix`、@ 和转发）、`mock-slack-bot.js`、`start-mock.js`、`spec/mock-slack-bot.md`、`config/` 两份 README、`.env.example`、`.gitignore`、`package.json` |
| `slackbot-mock-chain.sh` | 一条命令跑模拟全链路，要先套上参考实现 |

## 套到仓库根目录上

在你自己的分支上，从仓库根目录执行：

```sh
cp docs/chat-to-fix/slack/reference/src/slackBot/*.js src/slackBot/
cp docs/chat-to-fix/slack/reference/test/*.test.js test/
git apply docs/chat-to-fix/slack/reference/changes-to-root-files.patch
npm ci && npm test
```

补丁是对着 `main` 的 `7b600dc` 做的；你的分支动过这些文件的话，可能要手工合一下。
