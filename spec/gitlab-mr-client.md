# GitLab Draft MR 客户端规格

状态：客户端方法和本地测试已实现；现有 MR 与 CI 的只读调用已验证。Git push、真实 Draft MR 创建及标题／描述更新尚未验证。

客户端位于 [`src/gitlab/client.js`](../src/gitlab/client.js)。本地 agent 可通过 [`createGitlabConnection`](gitlab-connection.md) 取得这些方法，无需启动 HTTP 服务。

## Draft MR

- `createDraftMergeRequest` 使用任务分支作为来源，以 `master` 为目标。它先查找同一来源分支的开放 MR，避免普通重试重复创建。新 MR 标题保持 `Draft:` 前缀。
- `updateDraftMergeRequest` 只接受 MR IID、预期任务分支、标题和／或描述。它先核对 MR 仍开放、仍为 Draft，并且来源分支与预期一致。标题更新后仍保留 `Draft:` 前缀。
- 客户端没有合并、批准、关闭或设置自动合并的方法。当前 HTTP 服务也不开放 MR 写入接口。

## CI 检查

- 以 MR 当前 `sha` 为准。若 `head_pipeline` 属于旧 commit，查找当前 `sha` 的 MR pipeline，并按 ID 选最大的一条；没有找到时返回 `pending`，不借用旧成功结果。若 `head_pipeline` 已属于当前 commit，客户端直接使用它。同一 commit 有多条 pipeline 时的最新结果选择仍待 M4 验证。
- 读取当前主 pipeline 的 trigger jobs，并跟踪下游 pipeline。下游状态不能由主 pipeline 的 `success` 代替。
- 检查主、下游 pipeline 的当前 jobs。只要有失败 job，就返回 `failed`，即使 pipeline 总状态为 `success`。返回失败 job 的 ID、名称与链接；日志正文只供内部 `getJobTrace` 方法读取，不经 HTTP 接口输出。
- 只有主 pipeline、所有已发现的下游 pipeline 均为 `success`，且没有失败 job 时，才返回 `passed`。尚未产生当前 pipeline 或仍在运行时返回 `pending`。取消的 pipeline 返回 `failed`。

## 验证边界

本地测试覆盖 Draft 标题、来源分支检查、旧 commit 结果、下游失败和 pipeline 成功但 job 失败。真实 GitLab 只读检查已读取现有 MR 的主、下游 pipeline 与 jobs。写入调用、同一 commit 的多 pipeline 选择和自动修复循环尚未对真实项目验证；这不代表 M3 或 M4 已验收。
