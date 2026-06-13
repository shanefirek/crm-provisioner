#!/usr/bin/env bash
# Exchange a Zoho Self Client grant code for a refresh token.
# Usage: scripts/zoho-exchange.sh <GRANT_CODE>
# Requires: .dev.vars with ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET set.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 <grant_code>" >&2; exit 1; }
GRANT="$1"
cd "$(dirname "$0")/.."
[[ -f .dev.vars ]] || { echo "no .dev.vars" >&2; exit 1; }
set -a; . ./.dev.vars; set +a
[[ -n "${ZOHO_CLIENT_ID:-}" && -n "${ZOHO_CLIENT_SECRET:-}" ]] || { echo "ZOHO_CLIENT_ID/SECRET missing in .dev.vars" >&2; exit 1; }

RESP=$(curl -sS -X POST "$ZOHO_OAUTH_BASE/oauth/v2/token" \
  -d grant_type=authorization_code \
  -d "client_id=$ZOHO_CLIENT_ID" \
  -d "client_secret=$ZOHO_CLIENT_SECRET" \
  -d "code=$GRANT")

# scrub before printing/saving
echo "$RESP" | node -e "
const j=JSON.parse(require('fs').readFileSync(0,'utf8'));
if (j.error) { console.error('EXCHANGE FAILED:', JSON.stringify(j)); process.exit(2); }
console.log('access_token_present:', !!j.access_token);
console.log('refresh_token_present:', !!j.refresh_token);
console.log('api_domain:', j.api_domain);
console.log('expires_in:', j.expires_in, 's');
console.log('scope:', j.scope);
require('fs').writeFileSync('fixtures/zoho/oauth-exchange-scrubbed.json',
  JSON.stringify({...j, access_token:'REDACTED', refresh_token:'REDACTED'}, null, 2));
require('fs').writeFileSync('/tmp/zoho-refresh.txt', j.refresh_token || '');
"
echo
echo "→ Refresh token written to /tmp/zoho-refresh.txt"
echo "→ Next: append to .dev.vars and source it"
