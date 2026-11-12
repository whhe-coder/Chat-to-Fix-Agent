# Source this file from the project root before running anything:  . scripts/dev-env.sh
# Machine-specific paths go in scripts/dev-env.local.sh (not in git), for example:
#   export CHAT_TO_FIX_NODE_BIN="/path/to/node-v24/bin"      # a folder holding Node 24 (if node is not on PATH)
#   export CLAUDE_BIN="/path/to/claude"                       # the Claude Code CLI (if claude is not on PATH)
_c2f_root="${CHAT_TO_FIX_ROOT:-$PWD}"
if [ -f "$_c2f_root/scripts/dev-env.local.sh" ]; then . "$_c2f_root/scripts/dev-env.local.sh"; fi
# Node 24: from CHAT_TO_FIX_NODE_BIN when set, else whatever node is on PATH.
if [ -n "${CHAT_TO_FIX_NODE_BIN:-}" ]; then export PATH="$CHAT_TO_FIX_NODE_BIN:$PATH"; fi
# The bundled DSH 0.2.2-rc.1 runtime (runtime/package.json, installed from npm, never modified).
# scripts/start-chat-to-fix.sh boots runtime/node_modules/.bin/dsh; the tests resolve @deepseek-ai/* from here.
export DSH_HARNESS="${DSH_HARNESS:-$_c2f_root/runtime}"
# The Claude Code CLI: CLAUDE_BIN when set, else claude on PATH.
if [ -z "${CLAUDE_BIN:-}" ] && command -v claude >/dev/null 2>&1; then export CLAUDE_BIN="$(command -v claude)"; fi
unset _c2f_root
