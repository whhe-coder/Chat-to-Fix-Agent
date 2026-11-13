#!/bin/sh
# Starts chat-to-fix using DSH from the repository root install, headless and isolated.
#
#   scripts/start-chat-to-fix.sh [--patch <file>]...     extra --patch overlays go after config/cordis.patch.yml
#   scripts/stop-chat-to-fix.sh                          stops it (process group from the pid file)
#
# Environment (all optional):
#   CHAT_TO_FIX_DATA        data directory; everything the process writes goes under it (default <project>/.data/connected)
#   CHAT_TO_FIX_CONFIG      chat-to-fix configuration file (default $CHAT_TO_FIX_DATA/chat-to-fix.json; must exist)
#   CHAT_TO_FIX_HTTP_TOKEN  control-interface token (default: read from $CHAT_TO_FIX_DATA/http-token, generated once)
#   CHAT_TO_FIX_PASS_ENV    extra environment variable NAMES to pass to the process, space separated
#   CHAT_TO_FIX_START_TIMEOUT  seconds to wait for the control interface (default 90)
#
# Layout under $CHAT_TO_FIX_DATA:
#   dsh/        DSH_HOME: profiles/chat-to-fix (the profile), sessions, storages, logs, bot/ (bot layer state)
#   agents/     DSH_AGENTS_HOME (instead of ~/.agents)
#   tmp/        TMPDIR
#   xdg/        XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME, XDG_STATE_HOME
#   cache/      npm / pnpm caches (only used if DSH's plugin manager ever runs pnpm)
#   work/       the process's working directory (DSH reads <cwd>/.env; this one is empty)
#   run/        chat-to-fix.pid, chat-to-fix.log
# chat-to-fix's own task store is the `dataDir` of the configuration file; keep it under $CHAT_TO_FIX_DATA.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$(cd "$ROOT/../.." && pwd)"
DATA="${CHAT_TO_FIX_DATA:-$ROOT/.data/connected}"
mkdir -p "$DATA"
DATA="$(cd "$DATA" && pwd)"
DSH_BIN="$PROJECT_ROOT/node_modules/@deepseek-ai/dsh/lib/bin.js"
CONFIG="${CHAT_TO_FIX_CONFIG:-$DATA/chat-to-fix.json}"
PATCH="$ROOT/config/cordis.patch.yml"
RUN="$DATA/run"
PIDFILE="$RUN/chat-to-fix.pid"
LOG="$RUN/chat-to-fix.log"

if ! command -v node >/dev/null 2>&1; then CHAT_TO_FIX_ROOT="$ROOT" . "$ROOT/scripts/dev-env.sh"; fi
NODE="$(command -v node)"
[ -f "$DSH_BIN" ] || { echo "start-chat-to-fix: DSH is missing from the root install ($DSH_BIN)" >&2; exit 1; }
[ -f "$CONFIG" ] || { echo "start-chat-to-fix: no configuration at $CONFIG (copy config.example.json and set CHAT_TO_FIX_CONFIG)" >&2; exit 1; }
# chat-to-fix's task store and worktrees are wherever the configuration says; say so when that is
# outside the data directory (the isolation promise covers $CHAT_TO_FIX_DATA only).
"$NODE" -e '
  const [file, data] = process.argv.slice(1); const c = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
  const p = require("node:path"); for (const k of ["dataDir", "worktreesDir"]) {
    if (typeof c[k] === "string" && !p.resolve(c[k]).startsWith(data + p.sep)) console.error(`start-chat-to-fix: warning: ${k} ${c[k]} is outside ${data}`) }
' "$CONFIG" "$DATA" || { echo "start-chat-to-fix: cannot read $CONFIG as JSON" >&2; exit 1; }

# Extra overlays given on the command line.
OVERLAYS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --patch) [ $# -ge 2 ] || { echo "start-chat-to-fix: --patch needs a file" >&2; exit 2; }
             f="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; OVERLAYS="$OVERLAYS
$f"; shift 2 ;;
    *) echo "start-chat-to-fix: unknown argument $1" >&2; exit 2 ;;
  esac
done

alive() {
  [ -f "$PIDFILE" ] || return 1
  pid="$(cat "$PIDFILE")"
  case "$pid" in ''|*[!0-9]*) echo "start-chat-to-fix: bad pid file $PIDFILE" >&2; exit 1 ;; esac
  "$NODE" -e 'try { process.kill(-Number(process.argv[1]), 0) } catch (error) { if (error.code === "ESRCH") process.exit(1) }' "$pid"
}
if alive; then echo "start-chat-to-fix: already running (process group $(cat "$PIDFILE"))"; exit 0; fi

# A missing PID file does not prove that the Agent stopped. Check the authenticated health
# endpoint and the configured port before touching the log or launching another DSH process.
port="$("$NODE" -e '
  const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const port = c.httpPort ?? 3090;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("start-chat-to-fix: invalid httpPort in configuration");
    process.exit(1);
  }
  process.stdout.write(String(port));
' "$CONFIG")"
if CHAT_TO_FIX_DATA="$DATA" CHAT_TO_FIX_CONFIG="$CONFIG" "$NODE" "$ROOT/scripts/connected.ts" --running >/dev/null 2>&1; then
  echo "start-chat-to-fix: Agent already running on 127.0.0.1:$port (PID file missing); log unchanged"
  exit 0
fi
if [ "$port" -gt 0 ] && "$NODE" -e '
  const socket = require("node:net").connect({ host: "127.0.0.1", port: Number(process.argv[1]) });
  socket.on("connect", () => { socket.destroy(); process.exit(0) });
  socket.on("error", () => process.exit(1));
  socket.setTimeout(1500, () => { socket.destroy(); process.exit(1) });
' "$port"; then
  echo "start-chat-to-fix: 127.0.0.1:$port is occupied; not starting another Agent; log unchanged" >&2
  exit 1
fi
rm -f "$PIDFILE"

DSH_HOME_DIR="$DATA/dsh"
PROFILE="$DSH_HOME_DIR/profiles/chat-to-fix"
mkdir -p "$RUN" "$DATA/agents" "$DATA/tmp" "$DATA/work" "$DATA/cache/npm" "$DATA/cache/pnpm-store" \
  "$DATA/xdg/config" "$DATA/xdg/cache" "$DATA/xdg/data" "$DATA/xdg/state" "$PROFILE/node_modules"
chmod 700 "$DATA" "$RUN" "$DSH_HOME_DIR"

# The profile: DSH's base and web-app bundles (the web-app bundle carries the session controller,
# workspaces and agent presets the bot layer needs; config/cordis.patch.yml switches its web
# server and browser rows off), plus this project linked as the package `chat-to-fix`. The link is
# made by hand (no pnpm install, nothing downloaded): DSH's runtime resolution treats a profile
# node_modules symlink that points outside the profiles tree as a linked root.
cat > "$PROFILE/package.json" <<EOF
{
  "name": "dsh-profile-chat-to-fix",
  "private": true,
  "dependencies": { "chat-to-fix": "link:$PROJECT_ROOT" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
EOF
[ -f "$PROFILE/cordis.patch.yml" ] || printf '# Written by DSH settings forms only. chat-to-fix'"'"'s own rows are in config/cordis.patch.yml.\n[]\n' > "$PROFILE/cordis.patch.yml"
ln -sfn "$PROJECT_ROOT" "$PROFILE/node_modules/chat-to-fix"

# The control-interface token: given, else kept in a private file under the data directory.
if [ -z "${CHAT_TO_FIX_HTTP_TOKEN:-}" ]; then
  if [ ! -s "$DATA/http-token" ]; then
    (umask 077; "$NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$DATA/http-token")
  fi
  CHAT_TO_FIX_HTTP_TOKEN="$(cat "$DATA/http-token")"
fi

# The environment: only what the process needs. Everything else inherited from the calling
# shell is dropped (DSH_*, DS_BOT_*, DEEPSEEK_*, NODE_OPTIONS, ...), so no other installation's
# settings leak in. Credentials named here are passed through by name, never written anywhere.
KEEP="PATH HOME USER LOGNAME SHELL LANG LC_ALL LC_CTYPE TERM
HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY http_proxy https_proxy no_proxy all_proxy
NODE_USE_SYSTEM_CA NODE_EXTRA_CA_CERTS
ANTHROPIC_API_KEY CHAT_TO_FIX_SLACK_TOKEN CHAT_TO_FIX_JIRA_TOKEN CHAT_TO_FIX_JIRA_EMAIL CHAT_TO_FIX_GITLAB_TOKEN
CHAT_TO_FIX_HTTP_TOKEN ${CHAT_TO_FIX_PASS_ENV:-}"
(
  # This script's own values are copied to _FB_* names first: the calling environment may export
  # a variable of the same name (npm run exports NODE, for one), and the loop below unsets every
  # exported name it does not keep.
  _FB_NODE="$NODE" _FB_ROOT="$ROOT" _FB_DATA="$DATA" _FB_DSH_BIN="$DSH_BIN" _FB_CONFIG="$CONFIG"
  _FB_PATCH="$PATCH" _FB_PIDFILE="$PIDFILE" _FB_LOG="$LOG" _FB_HOME_DIR="$DSH_HOME_DIR"
  _FB_OVERLAYS="$OVERLAYS" _FB_TOKEN="$CHAT_TO_FIX_HTTP_TOKEN" _FB_KEEP="$(echo $KEEP)"
  for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do
    case "$name" in _FB_*) continue ;; esac
    case " $_FB_KEEP " in *" $name "*) ;; *) unset "$name" 2>/dev/null || true ;; esac
  done
  export CHAT_TO_FIX_HTTP_TOKEN="$_FB_TOKEN"
  export CHAT_TO_FIX_CONFIG="$_FB_CONFIG"
  export DSH_HOME="$_FB_HOME_DIR"                 # instead of ~/.dsh
  export DSH_AGENTS_HOME="$_FB_DATA/agents"       # instead of ~/.agents (AGENTS.md, skills)
  export DSH_TELEMETRY_DISABLED=1                 # launcher patches session-telemetry-otel off
  export TMPDIR="$_FB_DATA/tmp"                   # os.tmpdir(): spills, sandbox, subprocess output
  export XDG_CONFIG_HOME="$_FB_DATA/xdg/config" XDG_CACHE_HOME="$_FB_DATA/xdg/cache" \
         XDG_DATA_HOME="$_FB_DATA/xdg/data" XDG_STATE_HOME="$_FB_DATA/xdg/state"
  export npm_config_cache="$_FB_DATA/cache/npm" npm_config_store_dir="$_FB_DATA/cache/pnpm-store" \
         npm_config_update_notifier=false
  set -f
  set -- --profile chat-to-fix --patch "$_FB_PATCH"
  IFS='
'
  for f in $_FB_OVERLAYS; do [ -n "$f" ] && set -- "$@" --patch "$f"; done
  unset IFS
  : > "$_FB_LOG"
  chmod 600 "$_FB_LOG"
  echo "start-chat-to-fix: $(date -u +%Y-%m-%dT%H:%M:%SZ) dsh $*" >> "$_FB_LOG"
  exec "$_FB_NODE" "$_FB_ROOT/scripts/lib/launch-detached.ts" "$_FB_PIDFILE" "$_FB_LOG" "$_FB_DATA/work" -- "$_FB_NODE" "$_FB_DSH_BIN" "$@"
)

# Ready when the plugin prints its control-interface line; failed when the process group is gone.
i=0
limit="${CHAT_TO_FIX_START_TIMEOUT:-90}"
until grep -q "chat-to-fix: control interface on 127.0.0.1:" "$LOG" 2>/dev/null; do
  i=$((i + 1))
  if ! alive; then
    echo "start-chat-to-fix: the process exited during startup; last lines of $LOG:" >&2
    tail -30 "$LOG" >&2
    rm -f "$PIDFILE"
    exit 1
  fi
  if [ "$i" -gt "$((limit * 2))" ]; then
    echo "start-chat-to-fix: no control interface after ${limit}s; stopping. See $LOG" >&2
    "$ROOT/scripts/stop-chat-to-fix.sh" >/dev/null 2>&1 || true
    exit 1
  fi
  if grep -q "chat-to-fix: could not start the task layer" "$LOG" 2>/dev/null; then
    echo "start-chat-to-fix: the task layer failed to start; stopping. See $LOG" >&2
    tail -30 "$LOG" >&2
    "$ROOT/scripts/stop-chat-to-fix.sh" >/dev/null 2>&1 || true
    exit 1
  fi
  sleep 0.5
done
port="$(sed -n 's/.*chat-to-fix: control interface on 127\.0\.0\.1:\([0-9]*\).*/\1/p' "$LOG" | tail -1)"
echo "chat-to-fix: running (process group $(cat "$PIDFILE")), control interface http://127.0.0.1:$port, data $DATA, log $LOG"
