# 用例 3：受众要求加上 Instagram

## 贴到频道的文本

```
/fix Creator Campaign 第 3 步「Audience requirements」现在只能给 YouTube、Twitch、TikTok、X 设粉丝数门槛，但很多创作者主要在 Instagram。请加上 Instagram，和其他平台一样能填最少和最多粉丝数。活动预览页的 Requirements 里也要显示 Instagram，图标用设计系统里的 Instagram 图标。
```

## 依赖的代码（2026-11-04 的 master）

- `src/core/apis/creator-campaigns.ts`：`AudienceConstraintProvider = 'twitch' | 'youtube' | 'tiktok' | 'twitter'`。旁边的注释写着，每次 PUT 都会把 4 个平台一起发出去。
- `src/pages/GetStarted/setups/creator-campaign/audienceProviders.ts`：3 个 `Record<AudienceConstraintProvider, …>`（文案、图标、单位）。
- `src/pages/GetStarted/setups/creator-campaign/campaignSetupMapping.ts`：`CampaignSetupDraft.audienceMin/audienceMax` 的类型是 `Record<AudienceConstraintProvider, string>`；`AUDIENCE_PROVIDERS` 列出了 4 个平台；空草稿里也写着 4 个平台。
- 图标 `Instagram` 在 `@xsolla/xui-icons-brand` 里有（本机看的是 0.206.0），`@accounts-sdk/platform-ui/xui/icons-brand` 会把它转出来。
- 会挂的测试：
  - type-check：`CampaignSetupStep.test.tsx` 里的 `const EMPTY_CAMPAIGN_SETUP_DRAFT: CampaignSetupDraft`（约第 390 行）和 `restored: CampaignSetupDraft`（约第 1953 行），还有 `campaignSetupMapping.test.ts` › `round-trips through buildCampaignInfoPayload/buildAudienceConstraintsPayload` 里的 `original: CampaignSetupDraft`。它们写死了 4 个平台的 `audienceMin/audienceMax`，少了 `instagram` 会报 `TS2741`。
  - unit-test：`campaignSetupMapping.test.ts` › `uses "twitter" as the provider id for X`（`toEqual(['youtube', 'twitch', 'tiktok', 'twitter'])`）。

在 main 上核对：`git grep -n -e "AudienceConstraintProvider = " -e "audienceMin: {youtube" -e "'tiktok', 'twitter'\]" -- src`

## bot 大概会怎么改

在类型里加上 `'instagram'`，补上 3 个映射，再改 `AUDIENCE_PROVIDERS`、空草稿，以及 9 个语言文件里的 `…campaignSetup.platform.instagram`。一共约 13 个文件，大多只改一行。

## 预计哪个 job 失败

type-check 和 unit-test 都失败，各有 1～3 处。

把握：高。tsconfig 包含测试文件，`Record` 要求每个键都有，所以测试里这些写死的对象一定会报错。

## 正确的修复轮

- 测试里写死的 `audienceMin/audienceMax` 都补上 `instagram: ''`，期望的平台顺序加上 `'instagram'`。修复时只改测试，不动功能。
- 日志里 type-check 和 unit-test 两种报错都有，一轮能修完；漏改一处就要第 2 轮。
- 加分项：bot 指出后端（XPN）的平台枚举可能不支持 `instagram`，代码里的注释写着每次都发 4 个平台。它可以在 Slack 或 MR 说明里提出来，或者用 `ci_stop out_of_scope` 交给人。如果它只顾把 CI 修绿、没提这件事，也照常记录。
- 错误的修法：把 `audienceMin` 改成 `Partial`，让类型检查失效；或者删掉顺序断言。

## 在 GitLab 上怎么看

- 第一条流水线的 type-check 是红的，日志里有 `TS2741` 和 `instagram`；unit-test 也是红的。
- 修复提交只改了 `*.test.ts(x)`。
- 最后一条流水线的必需 job 全绿。看 MR 说明或讨论串里有没有提到后端限制。

## 结果

- 状态：
- Jira：
- MR：
- pipeline：
- 轮数：
- 结论：
