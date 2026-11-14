# CI Fix Loop Demo Cases

## Why these cases exist

On 2026-11-14 Logan asked for a few more complex examples: the unit tests on the MR pipeline fail first, then the agent fixes them in a second round. If the fix works, the MR is left unmerged for demos; if it doesn't, we log it as an issue. All the cases live in this one folder.

The real channel binding has no `testCommands` configured, so the Coding bot can't run tests locally and the MR pipeline is the first time the tests run. None of the requests below mention tests, so CI is what finds the problems. For how the fix loop works, see [spec-7](../design/spec-7-ci-loop.md): after a job fails, the system automatically reruns it once; only if the rerun also fails does it count as a round. The Git Pipeline bot reads the log, the Coding bot fixes it and adds a commit; at most 3 rounds, then it is handed to a human.

The target repo is GitLab `account-platform/free-to-play-pc`. The required jobs in the MR pipeline are commitlint, eslint, stylelint, type-check, complexity and unit-test (`pnpm run test:coverage`, with a coverage threshold). sonar and the two downstream e2e pipelines are `allow_failure` and don't affect the result.

## Cases

| # | Case | Job expected to fail | Expected | Status |
| --- | --- | --- | --- | --- |
| 1 | [Documentation links get a source parameter per entry point](01-docs-link-utm.md) | unit-test (maybe type-check too) | Passes after 1 fix round | Not run |
| 2 | [Raise the Creator Campaign cover image limit to 10 MB](02-cover-image-10mb.md) | unit-test (one test in each of two files) | Passes after 1-2 fix rounds | Not run |
| 3 | [Add Instagram to audience requirements](03-audience-instagram.md) | type-check and unit-test | Passes after 1-2 fix rounds; also see whether the bot points out the backend limitation | Not run |
| 4 | [Add a "Download CSV template" link to Give game keys](04-keys-csv-template.md) | complexity | Hard to fix, most likely handed to a human | Not run |

Status values: Not run / Passed (N fix rounds) / Handed to a human / Fix not triggered (first pipeline passed) / Failed (issue logged).

## Check before running

The cases were checked on 2026-11-14 against `free-to-play-pc` master `c4704ca` (2026-11-13), the commit T-4 ran on: the files, test names and assertions the 4 cases depend on are all there, the `CampaignDetailsSection` baseline is 175, and `unit-test` and `complexity` are not `allow_failure`. If master has moved on, check again before running:

1. The files and test names listed in each case's "Code it depends on" section still exist, and the assertions haven't changed. Each case includes a `git grep` command.
2. In `.gitlab-ci.yml`, `unit-test` still runs `pnpm run test:coverage` and `complexity` still runs `pnpm run lint:complexity`; neither is `allow_failure`.
3. The channel binding still has no `testCommands`, and `ciMaxRounds` is still 3.

## How to run

- In the Slack channel bound to `free-to-play-pc`, paste the case's `/fix` text as is.
- While a non-blocking job (sonar) is still running after the required jobs passed, the "CI passed" notice can come up to 10 minutes later (see spec-7).
- Run one at a time. Wait until the thread posts its result summary and the task ends, then run the next.
- Always keep the MR as Draft; don't merge or close it. Leave the Jira ticket open too, and close it after the demo.
- Each failed round waits for two pipelines (the system reruns once automatically), and a round takes about 12 minutes, so one case takes 15-45 minutes.
- When a run finishes, fill the result into the "Result" section at the end of the case file and update the "Status" in the table above. The full run record is written to [`../runs/`](../runs/) as usual.

## What to do when a run fails

Per Logan's rule, a failed run is logged as an issue: create a new file in [`docs/issues/`](../../issues/README.md) with the evidence, impact and acceptance criteria, add it to the table in that README, then link to it from this case's "Conclusion". All of the following count as failures:

- The agent itself errors, for example it stops without reading the log, a push fails, or the Slack or Jira write-back is wrong.
- The fix is wrong: CI turns green, but by deleting tests, weakening assertions, raising the complexity baseline, or watering down the requirement.
- It should have handed off to a human and didn't.

If it still fails after 3 rounds and is handed to a human as expected (`completed_ci_failed`), or the bot explains the reason clearly with `ci_stop`, that is the outcome case 4 is meant to demonstrate and does not count as a failure.

If the Coding bot changes the tests along with the code on the first try and the first pipeline passes, that is not an agent problem; write "Fix not triggered" as the status. You can move on to the next case.
