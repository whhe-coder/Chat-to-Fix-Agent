# Source this file from the repository root before running anything:  . src/chat-to-fix/scripts/dev-env.sh
# Machine-specific paths go in src/chat-to-fix/scripts/dev-env.local.sh (not in git), for example:
#   export CHAT_TO_FIX_NODE_BIN="/path/to/node-v24/bin"      # a folder holding Node 24 (if node is not on PATH)
# The Agent root: CHAT_TO_FIX_ROOT when set, else the nearest folder at or above the current one
# that holds scripts/dev-env.sh (so it also works from a subfolder such as bot/).
_c2f_root="${CHAT_TO_FIX_ROOT:-$PWD}"
if [ -f "$_c2f_root/src/chat-to-fix/scripts/dev-env.sh" ]; then _c2f_root="$_c2f_root/src/chat-to-fix"; fi
while [ ! -f "$_c2f_root/scripts/dev-env.sh" ] && [ "$_c2f_root" != "/" ]; do _c2f_root="$(dirname "$_c2f_root")"; done
if [ -f "$_c2f_root/scripts/dev-env.local.sh" ]; then
  . "$_c2f_root/scripts/dev-env.local.sh"
elif [ -f "$_c2f_root/../../chat-to-fix/scripts/dev-env.local.sh" ]; then
  . "$_c2f_root/../../chat-to-fix/scripts/dev-env.local.sh"
fi
# Node 24: from CHAT_TO_FIX_NODE_BIN when set, else whatever node is on PATH.
if [ -n "${CHAT_TO_FIX_NODE_BIN:-}" ]; then export PATH="$CHAT_TO_FIX_NODE_BIN:$PATH"; fi
# Use the operating system's trusted certificates for internal GitLab HTTPS.
export NODE_USE_SYSTEM_CA="${NODE_USE_SYSTEM_CA:-1}"
# The DSH runtime is installed by the repository root package.
export DSH_HARNESS="${DSH_HARNESS:-$_c2f_root/../..}"
# No Claude Code CLI is needed: all five bots run inside DSH on the Anthropic API, with the one key
# ANTHROPIC_API_KEY (docs/chat-to-fix/configuration.md). A CLAUDE_BIN left in dev-env.local.sh is ignored.
unset _c2f_root
