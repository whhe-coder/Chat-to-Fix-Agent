# 本地环境变量配置

[`../../.env.example`](../../.env.example) 列出变量并按服务分组。首次配置时，将模板复制为仓库根目录的 `.env.local`，填写本机值，然后限制文件权限。已有 `.env.local` 时不要覆盖：

```sh
cp -n .env.example .env.local
chmod 600 .env.local
```

`.env.local` 是本机明文文件，已被 Git 忽略。不要发送该文件，也不要把 token 写进 Git、命令参数、日志或聊天。启动入口使用 Node.js 的 `process.loadEnvFile` 自动加载；当前本机 Node.js 已验证支持。若旧版 Node.js 不支持此方法，文件存在时启动会报出明确错误。

已有的进程环境变量优先于 `.env.local`。某个 token 未设置时，Mac 上仍可从登录钥匙串的 `Chat-to-Fix-Agent/<变量名>` 条目读取，账号为 `local-agent`。`npm start`、`npm run start:server` 和 `npm run check:jira` 使用此顺序。钥匙串中的现有 token 副本仍保留。

## 变量来源

| 组 | 变量 | 来源或设置位置 |
| --- | --- | --- |
| 本地服务 | `PORT` | 自行选择未占用的本机端口；默认 `4000`。 |
| Slack | `SLACK_APP_TOKEN` | Slack API 当前应用的 **Basic Information → App-Level Tokens**；只选 `connections:write`。 |
| Slack | `SLACK_BOT_TOKEN` | Slack API 当前应用的 **OAuth & Permissions**；工作区批准安装后生成。当前尚未取得。 |
| GitLab | `GITLAB_TOKEN` | 目标项目的 **Settings → Access tokens**；当前项目 token 已创建，权限见 [GitLab 接入记录](../gitlab/README.md)。 |
| GitLab | `GITLAB_URL` | 目标私有 GitLab 站点地址；模板已填写。 |
| GitLab | `GITLAB_PROJECT` | 目标项目的仓库路径；模板已填写。 |
| GitLab | `GITLAB_BRANCH` | 目标分支；当前使用 `master`。 |
| Jira | `JIRA_TOKEN` | Atlassian 账号的 **Security → API tokens**；当前 scoped token 已创建，权限见 [Jira 接入记录](../jira/README.md)。 |
| Jira | `JIRA_CLOUD_ID` | Jira 站点 `/_edge/tenant_info` 响应中的 `cloudId`。 |
| Jira | `JIRA_BOARD_ID` | 目标 board 页面 URL 末尾的数字。 |
| Jira | `JIRA_EMAIL` | 创建个人 Jira token 的 Atlassian 账号邮箱；服务账号 Bearer token 留空。 |
| Jira | `JIRA_WORK_TYPE_FIELD_ID` | 在已登录 Jira 的浏览器中查询 `/rest/api/3/field/search?query=Work%20type`，选名称精确为 `Work type` 的字段 ID。 |

## 当前验证

用户确认后，现有 Slack App、GitLab 和 Jira token 已从钥匙串复制到本机 `.env.local`。文件权限为 `600`；`SLACK_BOT_TOKEN` 保持空白。使用该文件启动本地服务后，`/health`、`/gitlab/status` 和 `/jira/board` 均返回 `200`。真实值未进入 Git 跟踪文件。
