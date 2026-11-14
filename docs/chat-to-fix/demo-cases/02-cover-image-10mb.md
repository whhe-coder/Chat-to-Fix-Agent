# Case 2: Raise the Creator Campaign cover image limit to 10 MB

## Text to paste in the channel

```
/fix When uploading a game cover image in Get Started → Creator Campaign step 1 "Game details", anything over 5 MB gets "Image must be under 5 MB", but many merchants' original Steam cover images are 6–8 MB. Please raise the limit to 10 MB, and update the message text in every language to say 10 MB too.
```

## Code it depends on (master of 2026-11-04)

- `src/pages/GetStarted/setups/creator-campaign/GameDetailsFields.tsx`: `MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024`. `GameDetailsStep.tsx` uses it to decide whether a file is too large (`file.file.size > MAX_IMAGE_SIZE_BYTES`).
- The message `host.pages.getStarted.creatorCampaign.gameDetails.validation.imageTooLarge` is in 9 locale files (`src/locales/{en,zh,ja,ko,de,fr,es,pt,ru}.json`), all saying 5 MB.
- Tests that will fail:
  - `src/pages/GetStarted/setups/creator-campaign/GameDetailsFields.test.ts` › `caps an uploaded image at five mebibytes` (`expect(MAX_IMAGE_SIZE_BYTES).toBe(5 * 1024 * 1024)`)
  - `src/pages/GetStarted/setups/creator-campaign/GameDetailsStep.test.tsx` › `rejects an image over the size limit without calling the gateway` (uses a file of 5 MB + 1 byte and expects it to be rejected)
- `src/components/ProjectForm/constants.ts` also has a `MAX_IMAGE_SIZE` (5 MB). Production code doesn't use it; only its own test does. If the bot changes it too, `ProjectForm/constants.test.ts` › `caps image uploads at 5MB` will fail as well.

Check on main: `git grep -n -e "MAX_IMAGE_SIZE" -e "imageTooLarge" -e "5 \* 1024 \* 1024" -- src`

## How the bot will probably change it

Change the constant to `10 * 1024 * 1024` and update the message in the 9 locale files, about 10 files in total.

## Which job is expected to fail

unit-test fails, and both tests break: one is the constant assertion; in the other, a 5 MB + 1 byte file is no longer rejected, so the error message never shows up and the upload API gets called.

Confidence: high.

## The correct fix round

- Fix both tests together: change the constant assertion to 10 MB, and change the over-limit test's file to 10 MB + 1 byte. Ideally also add a test that a 6 MB file passes.
- It's possible that only one test gets fixed in a round, which means a second round. That happens to demonstrate multi-round fixing.
- Wrong fixes: changing the constant back to 5 MB, or deleting the over-limit test.
- A product risk CI can't see: the upload API (`uploadMerchantFile`) may also limit the size on the server. The MR is for demo only and won't be merged.

## What to look at on GitLab

- unit-test of the first pipeline fails, and the log has at least one of the two test names above.
- The fix commits only change `GameDetailsFields.test.ts` and `GameDetailsStep.test.tsx`, not the constant or the messages.
- In the last pipeline all required jobs are green.

## Result

- Status:
- Jira:
- MR:
- pipeline:
- Rounds:
- Conclusion:
