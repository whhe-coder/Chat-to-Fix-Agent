# SonarQube 接入

本仓库的 GitHub Actions 工作流在 `main` push、同仓库 PR 和手动触发时运行。`unit-test` job 执行类型检查和全部测试，并生成 `coverage/lcov.info`。`sonar` job 读取这份覆盖率，再提交 SonarQube 分析。Quality Gate 最多等待 600 秒。`sonar` job 允许失败；失败原因保留在 job 日志中，但不会使整个工作流失败。

## 启用

1. 在 SonarQube Server 创建项目。默认项目 key 为 `whhe-coder_chat-to-fix-agent`。已有项目可在 GitHub 仓库变量 `SONAR_PROJECT_KEY` 中填写其 key。
2. 在 GitHub 仓库变量中设置 `SONAR_HOST_URL`，例如 `https://sonarqube.example.com`。未设置时，`sonar` job 会跳过；`unit-test` 仍会运行。
3. 在 GitHub 仓库 secret 中设置项目分析 token `SONAR_TOKEN`。已设置 URL 但缺少 token 时，检查步骤会报错；`sonar` job 仍按非阻断规则处理。
4. 如果服务器使用私有 CA，在 GitHub 仓库 secret 中设置 PEM 格式的 `SONAR_ROOT_CERT`。
5. 如果 GitHub 托管 runner 无法访问 SonarQube，在仓库变量 `SONAR_RUNNER` 中设置可访问该服务器的 Linux self-hosted runner 标签。该 runner 还需能下载 GitHub Actions、Node.js 和 npm 依赖。
6. 触发一次 `main` 分析，核对 SonarQube 项目中的主分支和覆盖率。随后检查同仓库 PR 的分析；PR 分析需要 SonarQube 实例支持该功能并完成 GitHub 集成。

若仓库的分支保护或 ruleset 将 `sonar`、`SonarQube` 或 SonarQube 服务发布的检查设为必需项，需在 GitHub 设置中移除该要求。必需检查在运行中仍可能阻止合并；`continue-on-error` 只处理工作流失败结果。`unit-test` 可独立设置为必需检查。

本机可用 Node.js 24 运行 `npm ci`、`npm run typecheck`、`npm run test:coverage`。LCOV 报告写入 `coverage/lcov.info`；该目录不会提交到 Git。扫描范围由仓库根目录的 `sonar-project.properties` 定义。

当前只完成仓库内配置和本机验证。SonarQube 项目、GitHub 变量与 secret、runner 网络连通性，以及远端 Quality Gate 结果仍需在对应服务中核对。
