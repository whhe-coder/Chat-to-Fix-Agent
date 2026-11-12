# GitLab 连接函数规格

状态：独立模块已实现并通过本地测试。2026-11-12 已直接用重构后的连接函数读取真实项目的 `master` 分支；已删除的过渡服务也曾通过 `/gitlab/status` 完成真实只读复测。

## 入口

- [`createGitlabConnection`](../src/gitlab/connection.js) 创建可复用的 GitLab 连接对象。Agent 的连接准备脚本直接调用该函数。创建对象不发送 GitLab 请求；`checkConnection()` 才读取目标分支。
- 不传 `token` 时，函数调用 `loadGitlabToken()` 一次。变量来源和读取优先级见 [本地环境变量配置](../config/local-env/README.md)。其他系统没有钥匙串回退凭据。
- 调用方应在进程启动时创建一次连接，并复用返回对象。只有缺少环境变量时才可能触发钥匙串授权提示。
- 可传入 `token`、`gitlabUrl`、`project`、`fetchImpl`。连接对象只公开 `configured`、`checkConnection` 和客户端操作，不公开 token 值。

## 连接检查

`checkConnection(branch = 'master')` 读取目标分支，返回项目路径、分支名称和 commit ID。缺少凭据、GitLab 请求失败或分支响应无效时抛出错误；调用方负责处理错误。连接对象还提供读取 MR、CI、job trace，以及创建或更新 Draft MR 的客户端方法。它没有合并 MR 的方法。

## 验证边界

本地测试验证环境变量优先、钥匙串回退只调用一次、分支检查和返回对象不包含 token。重构后的连接函数已通过真实只读分支请求；过渡 HTTP 服务的历史验证结果见 [归档规格](../docs/archive/legacy-local-server/gitlab-readonly-server.md)；真实 GitLab 写入仍待验证。
