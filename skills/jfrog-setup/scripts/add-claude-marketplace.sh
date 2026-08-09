#!/usr/bin/env bash
# add-claude-marketplace.sh
# Register the JFrog unified Claude agent-plugin marketplace with Claude
# Code for the default `jf` server.
#
# Usage: bash add-claude-marketplace.sh
#
# Exit codes:
#   0  success
#   1  no default jf server, no access token, or marketplace add failed
#   3  required CLI missing

set -euo pipefail

tmp=""
trap 'rm -f "${tmp:-}"' EXIT

NETRC="$HOME/.netrc"
MP_PATH="/ml/core/api/v1/ai-registry/agent-plugins/custom/marketplace/claude-marketplace.json"
MP_PREFIXES=("" "/bridge-client")   # SaaS first, then self-hosted (Bridge Client)

urlenc() { jq -rn --arg x "$1" '$x|@uri'; }

# Drop the `machine <host>` block from ~/.netrc.
netrc_drop_host() {
  [[ -f "$NETRC" ]] || return 0
  awk -v h="$1" '
    $1 == "machine" && $2 == h        { skip=1; next }
    $1 == "machine" || $1 == "default" { skip=0 }
    !skip
  ' "$NETRC"
}

for cmd in jf claude jq base64; do
  command -v "$cmd" >/dev/null || { echo "ERROR: $cmd not on PATH" >&2; exit 3; }
done

# Read the default server's config in-process. Token never touches disk or stdout.
cfg=$(jf config export 2>/dev/null | base64 -d 2>/dev/null || true)
[[ -n "$cfg" ]] || {
  echo "ERROR: no default jf server. Run 'jf login' or 'jf config use <sid>'." >&2
  exit 1
}
SID=$(jq -r '.serverId    // empty' <<<"$cfg")
JFROG_URL=$(jq -r '.url         // empty' <<<"$cfg")
TOKEN=$(jq -r '.accessToken // empty' <<<"$cfg")
LOGIN=$(jq -r '.user        // empty' <<<"$cfg")

JFROG_URL="${JFROG_URL%/}"
SCHEME="${JFROG_URL%%://*}"
BASE="${JFROG_URL#*://}"          # keeps any /path prefix
HOST="${BASE%%/*}"                # for netrc

[[ -n "$TOKEN" && -n "$LOGIN" ]] || {
  echo "ERROR: missing access token or username in jf config for '$SID'. Run 'jf login'" >&2
  exit 1
}
[[ -n "$SID" && -n "$SCHEME" && -n "$HOST" ]] || {
  echo "ERROR: could not parse default jf server URL." >&2
  exit 1
}

# mktemp creates the file at mode 600; mv preserves the mode.
tmp=$(mktemp "${NETRC}.XXXXXX")
{
  netrc_drop_host "$HOST"
  printf '\nmachine %s\n  login %s\n  password %s\n' "$HOST" "$LOGIN" "$TOKEN"
} > "$tmp"
mv "$tmp" "$NETRC"

# Try SaaS path, then self-hosted (Bridge Client).
out=""
for prefix in "${MP_PREFIXES[@]}"; do
  URL="${SCHEME}://$(urlenc "$LOGIN"):$(urlenc "$TOKEN")@${BASE}${prefix}${MP_PATH}"
  if out=$(claude plugin marketplace add "$URL" 2>&1); then
    printf '%s\n' "$out"
    exit 0
  fi
done
printf '%s\n' "$out" >&2
exit 1
