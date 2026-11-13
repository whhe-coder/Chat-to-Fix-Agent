# scripts/lib/

脚本共用的小程序。

| 文件 | 放的是什么 |
|---|---|
| `launch-detached.ts` | 命令行小程序：在独立会话和进程组里启动一个命令，日志追加到文件，写 pid 文件后立即返回 |

谁调它：`../start-chat-to-fix.sh`。停的时候对整个进程组发信号（`stop-chat-to-fix.sh`），不要按名字杀进程。
