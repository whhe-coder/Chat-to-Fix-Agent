# Slack Bot 对接交接（给 Yuzhao）

- 日期：2026-11-12。写的人：Zihui（Chat-to-Fix）。
- 一句话：Slack Bot（仓库根目录 `src/slackBot/`，Logan 的代码）只管 Slack 收发；修 bug 的业务逻辑在 `chat-to-fix/`，两边通过本机 HTTP 接口对接。
- 分工：业务接口是 Chat-to-Fix 这边做的，已经写好；**Slack Bot 一侧归你**。我们的东西全在 `chat-to-fix/` 里，没动 `chat-to-fix/` 以外的任何文件。
- 我们顺手写了一版 Slack Bot 的参考实现，放在 [reference/](reference/README.md)，没有放进 `src/slackBot/`。你审、改、重写都行，以你的为准。
- 契约：
  - [slackbot.md](slackbot.md)：接口。
  - [slackenter.md](slackenter.md)：入口行为和权限。
  - 两份都以 Logan 的 [固定频道 `/fix` 规格](../../../spec/slack-fix-command.md) 为基础，不改它定下的东西。

## 1. 现在做到哪

| 部分 | 状态 |
|---|---|
| Chat-to-Fix 业务接口：发件箱 `GET /outbox`、`adapters.slack: "outbox"`、`POST /events` 的 `source: fix / mention`（`chat-to-fix/src/task/outbox.ts`、`http.ts`、`src/adapters/slack.ts`） | 做完。`chat-to-fix` 的 `npm test` 677 项全过；`scripts/connected.ts` 生成的配置已改成发件箱模式 |
| 讨论串里补充信息 → 任务带着补充重跑 | 做完，模拟环境测过 |
| 修不了、需要人处理时用中文说明原因 | 做完 |
| Slack Bot 参考实现：`/fix`、讨论串里的 @、发件箱转发、模拟入口（[reference/](reference/README.md)） | 参考用，归你。套到 `src/slackBot/` 上以后，根目录 `npm test` 60 项全过；**没连过真 Slack**，没人审过 |
| 模拟全链路（`reference/slackbot-mock-chain.sh`）：模拟 Slack Bot → Chat-to-Fix（本机假模型）→ 发件箱 → 模拟讨论串 | 套上参考实现后跑通：任务消息、建任务、@ 补充存进任务，“正在处理”“已停止”“没有在处理的任务”三条通知都回到讨论串 |

## 2. 接口速查

- 地址：都在 `http://127.0.0.1:3090`。
- 鉴权：请求头带 `x-chat-to-fix-token`。
- 格式：JSON。
- 细节和每种返回码见 [slackbot.md](slackbot.md) 第 4.2 节。

| 请求 | 什么时候调 | 要点 |
|---|---|---|
| `POST /events`，`source: "fix"` | `/fix` 通过、任务消息发出后 | `eventId` 填 `slash:<trigger_id>`；`threadTs` 和 `messageTs` 都填任务消息的 `ts` |
| `POST /events`，`source: "mention"` | 讨论串里有人 @ bot | `eventId` 填 Slack 的 `event_id`。只给已有任务补充信息，不会开新任务；讨论串里没有进行中的任务时回 409 |
| `GET /outbox?after=<游标>` | 每 3 秒 | 把每条 `text` 发到 `channel` 里 `threadTs` 那个讨论串；发成功一条就存一次游标 |
| `GET /tasks/<号>` | 排查时 | 状态、Jira、MR、CI、失败原因 |
| `POST /tasks/<号>/stop` | 要停一个任务时 | |
| `GET /health` | 启动时探一次 | |

Slack Bot 不写进度文案，讨论串里的话都来自发件箱。只有两句“服务暂时连不上”是 Slack Bot 自己写的。

## 3. 怎么跑

### 3.1 环境变量

放在仓库根目录的 `.env.local`，原有变量见 [config/local-env/README.md](../../../config/local-env/README.md)。

| 变量 | 值 |
|---|---|
| `SLACK_APP_TOKEN`、`SLACK_BOT_TOKEN` | 照旧 |
| `CHAT_TO_FIX_SLACK_CHANNEL` | 指定频道 ID，原有变量。Slack Bot 只认这个频道；Chat-to-Fix 也用它绑定仓库 |
| `CHAT_TO_FIX_API_URL` | 新增，默认 `http://127.0.0.1:3090` |
| `CHAT_TO_FIX_API_TOKEN` | 新增，Chat-to-Fix 启动后 `<数据目录>/http-token` 里的值 |

### 3.2 先用模拟入口试（不用 Slack 令牌）

1. 在自己的分支上把参考实现套到仓库根目录，命令见 [reference/README.md](reference/README.md)。不想要参考实现，就跳过这一步，按 [slackbot.md](slackbot.md) 第 4.4 节自己写。
2. 一条命令跑完整个模拟链路。不用 Slack，不用真模型，不花钱，跑完自动停：

```sh
cd chat-to-fix && . scripts/dev-env.sh    # Chat-to-Fix 的依赖装法见 chat-to-fix/README.zh.md
sh docs/slack/reference/slackbot-mock-chain.sh
```

它依次做这些事：

1. 起本机假模型和发件箱模式的 Chat-to-Fix（端口 3190）。
2. 起模拟 Slack Bot（端口 4101）。
3. 提交 `/fix`。
4. 任务运行中 @ 补充一句。
5. 停止任务。
6. 任务结束后再 @ 一次。
7. 打印发件箱和模拟讨论串。

假模型不会真的修，只能看到任务消息和系统通知；要看“已收到”和结果，得用真实模型跑一次。

### 3.3 真 Slack

正式接入时：

1. 用 `chat-to-fix/scripts/connected.ts --start` 起 Chat-to-Fix，它会打印接口令牌所在的文件。
2. 起你的 Slack Bot，用 `npm start`。

## 4. 你要做的

1. 读 [slackbot.md](slackbot.md) 第 4.2、4.4 节和 [slackenter.md](slackenter.md) 第 2 节，这是接口和行为的约定。
2. 决定用不用参考实现：套上再改，或者照约定自己写。和约定对不上、或者你觉得接口不好用的地方，直接提，我们改接口。
3. 用模拟入口（3.2）连本机 Chat-to-Fix，跑通 `/fix` → 讨论串回报。
4. Slack 应用配好、令牌到手后，在真 Slack 上验收（3.3）。

### 4.1 参考实现里大概率做过头的，直接改或删都没问题

参考实现是我们这边顺手写的，没和你对过，下面这些多半超出你实际需要。按你的想法改，删掉也不用问我们；接口那一侧不受影响。

| 部分 | 做过头在哪 | 可以怎么简化 |
|---|---|---|
| 模拟 Bot 的改动（补丁里的 `mock-slack-bot.js`、`start-mock.js`，约 140 行）、`test/mock-slack-fix.test.js`、补丁里 `spec/mock-slack-bot.md` 新加的一节 | 在 Logan 的私信模拟上加了 `/fix`、`/mentions`、`/relay/tick`、`/ephemerals` 四个接口和一整套内存假频道 | 你有自己的本地试法就整块不要；或者只留 `/fix` |
| `outbox-relay.js` 的 `createFileCursorStore`，以及补丁里的 `SLACK_BOT_STATE_DIR` 和 `.gitignore` 的 `.local/` | 发件箱游标存文件，重启后接着发 | 只存在内存里也行：重启后可能漏发或重发几条，第一版问题不大 |
| `chat-to-fix-api.js` 的错误码（`CHAT_TO_FIX_NETWORK`、`CHAT_TO_FIX_TIMEOUT`）和超时处理 | 为“连不上”单独分了类 | 直接用 `fetch` 加一个 `try/catch` 就够 |
| 补丁里 `slack-bot.js` 启动时调 `auth.test` 取 bot 的用户 ID | 为了去掉 @ 开头的机器人提及 | 去掉也行：事件里的 `authorizations` 已经带了 |
| `fix-command.js` 里 @ 补充“连不上”时的那句回复 | 文案是我们自己编的，约定里原来没有 | 改文案或不回都行 |
| 补丁里 `package.json` 的 `test` 改成 `node --test test/*.test.js` | 为了不扫进 `chat-to-fix/` | 你有别的办法就不用 |
| 补丁里 `.env.example`、`config/local-env/README.md`、`config/slack/README.md` 新加的几行 | 按我们的理解写的变量说明 | 按你的写法重写 |

比较确定该留的是 `fix-command.js` 里 `/fix` 和 @ 的判断顺序：它照的是 [slackenter.md](slackenter.md) 第 2 节的表。要改判断规则的话，先说一声，接口那边可能要跟着变。

## 5. 要你们定或办的

1. **Slack 应用**：
   - 注册 `/fix`。
   - 加 Bot scope `app_mentions:read` 和事件 `app_mention`，讨论串里补充信息要用。最好和这次安装审批一起提交。
   - 把 Bot 拉进指定频道。
   - 见 [slackenter.md](slackenter.md) 第 3 节。
2. **指定频道 ID**。
3. **部署**：第一版 Slack Bot 和 Chat-to-Fix 跑在同一台机器上，接口只听本机。要分开部署时再定。

## 6. 已知限制

- 发件箱是“至少发一次”：Slack Bot 发完一条还没存游标就崩溃的话，重启后这条会再发一次。
- 不支持私信。
- @ 补充时只有用户 ID，没有名字（没申请 `users:read`）。
- 模拟入口测不到真实的 3 秒确认、权限和事件投递。
