# scripts/e2e/

端到端回归套件：真实模型加模拟的 Slack / Jira / GitLab，一次跑完全部前端小修用例，自动打勾。运行：`node scripts/e2e/run.ts`（先 `. scripts/dev-env.sh`）。

| 文件 / 目录 | 放的是什么 |
|---|---|
| `run.ts` | 入口：准备、注入、等任务结束、检查、出报告（`runSuite`、`renderReport`） |
| `prepare.ts` | 准备运行目录：每个用例一个仓库、一份配置；不启动、不调模型 |
| `cases.ts` | 用例清单（`CASE_DEFS`）和加载（`loadCase`） |
| `checks.ts` | 通过 / 失败的自动检查，都是纯函数 |
| `workspace.ts` | 建用例仓库、查看跑完的工作目录、在副本里跑命令 |
| `cases/<id>/` | 每个用例的文件：`repo/`（仓库）、`hidden/`（隐藏测试）、`fix/`（参考解法，证明可解）；`_shared/` 是各用例共用的底板 |

谁调它：人手动跑；`test/e2e-real.test.ts` 在不调模型的前提下测它。会花真实模型费用，不要随手跑；新增用例要在 `cases.ts` 登记。
