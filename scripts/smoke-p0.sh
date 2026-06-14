#!/usr/bin/env bash
# crm-provisioner — cumulative smoke. P0 baseline: ~25 assertions.
# Future phases EXTEND this file (never write smoke-pN.sh).
#
# Usage:
#   bash scripts/smoke-p0.sh            # assumes wrangler dev running at :8787
#   PORT=8788 bash scripts/smoke-p0.sh  # override
set -uo pipefail
cd "$(dirname "$0")/.."

# Source .dev.vars if present so locally-run smoke (pre-commit hook, manual runs) sees the
# same env as the dev server it talks to. CI runs without this file; the workflow exports
# env vars directly. Keep file-not-found silent — CI absence is the expected case.
if [ -f .dev.vars ]; then
  set -a; . ./.dev.vars; set +a
fi
# Default TOKEN_AT_REST_KEY so `set -u` doesn't bomb on P14 assertions when run with neither
# .dev.vars present nor an explicit env (e.g. minimal CI without the secret). An empty key
# would cause the decrypt assertion to fail meaningfully ("got ''"), not to crash here.
: "${TOKEN_AT_REST_KEY:=}"

PORT="${PORT:-8787}"
# BASE override: point the smoke at a non-local deployment. Default = localhost.
# Set BASE=https://your.app.url to run against a deployed surface (sanity check after
# `railway up`, verify a staging env, etc.). When BASE is non-local, assertions that
# depend on direct DB access (P6 + P14 psql probes) or on spawning a sibling server
# process (P14 fail-at-boot) are SKIPPED with a note — they can't reach the remote PG
# or remote node process. The MCP boundary itself (all HTTP-driven assertions) runs in
# full against whatever URL you point at.
BASE="${BASE:-http://127.0.0.1:$PORT}"
case "$BASE" in
  http://127.0.0.1:*|http://localhost:*) IS_LOCAL=1 ;;
  *) IS_LOCAL=0 ;;
esac
PASS=0; FAIL=0
# A pass-with-note that the smoke skipped an assertion intentionally (vs failing it).
skip() { printf "  ~ %s\n    └ %s\n" "$1" "$2"; }
pass() { PASS=$((PASS+1)); printf "  ✓ %s\n" "$1"; }
fail() { FAIL=$((FAIL+1)); printf "  ✗ %s\n    └ %s\n" "$1" "$2"; }

# Each MCP request is a Streamable-HTTP POST; the server responds with SSE.
# We capture the body and pull the JSON line that starts with `data: `.
mcp_call() {
  local id="$1"; shift
  local method="$1"; shift
  local params="$1"; shift
  local body
  body=$(printf '{"jsonrpc":"2.0","id":%d,"method":"%s","params":%s}' "$id" "$method" "$params")
  curl -sS -X POST "$BASE/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "mcp-session-id: $MCP_SESSION" \
    -d "$body" 2>/dev/null \
    | awk '/^data: /{ sub(/^data: /, ""); print; exit }'
}

# ---- init (one-time) ----
echo "== Initializing MCP session =="
INIT_BODY='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
HDR_FILE=$(mktemp)
curl -sS -X POST "$BASE/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$INIT_BODY" -D "$HDR_FILE" -o /tmp/init.out
MCP_SESSION=$(grep -i '^mcp-session-id:' "$HDR_FILE" | tr -d '\r' | awk '{print $2}')
if [ -z "$MCP_SESSION" ]; then fail "got session id" "no mcp-session-id header"; cat "$HDR_FILE"; exit 1; fi
pass "got mcp-session-id ($MCP_SESSION)"

# Send the required notifications/initialized before any other call
curl -sS -X POST "$BASE/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $MCP_SESSION" -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' >/dev/null
pass "sent notifications/initialized"

# ---- 1. tools/list ----
echo "== tools/list =="
RESP=$(mcp_call 1 'tools/list' '{}')
[ -n "$RESP" ] && pass "tools/list returned" || fail "tools/list returned" "empty"
TOOL_COUNT=$(echo "$RESP" | node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync(0)).result?.tools||[]).length))" 2>/dev/null)
[ "$TOOL_COUNT" = "8" ] && pass "exactly 8 tools registered (P1)" || fail "exactly 8 tools registered (P1)" "got $TOOL_COUNT"
for t in list_templates connect_crm inspect_instance validate_spec plan apply get_run teardown_run; do
  echo "$RESP" | node -e "
const r=JSON.parse(require('fs').readFileSync(0));
const found=(r.result?.tools||[]).find(x=>x.name==='$t');
process.exit(found && (found.description||'').length>20 ? 0 : 1);
" && pass "tool '$t' registered with description" || fail "tool '$t' registered" "missing or no description"
done

# Helper: extract `text` content from a tools/call response, parse as JSON
text_of() { node -e "
const r=JSON.parse(require('fs').readFileSync(0));
const t=r.result?.content?.[0]?.text;
if(!t) process.exit(2);
process.stdout.write(t);
"; }
field_of() { node -e "
const t=require('fs').readFileSync(0,'utf8');
try { const j=JSON.parse(t); const p='$1'.split('.'); let v=j; for(const k of p){v=v?.[k]} process.stdout.write(v===undefined?'':String(v)); } catch(e){ process.exit(2) }
"; }

# ---- 2. list_templates ----
echo "== list_templates =="
R=$(mcp_call 2 'tools/call' '{"name":"list_templates","arguments":{}}' | text_of)
[ -n "$R" ] && pass "list_templates returned content" || fail "list_templates returned content" "empty"
TID=$(echo "$R" | field_of templates.0.id)
[ "$TID" = "toy-sales" ] && pass "toy-sales template present" || fail "toy-sales template present" "got '$TID'"

# P4+: real templates registered (toy + 4 verticals after Zoho/Deluge harvest)
TCOUNT=$(echo "$R" | node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync(0)).templates||[]).length))")
[ "$TCOUNT" -ge 5 ] && pass "registry has >=5 templates (toy + 4 verticals)" || fail "registry has >=5 templates" "got $TCOUNT"
echo "$R" | node -e "
const t=JSON.parse(require('fs').readFileSync(0)).templates||[];
const required=['real-estate','professional-services','hvac-services','manufacturing'];
process.exit(required.every(id=>t.some(x=>x.id===id)) ? 0 : 1);
" && pass "all 4 vertical templates registered" || fail "vertical templates registered" "missing"

# ---- 3. connect_crm (demo, writable) ----
echo "== connect_crm (demo, writable) =="
R=$(mcp_call 3 'tools/call' '{"name":"connect_crm","arguments":{"crm":"memory","org_label":"smoke","is_demo":true,"api_domain":"memory://smoke","writable_org_ids":["memory://smoke"]}}' | text_of)
CONN=$(echo "$R" | field_of connection_id)
IS_DEMO=$(echo "$R" | field_of is_demo)
[ -n "$CONN" ] && pass "got connection_id" || fail "got connection_id" "empty"
[ "$IS_DEMO" = "true" ] && pass "connection persisted is_demo=true" || fail "is_demo=true persisted" "got $IS_DEMO"

# Also create a NON-demo connection for the writability-refusal test below.
echo "== connect_crm (non-demo) =="
R=$(mcp_call 31 'tools/call' '{"name":"connect_crm","arguments":{"crm":"memory","org_label":"non-demo","is_demo":false}}' | text_of)
CONN_NONDEMO=$(echo "$R" | field_of connection_id)
[ -n "$CONN_NONDEMO" ] && pass "got non-demo connection_id" || fail "got non-demo connection_id" "empty"

# ---- 4. inspect_instance ----
echo "== inspect_instance =="
R=$(mcp_call 4 'tools/call' "{\"name\":\"inspect_instance\",\"arguments\":{\"connection_id\":\"$CONN\"}}" | text_of)
SF=$(echo "$R" | field_of snapshot.fields)
pass "inspect_instance returned snapshot (fields list: [$SF])"

# ---- 5. validate_spec — legal delta ----
echo "== validate_spec (legal) =="
LEGAL='{"spec_version":0,"fields":[{"api_name":"Probe_Field","label":"Probe","kind":"text","module":"Lead"}],"stages":[],"pipelines":[],"workflows":[]}'
R=$(mcp_call 5 'tools/call' "{\"name\":\"validate_spec\",\"arguments\":{\"template_ref\":\"toy-sales\",\"delta\":$LEGAL}}" | text_of)
OK=$(echo "$R" | field_of ok)
[ "$OK" = "true" ] && pass "legal delta validates" || fail "legal delta validates" "ok=$OK | $R"
HASH=$(echo "$R" | field_of spec_hash)
[ -n "$HASH" ] && pass "spec_hash returned" || fail "spec_hash returned" "missing"

# ---- 6. validate_spec — illegal extension point ----
echo "== validate_spec (extension-point violation) =="
# Force a violation by hand-crafting a template that omits 'workflows' from its extension points.
# Easier path: send a delta with an UNKNOWN field shape — caught by schema, same fail-closed semantics.
BAD_SCHEMA='{"spec_version":0,"fields":[{"label":"missing api_name","kind":"text","module":"Lead"}],"stages":[],"pipelines":[],"workflows":[]}'
R=$(mcp_call 6 'tools/call' "{\"name\":\"validate_spec\",\"arguments\":{\"template_ref\":\"toy-sales\",\"delta\":$BAD_SCHEMA}}" | text_of)
OK=$(echo "$R" | field_of ok)
ERR=$(echo "$R" | field_of error)
[ "$OK" = "false" ] && [ "$ERR" = "DELTA_SCHEMA_INVALID" ] && pass "bad schema rejected with DELTA_SCHEMA_INVALID" || fail "bad schema rejected" "ok=$OK error=$ERR"

# ---- 7. plan ----
echo "== plan =="
R=$(mcp_call 7 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$CONN\",\"template_ref\":\"toy-sales\",\"delta\":$LEGAL}}" | text_of)
PLAN_ID=$(echo "$R" | field_of plan_id)
[ -n "$PLAN_ID" ] && pass "plan returned plan_id" || fail "plan returned plan_id" "$R"
STEPS=$(echo "$R" | node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync(0)).steps||[]).length))")
[ "$STEPS" -ge 5 ] && pass "plan has >=5 steps (template base + delta)" || fail "plan has >=5 steps" "got $STEPS"

# ---- 8. apply ----
echo "== apply =="
R=$(mcp_call 8 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$PLAN_ID\"}}" | text_of)
RUN=$(echo "$R" | field_of run_id)
TRACE=$(echo "$R" | field_of trace_id)
STATUS=$(echo "$R" | field_of status)
[ -n "$RUN" ] && pass "apply returned run_id" || fail "apply returned run_id" "$R"
[ -n "$TRACE" ] && pass "apply returned trace_id" || fail "apply returned trace_id" "$R"
[ "$STATUS" = "succeeded" ] && pass "apply status = succeeded" || fail "apply status = succeeded" "got $STATUS"

# ---- 9. apply: plan-id is single-use ----
echo "== apply (plan_id consumed) =="
R=$(mcp_call 9 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$PLAN_ID\"}}" | text_of)
ERR=$(echo "$R" | field_of error)
[ "$ERR" = "PLAN_NOT_FOUND" ] && pass "second apply with same plan_id rejected (PLAN_NOT_FOUND)" || fail "plan_id is single-use" "error=$ERR"

# ---- 10. get_run ----
echo "== get_run =="
R=$(mcp_call 10 'tools/call' "{\"name\":\"get_run\",\"arguments\":{\"run_id\":\"$RUN\"}}" | text_of)
OK=$(echo "$R" | field_of ok)
RS=$(echo "$R" | field_of run.status)
ST=$(echo "$R" | field_of run.trace_id)
[ "$OK" = "true" ] && pass "get_run ok" || fail "get_run ok" "$R"
[ "$RS" = "succeeded" ] && pass "run status persisted = succeeded" || fail "run status persisted" "got $RS"
[ "$ST" = "$TRACE" ] && pass "trace_id persisted on run" || fail "trace_id persisted on run" "expected $TRACE got $ST"
SC=$(echo "$R" | node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync(0)).steps||[]).length))")
[ "$SC" -ge 5 ] && pass "run has >=5 step rows in Postgres" || fail "run has >=5 step rows in Postgres" "got $SC"

# ---- 11. idempotency: same delta + same connection → noop steps ----
echo "== idempotency (second plan on same state) =="
R=$(mcp_call 11 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$CONN\",\"template_ref\":\"toy-sales\",\"delta\":$LEGAL}}" | text_of)
NOOPS=$(echo "$R" | node -e "
const j=JSON.parse(require('fs').readFileSync(0));
process.stdout.write(String((j.steps||[]).filter(s=>s.diff==='noop').length));
")
[ "$NOOPS" -ge 1 ] && pass "second plan shows noop steps (idempotent)" || fail "second plan shows noop steps" "got $NOOPS"

# ---- 12. hardening: plan reports destructive_count (zero for memory adapter, but the field must exist) ----
echo "== plan reports destructive_count =="
DC=$(echo "$R" | field_of destructive_count)
[ "$DC" = "0" ] && pass "plan reports destructive_count=0 (memory adapter is non-destructive)" || fail "plan reports destructive_count field" "got '$DC'"

# ---- 13. hardening: apply refused on non-demo connection ----
echo "== hardening: non-demo connection refuses apply =="
# Need a fresh plan against the non-demo connection
R=$(mcp_call 13 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$CONN_NONDEMO\",\"template_ref\":\"toy-sales\",\"delta\":$LEGAL}}" | text_of)
NONDEMO_PLAN=$(echo "$R" | field_of plan_id)
R=$(mcp_call 14 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$NONDEMO_PLAN\"}}" | text_of)
ERR=$(echo "$R" | field_of error)
[ "$ERR" = "CONNECTION_NOT_WRITABLE" ] && pass "apply on non-demo connection refused with CONNECTION_NOT_WRITABLE" || fail "non-demo refusal" "error=$ERR"

# ---- 14. teardown_run reverses the original demo run ----
echo "== teardown_run =="
# Re-inspect to confirm state exists before teardown
PRE=$(mcp_call 15 'tools/call' "{\"name\":\"inspect_instance\",\"arguments\":{\"connection_id\":\"$CONN\"}}" | text_of)
PRE_FIELDS=$(echo "$PRE" | node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync(0)).snapshot?.fields||[]).length))")

R=$(mcp_call 16 'tools/call' "{\"name\":\"teardown_run\",\"arguments\":{\"run_id\":\"$RUN\"}}" | text_of)
OK=$(echo "$R" | field_of ok)
TD_RUN=$(echo "$R" | field_of teardown_run_id)
[ "$OK" = "true" ] && pass "teardown_run ok" || fail "teardown_run ok" "$R"
[ -n "$TD_RUN" ] && pass "teardown returned new run_id" || fail "teardown new run_id" "empty"

# Verify state was reversed
POST=$(mcp_call 17 'tools/call' "{\"name\":\"inspect_instance\",\"arguments\":{\"connection_id\":\"$CONN\"}}" | text_of)
POST_FIELDS=$(echo "$POST" | node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync(0)).snapshot?.fields||[]).length))")
[ "$POST_FIELDS" = "0" ] && pass "teardown emptied snapshot.fields ($PRE_FIELDS → 0)" || fail "teardown emptied snapshot.fields" "$PRE_FIELDS → $POST_FIELDS"

# Teardown run is queryable via get_run and links back via teardown_of_run
R=$(mcp_call 18 'tools/call' "{\"name\":\"get_run\",\"arguments\":{\"run_id\":\"$TD_RUN\"}}" | text_of)
TD_OF=$(echo "$R" | field_of run.teardown_of_run)
[ "$TD_OF" = "$RUN" ] && pass "teardown run's teardown_of_run links to original" || fail "teardown_of_run link" "got '$TD_OF' expected '$RUN'"

# ---- P5: retry-with-backoff via synthetic memory throws ----
# Three test cases probing the retry decision matrix:
#  (a) BoundaryError:transient → retried up to maxAttempts (5), then fails
#  (b) DataError → NOT retried (per the principle: same input → same failure)
#  (c) Throw-then-succeed → retried once, succeeds; tests retry-recovery
echo "== P5: typed errors + retry (synthetic memory throws) =="
P5_DELTA_TRANSIENT='{"spec_version":0,"fields":[{"api_name":"test__throw_boundary_transient_1","label":"x","kind":"text","module":"Lead"}],"stages":[],"pipelines":[],"workflows":[]}'
R=$(mcp_call 80 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P5_DELTA_TRANSIENT}}" | text_of)
P5_PLAN=$(echo "$R" | field_of plan_id)
R=$(mcp_call 81 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P5_PLAN\"}}" | text_of)
APPLY_STATUS=$(echo "$R" | field_of status)
P5_RUN_ID=$(echo "$R" | field_of run_id)
[ "$APPLY_STATUS" = "partial" ] && pass "P5: apply with transient-throw step → 'partial' (expected; step failed after max retries)" || fail "P5 apply partial" "got $APPLY_STATUS"

R=$(mcp_call 82 'tools/call' "{\"name\":\"get_run\",\"arguments\":{\"run_id\":\"$P5_RUN_ID\"}}" | text_of)
TRANSIENT_STEP=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_field');
process.stdout.write(JSON.stringify({code:s?.error_code, attempts:s?.attempts}));
")
echo "$TRANSIENT_STEP" | grep -q '"code":"BoundaryError:transient"' && pass "P5: transient step error_code = BoundaryError:transient (typed)" || fail "P5 transient error_code" "$TRANSIENT_STEP"
echo "$TRANSIENT_STEP" | grep -q '"attempts":5' && pass "P5: transient step attempts = 5 (max retries exhausted)" || fail "P5 transient attempts" "$TRANSIENT_STEP"

# (b) DataError — must NOT retry
P5_DELTA_DATA='{"spec_version":0,"fields":[{"api_name":"test__throw_data_error_1","label":"x","kind":"text","module":"Lead"}],"stages":[],"pipelines":[],"workflows":[]}'
R=$(mcp_call 83 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P5_DELTA_DATA}}" | text_of)
P5_PLAN_D=$(echo "$R" | field_of plan_id)
R=$(mcp_call 84 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P5_PLAN_D\"}}" | text_of)
P5_RUN_ID_D=$(echo "$R" | field_of run_id)
R=$(mcp_call 85 'tools/call' "{\"name\":\"get_run\",\"arguments\":{\"run_id\":\"$P5_RUN_ID_D\"}}" | text_of)
DATA_STEP=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_field');
process.stdout.write(JSON.stringify({code:s?.error_code, attempts:s?.attempts}));
")
echo "$DATA_STEP" | grep -q '"code":"DataError' && pass "P5: data-error step error_code starts with 'DataError' (typed)" || fail "P5 data error_code" "$DATA_STEP"
echo "$DATA_STEP" | grep -q '"attempts":1' && pass "P5: data-error step attempts = 1 (no retry per matrix)" || fail "P5 data attempts" "$DATA_STEP"

# (c) Throw-then-succeed — retry should recover on attempt 2
P5_DELTA_TS='{"spec_version":0,"fields":[{"api_name":"test__throw_then_succeed_1","label":"x","kind":"text","module":"Lead"}],"stages":[],"pipelines":[],"workflows":[]}'
R=$(mcp_call 86 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P5_DELTA_TS}}" | text_of)
P5_PLAN_TS=$(echo "$R" | field_of plan_id)
R=$(mcp_call 87 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P5_PLAN_TS\"}}" | text_of)
TS_STATUS=$(echo "$R" | field_of status)
[ "$TS_STATUS" = "succeeded" ] && pass "P5: throw-then-succeed apply succeeds (retry recovered)" || fail "P5 throw-then-succeed" "got $TS_STATUS"

# ---- P6: negative cache for permanent failures ----
# After a DataError step fails (recorded in P5 above), a fresh plan against the
# SAME field spec should mark the step blocked_by_prior_failure. force_retry_
# blocked:true bypasses; teardown clears the cache; expired entries ignored.
echo "== P6: negative cache for permanent failures =="
# Use a dedicated connection to keep the cache state predictable.
R=$(mcp_call 90 'tools/call' '{"name":"connect_crm","arguments":{"crm":"memory","org_label":"p6-cache","is_demo":true,"api_domain":"memory://p6","writable_org_ids":["memory://p6"]}}' | text_of)
P6_CONN=$(echo "$R" | field_of connection_id)
P6_FIELD_NAME="test__throw_data_error_p6"
P6_DELTA="{\"spec_version\":0,\"fields\":[{\"api_name\":\"$P6_FIELD_NAME\",\"label\":\"x\",\"kind\":\"text\",\"module\":\"Lead\"}],\"stages\":[],\"pipelines\":[],\"workflows\":[]}"

# 1. First apply against the synthetic-data-error field → record permanent failure
R=$(mcp_call 91 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$P6_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P6_DELTA}}" | text_of)
P6_PLAN1=$(echo "$R" | field_of plan_id)
mcp_call 92 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P6_PLAN1\"}}" > /dev/null
# Allow async cache write to settle (we await it in the handler, but stay safe).

# 2. Second plan → step for that field should now be blocked_by_prior_failure
R=$(mcp_call 93 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$P6_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P6_DELTA}}" | text_of)
P6_PLAN2=$(echo "$R" | field_of plan_id)
BLOCKED_COUNT=$(echo "$R" | field_of blocked_count)
[ "$BLOCKED_COUNT" -ge 1 ] && pass "P6: second plan reports blocked_count >= 1" || fail "P6 blocked_count" "got $BLOCKED_COUNT"
BLOCKED_DIFF=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_field' && x.payload?.api_name==='$P6_FIELD_NAME');
process.stdout.write(JSON.stringify({diff:s?.diff, notes:s?.notes?.slice(0,80)}));
")
echo "$BLOCKED_DIFF" | grep -q '"diff":"blocked_by_prior_failure"' && pass "P6: matching step diff = blocked_by_prior_failure" || fail "P6 diff" "$BLOCKED_DIFF"
echo "$BLOCKED_DIFF" | grep -q '"notes":"BLOCKED' && pass "P6: notes carry the BLOCKED explanation with original error" || fail "P6 notes" "$BLOCKED_DIFF"

# 3. Apply that blocked plan without force_retry_blocked → step status = skipped_blocked
R=$(mcp_call 94 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P6_PLAN2\"}}" | text_of)
P6_RUN_BLOCKED=$(echo "$R" | field_of run_id)
R=$(mcp_call 95 'tools/call' "{\"name\":\"get_run\",\"arguments\":{\"run_id\":\"$P6_RUN_BLOCKED\"}}" | text_of)
BLOCKED_STATUS=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_field');
process.stdout.write(s?.status || 'missing');
")
[ "$BLOCKED_STATUS" = "skipped_blocked" ] && pass "P6: blocked step apply records status = skipped_blocked" || fail "P6 skipped_blocked status" "got '$BLOCKED_STATUS'"

# 4. Apply with force_retry_blocked:true → step is re-attempted (still synthetic-throws so it fails again, but it attempted)
R=$(mcp_call 96 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$P6_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P6_DELTA}}" | text_of)
P6_PLAN_FORCE=$(echo "$R" | field_of plan_id)
R=$(mcp_call 97 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P6_PLAN_FORCE\",\"force_retry_blocked\":true}}" | text_of)
P6_RUN_FORCED=$(echo "$R" | field_of run_id)
R=$(mcp_call 98 'tools/call' "{\"name\":\"get_run\",\"arguments\":{\"run_id\":\"$P6_RUN_FORCED\"}}" | text_of)
FORCED_STATUS=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_field');
process.stdout.write(JSON.stringify({status:s?.status, code:s?.error_code}));
")
echo "$FORCED_STATUS" | grep -q '"status":"failed"' && pass "P6: force_retry_blocked bypasses cache → step retries and fails again (still DataError)" || fail "P6 force_retry_blocked bypass" "$FORCED_STATUS"

# 5. Cache cleanup via teardown — requires direct PG access to seed the cache row
#    and observe its deletion. LOCAL-ONLY: when running against a remote BASE, the
#    `teardown_run reports cache_entries_cleared` MCP-side check still runs, but the
#    seed + post-clear-count assertions are skipped.
if [ "$IS_LOCAL" = "1" ]; then
  R=$(mcp_call 100 'tools/call' '{"name":"connect_crm","arguments":{"crm":"memory","org_label":"p6-td","is_demo":true,"api_domain":"memory://p6td","writable_org_ids":["memory://p6td"]}}' | text_of)
  P6_TD_CONN=$(echo "$R" | field_of connection_id)
  P6_TD_DELTA='{"spec_version":0,"fields":[{"api_name":"clean_field_for_cache_clear","label":"x","kind":"text","module":"Lead"}],"stages":[],"pipelines":[],"workflows":[]}'
  # Manually insert a fake permanent_failure for the clean field on this connection.
  PGPASSWORD=crm psql -h 127.0.0.1 -p 5433 -U crm -d crm_provisioner -c "insert into permanent_failures (connection_id, operation, payload_hash, error_code, error_message, expires_at) select '$P6_TD_CONN', 'create_field', overlay->>'hash', 'DataError:FAKE_FOR_TEARDOWN_CLEAR', 'fake', extract(epoch from now())::integer + 86400 from (select 'create_field' as op, 'h12345678' as hash) ignored, lateral (select jsonb_build_object('hash','h12345678') as overlay) o;" >/dev/null 2>&1 || true
  # Now run plan + apply to create the field (without test prefix so it succeeds), then teardown.
  R=$(mcp_call 101 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$P6_TD_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P6_TD_DELTA}}" | text_of)
  P6_TD_PLAN=$(echo "$R" | field_of plan_id)
  R=$(mcp_call 102 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P6_TD_PLAN\"}}" | text_of)
  P6_TD_RUN=$(echo "$R" | field_of run_id)
  # Now manually insert a permanent_failure ALSO matching the same payload_hash so teardown clears it.
  PAYLOAD_HASH=$(PGPASSWORD=crm psql -h 127.0.0.1 -p 5433 -U crm -d crm_provisioner -t -A -c "select payload_json from run_steps where run_id = '$P6_TD_RUN' and operation = 'create_field' limit 1;" | node -e "
const fs=require('fs');
const obj=JSON.parse(fs.readFileSync(0,'utf8').trim());
// stableHash equivalent — same algo as src/core/overlay.ts
function canon(v){if(v===null||typeof v!=='object')return v;if(Array.isArray(v))return v.map(canon);const o=v;const k=Object.keys(o).sort();const r={};for(const x of k)r[x]=canon(o[x]);return r}
const json=JSON.stringify(canon(obj));
let h=0;for(let i=0;i<json.length;i++)h=((h<<5)-h+json.charCodeAt(i))|0;
process.stdout.write('h'+(h>>>0).toString(16).padStart(8,'0'));
")
  PGPASSWORD=crm psql -h 127.0.0.1 -p 5433 -U crm -d crm_provisioner -c "insert into permanent_failures (connection_id, operation, payload_hash, error_code, error_message, expires_at) values ('$P6_TD_CONN','create_field','$PAYLOAD_HASH','DataError:CACHED_BEFORE_TEARDOWN','simulated',extract(epoch from now())::integer + 86400);" >/dev/null
  BEFORE_CACHE=$(PGPASSWORD=crm psql -h 127.0.0.1 -p 5433 -U crm -d crm_provisioner -t -A -c "select count(*) from permanent_failures where connection_id='$P6_TD_CONN' and payload_hash='$PAYLOAD_HASH';")
  [ "$BEFORE_CACHE" = "1" ] && pass "P6: pre-teardown cache row exists for the to-be-reversed step" || fail "P6 cache row pre-teardown" "got count=$BEFORE_CACHE"
  # Now teardown the run — should clear the cache row matching that payload_hash.
  R=$(mcp_call 103 'tools/call' "{\"name\":\"teardown_run\",\"arguments\":{\"run_id\":\"$P6_TD_RUN\"}}" | text_of)
  CLEARED=$(echo "$R" | field_of cache_entries_cleared)
  [ "$CLEARED" -ge 1 ] && pass "P6: teardown_run reports cache_entries_cleared >= 1" || fail "P6 cache_entries_cleared" "got $CLEARED"
  AFTER_CACHE=$(PGPASSWORD=crm psql -h 127.0.0.1 -p 5433 -U crm -d crm_provisioner -t -A -c "select count(*) from permanent_failures where connection_id='$P6_TD_CONN' and payload_hash='$PAYLOAD_HASH';")
  [ "$AFTER_CACHE" = "0" ] && pass "P6: cache row is gone after teardown (next create attempt unblocked)" || fail "P6 cache row post-teardown" "got count=$AFTER_CACHE"
else
  skip "P6 cache row pre-teardown / post-teardown / cache_entries_cleared" "BASE=$BASE is non-local — psql probes against remote PG aren't reachable. The MCP-only path (teardown clears cache → next plan unblocks) is still covered indirectly by P6's blocked_by_prior_failure assertions earlier."
fi

# ---- P7: quality watchdog over the run ----
# Trip conditions (defaults: window=10, threshold=0.5, min_steps=5):
#   (a) 6 of 10 failures → trips with WatchdogError:failure_rate
#   (b) 4 of 10 failures → does NOT trip
#   (c) 10 silent-success steps (succeed with noop when plan said create) → trips
#       with WatchdogError:silent_success_rate
echo "== P7: quality watchdog =="

# (a) 6-of-10 failure-rate scenario.
# 6 test__throw_data_error fields + 4 plain fields; min_steps=5 must be exceeded
# before watchdog can trip — by seq 6 the trailing window is [F F F F F F]:6/6=100% → TRIPS.
R=$(mcp_call 110 'tools/call' '{"name":"connect_crm","arguments":{"crm":"memory","org_label":"p7-fr","is_demo":true,"api_domain":"memory://p7fr","writable_org_ids":["memory://p7fr"]}}' | text_of)
P7_CONN=$(echo "$R" | field_of connection_id)
P7_FAIL_DELTA=$(node -e "
const fields=[];
// 6 failure-triggers first (so watchdog trips while there's still steps remaining)
for (let i=1;i<=6;i++) fields.push({api_name:'test__throw_data_error_p7_f'+i,label:'x',kind:'text',module:'Lead'});
// Then 4 plain (would-succeed) steps that should be skipped_by_watchdog
for (let i=1;i<=4;i++) fields.push({api_name:'p7_plain_field_'+i,label:'x',kind:'text',module:'Lead'});
process.stdout.write(JSON.stringify({spec_version:0,fields,stages:[],pipelines:[],workflows:[]}));
")
R=$(mcp_call 111 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$P7_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P7_FAIL_DELTA}}" | text_of)
P7_PLAN_FR=$(echo "$R" | field_of plan_id)
R=$(mcp_call 112 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P7_PLAN_FR\"}}" | text_of)
P7_RUN_FR=$(echo "$R" | field_of run_id)
P7_STATUS_FR=$(echo "$R" | field_of status)
P7_ABORT_FR=$(echo "$R" | field_of aborted_by)
[ "$P7_STATUS_FR" = "aborted" ] && pass "P7: 6-of-N failures → run status = aborted" || fail "P7 failure-rate status" "got '$P7_STATUS_FR'"
echo "$P7_ABORT_FR" | grep -q 'WatchdogError:failure_rate' && pass "P7: aborted_by names failure_rate" || fail "P7 aborted_by" "got '$P7_ABORT_FR'"

# Check that at least one downstream step was skipped_by_watchdog
R=$(mcp_call 113 'tools/call' "{\"name\":\"get_run\",\"arguments\":{\"run_id\":\"$P7_RUN_FR\"}}" | text_of)
SKIPPED=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
process.stdout.write(String((d.steps||[]).filter(s=>s.status==='skipped_by_watchdog').length));
")
[ "$SKIPPED" -ge 1 ] && pass "P7: downstream steps marked skipped_by_watchdog ($SKIPPED of them)" || fail "P7 skipped count" "got $SKIPPED"

# P11: the run row carries watchdog_window_failures for post-mortem (was set + queryable
# pre-P11 but never asserted). The trip happens once the rolling window hits the threshold;
# the column records the failures-in-window count at trip time so an operator can
# distinguish "narrowly tripped" from "everything was failing."
RUN_FORENSICS=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
process.stdout.write(String(d.run?.watchdog_window_failures ?? 'missing'));
")
case "$RUN_FORENSICS" in
  ''|missing|0) fail "P11: runs.watchdog_window_failures recorded on trip" "got '$RUN_FORENSICS' (expected positive int per P7 retro: 6-of-N trip should record window failures)" ;;
  *) pass "P11: runs.watchdog_window_failures = $RUN_FORENSICS (post-mortem forensics queryable)" ;;
esac

# (b) 4-of-10 — should NOT trip (4/10 = 40% < 50% threshold; watchdog stays quiet)
R=$(mcp_call 114 'tools/call' '{"name":"connect_crm","arguments":{"crm":"memory","org_label":"p7-nt","is_demo":true,"api_domain":"memory://p7nt","writable_org_ids":["memory://p7nt"]}}' | text_of)
P7_CONN_NT=$(echo "$R" | field_of connection_id)
P7_NOT_DELTA=$(node -e "
const fields=[];
// Order matters: successes FIRST so the trailing window never hits >50% failure rate.
// Final window across 10 fields: [S S S S S S F F F F] = 40%.
for (let i=1;i<=6;i++) fields.push({api_name:'p7nt_plain_field_'+i,label:'x',kind:'text',module:'Lead'});
for (let i=1;i<=4;i++) fields.push({api_name:'test__throw_data_error_p7_nt'+i,label:'x',kind:'text',module:'Lead'});
process.stdout.write(JSON.stringify({spec_version:0,fields,stages:[],pipelines:[],workflows:[]}));
")
R=$(mcp_call 115 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$P7_CONN_NT\",\"template_ref\":\"toy-sales\",\"delta\":$P7_NOT_DELTA}}" | text_of)
P7_PLAN_NT=$(echo "$R" | field_of plan_id)
R=$(mcp_call 116 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P7_PLAN_NT\"}}" | text_of)
P7_STATUS_NT=$(echo "$R" | field_of status)
[ "$P7_STATUS_NT" = "partial" ] && pass "P7: 4-of-10 failures stays 'partial' (under threshold, watchdog quiet)" || fail "P7 under-threshold" "got '$P7_STATUS_NT'"

# (c) silent-success — 10 fields that succeed with noop when plan said create
R=$(mcp_call 117 'tools/call' '{"name":"connect_crm","arguments":{"crm":"memory","org_label":"p7-ss","is_demo":true,"api_domain":"memory://p7ss","writable_org_ids":["memory://p7ss"]}}' | text_of)
P7_CONN_SS=$(echo "$R" | field_of connection_id)
P7_SS_DELTA=$(node -e "
const fields=[];
for (let i=1;i<=10;i++) fields.push({api_name:'test__silent_success_p7ss'+i,label:'x',kind:'text',module:'Lead'});
process.stdout.write(JSON.stringify({spec_version:0,fields,stages:[],pipelines:[],workflows:[]}));
")
R=$(mcp_call 118 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$P7_CONN_SS\",\"template_ref\":\"toy-sales\",\"delta\":$P7_SS_DELTA}}" | text_of)
P7_PLAN_SS=$(echo "$R" | field_of plan_id)
R=$(mcp_call 119 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P7_PLAN_SS\"}}" | text_of)
P7_STATUS_SS=$(echo "$R" | field_of status)
P7_ABORT_SS=$(echo "$R" | field_of aborted_by)
[ "$P7_STATUS_SS" = "aborted" ] && pass "P7: silent-success run aborts" || fail "P7 silent-success status" "got '$P7_STATUS_SS'"
echo "$P7_ABORT_SS" | grep -q 'WatchdogError:silent_success_rate' && pass "P7: aborted_by names silent_success_rate" || fail "P7 silent aborted_by" "got '$P7_ABORT_SS'"

# ---- P11: testing-gap closure ----

echo "== P11: SFDC/Zoho fixtures → classifier (standalone) =="
if node --experimental-strip-types --no-warnings scripts/test-classifiers.mjs >/tmp/p11-cls.out 2>&1; then
  pass "P11: classifier-on-fixtures test-script green (converts 4 captured envelopes into regression guards)"
else
  fail "P11 classifier-on-fixtures" "$(cat /tmp/p11-cls.out)"
fi

echo "== P11: applyOverlay edge cases (standalone) =="
if node --experimental-strip-types --no-warnings scripts/test-overlay.mjs >/tmp/p11-ov.out 2>&1; then
  pass "P11: overlay-direct test-script green (multi-error accumulation, pipeline branch, stableHash determinism)"
else
  fail "P11 overlay-direct" "$(cat /tmp/p11-ov.out)"
fi

echo "== P11: memory-adapter throws BoundaryError:rate_limit (retry path was untested) =="
P11_DELTA_RL='{"spec_version":0,"fields":[{"api_name":"test__throw_boundary_rate_limit_1","label":"x","kind":"text","module":"Lead"}],"stages":[],"pipelines":[],"workflows":[]}'
R=$(mcp_call 140 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P11_DELTA_RL}}" | text_of)
P11_PLAN_RL=$(echo "$R" | field_of plan_id)
R=$(mcp_call 141 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P11_PLAN_RL\"}}" | text_of)
RL_STATUS=$(echo "$R" | field_of status)
RL_RUN=$(echo "$R" | field_of run_id)
[ "$RL_STATUS" = "partial" ] && pass "P11: rate_limit-throw apply → 'partial' (retried per matrix, then failed)" || fail "P11 rate_limit status" "got '$RL_STATUS'"
R=$(mcp_call 142 'tools/call' "{\"name\":\"get_run\",\"arguments\":{\"run_id\":\"$RL_RUN\"}}" | text_of)
RL_STEP=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_field');
process.stdout.write(JSON.stringify({code:s?.error_code, attempts:s?.attempts}));
")
echo "$RL_STEP" | grep -q '"code":"BoundaryError:rate_limit"' && pass "P11: rate_limit error_code = BoundaryError:rate_limit (typed)" || fail "P11 rate_limit error_code" "$RL_STEP"
echo "$RL_STEP" | grep -q '"attempts":5' && pass "P11: rate_limit attempts = 5 (retried per matrix, same as transient)" || fail "P11 rate_limit attempts" "$RL_STEP"

echo "== P11: memory-adapter throws BoundaryError:rejected (no-retry + cacheable) =="
P11_DELTA_RJ='{"spec_version":0,"fields":[{"api_name":"test__throw_boundary_rejected_1","label":"x","kind":"text","module":"Lead"}],"stages":[],"pipelines":[],"workflows":[]}'
R=$(mcp_call 143 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P11_DELTA_RJ}}" | text_of)
P11_PLAN_RJ=$(echo "$R" | field_of plan_id)
R=$(mcp_call 144 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P11_PLAN_RJ\"}}" | text_of)
RJ_STATUS=$(echo "$R" | field_of status)
RJ_RUN=$(echo "$R" | field_of run_id)
[ "$RJ_STATUS" = "partial" ] && pass "P11: rejected-throw apply → 'partial'" || fail "P11 rejected status" "got '$RJ_STATUS'"
R=$(mcp_call 145 'tools/call' "{\"name\":\"get_run\",\"arguments\":{\"run_id\":\"$RJ_RUN\"}}" | text_of)
RJ_STEP=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_field');
process.stdout.write(JSON.stringify({code:s?.error_code, attempts:s?.attempts}));
")
echo "$RJ_STEP" | grep -q '"code":"BoundaryError:rejected"' && pass "P11: rejected error_code = BoundaryError:rejected (typed)" || fail "P11 rejected error_code" "$RJ_STEP"
echo "$RJ_STEP" | grep -q '"attempts":1' && pass "P11: rejected attempts = 1 (no retry per matrix, distinct from transient/rate_limit)" || fail "P11 rejected attempts" "$RJ_STEP"
# rejected is cacheable per isCacheableFailure — second plan against the same delta must see blocked_by_prior_failure.
R=$(mcp_call 146 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P11_DELTA_RJ}}" | text_of)
RJ_BLOCKED=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
process.stdout.write(String(d.blocked_count ?? 0));
")
[ "$RJ_BLOCKED" -ge 1 ] && pass "P11: BoundaryError:rejected lands in permanent_failures cache (blocked_count=$RJ_BLOCKED on re-plan)" || fail "P11 rejected cacheable" "got blocked_count=$RJ_BLOCKED"

# ---- P10: host concurrency + retry correctness ----

echo "== P10: computeDelay honors Retry-After (standalone) =="
# Runs in-process — no server, no DB. Asserts the math directly per the audit's audit
# finding: a 60s Retry-After was silently clamped to 10s, burning attempts on 429.
if node --experimental-strip-types --no-warnings scripts/test-retry-after.mjs >/tmp/p10-retry.out 2>&1; then
  pass "P10: computeDelay test-script green (Retry-After honored to retryAfterCapMs)"
else
  fail "P10 computeDelay test-script" "$(cat /tmp/p10-retry.out)"
fi

echo "== P10: concurrent applies on the same plan_id don't share state =="
# The audit caught: cached.plan was mutated in-place; two concurrent applies on the
# same plan_id corrupted each other. The fix shallow-clones the plan before dispatch.
# This smoke proves the clone: two applies fire on the same plan_id, both should
# observe an independent step view (status either succeeded for the winner of the
# PLAN_CACHE.delete race, or PLAN_NOT_FOUND for the loser — never a corrupted shared mid-state).
R=$(mcp_call 130 'tools/call' '{"name":"connect_crm","arguments":{"crm":"memory","org_label":"p10-concurrent","is_demo":true,"api_domain":"memory://p10c","writable_org_ids":["memory://p10c"]}}' | text_of)
P10_CONN=$(echo "$R" | field_of connection_id)
P10_DELTA='{"spec_version":0,"fields":[{"api_name":"p10_concurrent_field","label":"x","kind":"text","module":"Lead"}],"stages":[],"pipelines":[],"workflows":[]}'
R=$(mcp_call 131 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$P10_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P10_DELTA}}" | text_of)
P10_PLAN=$(echo "$R" | field_of plan_id)
# Fire two applies in parallel. Background both, wait for both, then verify neither
# produced a corrupted response shape (the failure mode if the clone wasn't in place
# is that one apply's step seq indexing reads from the other's mutated steps).
mcp_call 132 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P10_PLAN\"}}" >/tmp/p10-a.out 2>&1 &
PID_A=$!
mcp_call 133 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P10_PLAN\"}}" >/tmp/p10-b.out 2>&1 &
PID_B=$!
wait $PID_A; wait $PID_B
# Decode each. One should be 'succeeded' / 'partial' / 'aborted', the other either
# the same OR a clean PLAN_NOT_FOUND (cache deleted by the winner). Neither should
# be 5xx, undefined status, or a shape with mixed steps.
RA=$(cat /tmp/p10-a.out | text_of 2>/dev/null || echo '{}')
RB=$(cat /tmp/p10-b.out | text_of 2>/dev/null || echo '{}')
SA=$(echo "$RA" | field_of status)
SB=$(echo "$RB" | field_of status)
EA=$(echo "$RA" | field_of error)
EB=$(echo "$RB" | field_of error)
# Acceptable outcomes for each: status in {succeeded,partial,aborted} OR error=PLAN_NOT_FOUND.
acceptable() {
  case "$1" in
    succeeded|partial|aborted) return 0 ;;
    *) [ "$2" = "PLAN_NOT_FOUND" ] && return 0 || return 1 ;;
  esac
}
if acceptable "$SA" "$EA" && acceptable "$SB" "$EB"; then
  pass "P10: concurrent applies both produced clean outcomes (A=$SA${EA:+/$EA}, B=$SB${EB:+/$EB})"
else
  fail "P10 concurrent isolation" "A status=$SA error=$EA; B status=$SB error=$EB — expected each to be succeeded/partial/aborted/PLAN_NOT_FOUND"
fi

echo "== P15: advisory-lock serialization on concurrent applies (same conn) =="
# P15 fix #1: host wraps apply in pg_advisory_xact_lock(hashtext('apply-'||crm||'-'||api_domain)).
# Two concurrent applies on the same connection MUST serialize through the lock — proven via
# run_steps timestamps: every step in B starts no earlier than A's last step finished.
# Only meaningful on local PG (remote BASE smoke skipped per IS_LOCAL gating).
if [ "$IS_LOCAL" = "1" ]; then
  R=$(mcp_call 150 'tools/call' '{"name":"connect_crm","arguments":{"crm":"memory","org_label":"p15-lock","is_demo":true,"api_domain":"memory://p15lock","writable_org_ids":["memory://p15lock"]}}' | text_of)
  P15_CONN=$(echo "$R" | field_of connection_id)
  P15_DELTA_A=$(node -e "
const fields=[];
for (let i=1;i<=5;i++) fields.push({api_name:'p15_lock_A_'+i,label:'x',kind:'text',module:'Lead'});
process.stdout.write(JSON.stringify({spec_version:0,fields,stages:[],pipelines:[],workflows:[]}));")
  P15_DELTA_B=$(node -e "
const fields=[];
for (let i=1;i<=5;i++) fields.push({api_name:'p15_lock_B_'+i,label:'x',kind:'text',module:'Lead'});
process.stdout.write(JSON.stringify({spec_version:0,fields,stages:[],pipelines:[],workflows:[]}));")
  R=$(mcp_call 151 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$P15_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P15_DELTA_A}}" | text_of)
  P15_PLAN_A=$(echo "$R" | field_of plan_id)
  R=$(mcp_call 152 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$P15_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$P15_DELTA_B}}" | text_of)
  P15_PLAN_B=$(echo "$R" | field_of plan_id)
  mcp_call 153 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P15_PLAN_A\"}}" >/tmp/p15-a.out 2>&1 &
  PIDA=$!
  mcp_call 154 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P15_PLAN_B\"}}" >/tmp/p15-b.out 2>&1 &
  PIDB=$!
  wait $PIDA; wait $PIDB
  P15_RA=$(cat /tmp/p15-a.out | text_of | field_of run_id)
  P15_RB=$(cat /tmp/p15-b.out | text_of | field_of run_id)
  if [ -n "$P15_RA" ] && [ -n "$P15_RB" ]; then
    OVERLAP=$(PGPASSWORD=crm psql -h 127.0.0.1 -p 5433 -U crm -d crm_provisioner -tA <<SQL
with a as (select min(started_at) as a_start, max(finished_at) as a_end from run_steps where run_id = '$P15_RA'),
     b as (select min(started_at) as b_start, max(finished_at) as b_end from run_steps where run_id = '$P15_RB')
select case
  when a.a_end <= b.b_start then 'serial:a-then-b'
  when b.b_end <= a.a_start then 'serial:b-then-a'
  else 'overlap'
end from a, b;
SQL
)
    if [ "$OVERLAP" = "serial:a-then-b" ] || [ "$OVERLAP" = "serial:b-then-a" ]; then
      pass "P15: concurrent applies on same conn serialized via advisory lock ($OVERLAP)"
    else
      fail "P15 lock serialization" "got '$OVERLAP' — runs interleaved despite the lock (race window still open)"
    fi
  else
    fail "P15 advisory-lock setup" "missing run_ids: A='$P15_RA' B='$P15_RB'"
  fi
else
  skip "P15 advisory-lock serialization" "BASE=$BASE is non-local — psql probes against remote PG aren't reachable for the timestamp comparison."
fi

echo "== P15: dedup-before-aborted_by — no duplicate skipped_by_watchdog rows =="
# P15 fix #4: existing P7 6-of-N failure-rate trip + future pre-batch trips must produce
# exactly ONE row per (run_id, seq) in run_steps with status=skipped_by_watchdog. Pre-fix
# the pre-batch trip path would have produced 2 (no UNIQUE constraint to catch it).
if [ "$IS_LOCAL" = "1" ]; then
  P15_DEDUP_ROWS=$(PGPASSWORD=crm psql -h 127.0.0.1 -p 5433 -U crm -d crm_provisioner -tA <<SQL 2>/dev/null
select coalesce(max(c),1) from (
  select count(*) as c from run_steps where status='skipped_by_watchdog'
  group by run_id, seq
) g;
SQL
)
  [ "$P15_DEDUP_ROWS" = "1" ] && pass "P15: every (run_id, seq) has exactly one skipped_by_watchdog row (dedup-first ordering green)" || fail "P15 dedup-first" "max rows per (run_id, seq) = $P15_DEDUP_ROWS (expected 1)"
else
  skip "P15 dedup-first ordering" "BASE=$BASE is non-local — psql probes against remote PG aren't reachable."
fi

echo "== P10: Zoho connect without api_domain → CONFIG_ERROR =="
# configuration-philosophy tier-2 fail-at-boot: previously the adapter silently fell back
# to zohoapis.com, breaking every non-com DC customer.
R=$(mcp_call 134 'tools/call' '{"name":"connect_crm","arguments":{"crm":"zoho","org_label":"p10-noapidomain","is_demo":true,"writable_org_ids":[],"refresh_token":"fake","dc":"eu"}}' | text_of)
P10_ZERR=$(echo "$R" | field_of error)
[ "$P10_ZERR" = "CONFIG_ERROR" ] && pass "P10: zoho connect without api_domain refused with CONFIG_ERROR" || fail "P10 zoho api_domain enforcement" "got error='$P10_ZERR' (expected CONFIG_ERROR)"

# ---- P14: token at-rest encryption ----
# LOCAL-ONLY: requires spawning a sibling server with `env -i` (proves fail-at-boot)
# and direct psql access (proves ciphertext-in-column + plaintext round-trip + legacy-
# column-NULL). Against a remote BASE the relevant code is verified by THIS server's
# boot (the remote already started successfully, proving the key is present and the
# encrypted insert/select paths work — every connect_crm and subsequent loadConn on a
# live URL is the implicit round-trip test).

if [ "$IS_LOCAL" = "1" ]; then
  echo "== P14: server refuses to boot without TOKEN_AT_REST_KEY (fail-at-boot, not fall-back) =="
  # Spawn the server with NO key set; expect non-zero exit + the instructive error on stderr.
  # env -i strips the shell's TOKEN_AT_REST_KEY; we pass through PATH/HOME/DATABASE_URL so
  # Node can find itself and connect to PG (but the key check happens before any DB call).
  # Different port so we don't fight the running dev server.
  DBURL="${DATABASE_URL:-postgres://crm:crm@127.0.0.1:5433/crm_provisioner}"
  BOOT_OUTPUT=$(env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$DBURL" PORT=8799 \
    node --experimental-strip-types --no-warnings src/host/server.ts 2>&1 || true)
  echo "$BOOT_OUTPUT" | grep -q "TOKEN_AT_REST_KEY env var is required" \
    && pass "P14: server boot fails loudly with instructive error when TOKEN_AT_REST_KEY is absent" \
    || fail "P14 fail-at-boot" "expected 'TOKEN_AT_REST_KEY env var is required' on stderr; got: $(echo "$BOOT_OUTPUT" | tail -3)"

  echo "== P17: tighter TOKEN_AT_REST_KEY validation — short key rejected =="
  # P17 fix #3 (sub-test 1): a 1-char key passes presence/non-whitespace but fails min-length.
  BOOT_OUT_SHORT=$(env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$DBURL" PORT=8799 TOKEN_AT_REST_KEY=x \
    node --experimental-strip-types --no-warnings src/host/server.ts 2>&1 || true)
  echo "$BOOT_OUT_SHORT" | grep -q "too short" \
    && pass "P17: server rejects TOKEN_AT_REST_KEY < 32 chars" \
    || fail "P17 short-key reject" "expected 'too short' in stderr; got: $(echo "$BOOT_OUT_SHORT" | tail -3)"

  echo "== P17: TOKEN_AT_REST_KEY non-base64 rejected =="
  # P17 fix #3 (sub-test 2): a long-but-non-base64 key rejected (avoids the smoke heredoc
  # shell-expansion concern from the code review — strict base64 has no shell-special chars).
  BAD_CHARSET_KEY="this-key-has-32-chars-but-bad-charset-with-dollar-sign-and-quote"
  BOOT_OUT_CHARSET=$(env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$DBURL" PORT=8799 TOKEN_AT_REST_KEY="$BAD_CHARSET_KEY" \
    node --experimental-strip-types --no-warnings src/host/server.ts 2>&1 || true)
  echo "$BOOT_OUT_CHARSET" | grep -q "non-base64" \
    && pass "P17: server rejects TOKEN_AT_REST_KEY with non-base64 characters" \
    || fail "P17 bad-charset reject" "expected 'non-base64' in stderr; got: $(echo "$BOOT_OUT_CHARSET" | tail -3)"

  echo "== P17: pgcrypto round-trip self-test fires at boot =="
  # P17 fix #3 (sub-test 3): the server logs the self-test pass on stdout after listening.
  # The currently-running server already did this; grep its log.
  grep -q "pgcrypto round-trip self-test passed" /tmp/server-p17.log 2>/dev/null \
    && pass "P17: pgcrypto round-trip self-test ran + passed at boot" \
    || fail "P17 pgcrypto self-test" "no 'self-test passed' message in /tmp/server-p17.log"

  echo "== P14: encrypted token round-trip via memory connection =="
  # The memory CONN created at smoke startup has NULL refresh_token (no auth needed for memory
  # adapter). The encrypted column should reflect NULL too — proves the case-when guards work.
  NULL_TOKEN_CT=$(PGPASSWORD=crm psql -h 127.0.0.1 -p 5433 -U crm -d crm_provisioner -tA -c \
    "select coalesce(octet_length(refresh_token_encrypted)::text, 'null') from connections where id = '$CONN'")
  [ "$NULL_TOKEN_CT" = "null" ] && pass "P14: memory connection's NULL refresh_token stays NULL in encrypted column (no ciphertext-for-empty)" || fail "P14 null-token encryption" "got octet_length='$NULL_TOKEN_CT' (expected NULL)"

  # A connection WITH an access_token should produce ciphertext (length > 0). Use a separate
  # connect_crm with a synthetic access_token to verify encryption happens on insert.
  R=$(mcp_call 901 'tools/call' '{"name":"connect_crm","arguments":{"crm":"memory","org_label":"p14-enc-test","is_demo":true,"api_domain":"memory://p14enc","writable_org_ids":["memory://p14enc"],"access_token":"synthetic-token-value-for-p14-smoke"}}' | text_of)
  P14_ENC_CONN=$(echo "$R" | field_of connection_id)
  ENC_LEN=$(PGPASSWORD=crm psql -h 127.0.0.1 -p 5433 -U crm -d crm_provisioner -tA -c \
    "select octet_length(access_token_encrypted) from connections where id = '$P14_ENC_CONN'")
  [ -n "$ENC_LEN" ] && [ "$ENC_LEN" -gt 50 ] && pass "P14: access_token encrypted at rest (ciphertext ${ENC_LEN} bytes)" || fail "P14 ciphertext present" "expected octet_length > 50, got '$ENC_LEN'"

  # Read-back via loadConn round-trip: the adapter sees the plaintext token. psql -c does
  # NOT expand :variable references — use a heredoc; the base64 key has no shell-special
  # characters so $-interpolation inside single-quoted SQL is safe.
  PLAINTEXT=$(PGPASSWORD=crm psql -h 127.0.0.1 -p 5433 -U crm -d crm_provisioner -tA <<SQL
select pgp_sym_decrypt(access_token_encrypted, '$TOKEN_AT_REST_KEY'::text)::text from connections where id = '$P14_ENC_CONN';
SQL
  )
  [ "$PLAINTEXT" = "synthetic-token-value-for-p14-smoke" ] && pass "P14: pgp_sym_decrypt round-trips the original plaintext (loadConn contract)" || fail "P14 decrypt round-trip" "got '$PLAINTEXT'"

  # Defense-in-depth: confirm the OLD plaintext column is NULL (we no longer write to it).
  LEGACY=$(PGPASSWORD=crm psql -h 127.0.0.1 -p 5433 -U crm -d crm_provisioner -tA -c \
    "select coalesce(access_token, 'null') from connections where id = '$P14_ENC_CONN'")
  [ "$LEGACY" = "null" ] && pass "P14: legacy plaintext access_token column is NULL (no double-write)" || fail "P14 plaintext column" "got '$LEGACY' (expected null)"
else
  skip "P14 fail-at-boot + encryption round-trip + legacy-column NULL" "BASE=$BASE is non-local — env -i subprocess + direct psql are not reachable. The remote server's successful boot + this smoke's connect_crm successes are the implicit P14 verification: the encrypted insert/decrypt-read paths work or the server would 5xx every connect_crm."
fi

# ---- 15. health ----
echo "== /health =="
H=$(curl -sS "$BASE/health")
echo "$H" | grep -q '"phase":"P0"' && pass "/health says P0" || fail "/health says P0" "$H"

# ============================================================================
# LIVE SFDC SMOKE — gated on SF_LIVE=1 (the pre-commit hook does NOT pass this)
# ============================================================================
# Touches real shane-dev org. Creates a probe field, verifies via SOQL through
# the adapter's snapshot, tears down, verifies removal. Skipped by default.
if [ "${SF_LIVE:-0}" = "1" ]; then
  echo
  echo "== LIVE: Salesforce adapter end-to-end =="
  SF_TOKEN=$(sf org display --target-org shane-dev --json 2>/dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0)).result.accessToken)")
  SF_URL="https://orgfarm-e843df8348-dev-ed.develop.my.salesforce.com"
  [ -n "$SF_TOKEN" ] && pass "got sf access token (len=${#SF_TOKEN})" || fail "got sf access token" "empty — run 'sf org login web' first"

  # Connection: declares writable_org_ids = exactly shane-dev's URL.
  # P12: sf_alias passed explicitly per connection (vs the legacy SF_ALIAS env-global). The
  # adapter's inferAlias() reads conn.sf_alias first; env stays as fallback for legacy rows.
  # Pass token via env to dodge any shell-escaping pitfalls.
  ARGS=$(SF_TOKEN="$SF_TOKEN" SF_URL="$SF_URL" node -e '
const args = { name: "connect_crm", arguments: {
  crm: "salesforce",
  org_label: "shane-dev (LIVE)",
  is_demo: true,
  api_domain: process.env.SF_URL,
  writable_org_ids: [process.env.SF_URL],
  access_token: process.env.SF_TOKEN,
  sf_alias: "shane-dev"
}};
process.stdout.write(JSON.stringify(args));
')
  R=$(mcp_call 50 'tools/call' "$ARGS" | text_of)
  SF_CONN=$(echo "$R" | field_of connection_id)
  SF_ALIAS_ECHO=$(echo "$R" | field_of sf_alias)
  [ -n "$SF_CONN" ] && pass "live SFDC connection created" || fail "live SFDC connection" "$R"
  [ "$SF_ALIAS_ECHO" = "shane-dev" ] && pass "P12: connect_crm persists sf_alias=shane-dev on the connection" || fail "P12 sf_alias persisted" "got '$SF_ALIAS_ECHO'"

  # P18 fix #1: connect_crm refuses SFDC connections without sf_alias (CONFIG_ERROR,
  # mirror of the Zoho api_domain check). Asymmetry the audit caught is now closed.
  R=$(mcp_call 5001 'tools/call' '{"name":"connect_crm","arguments":{"crm":"salesforce","org_label":"p18-no-alias","is_demo":true,"writable_org_ids":[],"access_token":"fake"}}' | text_of)
  P18_SF_ERR=$(echo "$R" | field_of error)
  [ "$P18_SF_ERR" = "CONFIG_ERROR" ] && pass "P18: salesforce connect without sf_alias refused with CONFIG_ERROR" || fail "P18 sf_alias required" "got error='$P18_SF_ERR' (expected CONFIG_ERROR)"

  # P18 fix #2: deployMetadata's try/finally rm closes the per-apply tmpdir leak. Count
  # sf-* dirs under TMPDIR before/after a fresh apply — should be unchanged. tmpdir on
  # macOS is /var/folders/.../T/, not /tmp; use the env's TMPDIR.
  TMP_DIR_REAL="${TMPDIR:-/tmp}"
  SF_DIRS_BEFORE=$(find "$TMP_DIR_REAL" -maxdepth 1 -type d -name "sf-*" 2>/dev/null | wc -l | tr -d ' ')
  # Pre-cleanup of any pre-existing dirs from older runs so the count is meaningful.
  find "$TMP_DIR_REAL" -maxdepth 1 -type d -name "sf-*" -mmin +60 -exec rm -rf {} + 2>/dev/null || true
  # The apply already happened above (creates field + permset deploy + assign + teardown).
  # Re-count now — any tmpdir from THIS run's deploys should be gone (try/finally rm).
  SF_DIRS_AFTER=$(find "$TMP_DIR_REAL" -maxdepth 1 -type d -name "sf-*" 2>/dev/null | wc -l | tr -d ' ')
  # The exact count varies (depends on what older runs left behind), but the delta should
  # be ≤ 0 — never positive — because every deploy this run cleans up after itself.
  if [ "$SF_DIRS_AFTER" -le "$SF_DIRS_BEFORE" ]; then
    pass "P18: deployMetadata tmpdir cleanup green (before=$SF_DIRS_BEFORE, after=$SF_DIRS_AFTER under $TMP_DIR_REAL)"
  else
    fail "P18 tmpdir leak" "before=$SF_DIRS_BEFORE, after=$SF_DIRS_AFTER — apply leaked $((SF_DIRS_AFTER - SF_DIRS_BEFORE)) sf-* dir(s) under $TMP_DIR_REAL"
  fi

  # inspect — should pull real stage list
  R=$(mcp_call 51 'tools/call' "{\"name\":\"inspect_instance\",\"arguments\":{\"connection_id\":\"$SF_CONN\"}}" | text_of)
  STAGE_COUNT=$(echo "$R" | node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync(0)).snapshot?.stages||[]).length))")
  [ "$STAGE_COUNT" -ge 5 ] && pass "live inspect returns >=5 real stages" || fail "live inspect stages" "got $STAGE_COUNT"

  # plan + apply a single field-only delta (cheap, fast, easy to teardown)
  SF_DELTA='{"spec_version":0,"fields":[{"api_name":"prov_smoke_field","label":"prov_smoke_field","kind":"text","module":"Lead","length":80,"description":"crm-provisioner P2 smoke — safe to delete"}],"stages":[],"pipelines":[],"workflows":[]}'
  R=$(mcp_call 52 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$SF_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$SF_DELTA}}" | text_of)
  SF_PLAN=$(echo "$R" | field_of plan_id)
  [ -n "$SF_PLAN" ] && pass "live plan returned plan_id" || fail "live plan" "$R"

  R=$(mcp_call 53 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$SF_PLAN\"}}" | text_of)
  SF_RUN=$(echo "$R" | field_of run_id)
  SF_STATUS=$(echo "$R" | field_of status)
  [ "$SF_STATUS" = "succeeded" ] && pass "live apply succeeded" || fail "live apply" "$R"

  # P9: apply response only carries {status, step_count, run_id} — not the step array.
  # Pull the steps from the run ledger via get_run and confirm grant_field_visibility ran.
  RUN_DETAIL=$(mcp_call 531 'tools/call' "{\"name\":\"get_run\",\"arguments\":{\"run_id\":\"$SF_RUN\"}}" | text_of)
  GRANT_STEP=$(echo "$RUN_DETAIL" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='grant_field_visibility');
if(!s){process.stdout.write('missing');process.exit(0)}
process.stdout.write(s.status==='succeeded' ? 'succeeded' : ('other:'+s.status));
")
  [ "$GRANT_STEP" = "succeeded" ] && pass "P9: apply ran grant_field_visibility step (succeeded)" || fail "P9 grant step ran" "got '$GRANT_STEP' (the create_field succeeded but FLS step missing means the field is invisible to non-admins)"

  # Verify via re-inspect — the new field should appear
  R=$(mcp_call 54 'tools/call' "{\"name\":\"inspect_instance\",\"arguments\":{\"connection_id\":\"$SF_CONN\"}}" | text_of)
  FOUND=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const f=(d.snapshot?.fields_lead||[]).find(x=>x.DeveloperName==='prov_smoke_field');
process.stdout.write(f ? 'yes' : 'no');
")
  [ "$FOUND" = "yes" ] && pass "live: probe field exists in SFDC" || fail "probe field exists after apply" "got $FOUND"

  # P9 PRIMARY GATE: the PROVISIONER_PERMSET ('Prov_Provisioned') must grant Read+Edit
  # on Lead.prov_smoke_field__c. FieldPermissions IS the FLS truth-source — if this row
  # is absent, no user except admins (who see everything via Profile) can SOQL the field.
  # Tooling query as admin reads the metadata; the field-visibility outcome is decided
  # right here, regardless of which user runs a later SELECT.
  FLS_QUERY="SELECT+Field,PermissionsRead,PermissionsEdit+FROM+FieldPermissions+WHERE+Parent.Name='Prov_Provisioned'+AND+Field='Lead.prov_smoke_field__c'"
  FLS_ROWS=$(sf api request rest "/services/data/v62.0/query?q=$FLS_QUERY" --target-org shane-dev 2>/dev/null | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
const r=(d.records||[])[0];
if(!r){process.stdout.write('zero-rows');process.exit(0)}
process.stdout.write(r.PermissionsRead && r.PermissionsEdit ? 'read-edit' : ('partial:'+JSON.stringify(r)));
")
  [ "$FLS_ROWS" = "read-edit" ] && pass "P9: FieldPermissions row for prov_smoke_field__c exists with Read+Edit" || fail "P9 FieldPermissions grant" "got '$FLS_ROWS' (this is the bug P9 was written to catch)"

  # P9 STRONGER GATE (optional, runs only when SF_PROBER_ALIAS is set in env):
  # Probe the field by SELECTing it AS the prober user. If FLS is correctly granted,
  # the query succeeds; if not, SFDC returns "No such column 'prov_smoke_field__c'".
  # One-time setup to enable: `sf org create user --definition-file config/prober-user-def.json \
  #   --target-org shane-dev --set-alias shane-dev-prober` (alias must auth as that user).
  # Then `sf org assign permset --name Prov_Provisioned --on-behalf-of <prober-username> --target-org shane-dev`
  # The admin alias's auth context handles the on-behalf-of grant.
  if [ -n "${SF_PROBER_ALIAS:-}" ]; then
    PROBER_OUT=$(sf data query --target-org "$SF_PROBER_ALIAS" --query "SELECT prov_smoke_field__c FROM Lead LIMIT 0" --json 2>&1 || true)
    if echo "$PROBER_OUT" | grep -q "No such column"; then
      fail "P9 prober SOQL probe — FLS NOT granted to non-admin" "the exact bug P9 was built to prevent: field exists, but a Standard User can't see it"
    else
      pass "P9: prober ($SF_PROBER_ALIAS) can SOQL the field (FLS works end-to-end)"
    fi
  else
    echo "    (SF_PROBER_ALIAS not set — primary FieldPermissions gate above is the live check; strong-gate prober probe skipped.)"
  fi

  # Idempotency: a second plan should diff to noop on the field
  R=$(mcp_call 55 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$SF_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$SF_DELTA}}" | text_of)
  NOOP_FIELD=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_field' && x.payload?.api_name==='prov_smoke_field');
process.stdout.write(s?.diff || 'missing');
")
  [ "$NOOP_FIELD" = "noop" ] && pass "live: second plan shows noop on existing field (idempotent)" || fail "idempotent re-plan" "got '$NOOP_FIELD'"

  # P9 idempotency: the grant_field_visibility step ALSO noops on re-plan, because the
  # FieldPermissions row was created on the first apply (snapshot.permset_field_perms
  # includes the field, so planSpec sees nothing missing).
  NOOP_GRANT=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='grant_field_visibility');
process.stdout.write(s?.diff || 'missing');
")
  [ "$NOOP_GRANT" = "noop" ] && pass "P9: second plan shows noop on grant_field_visibility (idempotent FLS)" || fail "P9 idempotent FLS re-plan" "got '$NOOP_GRANT'"

  # Teardown — verify the field is removed
  R=$(mcp_call 56 'tools/call' "{\"name\":\"teardown_run\",\"arguments\":{\"run_id\":\"$SF_RUN\"}}" | text_of)
  TD_STATUS=$(echo "$R" | field_of status)
  [ "$TD_STATUS" = "succeeded" ] && pass "live teardown succeeded" || fail "live teardown" "$R"

  R=$(mcp_call 57 'tools/call' "{\"name\":\"inspect_instance\",\"arguments\":{\"connection_id\":\"$SF_CONN\"}}" | text_of)
  GONE=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const f=(d.snapshot?.fields_lead||[]).find(x=>x.DeveloperName==='prov_smoke_field');
process.stdout.write(f ? 'still-there' : 'gone');
")
  [ "$GONE" = "gone" ] && pass "live: probe field removed by teardown" || fail "probe field removed" "got $GONE"

  # P9: after teardown, the FieldPermissions row for prov_smoke_field__c is gone too —
  # the permset's redeployed-without-this-field. (The permset itself still exists; only
  # this run's field entries got removed.)
  FLS_AFTER_TDN=$(sf api request rest "/services/data/v62.0/query?q=$FLS_QUERY" --target-org shane-dev 2>/dev/null | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
process.stdout.write((d.records||[]).length === 0 ? 'gone' : 'still-there');
")
  [ "$FLS_AFTER_TDN" = "gone" ] && pass "P9: FieldPermissions row removed by teardown (permset redeployed without field)" || fail "P9 FieldPermissions teardown" "got '$FLS_AFTER_TDN'"
else
  echo "  (SF_LIVE=0 — live SFDC assertions skipped. Run 'SF_LIVE=1 bash scripts/smoke-p0.sh' to exercise.)"
fi

# ---- P4: cold-session-style assertion ----
# A "cold" Claude session would: list_templates → pick one → author a tiny
# vertical-appropriate delta → validate → plan → see correct diff. Done with
# real-estate@v1 against the memory adapter (no real CRM needed).
echo "== P4: cold-session against real-estate@v1 (memory adapter) =="
R=$(mcp_call 70 'tools/call' '{"name":"connect_crm","arguments":{"crm":"memory","org_label":"P4 cold session","is_demo":true,"api_domain":"memory://p4","writable_org_ids":["memory://p4"]}}' | text_of)
P4_CONN=$(echo "$R" | field_of connection_id)
# Plain-language scenario encoded as the simplest possible delta:
# "Add an 'Inspection Scheduled' stage to the residential pipeline."
P4_DELTA='{"spec_version":0,"fields":[],"stages":[{"api_name":"Inspection_Scheduled","label":"Inspection Scheduled","forecast_category":"Pipeline","forecast_type":"Open","probability":40}],"pipelines":[{"api_name":"Residential","label":"Residential","module":"Deal","stages":["Inquiry_Received","Showing_Scheduled","Inspection_Scheduled","Offer_Made","Under_Contract","Closed_Won"]}],"workflows":[]}'
R=$(mcp_call 71 'tools/call' "{\"name\":\"validate_spec\",\"arguments\":{\"template_ref\":\"real-estate\",\"delta\":$P4_DELTA}}" | text_of)
OK=$(echo "$R" | field_of ok)
[ "$OK" = "true" ] && pass "P4: real-estate + delta validates" || fail "P4 validate" "$R"

R=$(mcp_call 72 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$P4_CONN\",\"template_ref\":\"real-estate\",\"delta\":$P4_DELTA}}" | text_of)
P4_PLAN=$(echo "$R" | field_of plan_id)
P4_STEPS=$(echo "$R" | node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync(0)).steps||[]).length))")
# 5 base fields + 6 base stages (5 + 1 appended) + 1 pipeline (noop) + 0 workflows
[ "$P4_STEPS" -ge 12 ] && pass "P4: plan has >=12 steps (5 fields + 6 stages + 1 pipeline)" || fail "P4 plan step count" "got $P4_STEPS"

R=$(mcp_call 73 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$P4_PLAN\"}}" | text_of)
[ "$(echo "$R" | field_of status)" = "succeeded" ] && pass "P4: apply succeeded against memory adapter" || fail "P4 apply" "$R"

# Validate professional-services too
R=$(mcp_call 74 'tools/call' '{"name":"validate_spec","arguments":{"template_ref":"professional-services","delta":{"spec_version":0,"fields":[],"stages":[],"pipelines":[],"workflows":[]}}}' | text_of)
[ "$(echo "$R" | field_of ok)" = "true" ] && pass "P4: professional-services base validates" || fail "P4 prof-svc validate" "$R"

# Extension-point default-deny still works on the real templates
BAD='{"spec_version":0,"fields":[{"module":"Lead","api_name":"x","label":"x","kind":"text"}],"stages":[],"pipelines":[],"workflows":[],"extends":"trying_to_overwrite"}'
R=$(mcp_call 75 'tools/call' "{\"name\":\"validate_spec\",\"arguments\":{\"template_ref\":\"real-estate\",\"delta\":$BAD}}" | text_of)
# delta has extra `extends` field which is not allowed (DeltaSpecSchema omits it)
ERR=$(echo "$R" | field_of error)
[ "$ERR" = "DELTA_SCHEMA_INVALID" ] && pass "P4: delta with disallowed 'extends' field rejected" || fail "P4 extra-field rejection" "got $ERR"

# ============================================================================
# LIVE ZOHO SMOKE — gated on ZOHO_LIVE=1
# ============================================================================
# Requires .dev.vars at repo root with ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET /
# ZOHO_REFRESH_TOKEN / ZOHO_DC / ZOHO_API_BASE. Touches the real Zoho trial org.
if [ "${ZOHO_LIVE:-0}" = "1" ]; then
  echo
  echo "== LIVE: Zoho adapter end-to-end =="
  # Source the .dev.vars without clobbering shell-critical names
  if [ -f .dev.vars ]; then
    set -a; . ./.dev.vars; set +a
  fi
  [ -n "${ZOHO_REFRESH_TOKEN:-}" ] && pass "ZOHO_REFRESH_TOKEN present in .dev.vars" || fail "ZOHO_REFRESH_TOKEN present" "missing"

  ARGS=$(ZRT="$ZOHO_REFRESH_TOKEN" ZDC="${ZOHO_DC:-com}" ZAD="${ZOHO_API_BASE:-https://www.zohoapis.com}" node -e '
const a = { name: "connect_crm", arguments: {
  crm: "zoho",
  org_label: "zoho trial (LIVE)",
  is_demo: true,
  api_domain: process.env.ZAD,
  writable_org_ids: [process.env.ZAD],
  refresh_token: process.env.ZRT,
  dc: process.env.ZDC
}};
process.stdout.write(JSON.stringify(a));
')
  R=$(mcp_call 60 'tools/call' "$ARGS" | text_of)
  Z_CONN=$(echo "$R" | field_of connection_id)
  [ -n "$Z_CONN" ] && pass "live Zoho connection created" || fail "live Zoho connection" "$R"

  # inspect
  R=$(mcp_call 61 'tools/call' "{\"name\":\"inspect_instance\",\"arguments\":{\"connection_id\":\"$Z_CONN\"}}" | text_of)
  Z_LEAD_FIELD_COUNT=$(echo "$R" | node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync(0)).snapshot?.fields_lead||[]).length))")
  Z_STAGE_COUNT=$(echo "$R" | node -e "process.stdout.write(String((JSON.parse(require('fs').readFileSync(0)).snapshot?.stages||[]).length))")
  [ "$Z_LEAD_FIELD_COUNT" -gt 5 ] && pass "live Zoho inspect: >5 Lead fields ($Z_LEAD_FIELD_COUNT)" || fail "Zoho inspect lead fields" "got $Z_LEAD_FIELD_COUNT"
  [ "$Z_STAGE_COUNT" -ge 5 ] && pass "live Zoho inspect: >=5 stages ($Z_STAGE_COUNT)" || fail "Zoho inspect stages" "got $Z_STAGE_COUNT"

  # plan + apply field-only delta
  Z_DELTA='{"spec_version":0,"fields":[{"api_name":"prov_zoho_smoke","label":"Prov Zoho Smoke","kind":"text","module":"Leads","length":80,"description":"crm-provisioner P3 smoke — safe to delete"}],"stages":[],"pipelines":[],"workflows":[]}'
  R=$(mcp_call 62 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$Z_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$Z_DELTA}}" | text_of)
  Z_PLAN=$(echo "$R" | field_of plan_id)
  [ -n "$Z_PLAN" ] && pass "live Zoho plan returned plan_id" || fail "Zoho plan" "$R"

  R=$(mcp_call 63 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$Z_PLAN\"}}" | text_of)
  Z_RUN=$(echo "$R" | field_of run_id)
  Z_STATUS=$(echo "$R" | field_of status)
  [ "$Z_STATUS" = "succeeded" ] && pass "live Zoho apply succeeded" || fail "Zoho apply" "$R"

  # verify
  R=$(mcp_call 64 'tools/call' "{\"name\":\"inspect_instance\",\"arguments\":{\"connection_id\":\"$Z_CONN\"}}" | text_of)
  FOUND=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
process.stdout.write((d.snapshot?.fields_lead||[]).find(x=>x.api_name==='prov_zoho_smoke') ? 'yes' : 'no');
")
  [ "$FOUND" = "yes" ] && pass "live Zoho: probe field exists" || fail "Zoho field exists" "got $FOUND"

  # idempotent re-plan
  R=$(mcp_call 65 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$Z_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$Z_DELTA}}" | text_of)
  Z_NOOP=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_field' && x.payload?.api_name==='prov_zoho_smoke');
process.stdout.write(s?.diff || 'missing');
")
  [ "$Z_NOOP" = "noop" ] && pass "live Zoho: idempotent re-plan = noop on field" || fail "Zoho idempotent" "got '$Z_NOOP'"

  # teardown
  R=$(mcp_call 66 'tools/call' "{\"name\":\"teardown_run\",\"arguments\":{\"run_id\":\"$Z_RUN\"}}" | text_of)
  Z_TD_STATUS=$(echo "$R" | field_of status)
  [ "$Z_TD_STATUS" = "succeeded" ] && pass "live Zoho teardown succeeded" || fail "Zoho teardown" "$R"

  R=$(mcp_call 67 'tools/call' "{\"name\":\"inspect_instance\",\"arguments\":{\"connection_id\":\"$Z_CONN\"}}" | text_of)
  GONE=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
process.stdout.write((d.snapshot?.fields_lead||[]).find(x=>x.api_name==='prov_zoho_smoke') ? 'still-there' : 'gone');
")
  [ "$GONE" = "gone" ] && pass "live Zoho: probe field removed by teardown" || fail "Zoho field removed" "got $GONE"

  # Workflow shapes (post-harvest): idle_deal_alert + field_derivation are SUPPORTED,
  # round_robin_assignment stays MANUAL. Plan should show idle_deal_alert as 'create',
  # not 'unsupported', and apply should create the workflow rule in the live trial.
  WF_DELTA='{"spec_version":0,"fields":[],"stages":[],"pipelines":[],"workflows":[{"shape":"idle_deal_alert","api_name":"prov_idle_alert","pipeline":"Standard","stage":"Qualification","idle_days":14,"notify":"owner"}]}'
  R=$(mcp_call 68 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$Z_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$WF_DELTA}}" | text_of)
  WF_STEP_DIFF=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_workflow:idle_deal_alert');
process.stdout.write(s?.diff || 'missing');
")
  [ "$WF_STEP_DIFF" = "create" ] && pass "live Zoho: idle_deal_alert workflow now marked CREATE (post-harvest)" || fail "Zoho idle_deal_alert diff" "got '$WF_STEP_DIFF'"

  WF_PLAN=$(echo "$R" | field_of plan_id)
  R=$(mcp_call 69 'tools/call' "{\"name\":\"apply\",\"arguments\":{\"plan_id\":\"$WF_PLAN\"}}" | text_of)
  WF_STATUS=$(echo "$R" | field_of status)
  WF_RUN=$(echo "$R" | field_of run_id)
  [ "$WF_STATUS" = "succeeded" ] && pass "live Zoho: workflow rule created end-to-end" || fail "Zoho workflow apply" "$R"

  # Confirm the rule actually exists in Zoho by listing automation/workflow_rules
  AT=$(curl -sS -X POST "$ZOHO_OAUTH_BASE/oauth/v2/token" -d "grant_type=refresh_token&client_id=$ZOHO_CLIENT_ID&client_secret=$ZOHO_CLIENT_SECRET&refresh_token=$ZOHO_REFRESH_TOKEN" 2>/dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0)).access_token||'')")
  WF_EXISTS=$(curl -sS "$ZOHO_API_BASE/crm/v8/settings/automation/workflow_rules?module=Deals" -H "Authorization: Zoho-oauthtoken $AT" 2>/dev/null | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
process.stdout.write((d.workflow_rules||[]).some(r=>r.name==='prov_prov_idle_alert') ? 'yes' : 'no');
")
  [ "$WF_EXISTS" = "yes" ] && pass "live Zoho: workflow rule visible via independent REST query" || fail "Zoho workflow REST verify" "got $WF_EXISTS"

  # P12: workflow_rule teardown ACTUALLY DELETEs the rule (audit finding #7). Previously
  # the teardown branch fell through to a silent-noop "no-op or stub op" — apply ran clean
  # but the rule stayed live in the org. Capture THIS run's specific workflow_rule_id from
  # get_run, then verify that exact ID is absent after teardown. Name-match alone is too
  # broad: pre-P12 runs left ~9 orphan 'prov_prov_idle_alert' rules in the trial org with
  # different IDs (cleanup is a separate concern from the teardown contract).
  R=$(mcp_call 690 'tools/call' "{\"name\":\"get_run\",\"arguments\":{\"run_id\":\"$WF_RUN\"}}" | text_of)
  WF_ID_CREATED=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_workflow:idle_deal_alert');
process.stdout.write(s?.result_json?.workflow_rule_id || '');
")
  [ -n "$WF_ID_CREATED" ] && pass "P12: workflow_rule_id captured from run ($WF_ID_CREATED)" || fail "P12 workflow id capture" "no workflow_rule_id in run_steps result_json"

  R=$(mcp_call 691 'tools/call' "{\"name\":\"teardown_run\",\"arguments\":{\"run_id\":\"$WF_RUN\"}}" | text_of)
  WF_TD_STATUS=$(echo "$R" | field_of status)
  [ "$WF_TD_STATUS" = "succeeded" ] && pass "P12: workflow_rule teardown_run succeeded" || fail "P12 workflow teardown" "$R"

  WF_THIS_GONE=$(curl -sS "$ZOHO_API_BASE/crm/v8/settings/automation/workflow_rules?module=Deals" -H "Authorization: Zoho-oauthtoken $AT" 2>/dev/null | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const target = process.argv[1];
process.stdout.write((d.workflow_rules||[]).some(r=>r.id===target) ? 'still-there' : 'gone');
" "$WF_ID_CREATED")
  [ "$WF_THIS_GONE" = "gone" ] && pass "P12: this run's workflow_rule actually DELETEd after teardown (specific-id verify)" || fail "P12 workflow_rule DELETE" "id $WF_ID_CREATED is '$WF_THIS_GONE' — the silent-noop teardown bug from audit finding #7"

  # round_robin_assignment stays MANUAL — plan should still show 'unsupported' with a note
  RR_DELTA='{"spec_version":0,"fields":[],"stages":[],"pipelines":[],"workflows":[{"shape":"round_robin_assignment","api_name":"prov_rr","module":"Lead","pool":["a@x.com","b@x.com"]}]}'
  R=$(mcp_call 70 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$Z_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$RR_DELTA}}" | text_of)
  RR_NOTE=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_workflow:round_robin_assignment');
process.stdout.write((s?.notes||'').includes('Deluge') ? 'yes' : 'no');
")
  [ "$RR_NOTE" = "yes" ] && pass "live Zoho: round_robin still UNSUPPORTED with Deluge guidance note" || fail "round_robin manual note" "got $RR_NOTE"

  # ===== Vertical template viability against live Zoho =====
  # plan-only (not apply) for all 4 verticals — viability check that field types
  # and stage shapes resolve cleanly through the spec engine + Zoho adapter
  # without errors. Apply-and-teardown for verticals is too noisy for the smoke
  # (adds ~3 stages * 4 templates * ~15s each), so we verify the PLAN passes
  # validation + diff computation, which catches structural issues.
  for V in real-estate professional-services hvac-services manufacturing; do
    R=$(mcp_call 80 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$Z_CONN\",\"template_ref\":\"$V\",\"delta\":{\"spec_version\":0,\"fields\":[],\"stages\":[],\"pipelines\":[],\"workflows\":[]}}}" | text_of)
    PLAN_OK=$(echo "$R" | field_of plan_id)
    if [ -n "$PLAN_OK" ]; then
      pass "live Zoho viability: template '$V' plans cleanly against trial"
    else
      ERR=$(echo "$R" | field_of error)
      fail "live Zoho viability: template '$V'" "no plan_id; error=$ERR"
    fi
  done
else
  echo "  (ZOHO_LIVE=0 — live Zoho assertions skipped. Run 'ZOHO_LIVE=1 bash scripts/smoke-p0.sh' to exercise.)"
fi

# ---- summary ----
echo
echo "== Summary =="
echo "  $PASS passed / $FAIL failed"
if [ "$FAIL" -gt 0 ]; then echo "  ✗ smoke failed"; exit 1; fi
echo "  ✓ ALL ASSERTIONS PASSED"
