# Jira 报告人是 token 所有者，发起人没有映射过去

- 状态：已确认，往后放、另开票（Zihui 2026-11-14）；需要 Bot 传邮箱 + Agent 指派
- 发现日期：2026-11-14
- 关联任务：真实 Slack `T-5` / [F2PGBA-411](https://xsolla.atlassian.net/browse/F2PGBA-411)、`T-8` / [F2PGBA-412](https://xsolla.atlassian.net/browse/F2PGBA-412)

## 复现

1. 起 Agent 和 Bot，在指定频道发一条能建单的 `/fix`。
2. 打开建出的 Jira 单，看报告人和经办人。

## 现象与证据

- 2026-11-14 用 Jira 接口核对：两张单的报告人都是 Agent 所用 Jira token 的所有者（个人账号），经办人为空。这两次发起人碰巧就是这位所有者，所以看不出错；换别人发起就会对不上。Jira 描述里模型写了发起人的 Slack 名，但没有设报告人或经办人字段。
- 任务的 `origin.user` 只有 Slack 的 `{id, name}`，没有邮箱；Bot 没有调 `users.info`。
- MR 描述里也没写发起人。

[Slack 接入架构](../chat-to-fix/slack/architecture.md) 4.8 拟按发起人邮箱设报告人/经办人。Zihui 2026-11-14 在频道说：CI 三次失败后“需要人看”只写在 Jira 评论里，不会通知到人；要等 Bot 传来发起人邮箱才能把单子指派给发起人，这项往后放、另开票。Slack App 已有 `users:read`、`users:read.email`；Agent 适配器已接受 `user.email`（`7521aa2`），但还不设报告人/经办人。

## 验收

- [ ] Bot：`users.info` 取邮箱（校验公司域名、不是机器人或访客），随 `user` 传给 Agent；拿不到时给发起人临时消息。
- [ ] Agent：按邮箱找 Jira 账号，设报告人或经办人；找不到时写明原因。
- [ ] 由 token 所有者以外的人发起一次，核对 Jira 上的人。
