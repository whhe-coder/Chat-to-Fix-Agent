#!/bin/sh
# Local mock chain for the Slack Bot hand-over (docs/chat-to-fix/slack/slackbot.md): the mock Slack Bot of the repo root ->
# Chat-to-Fix in outbox mode (local mock model, fake Jira and GitLab) -> outbox -> the mock thread.
# No Slack, no real model, no cost. It submits /fix, an @ while the task runs, stops the task, an @ after it
# ended, prints the outbox and the mock thread, and stops everything it started.
# Needs the reference implementation applied to the repo root first (docs/chat-to-fix/slack/reference/README.md).
#   sh docs/chat-to-fix/slack/reference/slackbot-mock-chain.sh  (from the repository root)
set -u
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
if ! grep -q createFixCommandHandler "$REPO/src/slackBot/mock-slack-bot.js" 2>/dev/null; then
  echo "The mock Slack Bot in $REPO/src/slackBot has no /fix yet: apply the reference first (docs/chat-to-fix/slack/reference/README.md)." >&2
  exit 2
fi
PROJ=$REPO/src/chat-to-fix
cd "$PROJ" && . scripts/dev-env.sh >/dev/null 2>&1
DATA=$PROJ/.data/outbox-demo
rm -rf "$DATA"; mkdir -p "$DATA"; chmod 700 "$DATA"
CH=C-MOCK-FIX
PORT=3190
MOCKSLACK=4101
log() { printf '\n== %s\n' "$*"; }

# 1. mock model
MOCK_LOG=$DATA/mock.jsonl MOCK_REPLY='MOCK-REPLY: the Main bot has read the task.' MOCK_PORT=0 node scripts/mock-llm.ts > "$DATA/mock.out" 2>&1 &
MOCKPID=$!
for i in $(seq 1 50); do MPORT=$(sed -n 's/.*listening on 127\.0\.0\.1:\([0-9]*\).*/\1/p' "$DATA/mock.out" | head -1); [ -n "$MPORT" ] && break; sleep 0.2; done
log "mock model on $MPORT"

# 2. Chat-to-Fix, outbox mode
cat > "$DATA/chat-to-fix.json" <<EOF
{ "dataDir": "$DATA/chat-to-fix", "worktreesDir": "$DATA/chat-to-fix/worktrees", "httpPort": $PORT, "language": "zh",
  "apiModel": "anthropic/claude-sonnet-5-5",
  "adapters": { "slack": "outbox", "jira": "fake", "gitlab": "fake" },
  "bindings": [{ "channel": "$CH", "repo": "group/project", "jiraProject": "DEMO" }] }
EOF
cat > "$DATA/demo.patch.yml" <<EOF
- id: llm-pi-ai
  config:
    providers:
      anthropic:
        apiKeyEnv: CHAT_TO_FIX_MOCK_LLM_KEY
        baseURL: http://127.0.0.1:$MPORT
        models:
          - id: claude-sonnet-5-5
- id: chat-to-fix
  config:
    claudeCommand: $PROJ/scripts/lib/fake-claude.sh
EOF
export CHAT_TO_FIX_DATA=$DATA CHAT_TO_FIX_MOCK_LLM_KEY=mock-not-a-key CHAT_TO_FIX_PASS_ENV=CHAT_TO_FIX_MOCK_LLM_KEY
for n in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do export $n=http://127.0.0.1:$MPORT; done
export NO_PROXY=127.0.0.1,localhost,::1 no_proxy=127.0.0.1,localhost,::1
sh scripts/start-chat-to-fix.sh --patch "$DATA/demo.patch.yml" 2>&1 | tail -1
TOKEN=$(cat "$DATA/http-token")
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy

# 3. mock Slack Bot (repo root), pointed at Chat-to-Fix
cd "$REPO"
MOCK_SLACK_PORT=$MOCKSLACK CHAT_TO_FIX_API_URL=http://127.0.0.1:$PORT CHAT_TO_FIX_API_TOKEN=$TOKEN CHAT_TO_FIX_SLACK_CHANNEL=$CH \
  node src/slackBot/start-mock.js > "$DATA/mock-slack.out" 2>&1 &
SLACKPID=$!
for i in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$MOCKSLACK/ephemerals" && break; sleep 0.2; done
J='Content-Type: application/json'
show() { curl -sS "http://127.0.0.1:$MOCKSLACK/threads/$TS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);for(const m of (t.messages||t.thread||[])) console.log("  ["+(m.user||m.userId||m.bot||"?")+"] "+String(m.text).replace(/\n/g," ").slice(0,140))})'; }

log "/fix 购买按钮拼错了"
OUT=$(curl -sS -X POST "http://127.0.0.1:$MOCKSLACK/fix" -H "$J" -d '{"text":"购买按钮拼错了，Purchse 应该是 Purchase","userId":"U-ALICE","userName":"alice"}')
echo "$OUT" | head -c 400; echo
TS=$(echo "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).threadTs))')
sleep 4
log "task on the Chat-to-Fix side"
curl -sS -H "x-chat-to-fix-token: $TOKEN" "http://127.0.0.1:$PORT/tasks" | head -c 300; echo

log "@ 补充 while the task runs"
curl -sS -X POST "http://127.0.0.1:$MOCKSLACK/mentions" -H "$J" -d "{\"threadTs\":\"$TS\",\"text\":\"补充：是英文界面的商品卡片\",\"userId\":\"U-ALICE\",\"eventId\":\"Ev-1\"}" | head -c 300; echo
log "stop the task"
curl -sS -X POST -H "x-chat-to-fix-token: $TOKEN" "http://127.0.0.1:$PORT/tasks/T-1/stop" | head -c 200; echo
sleep 2
log "@ after the task ended"
curl -sS -X POST "http://127.0.0.1:$MOCKSLACK/mentions" -H "$J" -d "{\"threadTs\":\"$TS\",\"text\":\"还有一个问题\",\"userId\":\"U-ALICE\",\"eventId\":\"Ev-2\"}" | head -c 300; echo
sleep 1
log "relay tick"
curl -sS -X POST "http://127.0.0.1:$MOCKSLACK/relay/tick" | head -c 200; echo
log "outbox on the Chat-to-Fix side"
curl -sS -H "x-chat-to-fix-token: $TOKEN" "http://127.0.0.1:$PORT/outbox" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s).messages) console.log("  #"+m.seq, m.taskId, m.purpose, m.kind??"", "|", m.text)})'
log "follow-ups stored on T-1"
curl -sS -H "x-chat-to-fix-token: $TOKEN" "http://127.0.0.1:$PORT/tasks/T-1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);console.log("  state", t.state, "| followUps", JSON.stringify((t.origin.followUps||[]).map(f=>f.text)))})'
log "mock Slack thread $TS"
show

# 4. stop everything
cd "$PROJ"; CHAT_TO_FIX_DATA=$DATA sh scripts/stop-chat-to-fix.sh 2>&1 | tail -1
kill $SLACKPID $MOCKPID 2>/dev/null
echo done
