# core/flow/

流程定义：八步的顺序、每步谁负责、什么算完成、哪些写工具属于哪一步，全部写成数据。

| 文件 | 放的是什么 |
|---|---|
| `steps.ts` | `STEPS` 步骤表、结束规则（`closeEndReason`、`OUTCOME_RULES`）、写工具归属、`createFlow`、`validateFlow` |

谁调它：`task/gate.ts` 读它来检查，`registry/` 和 `tools/` 的测试用它对账。要换步骤顺序或负责人，只改这个文件；不要把流程判断写进工具或提示词。
