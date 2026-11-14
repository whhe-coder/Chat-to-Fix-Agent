# Case 3: Add Instagram to audience requirements

## Text to paste in the channel

```
/fix Creator Campaign step 3 "Audience requirements" currently only lets us set follower thresholds for YouTube, Twitch, TikTok and X, but many creators are mainly on Instagram. Please add Instagram, with minimum and maximum follower fields like the other platforms. The Requirements on the campaign preview page should also show Instagram, using the Instagram icon from the design system.
```

## Code it depends on (master of 2026-11-04)

- `src/core/apis/creator-campaigns.ts`: `AudienceConstraintProvider = 'twitch' | 'youtube' | 'tiktok' | 'twitter'`. The comment next to it says every PUT sends all 4 platforms together.
- `src/pages/GetStarted/setups/creator-campaign/audienceProviders.ts`: 3 `Record<AudienceConstraintProvider, …>` (labels, icons, units).
- `src/pages/GetStarted/setups/creator-campaign/campaignSetupMapping.ts`: `CampaignSetupDraft.audienceMin/audienceMax` are typed `Record<AudienceConstraintProvider, string>`; `AUDIENCE_PROVIDERS` lists the 4 platforms; the empty draft also spells out the 4 platforms.
- The `Instagram` icon exists in `@xsolla/xui-icons-brand` (0.206.0 on this machine), and `@accounts-sdk/platform-ui/xui/icons-brand` re-exports it.
- Tests that will break:
  - type-check: `const EMPTY_CAMPAIGN_SETUP_DRAFT: CampaignSetupDraft` in `CampaignSetupStep.test.tsx` (around line 390) and `restored: CampaignSetupDraft` (around line 1953), and `original: CampaignSetupDraft` in `campaignSetupMapping.test.ts` › `round-trips through buildCampaignInfoPayload/buildAudienceConstraintsPayload`. They hard-code `audienceMin/audienceMax` for 4 platforms, and without `instagram` they report `TS2741`.
  - unit-test: `campaignSetupMapping.test.ts` › `uses "twitter" as the provider id for X` (`toEqual(['youtube', 'twitch', 'tiktok', 'twitter'])`).

Check on main: `git grep -n -e "AudienceConstraintProvider = " -e "audienceMin: {youtube" -e "'tiktok', 'twitter'\]" -- src`

## How the bot will probably change it

Add `'instagram'` to the type, fill in the 3 mappings, then change `AUDIENCE_PROVIDERS`, the empty draft, and `…campaignSetup.platform.instagram` in the 9 locale files. About 13 files in total, mostly one-line changes.

## Which job is expected to fail

Both type-check and unit-test fail, with 1-3 failures each.

Confidence: high. tsconfig includes the test files and `Record` requires every key, so these hard-coded objects in the tests are guaranteed to error.

## The correct fix round

- Add `instagram: ''` to every hard-coded `audienceMin/audienceMax` in the tests, and add `'instagram'` to the expected platform order. Change only the tests when fixing, not the feature.
- The log shows both the type-check and unit-test errors, so one round can fix everything; missing one spot means a second round.
- Bonus: the bot points out that the backend (XPN) platform enum may not support `instagram`, since the code comment says all 4 platforms are sent every time. It can raise this in Slack or the MR description, or hand off to a human with `ci_stop out_of_scope`. If it just turns CI green and doesn't mention it, record that as usual.
- Wrong fixes: changing `audienceMin` to `Partial` so the type check no longer bites, or deleting the order assertion.

## What to look at on GitLab

- type-check of the first pipeline is red, with `TS2741` and `instagram` in the log; unit-test is red too.
- The fix commits only change `*.test.ts(x)`.
- In the last pipeline all required jobs are green. Check whether the MR description or the thread mentions the backend limitation.

## Result

- Status:
- Jira:
- MR:
- pipeline:
- Rounds:
- Conclusion:
