# 抽取四处重复逻辑，并补齐材料块边界测试

- 状态：待处理
- 类型：重构建议；含一处已确认的单元测试缺口
- 记录日期：2026-11-13
- 核对基线：`main`，提交 `f9529f0`

## 背景

静态复核发现四处重复逻辑。当前没有证据表明它们已造成运行故障。抽取时需要保留各调用方的输入校验、输出格式和错误语义。四项可以分别实施和验收。

| 优先级 | 事项 | 重复位置 | 最小修改范围 |
| --- | --- | --- | --- |
| 高 | 材料块封装 | [`material.ts:5-26`](../../src/chat-to-fix/core/tools/material.ts#L5-L26)、[`runner.ts:9-32`](../../src/chat-to-fix/core/task/runner.ts#L9-L32)、[`http.ts:343-349`](../../src/chat-to-fix/core/task/http.ts#L343-L349) | 共用 `BEGIN/END MATERIAL` 标记、正文中的结束标记转义和块边界；三处保留各自的导语及任务信息，`runner` 保留尾句。 |
| 高 | 并发事件去重 | [`http.ts:85-92`](../../src/chat-to-fix/core/task/http.ts#L85-L92)、[`http.ts:145-153`](../../src/chat-to-fix/core/task/http.ts#L145-L153)、已有的 [`once():298-306`](../../src/chat-to-fix/core/task/http.ts#L298-L306) | 两个入口复用 `once(eventId, work)`；保留 `/fix` 的前置校验，以及缺少有效 `eventId` 时直接进入 `threadEvent` 的路径。 |
| 中 | Jira 文本转 ADF | [`connection.js:28-37`](../../src/jira/connection.js#L28-L37)、[`jira.ts:97-99`](../../src/chat-to-fix/core/adapters/jira.ts#L97-L99) | 抽出纯文本转 ADF 函数；保留 `connection.js` 的必填及长度校验，以及 `jira.ts` 的可空描述和 REST v2/v3 分支。 |
| 低 | 模拟 HTTP JSON 读取 | [`mock-channel.js:33-47`](../../src/slackBot/mock-channel.js#L33-L47)、[`mock-slack-bot.js:31-52`](../../src/slackBot/mock-slack-bot.js#L31-L52) | 共用内容类型校验、按字节上限读取及 JSON 对象解析；由调用方保留不同上限和错误消息。 |

## 已确认的测试缺口

`POST /tasks/<id>/messages` 的 [`taskMessageText`](../../src/chat-to-fix/core/task/http.ts#L343-L349) 会把补充消息中的 `-----END MATERIAL-----` 转为 `-----END_MATERIAL-----`。现有 [`http.test.ts:534-542`](../../src/chat-to-fix/test/http.test.ts#L534-L542) 只断言普通正文和前缀。若抽取时漏掉这条路径，伪结束标记会提前结束材料块，而该测试仍会通过。

[`runner.test.ts:107-109`](../../src/chat-to-fix/test/runner.test.ts#L107-L109) 和 [`service-tools.test.ts:121-130`](../../src/chat-to-fix/test/service-tools.test.ts#L121-L130) 已覆盖另外两条路径，但不能覆盖补充消息的 HTTP 路径。

## 验收条件

- [ ] 三条材料块路径共用同一封装；原有导语、任务信息、尾句和正文格式保持一致。三条路径都验证嵌入的结束标记无法提前关闭块。
- [ ] `/fix` 和已有讨论串的事件入口复用 `once()`；并发重复请求只创建或投递一次，重复响应保持现有状态与 `duplicate` 字段。无有效 `eventId` 和校验失败的响应保持一致。
- [ ] 两条 Jira 路径共用文本转 ADF 函数；验证 `\n`、`\r\n`、空行和评论正文。输入校验与 REST v2 的字符串正文保持一致。
- [ ] 两个模拟服务共用 JSON 读取逻辑；频道服务仍以 8192 字节为上限，私信服务仍以 16384 字节为上限。声明长度超限、实际流超限、错误内容类型、无效 JSON 和非对象正文仍返回各自现有状态码与错误消息。
- [ ] 在 `http.test.ts` 增加补充消息包含 `-----END MATERIAL-----` 的用例；断言发送到群内的消息只有一个原始结束标记，正文中的标记已转义。
- [ ] `npm run test:agent`、`npm run test:slack-bot`、`npm run test:connections` 和 `npm run typecheck` 通过。更新本文件的完成状态与验证结果。

## 复核说明

本 issue 来自只读代码审查。审查时 `HEAD` 与 `origin/main` 一致，工作区没有改动；未执行测试。四处重复代码是维护性改进，不应作为四个已复现缺陷上报。
