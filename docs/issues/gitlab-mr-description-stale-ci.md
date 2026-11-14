# MR 描述停在“CI has not run yet”，CI 通过后不更新

- 状态：已确认，待修复
- 发现日期：2026-11-14
- 关联任务：真实 Slack `T-5` / MR [!380](https://gitlab.loc/account-platform/free-to-play-pc/-/merge_requests/380)

## 复现

1. 起 Agent 和 Bot，在指定频道发一条能建单的 `/fix`。
2. CI 通过、任务结束后，打开 Draft MR 看描述。

## 现象与证据

!380 的描述最后一句是 `CI has not run yet.`，写于开 MR 时（11:36:44）。CI 在 11:39:35 判定通过，Slack 和 Jira 都收到了“CI 通过”，MR 描述没有改（GitLab 接口的描述内容与开 MR 时的 `mr_open_draft` 记录一致）。

T-8 的 !381 描述没写 CI 状态，没有这个问题。

## 影响

只看 MR 的评审人会以为 CI 还没跑，得自己去看流水线。

## 验收

- [ ] 开 MR 时不写会过时的 CI 状态；或者 CI 有结论后更新描述（或在 MR 下加一条评论）。
