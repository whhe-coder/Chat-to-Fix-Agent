# GitLab 连接函数规格

状态：独立模块已实现并通过本地测试。重构前的 GitLab 只读请求已在真实项目验证；本次重构后尚未重启服务做真实连接复测。

## 入口

- [`createGitlabConnection`](../src/gitlab/connection.js) 创建可复用的 GitLab 连接对象。HTTP 服务和后续本地 agent 可调用同一函数。创建对象不发送 GitLab 请求；`checkConnection()` 才读取目标分支。
- 不传 `token` 时，函数调用 `loadGitlabToken()` 一次。它优先读取 `GITLAB_TOKEN` 环境变量；在 Mac 上回退到登录钥匙串的 `Chat-to-Fix-Agent/GITLAB_TOKEN` 条目。其他系统没有回退凭据。
- 调用方应在进程启动时创建一次连接，并复用返回对象。HTTP 请求不再读取钥匙串。每次重启仍可能触发 macOS 钥匙串授权提示。
- 可传入 `token`、`gitlabUrl`、`project`、`fetchImpl`。连接对象只公开 `configured`、`checkConnection` 和客户端操作，不公开 token 值。

## 连接检查

`checkConnection(branch = 'master')` 读取目标分支，返回项目路径、分支名称和 commit ID。缺少凭据、GitLab 请求失败或分支响应无效时抛出错误；调用方负责处理错误。连接对象还提供读取 MR、CI、job trace，以及创建或更新 Draft MR 的客户端方法。它没有合并 MR 的方法。

## 验证边界

本地测试验证环境变量优先、钥匙串回退只调用一次、分支检查和返回对象不包含 token。真实 GitLab 写入和本次重构后的真实连接复测尚未完成。
