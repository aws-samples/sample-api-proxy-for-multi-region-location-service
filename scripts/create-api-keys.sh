#!/usr/bin/env bash
#
# create-api-keys.sh — create one Amazon Location Service API key per region
# declared in the country-region mapping file, then assemble the
# LOCATION_API_KEYS JSON ({ region: key }).
#
# The set of regions is the single source of truth in the mapping file
# (its top-level keys). HOME_REGION must be one of them; it is included
# automatically since the convention requires it to appear in the mapping.
#
# Usage:
#   scripts/create-api-keys.sh [--write-secret] [options]
#
# Options (also settable via environment variables):
#   --mapping-file PATH   Mapping JSON        (env MAPPING_FILE;
#                                              default config/country-region-map.json)
#   --key-name-prefix STR create-key name prefix, region appended
#                                             (env KEY_NAME_PREFIX; default ProxyApiKey)
#   --expire-time TS      API key expiry, ISO-8601
#                                             (env EXPIRE_TIME; default 2028-08-08T08:08:08Z)
#   --secret-name NAME    Secrets Manager secret name
#                                             (env SECRET_NAME; default location-proxy/api-keys)
#   --deploy-region REG   Region that holds the Secrets Manager secret
#                                             (env DEPLOY_REGION; required with --write-secret)
#   --write-secret        Create/update the Secrets Manager secret with the assembled JSON
#   -h, --help            Show this help
#
# Without --write-secret the script only prints the LOCATION_API_KEYS JSON to
# stdout (all progress goes to stderr) so you can review it before storing it.
#
# Requires: aws CLI (configured), node (used to parse the mapping file).

set -euo pipefail

MAPPING_FILE="${MAPPING_FILE:-config/country-region-map.json}"
KEY_NAME_PREFIX="${KEY_NAME_PREFIX:-ProxyApiKey}"
EXPIRE_TIME="${EXPIRE_TIME:-2028-08-08T08:08:08Z}"
SECRET_NAME="${SECRET_NAME:-location-proxy/api-keys}"
DEPLOY_REGION="${DEPLOY_REGION:-}"
WRITE_SECRET=false

log() { echo "$@" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mapping-file) MAPPING_FILE="$2"; shift 2 ;;
    --key-name-prefix) KEY_NAME_PREFIX="$2"; shift 2 ;;
    --expire-time) EXPIRE_TIME="$2"; shift 2 ;;
    --secret-name) SECRET_NAME="$2"; shift 2 ;;
    --deploy-region) DEPLOY_REGION="$2"; shift 2 ;;
    --write-secret) WRITE_SECRET=true; shift ;;
    -h|--help) sed -n '2,/^set -euo/{/^set -euo/!p;}' "$0" | sed 's/^# \{0,1\}//; s/^#$//'; exit 0 ;;
    *) log "Unknown argument: $1"; exit 2 ;;
  esac
done

command -v aws >/dev/null 2>&1 || { log "❌ aws CLI not found"; exit 1; }
command -v node >/dev/null 2>&1 || { log "❌ node not found"; exit 1; }
[ -f "$MAPPING_FILE" ] || { log "❌ Mapping file not found: $MAPPING_FILE"; exit 1; }

# Region set = the mapping file's top-level keys (single source of truth).
REGIONS="$(node -e '
  const m = require(require("path").resolve(process.argv[1]));
  const keys = Object.keys(m);
  if (!keys.length) { console.error("Mapping file declares no regions"); process.exit(1); }
  process.stdout.write(keys.join("\n"));
' "$MAPPING_FILE")"

if $WRITE_SECRET && [ -z "$DEPLOY_REGION" ]; then
  log "❌ --write-secret requires --deploy-region (where the secret is stored)"
  exit 1
fi

log "Regions from ${MAPPING_FILE}:"
log "  $(echo "$REGIONS" | tr '\n' ' ')"

# Create one key per region and collect region -> key pairs.
PAIRS=""  # newline-separated "region<TAB>key"
while IFS= read -r region; do
  [ -n "$region" ] || continue
  log "→ Creating API key in ${region} ..."
  key="$(aws location create-key \
    --key-name "${KEY_NAME_PREFIX}-${region}" \
    --restrictions "{
      \"AllowActions\":[\"geo-places:*\",\"geo-maps:*\"],
      \"AllowResources\":[
        \"arn:aws:geo-maps:${region}::provider/*\",
        \"arn:aws:geo-places:${region}::provider/*\"
      ]}" \
    --expire-time "${EXPIRE_TIME}" \
    --region "${region}" \
    --query 'Key' --output text)"
  PAIRS="${PAIRS}${region}	${key}
"
done <<EOF
$REGIONS
EOF

# Assemble the LOCATION_API_KEYS JSON with node (handles quoting safely).
JSON="$(printf '%s' "$PAIRS" | node -e '
  const fs = require("fs");
  const out = {};
  for (const line of fs.readFileSync(0, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const [region, key] = line.split("\t");
    out[region] = key;
  }
  process.stdout.write(JSON.stringify(out));
')"

if $WRITE_SECRET; then
  log "→ Writing secret ${SECRET_NAME} in ${DEPLOY_REGION} ..."
  if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$DEPLOY_REGION" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value \
      --secret-id "$SECRET_NAME" --secret-string "$JSON" --region "$DEPLOY_REGION" >/dev/null
    log "✔ Updated existing secret ${SECRET_NAME}"
  else
    aws secretsmanager create-secret \
      --name "$SECRET_NAME" --secret-string "$JSON" --region "$DEPLOY_REGION" >/dev/null
    log "✔ Created secret ${SECRET_NAME}"
  fi
else
  log "ℹ Not writing to Secrets Manager (pass --write-secret to store it)."
  log "  LOCATION_API_KEYS JSON (also printed to stdout):"
fi

# The JSON is the only thing on stdout, so it can be captured/piped.
printf '%s\n' "$JSON"
