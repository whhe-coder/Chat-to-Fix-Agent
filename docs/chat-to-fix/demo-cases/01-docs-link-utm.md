# 用例 1：文档链接按入口带来源参数

## 贴到频道的文本

```
/fix Dashboard 的「Documentation」快捷卡片，和 Get Started → Creator Campaign 第 3 步「Give game keys」下面的文档链接，现在打开的都是 https://developers.xsolla.com/?audience=pc-f2p，文档站分不出访问是从哪个入口来的。请给两个入口加上各自的来源参数：Dashboard 用 utm_source=publisher_account&utm_medium=dashboard_shortcut，Creator Campaign 用 utm_source=publisher_account&utm_medium=creator_campaign。audience=pc-f2p 保留。埋点里上报的 target_url 也用带参数的完整链接。
```

## 依赖的代码（2026-11-04 的 master）

- `src/pages/Dashboard/constants.ts`：`DOCUMENTATION_URL = 'https://developers.xsolla.com/?audience=pc-f2p'`。两个入口共用这个常量：`src/pages/Dashboard/components/Shortcuts.tsx`（`openDocs`）和 `src/pages/GetStarted/setups/creator-campaign/CampaignDetailsSection.tsx`（`trackDocumentationClick` 和 `href`）。
- 断言这个值、或断言用的是这个常量的测试：
  - `src/pages/Dashboard/constants.test.ts` › `points documentation at the PC F2P audience-scoped docs`（`toBe` 精确比较原链接）
  - `src/pages/Dashboard/components/Shortcuts.test.tsx` › `tracks the outbound link and opens it in a new tab`
  - `src/pages/GetStarted/setups/creator-campaign/CampaignDetailsSection.test.tsx` › `reports the documentation click with the target url`
  - `src/pages/GetStarted/setups/creator-campaign/CampaignSetupStep.test.tsx` › `tracks the game keys documentation link as a creator-campaign external guide click`

在 main 上核对：`git grep -n "DOCUMENTATION_URL" -- src`

## bot 大概会怎么改

两个入口要不同的链接，一个常量不够用了。常见的改法有两种：

- **A**：保留 `DOCUMENTATION_URL`，给它加上 Dashboard 的参数，再新建一个 Creator Campaign 用的常量，改 `CampaignDetailsSection.tsx`。
- **B**：删掉 `DOCUMENTATION_URL` 或给它改名，换成两个新常量或一个 `buildDocumentationUrl(medium)`，改两个组件。

## 预计哪个 job 失败

- 走 A：unit-test 失败。`constants.test.ts` 的精确比较不再相等。两个 Creator Campaign 测试还期望上报 `DOCUMENTATION_URL`，但组件已经换成了新常量。
- 走 B：type-check 也会失败。上面 4 个测试文件都还在 `import {DOCUMENTATION_URL}`，会报 `has no exported member`。

把握：高。只要 bot 第一次没顺手改测试，就一定失败。

## 正确的修复轮

- 只改测试，不动功能：期望值改成新链接或新常量，每个入口各断言自己的链接，保留“必须是 https”的断言。
- 走 B 时，4 个测试文件的 import 都要改。如果第一次只修了 type-check 报出来的文件，第二轮可能还有断言失败，所以可能要修 2 轮。
- 错误的修法：把链接改回原样，或者删掉断言。

## 在 GitLab 上怎么看

- MR 的 Commits 里有两个或更多提交：第一个是功能改动，后面的是修复。
- Pipelines 里第一条流水线的 unit-test（或 type-check）是红的，日志里能看到上面列出的测试名或 `TS2305`。最后一条流水线的必需 job 全绿。
- 修复提交只改了 `*.test.ts(x)`，或者在测试之外只做了很小的调整。

## 结果

- 状态：
- Jira：
- MR：
- pipeline：
- 轮数：
- 结论：
