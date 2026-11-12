# Chat-to-Fix Agent 已完成事项

更新日期：2026-11-12。本文只记录已落实并核对的事项。未完成工作和里程碑验收标准见 [实施计划](chat-to-fix-agent.md)。

## M0 Slack 私信入口

- [x] 增加按服务分组的 `.env.example` 模板和统一的 [本地环境变量配置](../config/local-env/README.md)。用户确认后，已将现有 Slack App、GitLab 和 Jira token 复制到权限为 `600` 的本机 `.env.local`；Bot token 仍待工作区批准。
- [x] 使用 `.env.local` 启动本地服务，`/health`、`/gitlab/status` 和 `/jira/board` 均返回 `200`。真实值未进入 Git 跟踪文件。
- [x] `App Home` 的 `Messages` 标签页允许用户发送私信。
- [x] Socket Mode 已开启。
- [x] Events API 仅订阅 `message.im`。
- [x] Bot Token Scopes 仅有 `im:history`、`chat:write`；User Token Scopes 为空。
- [x] 生成仅带 `connections:write` 的 App-level token，并保存到本机 Mac 登录钥匙串。Git 历史不保存 token 值。
- [x] 提交目标工作区安装申请；Slack 页面显示 `Request Submitted`。该申请尚不代表安装已获批准。
- [x] 在 [`src/slackBot/`](../src/slackBot/) 编写最小私信测试 Bot；本地 4 项消息处理测试通过。尚未进行真实私信收发验证。

## M0a 模拟私信入口

- [x] 增加无需 Slack token 的本机模拟 Bot。它复用现有私信处理器，提供模拟私信提交和 thread 查询接口；相同事件并发重试只回复一次。接口和边界见 [模拟 Bot 规格](../spec/mock-slack-bot.md)。
- [x] 模拟 Bot 的 4 项自动测试通过，包括原 thread 回复、事件去重、可替换处理器和本机 HTTP 接口。未执行 Jira 或 GitLab 写入。

## GitLab 接入准备（不代表 M1 或 M3 验收通过）

- [x] 在 [`src/server/`](../src/server/) 增加只监听本机的 Node.js 服务。`/health` 可用；`/gitlab/status` 以只读调用读取目标仓库的 `master` 分支。
- [x] 服务测试 3 项通过；本机启动服务后，真实 GitLab API 返回目标仓库的 `master` 提交信息。未验证 Git push 或创建 MR。
- [x] 创建 `chat-to-fix-agent` 项目 token：`Developer` 角色，仅选 `api` 和 `write_repository`，2026-12-11 到期。完整值已保存到本机 Mac 登录钥匙串；Git 历史不保存值。
- [x] 使用新 token 只读验证目标仓库分支、MR、pipeline、jobs 和一条 job trace，均返回 `200`。Git push、Draft MR 创建与标题／描述更新尚未验证。
- [x] 本地服务已从约定的 Mac 钥匙串条目读取新 token，并通过 `/gitlab/status` 返回目标仓库的 `master` 提交信息；默认端口 `4000` 已验证可用。
- [x] GitLab 客户端已实现 Draft MR 创建与标题／描述更新方法，并在本地验证分支检查和 Draft 状态保护。真实 MR 写入尚未执行。
- [x] `/gitlab/merge-requests/:iid/checks` 已通过现有 MR 的真实只读调用；它返回当前 commit、主 pipeline、已发现的下游 pipeline 和失败 jobs。尚未验证多条当前 commit pipeline 的选择规则或自动修复循环。
- [x] 将 GitLab 客户端移到 [`src/gitlab/`](../src/gitlab/)，抽出 `createGitlabConnection()` 和 `loadGitlabToken()`。服务改用该连接对象；本地测试验证凭据来源和独立连接。重构后的服务已通过真实 GitLab 只读复测。

## Jira 接入准备（不代表 M2 验收通过）

- [x] 确认目标为 Jira Cloud 的 `F2PGBA` board，核对读取单个 board 的官方 API 和所需 scopes。
- [x] 在 [`src/jira/`](../src/jira/) 实现独立只读连接函数与检查命令。模拟服务账号 Bearer、个人账号 Basic、钥匙串读取和错误脱敏的本地测试通过。
- [x] 在个人 Atlassian 账号下创建 `Chat-to-Fix-Board-Read` scoped token；应用仅选 Jira，权限仅选 `read:board-scope:jira-software` 和 `read:issue-details:jira`，到期日为 2027-02-09。token 已保存到本机钥匙串。
- [x] 用旧只读 token 通过目标 board 的真实只读 API 验证。返回名称为 `F2PGBA board`；响应未给出项目 key。
- [x] 在本地 Node.js 服务增加 `GET /jira/board`、`POST /jira/issues`、`POST /jira/issues/:key/comments`、`PUT /jira/issues/:key/comments/:id`。工单固定在 `F2PGBA` 项目；评论路径仅接受该项目的工单 key。
- [x] Jira 连接函数新增工单创建、评论新增和评论修改方法。普通文本转为 ADF；工单类型必须显式提供。本地模拟测试和服务路由测试通过。
- [x] 根据 Atlassian 官方 OpenAPI 核对三个写入端点的 granular OAuth scope 并集，并在 scoped API token 创建确认页核对所选权限。
- [x] 在个人 Atlassian 账号下创建仅限 Jira 的 `Chat-to-Fix-Jira-Issues-Comments` scoped token。创建前确认页列出原有 2 项 board scopes 和 12 项写入 API scopes，到期日为 2027-02-09。用户已将新值保存到本机钥匙串。
- [x] 本机使用新 token 成功读取目标 board；缺字段的创建请求返回 `400`，未创建工单。刷新后的 Atlassian 列表显示新 token 近期访问、旧 token 未显示本次访问。
- [x] 用户确认后，撤销旧 `Chat-to-Fix-Board-Read` token。Atlassian 显示撤销成功；刷新列表后旧 token 不再出现，新的 `Chat-to-Fix-Jira-Issues-Comments` 仍在。
- [x] 确认 `F2PGBA` 创建 `Task` 工单时 `Work type` 为必填单选字段；Jira 连接函数新增 `workType` 输入和 `JIRA_WORK_TYPE_FIELD_ID` 配置。实际字段 ID 不写入仓库。
- [x] 用新 token 经本地服务真实创建一张验证工单，新增并修改该账号自己的评论。创建和新增返回 `201`，修改返回 `200`；新 token 回读到修改后的评论，并通过目标 board 查询到该工单。完整本地测试 28 项通过。
