# Source this file before running anything:  . scripts/dev-env.sh
# Local toolchain for this machine. Paths are specific to this Mac.
export CHAT_TO_FIX_NODE_BIN="/Users/zihuifan/Documents/mywork/ds-bot/.toolchain/node-v24.22.2/bin"
export PATH="$CHAT_TO_FIX_NODE_BIN:$PATH"
# The bundled DSH 0.2.2-rc.1 runtime (runtime/package.json, installed from npm, never modified).
# scripts/start-chat-to-fix.sh boots runtime/node_modules/.bin/dsh; the tests resolve @deepseek-ai/* from here.
export DSH_HARNESS="/Users/zihuifan/Documents/mywork/chat-to-fix/chat-to-fix/runtime"
# Claude Code CLI bundled with the Claude desktop app (the hash folder changes when the app updates).
export CLAUDE_BIN="$HOME/Library/Application Support/Claude/claude-code/2.1.321/ddbdf2b334e1/claude.app/Contents/MacOS/claude"
