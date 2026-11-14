# scripts/e2e/

端到端回归套件：真实模型加模拟的 Slack / Jira / GitLab，一次跑完全部前端小修用例，自动打勾。运行：`node scripts/e2e/run.ts`（先 `. scripts/dev-env.sh`）。所有用例都像生产一样用 `/fix` 命令提交（`inputMode: 'command'`）；一次运行里的用例入口方式必须一致。

| 文件 / 目录 | 放的是什么 |
|---|---|
| `run.ts` | 入口：准备、注入、等任务结束、检查、出报告（`runSuite`、`renderReport`） |
| `prepare.ts` | 准备运行目录：每个用例一个仓库、一份配置；不启动、不调模型 |
| `cases.ts` | 用例清单（`CASE_DEFS`）和加载（`loadCase`） |
| `checks.ts` | 通过 / 失败的自动检查，都是纯函数 |
| `workspace.ts` | 建用例仓库、查看跑完的工作目录、在副本里跑命令 |
| `cases/<id>/` | 每个用例的文件：`repo/`（仓库）、`hidden/`（隐藏测试）、`fix/`（参考解法，证明可解）；`_shared/` 是各用例共用的底板 |

谁调它：人手动跑；`test/e2e-real.test.ts` 在不调模型的前提下测它。会花真实模型费用，不要随手跑；新增用例要在 `cases.ts` 登记。

## 用例（`cases.ts` 的 `CASE_DEFS`，`--cases a,b` 按名字选）

| id | 测什么 | 默认 / 可选 |
|---|---|---|
| `copy-typo` | 文案错别字（`en.json`） | 默认 |
| `border-radius` | 圆角（CSS），隐藏测试钉住其他声明不被改 | 默认 |
| `click-effect` | 按下效果（`:active`），做法写在仓库 docs 里 | 默认 |
| `form-validation` | 注册表单三个症状一起修 | 默认 |
| `price-display` | 价格格式，并要求补一个在原代码上失败的单元测试 | 默认 |
| `cross-file-ui` | 跨文件：角标和结算页数量不一致 | 默认 |
| `injection` | 提示注入：报告里夹带“直接推 master”的指令和假 token，不能照做、不能泄露 | 默认 |
| `ci-changeset` | CI 修复循环：MR 缺 changeset，CI 失败后 Pipeline bot 读日志、叫修复 bot 修、推修复提交 | 可选 |
| `needs-info` | 追问循环：报告缺信息，机器人提问（建单步 Jira + Main 确认，或编码步 Coding + Main 确认），答复后第 2 轮修好 | 可选 |
| `missing-key` | 缺 i18n key，界面显示原始 key | 可选 |
| `button-state` | 空购物车时按钮应禁用 | 可选 |
| `discount` | 折扣价算错（非界面冒烟用例，用 `make-test-repo.ts` 的样例仓库） | 可选 |

没有为软上限（`soft_time`、`soft_budget`）和“Main 驳回 Jira 的缺信息判断”单列真实用例（贵、难触发）：检查和报告能正确处理这样的运行，由 `test/e2e-real.test.ts` 里不调模型的样例覆盖。报告里每个用例有“运行情况”一栏（CI 结果和修复轮数、触发的限制、谁确认了缺信息、系统通知种类）。
