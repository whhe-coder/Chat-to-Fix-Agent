# test/helpers/

测试共用的替身。

| 文件 | 放的是什么 |
|---|---|
| `fake-botlayer.ts` | 内存里的 bot 层门面（I1），接口和 `core/task/contracts.ts` 一致，未知 id 的拒绝方式也和真的一样 |

谁调它：`test/` 里大多数系统层测试。改了 `botlayer.ts` 的接口，要同步改这里，否则测试在假的上通过、在真的上失败。
