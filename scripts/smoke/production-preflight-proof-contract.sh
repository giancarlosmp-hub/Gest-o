#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export PRODUCTION_PREFLIGHT_PROOF_ROOT="$TMP/proof"
export PRODUCTION_PREFLIGHT_PROOF_EXPECTED_OWNER="$(id -un):$(id -gn)"
source "$ROOT/scripts/lib/production-preflight-proof.sh"
sha=1111111111111111111111111111111111111111
db=salesforce_pro container=gest-o-db-clean-v2-20260717 volume=gest-o-pgdata-clean-v2-20260717
result="$PRODUCTION_PREFLIGHT_PROOF_ROOT/latest/result.tsv"
publish(){ production_preflight_proof_publish "$result" "$sha" "$db" "$container" "$volume" 60; }
valid(){ production_preflight_proof_validate "$result" "$sha" "$db" "$container" "$volume" 60; }
reject(){ if valid; then printf 'accepted invalid case: %s\n' "$1" >&2; exit 1; fi; }
publish; valid
rm -rf "$PRODUCTION_PREFLIGHT_PROOF_ROOT/latest"; reject missing_directory
publish; rm "$result"; reject missing_file
publish; mv "$result" "$TMP/regular"; ln -s "$TMP/regular" "$result"; reject file_symlink
publish; mv "$PRODUCTION_PREFLIGHT_PROOF_ROOT/latest" "$TMP/latest-real"; ln -s "$TMP/latest-real" "$PRODUCTION_PREFLIGHT_PROOF_ROOT/latest"; reject directory_symlink
rm -f "$PRODUCTION_PREFLIGHT_PROOF_ROOT/latest"; mv "$TMP/latest-real" "$PRODUCTION_PREFLIGHT_PROOF_ROOT/latest"
publish; rm "$result"; mkdir "$result"; reject non_regular; rm -rf "$result"
publish; chmod 644 "$result"; reject file_mode
publish; chmod 755 "$PRODUCTION_PREFLIGHT_PROOF_ROOT/latest"; reject directory_mode
if [[ $(id -u) == 0 ]]; then publish; chown nobody:nogroup "$result"; reject file_owner; fi
for replacement in 'STATUS|FAIL' 'SHA|2222222222222222222222222222222222222222' 'MODE|build' 'DATABASE|wrong' 'DB_CONTAINER|wrong' 'DB_VOLUME|wrong' 'FORMAT|2'; do
  publish; key=${replacement%%|*}; value=${replacement#*|}; sed -i "s/^$key\t.*/$key\t$value/" "$result"; reject "$key"
done
publish; sed -i '/^MODE/d' "$result"; reject missing_field
publish; printf 'STATUS\tPASS\n' >>"$result"; reject duplicate_field
publish; printf 'EXTRA\tNO\n' >>"$result"; reject extra_field
publish; printf 'malformed\n' >>"$result"; reject malformed
publish; sed -i 's/^STATUS\t.*/STATUS\tPASS\textra/' "$result"; reject extra_column
publish; created=$(( $(date +%s) + 60 )); sed -i "s/^CREATED_AT_EPOCH\t.*/CREATED_AT_EPOCH\t$created/;s/^BUNDLE_ID\t.*/BUNDLE_ID\t$sha-$created/" "$result"; reject future
publish; created=$(( $(date +%s) - 61 )); sed -i "s/^CREATED_AT_EPOCH\t.*/CREATED_AT_EPOCH\t$created/;s/^BUNDLE_ID\t.*/BUNDLE_ID\t$sha-$created/" "$result"; reject stale
publish; sed -i 's/^BUNDLE_ID\t.*/BUNDLE_ID\tpartial/' "$result"; reject partial
publish; before=$(sha256sum "$result")
PRODUCTION_PREFLIGHT_TEST_FAIL_PUBLICATION=true; export PRODUCTION_PREFLIGHT_TEST_FAIL_PUBLICATION
if publish; then exit 1; fi; [[ $(sha256sum "$result") == "$before" ]]
unset PRODUCTION_PREFLIGHT_TEST_FAIL_PUBLICATION; valid
printf 'production preflight proof contract: PASS\n'
