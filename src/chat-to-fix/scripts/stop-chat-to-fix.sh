#!/bin/sh
# Stops the chat-to-fix process started by scripts/start-chat-to-fix.sh: SIGTERM to its process group
# (DSH disposes the plugin tree, chat-to-fix closes its listener), SIGKILL to the group after a grace
# period, then removes the pid file. Never kills by name.
#
#   scripts/stop-chat-to-fix.sh            CHAT_TO_FIX_DATA selects the data directory (default <project>/.data/connected)
#   CHAT_TO_FIX_STOP_GRACE=<seconds>       grace before SIGKILL (default 15)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$(cd "$ROOT/../.." && pwd)"
DATA="${CHAT_TO_FIX_DATA:-$ROOT/.data/connected}"
PIDFILE="$DATA/run/chat-to-fix.pid"
NODE="$(command -v node)"

if [ ! -f "$PIDFILE" ]; then
  if "$NODE" "$ROOT/scripts/connected.ts" --running >/dev/null 2>&1; then
    echo "stop-chat-to-fix: Agent is running but $PIDFILE is missing; cannot stop it safely" >&2
    exit 1
  fi
  echo "chat-to-fix: not running (no pid file)"
  exit 0
fi
pid="$(cat "$PIDFILE")"
case "$pid" in ''|*[!0-9]*) echo "stop-chat-to-fix: bad pid file $PIDFILE" >&2; rm -f "$PIDFILE"; exit 1 ;; esac

group_alive() { "$NODE" -e 'try { process.kill(-Number(process.argv[1]), 0) } catch (error) { if (error.code === "ESRCH") process.exit(1) }' "$pid"; }
if ! group_alive; then
  echo "chat-to-fix: not running (stale pid file removed)"
  rm -f "$PIDFILE"
  exit 0
fi
# The group leader must still be this project's DSH; a recycled pid is not ours to signal.
leader="$(ps -o command= -p "$pid" 2>/dev/null || true)"
case "$leader" in
  *"$PROJECT_ROOT/node_modules/@deepseek-ai/dsh/lib/bin.js"*) ;;
  '') ;; # leader already gone, other members of its group remain: they are ours (same group id)
  *) echo "stop-chat-to-fix: process $pid is not this project's DSH ($leader); not signalling it" >&2; exit 1 ;;
esac

if ! kill -TERM "-$pid" 2>/dev/null; then
  echo "stop-chat-to-fix: cannot signal process group $pid; PID file retained" >&2
  exit 1
fi
grace="${CHAT_TO_FIX_STOP_GRACE:-15}"
i=0
while group_alive && [ "$i" -lt "$((grace * 5))" ]; do sleep 0.2; i=$((i + 1)); done
if group_alive; then
  echo "stop-chat-to-fix: still running after ${grace}s, sending SIGKILL to process group $pid" >&2
  if ! kill -KILL "-$pid" 2>/dev/null; then
    echo "stop-chat-to-fix: cannot signal process group $pid; PID file retained" >&2
    exit 1
  fi
  sleep 0.5
fi
if group_alive; then echo "stop-chat-to-fix: process group $pid did not exit; PID file retained" >&2; exit 1; fi
rm -f "$PIDFILE"
echo "chat-to-fix: stopped (process group $pid)"
