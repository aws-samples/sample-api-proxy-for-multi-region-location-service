#!/usr/bin/env bash
#
# delete-api-keys.sh — delete the Amazon Location Service API keys that
# create-api-keys.sh would create for a given mapping file (one key named
# <prefix>-<region> per region declared in the mapping).
#
# Use this to clean up leftover keys from earlier experiments before rerunning
# create-api-keys.sh.
#
# Usage:
#   scripts/delete-api-keys.sh [--yes] [options]
#
# Options (also settable via environment variables):
#   --mapping-file PATH   Mapping JSON        (env MAPPING_FILE;
#                                              default config/country-region-map.json)
#   --key-name-prefix STR create-key name prefix, region appended
#                                             (env KEY_NAME_PREFIX; default ProxyApiKey)
#   --no-force            Do NOT pass forceDelete (only deletes keys deactivated
#                         >90 days ago; default IS to force-delete)
#   --yes                 Actually delete. Without it, this is a dry run that only
#                         lists which keys would be deleted.
#   -h, --help            Show this help
#
# SAFETY:
#   - Default is a DRY RUN: nothing is deleted, keys to delete are listed.
#   - --force-delete (the default here) is IRREVERSIBLE and bypasses the API
#     key's 90-day deactivation requirement. Only use it for keys you are
#     certain are no longer in use (e.g. leftovers from setup experiments).
#   - Keys that don't exist are skipped, not treated as errors (leftovers may
#     be partial).
#
# Requires: aws CLI (configured), node (used to parse the mapping file).

set -euo pipefail

MAPPING_FILE="${MAPPING_FILE:-config/country-region-map.json}"
KEY_NAME_PREFIX="${KEY_NAME_PREFIX:-ProxyApiKey}"
FORCE_DELETE=true
DO_DELETE=false

log() { echo "$@" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mapping-file) MAPPING_FILE="$2"; shift 2 ;;
    --key-name-prefix) KEY_NAME_PREFIX="$2"; shift 2 ;;
    --no-force) FORCE_DELETE=false; shift ;;
    --yes) DO_DELETE=true; shift ;;
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

log "Regions from ${MAPPING_FILE}:"
log "  $(echo "$REGIONS" | tr '\n' ' ')"
$FORCE_DELETE && log "Mode: force-delete (bypasses 90-day rule)" || log "Mode: no-force (only keys deactivated >90 days)"
$DO_DELETE || log "DRY RUN — nothing will be deleted. Re-run with --yes to delete."
log ""

FORCE_ARG=""
$FORCE_DELETE && FORCE_ARG="--force-delete"

deleted=0
skipped=0
failed=0
while IFS= read -r region; do
  [ -n "$region" ] || continue
  key_name="${KEY_NAME_PREFIX}-${region}"

  # Does the key exist in this region?
  if ! aws location describe-key --key-name "$key_name" --region "$region" >/dev/null 2>&1; then
    log "· ${region}: no key named ${key_name} — skip"
    skipped=$((skipped + 1))
    continue
  fi

  if ! $DO_DELETE; then
    log "would delete: ${key_name} (${region})"
    continue
  fi

  log "→ deleting ${key_name} (${region}) ..."
  if aws location delete-key --key-name "$key_name" $FORCE_ARG --region "$region" >/dev/null 2>&1; then
    log "  ✔ deleted"
    deleted=$((deleted + 1))
  else
    log "  ✗ failed to delete ${key_name} in ${region}"
    failed=$((failed + 1))
  fi
done <<EOF
$REGIONS
EOF

log ""
if $DO_DELETE; then
  log "Done. deleted=${deleted} skipped(not found)=${skipped} failed=${failed}"
  [ "$failed" -eq 0 ] || exit 1
else
  log "Dry run complete. Re-run with --yes to delete the keys listed above."
fi
