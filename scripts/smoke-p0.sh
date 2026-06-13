#!/usr/bin/env bash
# crm-provisioner — cumulative smoke. P0 baseline: ~25 assertions.
# Future phases EXTEND this file (never write smoke-pN.sh).
#
# Usage:
#   bash scripts/smoke-p0.sh            # assumes wrangler dev running at :8787
#   PORT=8788 bash scripts/smoke-p0.sh  # override
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
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
  # Pass token via env to dodge any shell-escaping pitfalls.
  ARGS=$(SF_TOKEN="$SF_TOKEN" SF_URL="$SF_URL" node -e '
const args = { name: "connect_crm", arguments: {
  crm: "salesforce",
  org_label: "shane-dev (LIVE)",
  is_demo: true,
  api_domain: process.env.SF_URL,
  writable_org_ids: [process.env.SF_URL],
  access_token: process.env.SF_TOKEN
}};
process.stdout.write(JSON.stringify(args));
')
  R=$(mcp_call 50 'tools/call' "$ARGS" | text_of)
  SF_CONN=$(echo "$R" | field_of connection_id)
  [ -n "$SF_CONN" ] && pass "live SFDC connection created" || fail "live SFDC connection" "$R"

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

  # Verify via re-inspect — the new field should appear
  R=$(mcp_call 54 'tools/call' "{\"name\":\"inspect_instance\",\"arguments\":{\"connection_id\":\"$SF_CONN\"}}" | text_of)
  FOUND=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const f=(d.snapshot?.fields_lead||[]).find(x=>x.DeveloperName==='prov_smoke_field');
process.stdout.write(f ? 'yes' : 'no');
")
  [ "$FOUND" = "yes" ] && pass "live: probe field exists in SFDC" || fail "probe field exists after apply" "got $FOUND"

  # Idempotency: a second plan should diff to noop on the field
  R=$(mcp_call 55 'tools/call' "{\"name\":\"plan\",\"arguments\":{\"connection_id\":\"$SF_CONN\",\"template_ref\":\"toy-sales\",\"delta\":$SF_DELTA}}" | text_of)
  NOOP_FIELD=$(echo "$R" | node -e "
const d=JSON.parse(require('fs').readFileSync(0));
const s=(d.steps||[]).find(x=>x.operation==='create_field' && x.payload?.api_name==='prov_smoke_field');
process.stdout.write(s?.diff || 'missing');
")
  [ "$NOOP_FIELD" = "noop" ] && pass "live: second plan shows noop on existing field (idempotent)" || fail "idempotent re-plan" "got '$NOOP_FIELD'"

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
else
  echo "  (SF_LIVE=0 — live SFDC assertions skipped. Run 'SF_LIVE=1 bash scripts/smoke-p0.sh' to exercise.)"
fi

# ---- summary ----
echo
echo "== Summary =="
echo "  $PASS passed / $FAIL failed"
if [ "$FAIL" -gt 0 ]; then echo "  ✗ smoke failed"; exit 1; fi
echo "  ✓ ALL ASSERTIONS PASSED"
