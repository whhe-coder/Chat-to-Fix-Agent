# 用例 2：Creator Campaign 封面图上限改成 10 MB

## 贴到频道的文本

```
/fix Get Started → Creator Campaign 第 1 步「Game details」上传游戏封面图时，超过 5 MB 就报「Image must be under 5 MB」，可很多商户的 Steam 封面原图有 6–8 MB。请把上限改成 10 MB，各语言的提示文案也一起改成 10 MB。
```

## 依赖的代码（2026-11-04 的 master）

- `src/pages/GetStarted/setups/creator-campaign/GameDetailsFields.tsx`：`MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024`。`GameDetailsStep.tsx` 用它判断文件是否过大（`file.file.size > MAX_IMAGE_SIZE_BYTES`）。
- 文案 `host.pages.getStarted.creatorCampaign.gameDetails.validation.imageTooLarge` 在 9 个语言文件里（`src/locales/{en,zh,ja,ko,de,fr,es,pt,ru}.json`），都写着 5 MB。
- 会失败的测试：
  - `src/pages/GetStarted/setups/creator-campaign/GameDetailsFields.test.ts` › `caps an uploaded image at five mebibytes`（`expect(MAX_IMAGE_SIZE_BYTES).toBe(5 * 1024 * 1024)`）
  - `src/pages/GetStarted/setups/creator-campaign/GameDetailsStep.test.tsx` › `rejects an image over the size limit without calling the gateway`（用一个 5 MB + 1 字节的文件，期望它被拒绝）
- `src/components/ProjectForm/constants.ts` 里也有一个 `MAX_IMAGE_SIZE`（5 MB），生产代码没用它，只有它自己的测试用。bot 如果也改了它，`ProjectForm/constants.test.ts` › `caps image uploads at 5MB` 也会失败。

在 main 上核对：`git grep -n -e "MAX_IMAGE_SIZE" -e "imageTooLarge" -e "5 \* 1024 \* 1024" -- src`

## bot 大概会怎么改

把常量改成 `10 * 1024 * 1024`，再改 9 个语言文件里的文案，一共约 10 个文件。

## 预计哪个 job 失败

unit-test 失败，两个测试都会挂：一个是常量断言；另一个里，5 MB + 1 字节的文件现在不会被拒绝了，等不到错误文案，还会去调上传接口。

把握：高。

## 正确的修复轮

- 两个测试一起改：常量断言改成 10 MB；超限测试的文件改成 10 MB + 1 字节。最好再加一个 6 MB 能通过的测试。
- 一轮里只修好一个也是可能的，那就要第 2 轮。这正好演示多轮修复。
- 错误的修法：把常量改回 5 MB，或者删掉超限测试。
- 产品上的风险 CI 看不到：上传接口（`uploadMerchantFile`）在服务端可能也限制了大小。MR 只用来演示，不合并。

## 在 GitLab 上怎么看

- 第一条流水线的 unit-test 失败，日志里有上面两个测试名中的至少一个。
- 修复提交只改了 `GameDetailsFields.test.ts` 和 `GameDetailsStep.test.tsx`，没碰常量和文案。
- 最后一条流水线的必需 job 全绿。

## 结果

- 状态：
- Jira：
- MR：
- pipeline：
- 轮数：
- 结论：
