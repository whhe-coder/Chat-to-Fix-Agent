#!/bin/sh
# Stand-in for the Claude Code CLI in the smoke run (scripts/smoke.mjs sets the plugin row's
# claudeCommand to this file). It makes the `claude-code` route exist without a real CLI, so the
# Coding bot can be created, and guarantees that no real model call can happen: `--version`
# answers, anything else is logged to $TMPDIR/fake-claude.log and fails.
if [ "${1:-}" = "--version" ]; then echo "0.0.0 (chat-to-fix smoke stand-in, not Claude Code)"; exit 0; fi
printf '%s fake-claude called: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "${TMPDIR:-/tmp}/fake-claude.log"
echo "fake-claude: this is the smoke-run stand-in; it does not run models" >&2
exit 1
