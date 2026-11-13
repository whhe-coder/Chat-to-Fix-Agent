# TS 改写前的代码统计

写于 2026-11-12，对应提交 `d988a3e`。English version: [INVENTORY.en.md](INVENTORY.en.md)

这份统计用来回答两个问题：从 DS Bot 搬来的 `bot/` 里，哪些是我们真正在用的；删掉其余部分之后，测试还能不能跑。结论是本次 TS 改写的范围依据。

## 1. 结论

- `bot/` 共 407 个文件（不含 `node_modules`）。运行时真正加载的只有 **36 个 JS 文件，共 11,409 行**，外加 `bot/package.json`（`diagnostics.js` 从里面读版本号）。
- 在副本里删掉 338 个没用到的文件后，我们自己的测试和冒烟结果与删除前完全一样：`npm test` 250 项全过，`test:layer` 18 项全过，冒烟 23 项全过。
- `test:bot` 从 1828 项变成 136 项（134 过，2 跳过，和删除前跳过的是同两项，都是只在 Windows 上才有意义的用例）。少掉的是随删掉的模块一起删掉的测试；其中 42 个文件也在测我们用到的功能，决定改写后留下，见第 6 节。
- 改写的总量约 2.5 万行：自己写的 10,914 行，加上 `bot/` 运行时 11,409 行，再加上保留的 `bot/` 测试 2,561 行。

## 2. 怎么统计的

1. 从 `src/` 下所有文件出发，顺着相对路径的 `import`、`export … from`、动态 `import('…')` 和 `new URL('…', import.meta.url)` 一路找下去，找到的就是运行时会加载的文件。DSH 只加载一个插件入口 `src/plugin.js`（`config/cordis.patch.yml` 第 175 行），所以运行时的入口全在 `src/` 里。
2. 再从 `test/`、`scripts/` 和 `bot/test/harness-resolve.mjs` 出发找一遍，多找到的就是"只给测试用"的文件。
3. `bot/src` 里用变量做路径的动态加载只有四处，加载的都是外部包（MCP 客户端、playwright、computer 插件），而且所在文件都不在运行时集合里。
4. 静态分析可能漏掉东西，所以又做了第 5 节的试删：把副本按统计结果删掉，再把四套测试和冒烟全部跑一遍。

统计脚本是 [inventory.mjs](inventory.mjs)，逐文件结果见 [bot-files.tsv](bot-files.tsv)。

## 3. 总量

| 部分 | 文件 | 行数 | 处理 |
|---|---|---|---|
| 自己写的 `src/` | 35 | 4,474 | 改写 |
| 自己写的 `test/` | 26 | 5,731 | 先留 JS，最后改写 |
| 自己写的 `scripts/` | 6 | 709 | 改写 |
| `bot/` 运行时 | 36 | 11,409 | 改写 |
| `bot/` 测试支撑（`fake-ctx.js`、`loop-kit.js`、`harness-resolve.mjs`） | 3 | 203 | 保留 |
| `bot/` 测试，只测用到的模块 | 14 | 2,358 | 保留 |
| `bot/` 测试夹具 `test/fixtures/` | 11 | — | 保留 |
| `bot/` 许可文件、`package.json`、`package-lock.json` | 5 | — | 保留 |
| `bot/` 没用到的源码和其他文件 | 195 | 约 8.7 万 | 删除 |
| `bot/` 测试，删掉的模块一起删 | 143 | 39,768 | 删除 |

我们自己写的部分按目录：

| 目录 | 行数 |
|---|---|
| `src/task/` | 1,758 |
| `src/tools/` | 828 |
| `src/adapters/` | 692 |
| `src/engine/` | 528 |
| `src/config.js` | 138 |
| `src/flow/` | 130 |
| `src/bot/` | 122 |
| `src/registry/` | 120 |
| `src/app.js` | 76 |
| `src/plugin.js` | 42 |
| `src/prompts/` | 40 |

## 4. `bot/` 运行时的 36 个文件

"谁引用"一栏只列直接引用它的文件。`host/` 前缀指 `bot/src/host/`。

| 文件 | 行数 | 谁引用 | 外部依赖 |
|---|---|---|---|
| `host/parts.js` | 1,633 | `src/bot/index.js` | `dsh-llm`、`deep-view/core` |
| `host/groups.js` | 1,509 | `src/bot/index.js`、`src/task/botlayer.js` | `dsh-llm`、`dsh-tools` |
| `host/turns.js` | 1,150 | `src/bot/index.js`、`groups.js`、`resume.js` | `dsh-scope` |
| `host/roster.js` | 788 | `src/bot/index.js` | |
| `host/tools.js` | 766 | `src/bot/index.js`、`groups.js`、`local-agents/index.js` | `dsh-tools` |
| `host/local-agents/adapter.js` | 563 | `local-agents/index.js` | `dsh-llm` |
| `host/store.js` | 560 | `src/bot/index.js` | |
| `host/resume.js` | 446 | `src/bot/index.js`、`parts.js` | |
| `host/btw.js` | 373 | `parts.js` | `dsh-llm` |
| `host/handoffs.js` | 331 | `src/bot/index.js` | |
| `host/models.js` | 315 | `src/bot/index.js` | |
| `host/chat-index.js` | 294 | `src/bot/index.js` | |
| `host/diagnostics.js` | 258 | `src/bot/index.js`、`turns.js` | |
| `host/schedules.js` | 249 | `turns.js` | |
| `host/folders.js` | 231 | `src/bot/index.js`、`tools.js` | |
| `host/local-agents/index.js` | 198 | `src/bot/index.js` | `dsh-tools` |
| `host/delivery.js` | 173 | `src/bot/index.js` | `dsh-llm` |
| `host/steward.js` | 166 | `parts.js` | |
| `host/requests.js` | 142 | `src/bot/index.js`、`tools.js` | |
| `host/local-agents/mcp.js` | 142 | `local-agents/adapter.js` | |
| `host/permissions.js` | 118 | `src/bot/index.js` | |
| `host/approvals.js` | 117 | `src/bot/index.js` | |
| `host/home-lock.js` | 99 | `store.js` | |
| `host/constants.js` | 95 | 多个模块 | |
| `shared/im-platforms.js` | 87 | `groups.js`、`parts.js`、`turns.js` | |
| `host/local-agents/discover.js` | 83 | `local-agents/index.js` | |
| `host/prompt.js` | 74 | `src/bot/index.js` | |
| `shared/mentions.js` | 73 | `groups.js`、`roster.js`、`tools.js` | |
| `shared/group-replies.js` | 70 | `parts.js` | |
| `host/local-agents/launch.js` | 68 | `local-agents/index.js` | |
| `host/local-agents/claude-engine.js` | 60 | `local-agents/index.js` | |
| `host/text.js` | 50 | `src/task/botlayer.js` 和多个模块 | |
| `host/time-context.js` | 47 | `src/bot/index.js` | `dsh-llm` |
| `host/links.js` | 40 | `tools.js`、`turns.js` | |
| `host/files.js` | 28 | `btw.js`、`store.js` | |
| `host/local-agents/engines.js` | 13 | `local-agents/adapter.js`、`local-agents/index.js` | |

外部依赖：`@deepseek-ai/*` 四个包由 `runtime/` 里的 DSH 提供；`bot/package.json` 声明的依赖里，只剩 `deep-view` 还在用（`parts.js` 第 26 行），其余的 `@modelcontextprotocol/client`、`imapflow`、`mailparser`、`nodemailer` 和三个开发依赖都只被删掉的模块用到。

**第二轮可以再裁的**：`btw.js`（旁聊）、`schedules.js`（定时任务）、`steward.js`、`shared/im-platforms.js`、`shared/group-replies.js`，以及 `parts.js` 里用到 `deep-view` 的卡片部分，看名字是我们没有用到的功能，但它们被保留的模块直接引用，所以第一轮按"有引用就留"保留了下来。要不要删，改写到对应模块时再逐个确认，确认前不算进结论。

## 5. 试删

在 `d988a3e` 的完整副本里（不碰真实目录）按第 3 节删掉 338 个文件，然后跑和删除前同样的四套测试。

| 测试 | 删除前（真实目录） | 删除后（副本） |
|---|---|---|
| `npm test` | 250 项，全过 | 250 项，全过 |
| `npm run test:layer` | 18 项，全过 | 18 项，全过 |
| `npm run smoke` | 23 项，全过 | 23 项，全过 |
| `test:bot`（`--test-concurrency=6`） | 1828 项：1826 过，2 跳过 | 136 项：134 过，2 跳过 |

删掉的文件按目录：

| 目录 | 文件 | 行数 |
|---|---|---|
| `bot/test/` | 145 | 39,860 |
| `bot/` 根目录（`client.js`、`index.js`、`office.js`、`web-search.js` 等） | 9 | 37,825 |
| `bot/src/client/`（网页界面） | 94 | 22,635 |
| `bot/src/host/` 里没用到的模块 | 25 | 9,543 |
| `bot/dev/` | 19 | 3,360 |
| `bot/src/host/im/` | 11 | 3,097 |
| `bot/src/office/` | 11 | 2,397 |
| `bot/src/host/connectors/` | 7 | 2,363 |
| `bot/src/host/browser/` | 10 | 1,712 |
| `bot/src/host/computer/` | 3 | 1,378 |
| `bot/scripts/` | 3 | 261 |
| 其他空文件 | 1 | 0 |

## 6. `bot/` 的测试

按每个测试文件实际加载的 `bot/src` 模块分类：

| 类别 | 文件 | 行数 | 处理 |
|---|---|---|---|
| 只测用到的模块 | 14 | 2,358 | 保留，试删后全部能跑 |
| 同时碰到用到和没用到的模块 | 75 | 28,363 | 删除，其中一部分可以救回，见下面 |
| 只测没用到的模块 | 48 | 7,060 | 删除 |
| 不碰 `bot/src`（测网页构建、样式、`dev/` 脚本等） | 20 | 4,345 | 删除 |

"同时碰到"的 75 个文件里，大多数通过 DS Bot 的整包入口 `bot/index.js` 的 `createRuntime` 来测。我们自己的入口 `src/bot/index.js` 也有 `createRuntime`，只是返回的是对外的门面；加一个三行的转接（用 `runtimeOf` 取回内部对象）后，可以把其中 42 个文件指到我们的入口上试跑。

| 结果 | 文件 | 测试项 |
|---|---|---|
| 全过 | 5（`request-id`、`switch-keeps-input`、`room-races`、`model-switch-compaction`、`agent-preset`） | 46 |
| 部分过 | 20 | 192 过 / 共 415 |
| 全不过 | 17 | 0 / 共 102 |
| 合计 | 42 | 238 过 / 共 563 |

不过的主要原因是这些测试通过 DS Bot 网页界面的 `POST /api/bot` 接口来驱动（237 项卡在同一处：测试替身里的 `ctx.connection.fetch` 注册的路由不存在），而网页界面和 `connection` 服务已经被我们删掉了。逐文件结果见 [salvage-trial.tsv](salvage-trial.tsv)。

能跑的 238 项多数在测群聊轮次、交接结果、bot 消息这些我们在用的功能（例如 `group-work` 58/77、`bot-messages` 39/50、`follow-through` 27/28、`blocking-question` 13/14）。

**决定（Zihui，2026-11-12）**：这 42 个文件不丢，改写成直接调用运行时，不经过网页接口。改完后，测的是已删功能的那些项删掉，其余的都要能过，并在改 TS 之前进入基线。

## 7. 改写的步骤

1. 在真实目录按 [bot-files.tsv](bot-files.tsv) 删掉标为 `delete` 的文件，`bot/package.json` 的依赖只留 `deep-view`。跑四套测试，结果应与第 5 节"删除后"一列一致。
2. 按第 6 节的决定改写那 42 个测试文件，仍用 JS。跑完后定下基线：四套测试加冒烟的项数和结果。
3. 定好 TS 的写法再动手：`tsconfig.json`、类型检查命令、导入路径带 `.ts` 扩展名、只用 Node 能直接去掉的类型写法，并实际试一次 DSH 能否加载 `.ts` 的插件入口。这一步由一个人先做完，后面并行的人都照它写。
4. 并行改写源码，测试保持 JS 不动。用 Sonnet 5.5（high）的子 agent，每个只拥有下面一组文件，互不交叉：

   | 组 | 文件 | 约行数 |
   |---|---|---|
   | A | `src/task/` | 1,760 |
   | B | `src/tools/`、`src/adapters/` | 1,520 |
   | C | `src/engine/`、`flow/`、`registry/`、`prompts/`、`bot/`、`config.js`、`app.js`、`plugin.js`，以及 `scripts/` | 1,900 |
   | D | `host/parts.js`、`btw.js`、`steward.js`、`shared/group-replies.js` | 2,240 |
   | E | `host/groups.js`、`roster.js`、`shared/mentions.js`、`shared/im-platforms.js` | 2,460 |
   | F | `host/turns.js`、`resume.js`、`schedules.js`、`diagnostics.js`、`links.js` | 2,150 |
   | G | `host/` 其余 16 个文件（`tools`、`store`、`home-lock`、`files`、`folders`、`models`、`permissions`、`approvals`、`requests`、`delivery`、`handoffs`、`chat-index`、`prompt`、`time-context`、`text`、`constants`） | 3,440 |
   | H | `host/local-agents/` | 1,130 |

5. 合并后由主会话统一跑类型检查，修跨组的类型不一致，再用第 2 步的同一批测试和冒烟验收，结果要和基线一致。验证和查问题用 Opus 的子 agent。
6. 最后把测试本身改成 TS，同样按目录分组并行。

## 8. 还要注意的

- `src/bot/index.js` 里写着：只有 `bot/` 下的文件才能解析到 `@deepseek-ai/dsh-tools`，所以 `defineTool` 从 `bot/src/host/tools.js` 转出。测试靠 `bot/test/harness-resolve.mjs` 把 `@deepseek-ai/*` 指到 `runtime/`。改写后如果调整目录结构，这两处的模块解析要一起处理。
- DSH 能不能直接加载 `.ts` 的插件入口（`src/plugin.js`），还没试过。
- 静态分析只能说明"不会被加载"，不能说明"被加载的代码都会被执行"。保留的 36 个文件里，仍然有我们不用的功能分支（交接文档 5.3 节提到 `parts.js` 没裁）。
- 第 6 节"只测用到的模块"的分类，以文件实际加载的模块为准；一个测试文件可能只测某个模块里我们不用的那部分功能。
