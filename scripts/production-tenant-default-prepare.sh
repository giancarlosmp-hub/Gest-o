#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/.." && pwd); cd "$root"
die(){ printf '[tenant-default-prepare] ERROR %s\n' "$*" >&2; exit 1; }
: "${MODE:?MODE=dry-run or MODE=apply is required}"; [[ "$MODE" == dry-run || "$MODE" == apply ]] || die 'invalid MODE'
: "${EXPECTED_SHA:?EXPECTED_SHA is required}"; : "${API_IMAGE:?API_IMAGE is required}"
: "${DATABASE_URL:?temporary DML DATABASE_URL is required}"; : "${PRODUCTION_DB_CONTAINER_EXPECTED:?approved container is required}"
[[ "$EXPECTED_SHA" == $(git rev-parse HEAD) ]] || die 'EXPECTED_SHA mismatch'
[[ -z $(git status --porcelain) ]] || die 'worktree is dirty'
[[ $(git rev-parse origin/main) == "$EXPECTED_SHA" ]] || die 'origin/main/SHA mismatch'
[[ ${RUNTIME_TENANCY_MODE:-} == disabled ]] || die 'RUNTIME_TENANCY_MODE=disabled evidence is required'
[[ ${DATABASE_SCHEMA_MODE:-} == external ]] || die 'DATABASE_SCHEMA_MODE=external is required'
label=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$API_IMAGE" 2>/dev/null) || die 'local API image required'
[[ "$label" == "$EXPECTED_SHA" ]] || die 'API image revision label mismatch'
schema_result="${SCHEMA_EVIDENCE_DIR:-/var/log/gest-o/schema}/$EXPECTED_SHA/migrations/20260802120000_tenancy_control_plane/result.tsv"
rg -q $'^result\tPASS$' "$schema_result" || die 'control-plane schema PASS required'
operator_uid=$(id -u); operator_gid=$(id -g)
evidence="${TENANCY_EVIDENCE_DIR:-/var/log/gest-o/tenancy}/$EXPECTED_SHA/default-tenant"
mkdir -p "$evidence"; chmod 700 "$evidence"
[[ $(stat -c '%u:%g %a' "$evidence") == "$operator_uid:$operator_gid 700" ]] || die 'evidence directory ownership/mode mismatch'
[[ ! -f "$evidence/result.tsv" ]] || die 'completed evidence is immutable'
printf 'sha\t%s\nmode\t%s\nidentity_version\t1\n' "$EXPECTED_SHA" "$MODE" >"$evidence/metadata.tsv"
run_runner(){ docker run --rm --pull=never --user "$operator_uid:$operator_gid" --network container:"$PRODUCTION_DB_CONTAINER_EXPECTED" \
  -e DATABASE_URL -e TENANCY_MODE=default-only -e EVIDENCE_DIR=/evidence -e APP_COMMIT="$EXPECTED_SHA" \
  ${CONFIRM:+-e CONFIRM} ${EXPECTED_AGGREGATE_HASH:+-e EXPECTED_AGGREGATE_HASH} -e EXPECTED_SHA \
  -v "$evidence:/evidence" "$API_IMAGE" node apps/api/dist/scripts/prepareDefaultTenant.js "$@"; }
if [[ "$MODE" == dry-run ]]; then
  [[ -z ${CONFIRM:-} ]] || die 'dry-run accepts no write confirmation'
  run_runner --dry-run
  for evidence_file in metadata.tsv dry-run-result.tsv; do
    [[ $(stat -c '%u:%g' "$evidence/$evidence_file") == "$operator_uid:$operator_gid" ]] || die "evidence owner mismatch: $evidence_file"
    mode=$(stat -c '%a' "$evidence/$evidence_file"); (( (8#$mode & 8#007) == 0 )) || die "evidence permissions expose other: $evidence_file"
  done
  exit 0
fi
[[ ${CONFIRM:-} == PREPARE_DEFAULT_TENANT ]] || die 'CONFIRM=PREPARE_DEFAULT_TENANT required'
[[ ${DML_AUTHORITY_PROVISIONING:-} == APPROVED_TEMPORARY_ROLE ]] || die 'approved temporary least-privilege DML role is not provisioned'
: "${BACKUP_RESULT_FILE:?backup PASS required}"; : "${PREFLIGHT_RESULT_FILE:?preflight PASS required}"
rg -q '^PASS([[:space:]]|$)' "$BACKUP_RESULT_FILE" || die 'backup did not PASS'
rg -q '^PASS([[:space:]]|$)' "$PREFLIGHT_RESULT_FILE" || die 'preflight did not PASS'
[[ -f "$evidence/dry-run-result.tsv" ]] || die 'dry-run of same SHA required'
EXPECTED_AGGREGATE_HASH=$(awk -F '\t' 'NR==2{for(i=1;i<=NF;i++) if(h[i]=="expectedAggregateHash") print $i} NR==1{for(i=1;i<=NF;i++)h[i]=$i}' "$evidence/dry-run-result.tsv")
[[ "$EXPECTED_AGGREGATE_HASH" =~ ^[0-9a-f]{64}$ ]] || die 'dry-run hash missing'
export EXPECTED_AGGREGATE_HASH
run_runner --apply
for evidence_file in metadata.tsv dry-run-result.tsv result.tsv; do
  [[ $(stat -c '%u:%g' "$evidence/$evidence_file") == "$operator_uid:$operator_gid" ]] || die "evidence owner mismatch: $evidence_file"
  mode=$(stat -c '%a' "$evidence/$evidence_file"); (( (8#$mode & 8#007) == 0 )) || die "evidence permissions expose other: $evidence_file"
done
