# Slack `/fix` 入口：Logan 的方案和我们怎么接

2026-11-12，只读研究。查的是公司仓库 `whhe-coder/Chat-to-Fix-Agent` 的 `main`（最新提交 `8c2039dc`），以及我们本地 `chat-to-fix/` 的入口代码。没有改代码，也没有调用 Slack。

## 结论

1. **Logan 那边只有规格和 Slack 应用配置，没有处理 `/fix` 的代码，也没有任何验证。** 他 11-12 把入口从"私信"改成"指定频道 `/fix`"（提交 `067cf9a5`，只改了文档）。`src/slackBot/` 里仍然只有私信测试 Bot。Slack 里 `/fix` 命令还没创建，频道没定，Bot token 也没拿到。所以没有能直接采用的实现，事件格式也没有真实样本可以参考。
2. **最要紧的是 Slack 应用的权限冲突。** Logan 把公司那个 `Chat-to-Fix` Slack 应用改成了只有 `commands`、`chat:write` 两个 Bot 权限，关掉了全部事件（包括 `app_mention`），并且明确"不申请频道历史读取权限"。我们的设计需要 `app_mention` 事件，还要读讨论（`channels:history`、`groups:history`）。如果两边共用这个应用，我们的 @ 入口和"取回讨论"在他现在的配置下都跑不通。这个应用的安装申请还在等审批。要加权限，最好赶在批下来之前说，不然得再批一次。
3. **建议：@ 仍是主入口，`/fix` 作为第二个入口加上。** 根据 Slack 文档，开发者自建的斜杠命令不能在讨论串里用，载荷里也没有 `thread_ts`。所以 `/fix` 只能开新问题，不能"把这段讨论修掉"。另外，补充信息（`needs_info` 后在讨论串里再 @）也得靠 @。`/fix` 只做 @ 的补充，不替代它。
4. **怎么接：** 收到 `/fix` 后，服务端检查通过，就先在频道发一条开头消息作为讨论串。之后的任务和 @ 走完全一样的路。拒绝和出错只通过 `response_url` 发临时消息告诉发起人，频道里不留痕迹。改动集中在转发程序、`/events` 和 Slack 适配器，**工作量约 1～1.5 天（本机模拟测试通过为止），拿到真 token 后再花约半天在真 Slack 上验证。**
5. **一个应用只能有一个程序连。** Socket Mode 下，同一个应用最多开 10 个连接，每条消息可能发给其中任何一个连接（文档原话："each payload may be sent to any of the connections"）。所以 Logan 的 Bot 和我们的转发程序如果同时连同一个应用，消息会被随机分走。要么分两个应用，要么同一时间只跑一套。

## 1. Logan 的方案（公司仓库 `main`）

### 入口设计

| 项 | 内容 | 出处 |
|---|---|---|
| 入口 | 在指定频道输入 `/fix 问题描述`，命令正文不能为空 | `README.md`、`spec/slack-fix-command.md` |
| 频道 | 只接受一个指定频道的 ID；其他频道的调用只向发起者返回拒绝说明，不启动任务。频道类型和 ID 未定 | 同上 |
| 回复 | 在 Slack 要求的时间内确认，再在指定频道发一条任务消息；之后 Jira、MR、CI 的进度都回在这条消息的讨论串里 | 同上 |
| 去重 | 同一条命令重试不能重复启动任务；持久去重放在 M1 | 同上 |
| 不启动任务的情况 | 普通频道消息、私信、讨论串回复，以及频道里的 @ | `config/slack/README.md` |
| 以前的方案 | 11-11 是私信入口（`message.im`），代码和本机测试还在，已标为历史 | `spec/slack-dm-entry.md` |

### Slack 应用配置（他在 Slack 页面上核对过的状态）

| 页面 | 状态 |
|---|---|
| Bot Token Scopes | 只有 `commands`、`chat:write`（`im:history`、`app_mentions:read` 已删） |
| User Token Scopes | 无 |
| Event Subscriptions | Off，没有任何 Bot 事件（`message.im`、`app_mention` 都删了） |
| Socket Mode | 已开 |
| App-level token | 已生成，只有 `connections:write`，存在他 Mac 的钥匙串里 |
| Slash Commands | `/fix` **未创建** |
| 安装 | 工作区和组织的申请显示 "Request Submitted"；申请链接里已经是新的权限组合，但审批人看到的是否已更新，**没有证实**；Bot token（`xoxb-`）**没拿到** |
| App Home 的 Messages 标签 | 仍开着（他计划关掉） |

### 做到哪一步、验证到哪一步

- 代码：没有任何 `/fix` 处理代码。`src/slackBot/slack-bot.js` 用 `@slack/bolt` 4.7.3，只监听私信 `message` 事件，回一句固定的测试文字；模拟 Bot（`mock-slack-bot.js`）也只模拟私信。两者都"未进行真实 Slack 收发验证"（`plans/done.md`）。
- 计划：M0（配置 `/fix`）进行中，剩下"注册 `/fix`、定频道 ID、核对审批"三件事。M1（Bot 接本地 agent）未开始。真实 Slack 验收要到 M6。
- 最近 30 条提交里，和 `/fix` 有关的只有 `067cf9a5 docs: record Slack slash command permission change`（7 个文档文件，没有代码）。
- 他真正验证过的是 Jira 写入（用真实工单和评论）和 GitLab 的只读调用，和 Slack 入口无关。
- 他的令牌变量名是 `SLACK_APP_TOKEN`、`SLACK_BOT_TOKEN`（钥匙串条目 `Chat-to-Fix-Agent/<变量名>`，账号 `local-agent`）。我们用的是 `CHAT_TO_FIX_SLACK_APP_TOKEN`、`CHAT_TO_FIX_SLACK_TOKEN`。共用应用的话，在启动脚本里对应一下就行。

### 可以参考的和不要跟的

- 可以参考：他的规格里"只在指定频道接受，其他地方只回发起人，不启动任务；先确认，再发任务消息，进度回在讨论串里；重试不重复建任务"这几条，和我们的监听口规则一致，可以照这个写验收。
- 不要跟：去掉 @ 和"不读频道历史"。我们的第 1 步"取回讨论"、Slack bot 的摘要、`needs_info` 之后的补充信息，都离不开读讨论串和 @。

## 2. 我们现在的入口

| 环节 | 现状 | 位置 |
|---|---|---|
| 转发程序 | 用 Socket Mode 连 Slack，每个信封先确认。只处理 `events_api` 里的 `app_mention`，转成 `/events` 的请求体。`slash_commands` 信封只确认、不转发也不回话，用户敲 `/fix` 后**什么也看不到** | `scripts/slack-forwarder.ts:228-233` |
| 请求体 | `{ eventId, channel, threadTs, messageTs, user: { id, name? }, text, files, permalink? }`；`threadTs` 取 @ 所在讨论串，不在讨论串里就取消息本身的 `ts` | `slack-forwarder.ts:32-67` |
| 监听口 `POST /events` | 依次：必填字段（`eventId`、`channel`、`threadTs`、`messageTs`、`text`、`user.id`）→ 按 `eventId` 去重 → `bindingOf(config, channel)` 查频道绑定，没绑定就回 422，并在讨论串里发一条说明 → 同一讨论串已有排队中或运行中的任务时，回 200 并提示 → `needs_info` 的任务重新排队 → 队列满回 429 → 建任务，回 202 | `src/task/http.ts:44-86` |
| 绑定 | 按频道 ID 一对一绑定仓库和 Jira 项目 | `src/config.ts:131` |
| 读讨论 | `conversations.replies` 读 `origin.channel` + `origin.threadTs`；需要 `channels:history`、`groups:history`；`users:read` 可选 | `src/adapters/slack.ts:107-142` |
| 回复 | `chat.postMessage`，带 `thread_ts: origin.threadTs`；只试一次，并处理掉 `@channel` 这类广播提及 | `src/adapters/slack.ts:144-156` |
| 系统通知 | `channel_not_bound`、`queue_full`、`in_progress` 都通过 `reply(origin, 'system', …)` 发到讨论串，**前提是有 `threadTs`** | `src/app.ts:36`、`src/task/monitor.ts:32-40` |
| 任务消息 | `origin.text` 放进给主 bot 的"材料块"，`origin.permalink` 作为讨论链接 | `src/task/runner.ts:17-33` |

## 3. `/fix` 和 @ 的差别（以 Slack 文档为准，未在真 Slack 上验证）

| 点 | @ 机器人 | `/fix` |
|---|---|---|
| 事件 | `events_api` / `app_mention`，有 `event_id`，Slack 会重试 | `slash_commands` 信封，载荷字段：`team_id`、`channel_id`、`channel_name`、`user_id`、`user_name`、`command`、`text`、`response_url`、`trigger_id` 等；**没有 `thread_ts`，也没有消息 `ts`** |
| 讨论串 | 有：@ 本身就是一条消息，或者在已有讨论串里 | 没有。文档："Slash commands created by developers cannot, however, be invoked in message threads."。命令本身也不会作为消息出现在频道里 |
| 确认时限 | 尽快确认 | 3000 毫秒内必须确认，否则用户看到 `operation_timeout`。Socket Mode 的确认是 `{ envelope_id, payload? }`，`payload` 里可以直接带一条回复 |
| 去重键 | `event_id` | 用 `trigger_id`（每次调用一个，只能用一次）。文档没写斜杠命令会不会重发，但我们的转发程序自己会重试 `/events`，所以仍然要去重 |
| 读之前的讨论 | 能 | 不能。只有命令里那一行文字 |
| 权限 | `app_mentions:read` + `app_mention` 事件 | `commands`（Slack 文档页没写明，是常规做法，Logan 的配置里也是它） |
| 能在哪用 | Bot 所在的频道 | 任何会话都能调起，包括 Bot 不在的频道和别人之间的私信 |

## 4. 建议的接法

### 4.1 讨论串的开头：先在频道发一条消息

要发。开头消息的 `ts` 就是这个任务的 `threadTs` 和 `messageTs`。之后读讨论、Slack bot 的"已收到"、提问、CI 通知、结果，全部沿用现在的 `reply(origin, …)`，不用改。用户之后在这条讨论串里 @ 机器人补充信息，走现有的 @ 入口：`findByThread` 能找到这个任务，`needs_info` 时重新排队。

开头消息由系统发（作者是 Bot），内容示例：

> <@U123> 用 /fix 提了一个修复请求：
> > 登录页"忘记密码"链接点了没反应
> 进度会回在这条消息的讨论串里。

- 一定要写出 `<@发起人>`。Slack bot 的摘要里有"requester"一项，读讨论时 `<@U..>` 会被换成名字；不写的话，讨论串里只看得到 Bot 自己。
- 用户的原文要先经过 `neutralizeBroadcasts`，防止 `@channel` 这类广播。
- 建议在 `/fix` 的命令配置里勾上 "Escape channels, users, and links"。这样文字里的 @ 和 # 会变成 ID，`readableText` 能换成名字。

**谁来发开头消息：建议服务端（`/events`）发，不让转发程序发。** 理由：只有服务端知道绑定和队列的情况，"拒绝时频道里不留痕迹"只有它能保证。转发程序保持"翻译、确认、转交"这一个职责。（另一个做法是转发程序先发开头消息、再按现在的格式 POST `/events`，服务端一行不改。但那样没绑定的频道和队列满时，频道里会留下一条开头消息，后面跟一句"不受理"，而且转发程序得自己读配置查绑定。代码少半天左右，体验差一些。）

服务端处理 `/fix` 的顺序（`source: "slash"`，请求里没有 `threadTs`）：

1. 按 `eventId`（`slash:<trigger_id>`）去重。另外在内存里记一个"处理中"的集合，防止转发程序重试时两次请求同时进来，发出两条开头消息。
2. 查绑定：没绑定就回 422 `channel_not_bound`，**不往频道发东西**。
3. 队列满：回 429 `queue_full`，同样不往频道发东西。
4. 发开头消息（Slack 适配器的新函数 `startThread(channel, text)`，返回 `{ ts, permalink }`）。失败（多半是 `not_in_channel`）就回 502，并带上适配器的错误码。
5. 用 `threadTs = messageTs = 开头消息的 ts` 建任务、排队，回 202 `{ taskId, permalink }`。

### 4.2 `response_url` 和 `chat.postMessage`

| | `response_url` | `chat.postMessage` |
|---|---|---|
| 限制 | 30 分钟内最多用 5 次；不需要 Bot 在频道里 | 要 `chat:write`，Bot 要在频道里（公开频道可以用 `chat:write.public` 绕过） |
| 能否开讨论串 | 文档没说会返回 `ts`，不能拿来开讨论串 | 返回 `ts` |
| 可见范围 | 默认只有发起人能看到（临时消息） | 频道所有人 |

分工：**`response_url` 只给发起人看的即时反馈用**，由转发程序根据 `/events` 的结果发：

- 422 没绑定："这个频道没有接入 Chat-to-Fix，请在绑定的频道里用 /fix。"
- 429 队列满："修复队列已满，请稍后再试。"
- 502 发不出开头消息："机器人不在这个频道，请先邀请它。"
- 连不上服务：现在 @ 在这种情况下会被静默丢掉，`/fix` 至少能告诉发起人"服务暂时不可用"。
- 202 受理：可以不回（开头消息本身就是回执），也可以回一句"已建任务 T-12：<讨论串链接>"。

**进度和结果一律用 `chat.postMessage` 回在开头消息的讨论串里。** 我们的任务常常超过 30 分钟，`response_url` 撑不住。

确认：转发程序收到信封后，立刻发不带 `payload` 的确认（现在就是这样）。命令正文为空这类转发程序自己就能判断的情况，可以直接在确认的 `payload` 里回用法说明，连 `/events` 都不用调。

### 4.3 在私信里用和在频道里用

- **频道里**：按 `channel_id` 查绑定，和 @ 一样，一个频道对应一个仓库。
- **和 Bot 的私信里**（App Home 的 Messages 标签）：每个人和 Bot 的私信频道 ID（`D…`）都不同，按频道绑定查不到。有三种办法：
  1. 不支持，返回临时消息"请在绑定的频道里用 /fix"。**建议第一版就这样**，零配置。
  2. `/fix <仓库别名> 描述`：给每个绑定加一个 `alias`，私信里必须写别名。讨论串开在私信里，读私信讨论需要再加 `im:history`。
  3. 每个人一个默认绑定：要维护人和仓库的对应表，不建议。
- **别人之间的私信或群聊私信里**：Bot 不在里面。文档说斜杠命令可以借此往这类私信发消息，但我们不建议在这里开任务（读不到讨论，别人也看不到进度）。一律回临时消息拒绝。

### 4.4 需要的 Slack 权限（我们的设计加上 `/fix` 之后）

| 类型 | 权限或配置 | 用途 | Logan 现在的配置里有没有 |
|---|---|---|---|
| Bot scope | `app_mentions:read` | @ 入口 | 没有（被删了） |
| Bot scope | `channels:history`、`groups:history` | 读讨论（公开频道和私有频道） | 没有，他明确说不申请 |
| Bot scope | `chat:write` | 开头消息和所有回复 | 有 |
| Bot scope | `commands` | `/fix` | 有 |
| Bot scope | `users:read`（可选） | 把发言人显示成名字 | 没有 |
| Bot scope | `im:history`（只在选 4.3 的第 2 种时才要） | 读私信里的讨论串 | 没有 |
| Bot 事件 | `app_mention` | @ 入口 | 没有（事件全关） |
| Slash Command | `/fix`，勾上 "Escape channels, users, and links"；Socket Mode 下不需要 Request URL | `/fix` | 未创建 |
| App-level token | `connections:write` | Socket Mode | 有 |
| 其他 | 把 Bot 邀请进每个绑定的频道 | 读讨论、发消息 | 频道未定 |

`chat.getPermalink`（转发程序补充链接时用）据我们所知不需要额外权限，没有在真 Slack 上核对过。

## 5. 按文件的改动清单和工作量

| 文件 | 改动 | 估计 |
|---|---|---|
| `scripts/slack-forwarder.ts` | 新增 `slashCommandToEvent(payload)`（纯函数）：只认配置的命令名（默认 `/fix`），正文为空时直接给出用法说明；生成 `{ source: 'slash', eventId: 'slash:<trigger_id>', channel: channel_id, user: { id: user_id, name: user_name }, text, responseUrl }`。循环里处理 `type === 'slash_commands'`。新增 `respond(responseUrl, text)`，根据 `/events` 的结果发临时消息；`response_url` 不在日志里打印 | 约 80～100 行 |
| `src/task/http.ts` | `postEvent` 加 `source === 'slash'` 分支（4.1 的五步）；必填字段改成按来源检查；记一个内存里的"处理中"集合；`createHttp` 多注入一个 `startThread` | 约 50～70 行 |
| `src/adapters/slack.ts` | 真实适配器新增 `startThread(channel, text)`：`chat.postMessage`（不带 `thread_ts`，只试一次，处理广播提及）+ `chat.getPermalink`（尽力而为）。假适配器新增同名函数，写出讨论串文件，让 `readThread` 能读到 | 约 40 行 |
| `src/app.ts` | 把 `adapters.slack.startThread` 传进 `createHttp` | 几行 |
| `src/config.ts` | 可选：`slack.slashCommand`（默认 `/fix`）。选 4.3 的第 2 种时，绑定多一个 `alias` | 0～20 行 |
| `scripts/fake-event.ts` | 加 `--slash` 模式，没有真 Slack 时也能走一遍 | 约 20 行 |
| 测试 | `test/slack-forwarder.test.ts`：载荷转换、确认先于处理、各种状态码对应的临时消息、空正文。`test/http.test.ts`：去重、并发重试只发一条开头消息、没绑定或队列满时不往频道发、发不出时回 502、受理后 `findByThread` 能找到。`test/adapters-slack.test.ts`：`startThread` 的真实和假实现 | 约 12～15 个用例 |
| 文档 | `software-spec.md` 7.1 监听口、`spec-4` 的 Slack 适配器和权限、`README.md` 入口说明 | 半小时到 1 小时 |

合计：本机加模拟测试约 1～1.5 天。拿到真 Bot token、注册好 `/fix` 后，在真 Slack 上验证约半天（主要是确认载荷字段、在私有频道和 Bot 不在的频道里的表现、`response_url` 的实际效果）。

**马上能做的小事（不管要不要 `/fix`）：** 转发程序收到 `slash_commands` 时，在确认的 `payload` 里回一句"暂不支持 /fix，请在绑定的频道里 @ 我"，免得用户敲了没反应。约 10 行加 1 个测试。

## 6. 需要 Zihui 或同事决定的事

| # | 问题 | 谁定 | 建议 |
|---|---|---|---|
| 1 | 和 Logan 共用公司的 `Chat-to-Fix` Slack 应用，还是我们另开一个？ | Zihui + Logan | 另开一个最省事，互不影响。共用的话见第 2、3 条 |
| 2 | 共用的话，要不要在审批通过前给应用加上 `app_mentions:read`、`channels:history`、`groups:history`（可选 `users:read`）和 `app_mention` 事件？ | Zihui + Logan + 工作区管理员 | 要加就趁现在，否则会再走一轮审批 |
| 3 | 共用的话，同一时间只能跑一个程序连这个应用（Socket Mode 会把消息随机分给各个连接） | Zihui + Logan | 定好谁在什么时候连 |
| 4 | 要不要做 `/fix`？做的话，是不是作为 @ 之外的第二个入口？ | Zihui | 做，作为第二个入口；@ 保留 |
| 5 | 开头消息由服务端发（建议），还是转发程序发（少改一些，但拒绝时频道里会留痕迹）？ | Zihui | 服务端发 |
| 6 | `/fix` 在和 Bot 的私信里：不支持、带仓库别名，还是按人设默认绑定？ | Zihui | 第一版不支持 |
| 7 | 试点频道是哪个，是公开频道还是私有频道？（决定 `channels:history` 和 `groups:history` 要不要都申请，以及要不要 `chat:write.public`） | Zihui 或负责试点的同事 | 两个 history 权限都申请；不要 `chat:write.public`，绑定的频道都邀请 Bot 进去 |
| 8 | 受理后要不要再用 `response_url` 回发起人一句"已建任务 T-n"？ | Zihui | 可有可无，开头消息已经够了 |
