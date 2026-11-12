#!/bin/sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${CHAT_TO_FIX_DATA:-$ROOT/.data/connected}"
if CHAT_TO_FIX_DATA="$DATA" node "$ROOT/scripts/connected.ts" --running >/dev/null 2>&1; then
  echo "chat-to-fix: Agent 当前运行；以下日志包含历史记录。"
else
  echo "chat-to-fix: Agent 健康检查未通过；以下日志包含历史记录。"
fi
exec tail -n 30 -f "$DATA/run/chat-to-fix.log"
