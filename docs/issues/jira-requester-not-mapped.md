# Jira 报告人是 token 所有者，发起人没有映射过去

- 状态：已确认，待实现（Bot 取邮箱 + Agent 设报告人/经办人）
- 发现日期：2026-11-14
- 关联任务：真实 Slack `T-5` / [F2PGBA-411](https://xsolla.atlassian.net/browse/F2PGBA-411)、`T-8` / [F2PGBA-412](https://xsolla.atlassian.net/browse/F2PGBA-412)

## 现象与证据

- 两张单的报告人都是 Jira token 的所有者，经办人为空。这两次发起人碰巧也是 token 所有者，所以看不出错；换别人发起就会对不上。
- 任务的 `origin.user` 只有 Slack 的 `{id, name}`，没有邮箱；Bot 没有调 `users.info`。
- MR 描述里也没写发起人。

2026-11-13 已定：发起人映射到 Jira 报告人/经办人。Slack App 已有 `users:read`、`users:read.email`；Agent 适配器已接受 `user.email`（`7521aa2`），但还不设报告人/经办人。设计见 [Slack 接入架构](../chat-to-fix/slack/architecture.md) 4.8。

## 验收

- [ ] Bot：`users.info` 取邮箱（校验公司域名、不是机器人或访客），随 `user` 传给 Agent；拿不到时给发起人临时消息。
- [ ] Agent：按邮箱找 Jira 账号，设报告人或经办人；找不到时写明原因。
- [ ] 由 token 所有者以外的人发起一次，核对 Jira 上的人。
