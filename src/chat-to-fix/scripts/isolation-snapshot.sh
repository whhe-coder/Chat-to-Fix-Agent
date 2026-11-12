#!/bin/sh
# Lists names and modification times (never contents) of the places outside the project where
# a DSH process would read or write by default, for a before/after comparison around a run:
#
#   scripts/isolation-snapshot.sh > before.txt; <run>; scripts/isolation-snapshot.sh > after.txt
#   diff before.txt after.txt
#
# Each line: <mtime epoch> <path>. Paths that do not exist print as "absent <path>".
# Depth is limited so only names near the top of each place are listed.
set -u
H="$HOME"
TMP_DEFAULT="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp)"
list() { # <depth> <path>
  if [ -e "$2" ] || [ -L "$2" ]; then
    find "$2" -maxdepth "$1" \( -name node_modules -prune \) -o -print 2>/dev/null | LC_ALL=C sort | while IFS= read -r p; do
      printf '%s %s\n' "$(stat -f %m "$p" 2>/dev/null || echo '?')" "$p"
    done
  else
    printf 'absent %s\n' "$2"
  fi
}
list 0 "$H"                                   # the home directory itself (entries added/removed)
find "$H" -maxdepth 1 -name '.*' 2>/dev/null | LC_ALL=C sort | while IFS= read -r p; do printf '%s %s\n' "$(stat -f %m "$p")" "$p"; done
list 3 "$H/.dsh"                              # default DSH_HOME
list 2 "$H/.agents"                           # default DSH_AGENTS_HOME (AGENTS.md, skills/)
list 1 "$H/.deepseek"
list 1 "$H/.config"
list 1 "$H/.cache"
list 1 "$H/.npm"
list 1 "$H/.npm/_logs"                        # npm writes one debug log per command here
list 1 "$H/.pnpm-store"
list 1 "$H/.local/share"
list 1 "$H/.local/state"
list 1 "$H/.anthropic"
list 1 "$H/.pi"
list 1 "$H/.claude"                           # Claude Code: changes here come from any running Claude Code
list 1 "$H/Library/Caches"
list 1 "$H/Library/Application Support"
list 1 "$H/Library/Preferences"
list 1 "$H/Library/Logs"
list 1 "$H/Documents/mywork/ds-bot"           # the user's DS Bot checkout (names only)
list 0 "$TMP_DEFAULT"                         # the default os.tmpdir()
