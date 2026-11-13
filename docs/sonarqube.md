# SonarQube 接入

GitHub 保存源代码。公司 GitLab 以“Run CI/CD for external repository”连接这个 GitHub 仓库，并运行内部 SonarQube 组件。GitHub Actions 继续运行现有单元测试。

## 仓库配置

- `.gitlab-ci.yml` 只为 `main` 和 GitHub PR 运行流水线。`coverage` job 使用 Node.js 24 执行类型检查和测试，并交付 `coverage/lcov.info`。
- 内部 `gitlab-ci-sonar@0.2.6` 组件在 `coverage` 完成后扫描。仓库根目录的 `sonar-project.properties` 固定项目 key、扫描范围和覆盖率路径。
- GitLab 对 GitHub PR 使用 `external_pull_request_event`。组件原本只识别 GitLab MR；同名 `sonar` job 的 `before_script` 把 GitHub PR 变量映射到组件需要的参数。
- 首次接入时，Sonar job 的 Quality Gate 只报告结果，不阻断流水线。检查主分支基线和 PR 结果后，再决定是否改为阻断。

## 服务端设置

1. 在 GitLab 选择 **New project/repository → Run CI/CD for external repository → GitHub**，连接 `whhe-coder/Chat-to-Fix-Agent`。GitLab 的此入口要求 GitHub classic PAT 具有 `repo` 和 `admin:repo_hook` 权限。该凭据供 GitLab 持续拉取代码并回写状态；撤销前须先替换连接凭据。
2. 在 SonarQube 创建项目，key 使用 `whhe-coder_chat-to-fix-agent`，主分支使用 `main`。
3. 为该 SonarQube 项目生成分析 token，并在新建的 GitLab 项目中设置 masked CI/CD 变量 `SONAR_TOKEN`。不要把 token 写进仓库。
4. 确认 GitLab 项目能使用可访问公司 SonarQube 的 runner，且 runner 能拉取 Node.js 24 镜像并安装 npm 依赖。
5. 将本配置合入 GitHub `main` 后，核对第一次主分支扫描、覆盖率和 Quality Gate。再打开或更新同仓库 PR，核对 GitLab 的 `external_pull_request_event` 流水线和 GitHub commit status。GitLab 不支持外部 fork PR 流水线。

如果 GitLab 项目启用了受保护变量，确认同仓库 PR 流水线能读取 `SONAR_TOKEN`。外部 fork PR 不运行此流水线。

本机可用 Node.js 24 运行 `npm ci`、`npm run typecheck`、`npm run test:coverage`。覆盖率报告位于 `coverage/lcov.info`，不会提交到 Git。
