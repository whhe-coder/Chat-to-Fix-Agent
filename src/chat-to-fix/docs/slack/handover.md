# Slack Bot 对接交接（给 Yuzhao）

> 本文保留 PR #5 的设计与交接背景。目录已迁至 `src/chat-to-fix/`；本期只接受 `/fix` 首次提交和 Agent 自动 CI 修复，不启用用户在讨论串中的二次修改。

- 日期：2026-11-12。写的人：Zihui（Chat-to-Fix）。
- 一句话：Slack Bot（仓库根目录 `src/slackBot/`，Logan 的代码）只管 Slack 收发；修 bug 的业务逻辑在 `chat-to-fix/`，两边通过本机 HTTP 接口对接。
- 分工：业务接口是 Chat-to-Fix 这边做的，已经写好；**Slack Bot 一侧归你**。我们的东西全在 `chat-to-fix/` 里，没动 `chat-to-fix/` 以外的任何文件。
- 我们顺手写了一版 Slack Bot 的参考实现，放在 [reference/](reference/README.md)，没有放进 `src/slackBot/`。你审、改、重写都行，以你的为准。
- 先读这几份：
  - [vs-logan.md](vs-logan.md)：我们怎么基于 Logan 的规格延展，哪些照搬、哪些补上、哪 2 处要他改。
  - [slackbot.md](slackbot.md)：接口。
  - [slackenter.md](slackenter.md)：入口行为和权限。
- 规格怎么并进 Logan 的文档，见第 5 节。

## 1. 现在做到哪

| 部分 | 状态 |
|---|---|
| Chat-to-Fix 业务接口：发件箱 `GET /outbox`、`adapters.slack: "outbox"`、`POST /events` 的 `source: fix / mention`、`GET /health` 带 `queueFull` | 做完；`scripts/connected.ts` 生成的配置已改成发件箱模式 |
| 进度通知：工单已建、MR 已开、CI 每轮修复推送（带 commit 链接），对齐 Logan README 的五个回报节点 | 做完 |
| 讨论串里补充信息 → 任务带着补充重跑；开关 `slack.mentions`，权限没批时关掉，改为提示补全后重新 `/fix` | 做完，模拟环境测过；`connected.ts` 先设为关 |
| 修不了、需要人处理时用中文说明原因 | 做完 |
| Slack Bot 参考实现：`/fix`（先问 `/health`）、讨论串里的 @、发件箱转发、模拟入口（[reference/](reference/README.md)） | 参考用，归你。套到 `main` 上以后，根目录 `npm test` 62 项全过；**没连过真 Slack**，没人审过 |
| 模拟全链路（`reference/slackbot-mock-chain.sh`）：模拟 Slack Bot → Chat-to-Fix（本机假模型）→ 发件箱 → 模拟讨论串 | 套上参考实现后跑通 |

## 2. 接口速查

- 地址：`http://127.0.0.1:3090`。
- 鉴权：请求头带 `x-chat-to-fix-token`。
- 格式：JSON。
- 细节和每种返回码见 [slackbot.md](slackbot.md) 第 4.2 节。

| 请求 | 什么时候调 | 要点 |
|---|---|---|
| `GET /health` | 每次 `/fix`，发任务消息之前 | 连不上或 `queueFull: true`，就只给发起人回临时消息，不发任务消息 |
| `POST /events`，`source: "fix"` | 任务消息发出后 | `eventId` 填 `slash:<trigger_id>`；`threadTs` 和 `messageTs` 都填任务消息的 `ts` |
| `POST /events`，`source: "mention"` | 讨论串里有人 @ bot | `eventId` 填 Slack 的 `event_id`。只给已有任务补充信息，不开新任务；讨论串里没有进行中的任务时回 409 |
| `GET /outbox?after=<游标>` | 每 3 秒 | 把每条 `text` 原样发到 `channel` 的 `threadTs` 讨论串；发成功一条就存一次游标 |
| `GET /tasks/<号>` | 排查时 | 状态、Jira、MR、CI、失败原因 |
| `POST /tasks/<号>/stop` | 要停一个任务时 | |

Slack Bot 不写进度文案，讨论串里的话都来自发件箱。它只自己写两句“服务暂时连不上”，外加 `/fix` 的拒绝说明。

## 3. 怎么跑

### 3.1 环境变量

放在仓库根目录的 `.env.local`，原有变量见 [config/local-env/README.md](../../../../config/local-env/README.md)。

| 变量 | 值 |
|---|---|
| `SLACK_APP_TOKEN`、`SLACK_BOT_TOKEN` | 照旧 |
| `CHAT_TO_FIX_SLACK_CHANNEL` | 原有变量，指定频道 ID。Slack Bot 只认这个频道，Chat-to-Fix 也用它绑定仓库 |
| `CHAT_TO_FIX_API_URL` | 新增，默认 `http://127.0.0.1:3090` |
| `CHAT_TO_FIX_API_TOKEN` | 新增，Chat-to-Fix 启动后 `<数据目录>/http-token` 里的值 |

### 3.2 先用模拟入口试（不用 Slack 令牌）

1. 在自己的分支上把参考实现套到仓库根目录，命令见 [reference/README.md](reference/README.md)。不想要参考实现，就跳过这步，按 [slackbot.md](slackbot.md) 第 4.4 节自己写。
2. 一条命令跑完整个模拟链路。不用 Slack，不用真模型，不花钱，跑完自动停：

```sh
cd chat-to-fix && . scripts/dev-env.sh    # Chat-to-Fix 的依赖装法见 chat-to-fix/README.zh.md
sh docs/slack/reference/slackbot-mock-chain.sh
```

假模型不会真的修，只能看到任务消息和系统通知；要看“已收到”和结果，得用真实模型跑一次。

### 3.3 真 Slack

1. 用 `chat-to-fix/scripts/connected.ts --start` 起 Chat-to-Fix，它会打印接口令牌所在的文件。
2. 起你的 Slack Bot（`npm start`）。
3. `app_mentions:read` 批下来以后，把 Chat-to-Fix 配置里的 `slack.mentions` 改成 `true`。

## 4. 你要做的

1. 读 [vs-logan.md](vs-logan.md)，再读 [slackbot.md](slackbot.md) 第 4.2、4.4 节和 [slackenter.md](slackenter.md) 第 2 节。这是接口和行为的约定。
2. 决定用不用参考实现：套上再改，或者照约定自己写。和约定对不上、或者你觉得接口不好用的地方，直接提，我们改接口。
3. 用模拟入口（3.2）连本机 Chat-to-Fix，跑通 `/fix` → 讨论串回报。
4. 按第 5 节把规格并进 Logan 的文档。
5. Slack 应用配好、令牌到手后，在真 Slack 上验收（3.3）。

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

比较确定该留的是 `fix-command.js` 里 `/fix` 和 @ 的判断顺序，包括先问 `/health`：它照的是 [slackenter.md](slackenter.md) 第 2 节的表。要改判断规则的话先说一声，接口那边可能要跟着变。

## 5. 规格怎么合并

- **原则**：
  - Slack 一侧的行为以 Logan 的 `spec/` 为准，我们的 [slackenter.md](slackenter.md) 并进去。
  - 接口的约定由提供方 Chat-to-Fix 维护，[slackbot.md](slackbot.md) 留在 `chat-to-fix/docs/slack/`，Logan 的文档链接过来，不复制。
- **怎么提交**：在你们自己的分支和 PR 里做，不和 Chat-to-Fix 的 PR 混。
- **合并之后**：我们这边把 slackenter.md 改成一行“已并入 `spec/slack-fix-command.md`”，并改掉指向它的链接。

| 我们的内容 | 并到 Logan 的哪里 | 怎么并 | 谁 |
|---|---|---|---|
| slackenter.md 2.1：`/fix` 每种情况的处理和文案，先问 `/health` | `spec/slack-fix-command.md`“目标行为” | 补成一张表；他已经写了的几条（空正文、其他频道、私信、确认时限、去重）保持他的写法，只加文案和 `/health` 两行 | Yuzhao |
| slackenter.md 2.2：讨论串里的 @ 补充 | `spec/slack-fix-command.md`，新加一节“讨论串里的补充” | 整节搬过去；他“thread 回复不启动任务”那句保留，后面加“讨论串里 @ bot 只给已有任务补充信息” | Yuzhao |
| slackenter.md 2.3：回报都来自发件箱 | `spec/slack-fix-command.md`“目标行为”最后一条（“Bot 在任务消息的 thread 回报结果”） | 改成“回报的内容来自 Chat-to-Fix 的发件箱，见 slackbot.md” | Yuzhao |
| slackenter.md 3：权限多 `app_mentions:read`、事件 `app_mention` | `spec/slack-fix-command.md`“Slack 配置与权限”表，`config/slack/README.md`“接下来” | 表里加两行，当前状态写“待申请”；批下来后改状态 | Logan（和管理员） |
| slackbot.md 4.4：Slack Bot 侧的改动 | 新建 `spec/slack-bot-relay.md`，或并进 `spec/slack-fix-command.md` | 照参考实现最后的样子写；接口细节只链接 slackbot.md 4.2 | Yuzhao |
| slackbot.md 4.2：接口本身 | 不并 | `plans/chat-to-fix-agent.md` M1“待确定的实施接口”那条改成链接到它 | Logan |
| vs-logan.md 3.2：`src/server/` 不承接 Bot 任务 | 根目录 `README.md`“计划交付物”里“本地服务……后续承接 Bot 任务” | 改成“只做 GitLab、Jira 连通检查；Bot 任务由 Chat-to-Fix 承接” | Logan |
| 补丁里 `spec/mock-slack-bot.md` 新加的一节 | `spec/mock-slack-bot.md` | 用了参考实现的模拟 Bot 才并；不用就丢掉 | Yuzhao |
| plans 执行规则“Bot 保存 Slack 命令、任务、Jira 工单和 MR 的对应关系” | `plans/chat-to-fix-agent.md` | 改成“对应关系由 Chat-to-Fix 的任务保存，Bot 只保存发件箱游标” | Logan |

冲突时：Slack 怎么收发，听 Logan 的；接口字段和返回码，听 slackbot.md 的。真对不上就提出来，我们一起改。

## 6. 要你们定或办的

1. **Slack 应用**：
   - 注册 `/fix`。
   - 加 Bot scope `app_mentions:read` 和事件 `app_mention`，讨论串里补充信息要用。最好和这次安装审批一起提交；没批下来不影响上线，Chat-to-Fix 先用 `slack.mentions: false`。
   - 把 Bot 拉进指定频道。
2. **指定频道 ID**。
3. **部署**：第一版 Slack Bot 和 Chat-to-Fix 跑在同一台机器上，接口只听本机。要分开部署时再定。

## 7. 已知限制

- 发件箱是“至少发一次”：Slack Bot 发完一条还没存游标就崩溃的话，重启后这条会再发一次。
- Slack Bot 重启后 Slack 重投同一条 `/fix`，可能多发一条任务消息；任务本身不会重复。
- 不支持私信。
- @ 补充时只有用户 ID，没有名字（没申请 `users:read`）。
- 模拟入口测不到真实的 3 秒确认、权限和事件投递。
