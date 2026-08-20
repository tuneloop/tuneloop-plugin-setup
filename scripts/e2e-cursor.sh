#!/bin/bash
# End-to-end exercise of the Cursor capture pipeline, no Cursor needed:
#
#   fixture hook payloads → generated hook script (record, one process per
#   event, exactly as Cursor invokes it) → __flush → capture server →
#   saved bundle → tuneloop-enterprise's cursor adapter parses it.
#
# Usage: scripts/e2e-cursor.sh [path-to-tuneloop-enterprise]
set -euo pipefail
cd "$(dirname "$0")/.."

ENTERPRISE="${1:-$HOME/relvy/git-repos/tuneloop-enterprise}"
FIXTURE="$ENTERPRISE/packages/core/src/adapters/cursor/__fixtures__/probe"
[ -f "$FIXTURE/events.jsonl" ] || { echo "fixture not found at $FIXTURE"; exit 1; }

WORK="$(mktemp -d /tmp/tuneloop-cursor-e2e.XXXXXX)"
PORT=9971
CONV="aaaa1111-1111-1111-1111-111111111111"
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

echo "== build =="
npm run build --silent

echo "== stage a fake Cursor transcript layout (what transcript_path points at) =="
TDIR="$WORK/agent-transcripts/$CONV"
mkdir -p "$TDIR/subagents"
cp "$FIXTURE/transcript.jsonl" "$TDIR/$CONV.jsonl"
cp "$FIXTURE/subagents/"*.jsonl "$TDIR/subagents/"

echo "== bake a hook script pointed at the capture server =="
node dist/cli.js --server "http://localhost:$PORT" --token e2e-token --harness cursor -o "$WORK/tuneloop-cursor.zip" >/dev/null
unzip -q -o "$WORK/tuneloop-cursor.zip" -d "$WORK/plugin"
SCRIPT="$WORK/plugin/bin/tuneloop-cursor-hook.mjs"
[ -f "$SCRIPT" ] || { echo "zip missing bin script"; exit 1; }
# The zip must carry the manifest and a valid hooks config.
node -e "JSON.parse(require('fs').readFileSync('$WORK/plugin/.cursor-plugin/plugin.json'))"
node -e "const h=JSON.parse(require('fs').readFileSync('$WORK/plugin/hooks/hooks.json')); if(h.version!==1||Object.keys(h.hooks).length!==12) throw new Error('bad hooks.json')"

echo "== start capture server =="
PORT=$PORT SAVE_UPLOADS_TO="$WORK/uploads" node test-server.js >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
sleep 0.5

echo "== replay fixture events through the hook script, one process per event =="
export TUNELOOP_CURSOR_SPOOL="$WORK/spool"
# sessionEnd would trigger an immediate detached flush mid-replay; strip the
# trigger by replaying events verbatim and flushing explicitly afterward, so
# the test asserts one deterministic bundle. (transcript_path is injected the
# way live payloads carry it.)
python3 - "$FIXTURE/events.jsonl" "$TDIR/$CONV.jsonl" <<'PY' > "$WORK/replay.jsonl"
import json,sys
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    o=json.loads(line)
    if 'payload' not in o: continue
    o['payload']['transcript_path']=sys.argv[2]
    print(json.dumps(o))
PY
COUNT=0
while IFS= read -r line; do
  EVENT=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).payload.hook_event_name??'unknown')" "$line")
  printf '%s' "$(node -e "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).payload))" "$line")" \
    | node "$SCRIPT" "$EVENT"
  COUNT=$((COUNT+1))
done < "$WORK/replay.jsonl"
echo "   replayed $COUNT events"

SPOOLED=$(find "$WORK/spool" -name '*.json' | wc -l | tr -d ' ')
echo "   spooled $SPOOLED event files across $(find "$WORK/spool" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ') conversations"
[ "$SPOOLED" -eq "$COUNT" ] || { echo "FAIL: spooled $SPOOLED != replayed $COUNT"; exit 1; }

echo "== flush =="
node "$SCRIPT" __flush "$CONV"
sleep 0.5

BUNDLE=$(ls "$WORK/uploads"/bundle-*.json 2>/dev/null | head -1)
[ -n "$BUNDLE" ] || { echo "FAIL: no bundle captured"; cat "$WORK/server.log"; exit 1; }
echo "   bundle captured: $BUNDLE ($(wc -c < "$BUNDLE" | tr -d ' ') bytes)"

echo "== uploader meta carries the account email =="
grep -q '"userEmail": "dev@example.com"' "$WORK/uploads"/meta-*.json || { echo "FAIL: account email missing from meta"; exit 1; }

echo "== compaction: per-event files folded into archive =="
LEFT=$(find "$WORK/spool/$CONV" -name '*.json' -not -name '.*' | wc -l | tr -d ' ')
[ "$LEFT" -eq 0 ] || { echo "FAIL: $LEFT event files left uncompacted"; exit 1; }
[ -f "$WORK/spool/$CONV/archive.jsonl.gz" ] || { echo "FAIL: no archive written"; exit 1; }

echo "== idempotence: unchanged content re-flush must not re-upload =="
node "$SCRIPT" __flush "$CONV"
sleep 0.3
N=$(ls "$WORK/uploads"/bundle-*.json | wc -l | tr -d ' ')
[ "$N" -eq 1 ] || { echo "FAIL: re-flush produced a second upload"; exit 1; }

echo "== resume: NEW content must re-upload (upsert path) =="
printf '%s' '{"hook_event_name":"beforeSubmitPrompt","conversation_id":"'"$CONV"'","generation_id":"44444444-aaaa-4aaa-8aaa-444444444444","prompt":"one more thing","workspace_roots":["/repo"],"user_email":"dev@example.com","transcript_path":"'"$TDIR/$CONV.jsonl"'"}' \
  | node "$SCRIPT" beforeSubmitPrompt
node "$SCRIPT" __flush "$CONV"
sleep 0.3
N=$(ls "$WORK/uploads"/bundle-*.json | wc -l | tr -d ' ')
[ "$N" -eq 2 ] || { echo "FAIL: resumed conversation did not re-upload (got $N bundles)"; exit 1; }
# The second bundle must contain the FULL history (archive + new event).
LAST=$(ls -t "$WORK/uploads"/bundle-*.json | head -1)
node -e "
const b=JSON.parse(require('fs').readFileSync('$LAST','utf8'));
const ev=b.files.find(f=>f.name==='events.jsonl').content;
const n=ev.trim().split('\n').length;
if(n!==29) throw new Error('resumed bundle has '+n+' lines, want 29 (header+27+1 new)');
if(!ev.includes('one more thing')) throw new Error('new prompt missing');
if(!ev.includes('again please')) throw new Error('archived history missing from resumed bundle');
"
echo "   resumed bundle carries full history (29 lines) + the new prompt"

echo "== hand the bundle to the enterprise adapter =="
cd "$ENTERPRISE"
TUNELOOP_E2E_BUNDLE="$BUNDLE" pnpm vitest run packages/core/src/adapters/cursor/e2e.test.ts

echo
echo "E2E PASS — artifacts in $WORK"
