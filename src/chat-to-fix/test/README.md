# test/

系统层和 bot 层的测试（Node 内置 test runner）。运行：`npm test`（全部），或 `npm run test:agent`（本目录）、`test:agent-layer`（`bot/`）、`test:agent-bot`（根目录 `bot/test/`）。

| 文件 | 测什么 |
|---|---|
| `store` / `queue` / `gate` / `recorder` / `runner` / `monitor` / `monitor-ci` / `outbox` / `pricing` / `http` `.test.ts` | `core/task/` 里同名的部分 |
| `registry` / `prompts` / `config` `.test.ts` | 注册表、提示词读取、配置 |
| `tools` / `tools-ci` / `tools-notices` / `service-tools` / `coding-tools` `.test.ts` | `core/tools/` 的各类工具 |
| `adapters` / `adapters-slack` / `adapters-jira` / `adapters-gitlab` / `adapters-ci` `.test.ts` | `core/adapters/`（真实适配器对本机桩服务） |
| `app` / `integration` / `e2e` `.test.ts` | 整个系统层（假 bot 层、模拟适配器）连起来 |
| `e2e-real.test.ts` | `scripts/e2e/` 的用例可解、检查判对（不调模型） |
| `connected` / `first-run` / `watch` / `flow-page` / `debug-ui-chat` / `slack-forwarder` `.test.ts` | `scripts/` 里同名的脚本 |
| `bot/` | 真实 bot 层上的测试，见 `bot/README.md` |
| `helpers/` | 测试共用的替身，见 `helpers/README.md` |
| `fixtures/` | 测试用的数据，见 `fixtures/README.md` |

什么时候来改：改了对应代码就跑、就补。不要在测试里调真实模型或真实服务；`npm test` 必须保持全绿。
