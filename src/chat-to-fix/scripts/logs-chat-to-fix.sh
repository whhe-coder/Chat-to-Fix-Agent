#!/bin/sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${CHAT_TO_FIX_DATA:-$ROOT/.data/connected}"
exec tail -n 30 -f "$DATA/run/chat-to-fix.log"
