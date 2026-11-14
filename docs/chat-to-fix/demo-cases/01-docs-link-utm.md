# Case 1: Documentation links get a source parameter per entry point

## Text to paste in the channel

```
/fix The "Documentation" shortcut card on the Dashboard, and the documentation link under Get Started → Creator Campaign step 3 "Give game keys", both open https://developers.xsolla.com/?audience=pc-f2p right now, so the docs site can't tell which entry point a visit came from. Please add a source parameter for each entry point: Dashboard uses utm_source=publisher_account&utm_medium=dashboard_shortcut, Creator Campaign uses utm_source=publisher_account&utm_medium=creator_campaign. Keep audience=pc-f2p. The target_url reported in the tracking event should also be the full link with the parameters.
```

## Code it depends on (master of 2026-11-04)

- `src/pages/Dashboard/constants.ts`: `DOCUMENTATION_URL = 'https://developers.xsolla.com/?audience=pc-f2p'`. Both entry points share this constant: `src/pages/Dashboard/components/Shortcuts.tsx` (`openDocs`) and `src/pages/GetStarted/setups/creator-campaign/CampaignDetailsSection.tsx` (`trackDocumentationClick` and `href`).
- Tests that assert this value, or assert that this constant is used:
  - `src/pages/Dashboard/constants.test.ts` › `points documentation at the PC F2P audience-scoped docs` (`toBe`, exact comparison with the original link)
  - `src/pages/Dashboard/components/Shortcuts.test.tsx` › `tracks the outbound link and opens it in a new tab`
  - `src/pages/GetStarted/setups/creator-campaign/CampaignDetailsSection.test.tsx` › `reports the documentation click with the target url`
  - `src/pages/GetStarted/setups/creator-campaign/CampaignSetupStep.test.tsx` › `tracks the game keys documentation link as a creator-campaign external guide click`

Check on main: `git grep -n "DOCUMENTATION_URL" -- src`

## How the bot will probably change it

The two entry points need different links, so one constant is no longer enough. Two common approaches:

- **A**: Keep `DOCUMENTATION_URL`, add the Dashboard parameters to it, create a new constant for Creator Campaign, and change `CampaignDetailsSection.tsx`.
- **B**: Delete or rename `DOCUMENTATION_URL`, replace it with two new constants or a `buildDocumentationUrl(medium)`, and change both components.

## Which job is expected to fail

- Approach A: unit-test fails. The exact comparison in `constants.test.ts` no longer matches. The two Creator Campaign tests still expect `DOCUMENTATION_URL` to be reported, but the component now uses the new constant.
- Approach B: type-check fails too. The 4 test files above still `import {DOCUMENTATION_URL}` and will report `has no exported member`.

Confidence: high. As long as the bot doesn't happen to fix the tests on the first pass, it will fail.

## The correct fix round

- Change only the tests, not the feature: update the expected values to the new link or constant, assert each entry point's own link, and keep the "must be https" assertion.
- With approach B, the imports in all 4 test files need changing. If the first round only fixes the files type-check reports, the second round may still hit assertion failures, so it may take 2 rounds.
- Wrong fixes: changing the link back to the original, or deleting the assertions.

## What to look at on GitLab

- The MR's Commits has two or more commits: the first is the feature change, the rest are fixes.
- In Pipelines, unit-test (or type-check) of the first pipeline is red, and the log shows the test names listed above or `TS2305`. In the last pipeline all required jobs are green.
- The fix commits only change `*.test.ts(x)`, or make only very small adjustments outside the tests.

## Result

- Status:
- Jira:
- MR:
- pipeline:
- Rounds:
- Conclusion:
