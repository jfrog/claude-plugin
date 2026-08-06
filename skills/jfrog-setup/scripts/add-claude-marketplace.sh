#!/usr/bin/env bash
# add-claude-marketplace.sh
# Register the JFrog unified Claude agent-plugin marketplace with Claude
# Code for the default `jf` server.
#
# Usage: bash add-claude-marketplace.sh
#
# Exit codes:
#   0  success
#   1  no default jf server, no access token, or no marketplace endpoint
#   3  required CLI missing
#   *  passthrough from `claude plugin marketplace add`

set -euo pipefail

tmp=""
trap 'rm -f "${tmp:-}"' EXIT

NETRC="$HOME/.netrc"
MP_PATH="/ml/core/api/v1/ai-registry/agent-plugins/custom/marketplace/claude-marketplace.json"
MP_PREFIXES=("" "/bridge-client")   # SaaS first, then self-hosted (Bridge Client)
WHOAMI_PATH="/access/api/v1/tokens/me"

urlenc() {
  local s="$1" out="" i c hex
  for (( i=0; i<${#s}; i++ )); do
    c="${s:i:1}"
    if [[ "$c" =~ [a-zA-Z0-9.~_-] ]]; then
      out+="$c"
    else
      printf -v hex '%%%02X' "'$c"; out+="$hex"
    fi
  done
  printf '%s' "$out"
}

# Drop the `machine <host>` block from ~/.netrc.
netrc_drop_host() {
  [[ -e "$NETRC" ]] || return 0
  awk -v h="$1" '
    $1 == "machine" && $2 == h        { skip=1; next }
    $1 == "machine" || $1 == "default" { skip=0 }
    !skip
  ' "$NETRC"
}

for cmd in jf claude jq base64; do
  command -v "$cmd" >/dev/null || { echo "ERROR: $cmd not on PATH" >&2; exit 3; }
done

default_info=$(jf config show 2>/dev/null | awk '
  /^Server ID:/           { sid=$NF }
  /^JFrog Platform URL:/  { url=$NF }
  /^Default:[[:space:]]*true/ { print sid, url; exit }
')
[[ -n "$default_info" ]] || {
  echo "ERROR: no default jf server. Run 'jf login' or 'jf config use <sid>'." >&2
  exit 1
}
SID="${default_info%% *}"
JFROG_URL="${default_info#* }"
JFROG_URL="${JFROG_URL%/}"
SCHEME="${JFROG_URL%%://*}"
BASE="${JFROG_URL#*://}"          # keeps any /path prefix
HOST="${BASE%%/*}"                # for netrc
[[ -n "$SID" && -n "$SCHEME" && -n "$HOST" ]] || {
  echo "ERROR: could not parse default jf server." >&2
  exit 1
}

# Decode in-process so the token never touches disk or stdout.
cfg=$(jf config export "$SID" 2>/dev/null | base64 -d 2>/dev/null || true)
[[ -n "$cfg" ]] || { echo "ERROR: could not read jf config for '$SID'." >&2; exit 1; }
TOKEN=$(jq -r '.accessToken // empty' <<<"$cfg")
[[ -n "$TOKEN" ]] || {
  echo "ERROR: no access token stored in jf config for '$SID'. Run 'jf login'"    >&2
  echo "       or 'jf config add --access-token <T>' to configure one, then retry." >&2
  exit 1
}

# Resolve the real username from the token's subject (works for JWT and
# reference tokens; format is "<issuer>/users/<username>").
subject=$(jf api --server-id "$SID" "$WHOAMI_PATH" 2>/dev/null | jq -r '.subject // empty')
LOGIN="${subject##*/users/}"
[[ -n "$LOGIN" && "$LOGIN" != "$subject" ]] || {
  echo "ERROR: could not resolve username for '$SID' via $WHOAMI_PATH." >&2
  exit 1
}

MARKETPLACE_PATH=""
for prefix in "${MP_PREFIXES[@]}"; do
  path="${prefix}${MP_PATH}"
  jf api --server-id "$SID" "$path" >/dev/null 2>&1 || continue
  MARKETPLACE_PATH="$path"
  break
done
[[ -n "$MARKETPLACE_PATH" ]] || {
  echo "ERROR: marketplace endpoint not found on '$SID'." >&2
  exit 1
}

# mktemp creates the file at mode 600; mv preserves the mode.
tmp=$(mktemp "${NETRC}.XXXXXX")
{
  netrc_drop_host "$HOST"
  printf '\nmachine %s\n  login %s\n  password %s\n' "$HOST" "$LOGIN" "$TOKEN"
} > "$tmp"
mv "$tmp" "$NETRC"

URL="${SCHEME}://$(urlenc "$LOGIN"):$(urlenc "$TOKEN")@${BASE}${MARKETPLACE_PATH}"

status=0
claude plugin marketplace add "$URL" || status=$?
exit "$status"
