#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/.." && pwd); cd "$root"
readonly MIGRATION_ID=20260827190000_add_erp_order_manual_resolution
readonly CONFIRMATION=APPLY_PR827_SCHEMA
die(){ printf '[pr827-schema] ERROR %s\n' "$*" >&2; exit 1; }
source scripts/lib/pr827-backup-proof.sh
if [[ ${1:-} == --validate-backup-override ]]; then
 : "${PR827_BACKUP_FIXTURE_ROOT:?PR827_BACKUP_FIXTURE_ROOT is required}"
 : "${BACKUP_RESULT_FILE:?BACKUP_RESULT_FILE is required}"
 pr827_backup_fixture_authorize "$PR827_BACKUP_FIXTURE_ROOT" "$root" "$BACKUP_RESULT_FILE" || die 'protected backup fixture boundary is invalid'
 echo BACKUP_OVERRIDE_AUTHORIZATION=PASS
 exit 0
fi
MODE=${MODE:-preview}; [[ $MODE == preview || $MODE == apply ]] || die 'MODE must be preview or apply'
: "${PRODUCTION_ENV_FILE:?validated PRODUCTION_ENV_FILE is required}"
: "${PRODUCTION_ENV_SOURCE:?validated PRODUCTION_ENV_SOURCE is required}"
: "${ERP_PRODUCTION_ENV_SOURCE:?validated ERP_PRODUCTION_ENV_SOURCE is required}"
ENV_FILE=$PRODUCTION_ENV_FILE
[[ $PRODUCTION_ENV_SOURCE == legacy_copy || $PRODUCTION_ENV_SOURCE == canonical ]] || die 'environment source is invalid'
case "$ERP_PRODUCTION_ENV_SOURCE:$PRODUCTION_ENV_SOURCE" in
 legacy_build_only:legacy_copy|canonical:canonical) ;;
 *) echo PR827_ENV_SOURCE_CLASSIFICATION=REJECTED; die 'environment source classification is inconsistent' ;;
esac
[[ -f $ENV_FILE && ! -L $ENV_FILE ]] || die 'production environment is not a regular non-symlink file'
[[ $(stat -c '%U:%G' "$ENV_FILE") == "${ERP_ENV_EXPECTED_OWNER:-root:root}" ]] || die 'production environment owner is invalid'
[[ $(stat -c '%a' "$ENV_FILE") == "${ERP_ENV_EXPECTED_MODE:-600}" ]] || die 'production environment mode is invalid'
env_hash_before=$(sha256sum "$ENV_FILE"|cut -d' ' -f1); catalog_file=''; tmp=''; stage=''
cleanup(){ local rc=$?; [[ -z $catalog_file ]]||rm -f "$catalog_file"; [[ -z ${transaction_catalog:-} ]]||rm -f "$transaction_catalog"; [[ -z $tmp ]]||rm -rf "$tmp"; [[ -z $stage || ! -e $stage ]]||rm -rf "$stage"; if [[ -f $ENV_FILE && ! -L $ENV_FILE && $(sha256sum "$ENV_FILE"|cut -d' ' -f1) == "$env_hash_before" ]]; then echo PR827_ENV_IMMUTABLE=PASS; else echo PR827_ENV_IMMUTABLE=FAIL >&2; rc=1; fi; exit "$rc"; }; trap cleanup EXIT
awk '/^[[:space:]]*($|#)/{next} /^[A-Za-z_][A-Za-z0-9_]*=/{next} {exit 1}' "$ENV_FILE" || die 'production environment syntax is invalid'
[[ $(awk -F= '$1=="DATABASE_URL"{n++} END{print n+0}' "$ENV_FILE") -eq 1 ]] || die 'DATABASE_URL contract cardinality is invalid'
set -a; source "$ENV_FILE"; set +a
: "${DATABASE_URL:?DATABASE_URL is required}"
echo "ERP_PRODUCTION_ENV_SOURCE=$ERP_PRODUCTION_ENV_SOURCE"; echo "PR827_ENV_SOURCE=$PRODUCTION_ENV_SOURCE"; echo PR827_ENV_SOURCE_CLASSIFICATION=VALID; echo PR827_ENV_METADATA=VALID; echo PR827_DATABASE_URL_CONTRACT=PASS
: "${EXPECTED_SHA:?EXPECTED_SHA is required}"
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?PRODUCTION_DB_CONTAINER_EXPECTED is required}"; : "${PRODUCTION_DB_NAME_EXPECTED:?PRODUCTION_DB_NAME_EXPECTED is required}"
: "${SCHEMA_EVIDENCE_DIR:?SCHEMA_EVIDENCE_DIR is required}"
[[ $PRODUCTION_DB_NAME_EXPECTED == salesforce_pro && ${DATABASE_SCHEMA_MODE:-} == external ]] || die 'database/schema is not authorized'
[[ ${MIGRATION_ID_REQUESTED:-$MIGRATION_ID} == $MIGRATION_ID ]] || die 'migration is not allowlisted'
[[ $(git rev-parse HEAD) == "$EXPECTED_SHA" && $(git rev-parse origin/main) == "$EXPECTED_SHA" ]] || die 'SHA is not frozen origin/main'
[[ -z $(git status --porcelain) ]] || die 'worktree is dirty'
registry=$(node scripts/production-schema-migrations.mjs "$MIGRATION_ID") || die 'allowlist/checksum validation failed'
migration=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).absolutePath)' "$registry")
checksum=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sha256)' "$registry")
baseline_path=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).productionBaseline.path)' "$registry")
baseline_checksum=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).productionBaseline.sha256)' "$registry")

# The legacy ledger is a protected directory of immutable, one-row evidence bundles.
history=$SCHEMA_EVIDENCE_DIR; [[ -d $history && ! -L $history ]] || die 'legacy history location is invalid'
[[ $(stat -c '%U:%G' "$history") == "${APPLIED_TSV_EXPECTED_OWNER:-root:root}" ]] || die 'legacy history owner is invalid'
history_mode=$(stat -c '%a' "$history")
case "$history_mode" in
 700) history_mode_class=OWNER_PRIVATE ;;
 750) history_mode_class=GROUP_TRAVERSE ;;
 755) history_mode_class=PROTECTED_BUNDLE_ROOT ;;
 *) history_mode_class=UNKNOWN ;;
esac
echo LEGACY_HISTORY_VARIABLE=SCHEMA_EVIDENCE_DIR_MODE
echo LEGACY_HISTORY_VALUES_ALLOWED=700_OWNER_PRIVATE,750_GROUP_TRAVERSE,755_PROTECTED_BUNDLE_ROOT
echo "LEGACY_HISTORY_VALUE_RECEIVED=$history_mode_class"
[[ $history_mode_class != UNKNOWN ]] || { echo LEGACY_HISTORY_REJECTION_STAGE=history_root_metadata; die 'legacy history mode is invalid'; }
echo LEGACY_HISTORY_REJECTION_STAGE=NONE
source scripts/lib/pr827-legacy-history.sh
baseline_count=0; current_count=0; current_invalid=0; baseline_file=''
while IFS= read -r -d '' f; do
 record_path=$(awk -F $'\t' 'NR==1{print $3}' "$f" 2>/dev/null || :)
 case "$record_path" in
  "$baseline_path") pr827_validate_record "$f" "$baseline_path" "$baseline_checksum" || { echo PR827_LEGACY_HISTORY_STATE=HISTORY_DIVERGENT; echo "HISTORY_DIVERGENCE_CATEGORY=$history_failure"; die 'legacy baseline history is malformed or checksum-divergent'; }; baseline_file=$f; baseline_count=$((baseline_count+1)) ;;
  "apps/api/prisma/migrations/$MIGRATION_ID/migration.sql") current_count=$((current_count+1)); pr827_validate_record "$f" "$record_path" "$checksum" || current_invalid=1 ;;
  *) echo PR827_LEGACY_HISTORY_STATE=HISTORY_DIVERGENT; echo HISTORY_DIVERGENCE_CATEGORY=MIGRATION_PATH_INVALID; die 'legacy history format or migration is not allowlisted' ;;
 esac
done < <(find "$history" -mindepth 2 -maxdepth 2 -name applied.tsv -print0)
(( baseline_count == 1 )) || { echo PR827_LEGACY_HISTORY_STATE=HISTORY_DIVERGENT; (( baseline_count == 0 )) && echo HISTORY_DIVERGENCE_CATEGORY=BUNDLE_ABSENT || echo HISTORY_DIVERGENCE_CATEGORY=BUNDLE_AMBIGUOUS; die 'legacy production baseline is absent or divergent'; }
(( current_count <= 1 )) || { echo PR827_LEGACY_HISTORY_STATE=HISTORY_DIVERGENT; echo HISTORY_DIVERGENCE_CATEGORY=BUNDLE_AMBIGUOUS; die 'legacy history is divergent'; }
echo "PR827_HISTORICAL_FORMAT_VERSION=$history_format"
echo HISTORY_DIVERGENCE_CATEGORY=NONE
history_state=ABSENT
if (( current_count == 1 && current_invalid == 0 )); then history_state=APPLIED_VALID
elif (( current_count == 1 )); then history_state=APPLIED_INVALID
fi
echo "PR827_LEGACY_HISTORY_STATE=$history_state"; echo PR827_PRODUCTION_BASELINE=PASS
psql_admin(){ docker exec --user postgres -i "$PRODUCTION_DB_CONTAINER_EXPECTED" psql -X -v ON_ERROR_STOP=1 -d "$PRODUCTION_DB_NAME_EXPECTED" "$@"; }
[[ $(psql_admin -Atc "SELECT current_database()||E'\\t'||current_user") == $'salesforce_pro\tpostgres' ]] || die 'database/admin identity mismatch'
diagnostics=$(psql_admin -qAtF $'\t' -f - <scripts/sql/pr827-connection-diagnostics.sql); printf '%s\n' "$diagnostics"
[[ $(awk -F$'\t' '$1=="PRISMA_LEDGER_LOCATION"{print $2}' <<<"$diagnostics") == ABSENT ]] || die 'Prisma ledger must remain absent'
baseline_catalog=$(psql_admin -qAtF $'\t' -f - <scripts/pr827-baseline-catalog.sql); printf '%s\n' "$baseline_catalog"; [[ $baseline_catalog == $'PR827_BASELINE_CATALOG_STATE\tVALID' ]] || die 'required production baseline catalog is invalid'
catalog_file=$(mktemp); psql_admin -qAtF $'\t' -f - <scripts/pr827-schema-catalog.sql | sed '/^$/d' >"$catalog_file"
if [[ ! -s $catalog_file ]]; then catalog_state=ABSENT; elif node scripts/pr827-schema-catalog-validate.mjs "$catalog_file" >/dev/null 2>&1; then catalog_state=COMPLETE; else catalog_state=PARTIAL; fi
echo "PR827_CATALOG_STATE=$catalog_state"
if [[ $history_state == APPLIED_VALID && $catalog_state == COMPLETE ]]; then echo PR827_SCHEMA_PREFLIGHT=PASS; [[ $MODE == preview ]] && exit 0; idempotent=1
elif [[ $history_state == ABSENT && $catalog_state == ABSENT ]]; then echo READY_TO_APPLY; echo PR827_SCHEMA_PREFLIGHT=PASS; [[ $MODE == preview ]] && exit 0; idempotent=0
else echo HISTORY_DIVERGENCE_CATEGORY=HISTORY_CATALOG_DIVERGENCE; die 'history/catalog state is divergent'; fi

[[ ${CONFIRM:-} == $CONFIRMATION ]] || die "CONFIRM=$CONFIRMATION required"
: "${API_IMAGE:?API_IMAGE is required}"; docker image inspect "$API_IMAGE" >/dev/null 2>&1 || die 'pinned API image absent'
[[ $(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$API_IMAGE") == "$EXPECTED_SHA" ]] || die 'image/SHA mismatch'
: "${BACKUP_RESULT_FILE:?BACKUP_RESULT_FILE is required}"
# The production contract remains fixed. The only override is a disposable
# checkout rooted below /tmp, used by this repository's PostgreSQL harness.
if [[ -n ${PR827_BACKUP_FIXTURE_ROOT:-} ]]; then
 echo BACKUP_OVERRIDE_REQUESTED=YES
 fixture_real=$(realpath "$PR827_BACKUP_FIXTURE_ROOT")
 runner_real=$(realpath "$root")
 pr827_backup_fixture_authorize "$fixture_real" "$runner_real" "$BACKUP_RESULT_FILE" || die 'protected backup fixture boundary is invalid'
 echo BACKUP_OVERRIDE_HARNESS_ROOT_CLASS=EXTERNAL_TMP
 echo BACKUP_OVERRIDE_CHECKOUT_CLASS=EXPECTED_DISPOSABLE_CHECKOUT
 echo BACKUP_OVERRIDE_RESULT_CLASS=EXPECTED_DISPOSABLE_BACKUP_RESULT
 export PR827_BACKUP_PROOF_ROOT="$fixture_real/backup"
 fixture_owner=${PR827_BACKUP_FIXTURE_EXPECTED_OWNER:-$(id -un):$(id -gn)}
 [[ "$fixture_owner" =~ ^[A-Za-z_][A-Za-z0-9_-]*:[A-Za-z_][A-Za-z0-9_-]*$ ]] || die 'protected backup fixture owner is invalid'
 export PR827_BACKUP_PROOF_EXPECTED_OWNER="$fixture_owner"
 echo BACKUP_OVERRIDE_AUTHORIZATION=PASS
else
 unset PR827_BACKUP_PROOF_ROOT PR827_BACKUP_PROOF_EXPECTED_OWNER
 echo BACKUP_OVERRIDE_REQUESTED=NO
 echo BACKUP_OVERRIDE_AUTHORIZATION=PRODUCTION_DEFAULTS
fi
pr827_backup_proof_validate "$BACKUP_RESULT_FILE" "$EXPECTED_SHA" "${BACKUP_MAX_AGE_SECONDS:-3600}" || die 'protected backup proof required'
if (( idempotent == 0 )); then
 # Revalidate the mutable catalog and history immediately before granting write authority.
 [[ $(sha256sum "$ENV_FILE" | cut -d' ' -f1) == "$env_hash_before" ]] || die 'environment changed before apply'
 [[ $(git rev-parse HEAD) == "$EXPECTED_SHA" && $(git rev-parse origin/main) == "$EXPECTED_SHA" && -z $(git status --porcelain) ]] || die 'SHA/worktree changed before apply'
 [[ $(sha256sum "$migration" | cut -d' ' -f1) == "$checksum" ]] || die 'migration checksum changed before apply'
 pr827_validate_record "$baseline_file" "$baseline_path" "$baseline_checksum" || die 'legacy baseline history changed before apply'
 [[ $(psql_admin -Atc "SELECT current_database()||E'\\t'||current_user") == $'salesforce_pro\tpostgres' ]] || die 'database/admin identity changed before apply'
 [[ $(psql_admin -qAtF $'\t' -f - <scripts/sql/pr827-connection-diagnostics.sql | awk -F$'\t' '$1=="PRISMA_LEDGER_LOCATION"{print $2}') == ABSENT ]] || die 'Prisma ledger appeared before apply'
 [[ $(psql_admin -qAtF $'\t' -f - <scripts/pr827-baseline-catalog.sql) == $'PR827_BASELINE_CATALOG_STATE\tVALID' ]] || die 'baseline changed before apply'
 psql_admin -qAtF $'\t' -f - <scripts/pr827-schema-catalog.sql >"$catalog_file"; [[ ! -s $catalog_file ]] || die 'target catalog changed before apply'
 ! find "$history" -mindepth 2 -maxdepth 2 -name applied.tsv -exec grep -Fl "apps/api/prisma/migrations/$MIGRATION_ID/migration.sql" {} + | grep -q . || die 'history changed before apply'
 out="$history/$EXPECTED_SHA"; stage="$history/.pr827-$EXPECTED_SHA.tmp"
 [[ ! -e $out && ! -e $stage ]] || die 'history target already exists'; mkdir -m 700 "$stage"
 printf '%s  %s\n' "$checksum" "apps/api/prisma/migrations/$MIGRATION_ID/migration.sql" >"$stage/migration.sha256"; chmod 600 "$stage/migration.sha256"
 printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$EXPECTED_SHA" "apps/api/prisma/migrations/$MIGRATION_ID/migration.sql" >"$stage/applied.tsv"; chmod 600 "$stage/applied.tsv"
 python3 - "$stage" <<'PY'
import os, sys
for name in ('migration.sha256','applied.tsv'):
    with open(os.path.join(sys.argv[1], name), 'rb') as f: os.fsync(f.fileno())
fd=os.open(sys.argv[1], os.O_RDONLY); os.fsync(fd); os.close(fd)
PY
 # Keep one psql session and transaction open: approve DDL, atomically publish the
 # durable directory on the host, then commit. Publication failure sends ROLLBACK.
 transaction_catalog=$(mktemp)
 coproc PR827_TX { psql_admin -qAtF $'\t' -f -; }
 tx_in=${PR827_TX[1]}; tx_out=${PR827_TX[0]}; tx_pid=$PR827_TX_PID
 { echo 'BEGIN;'; cat "$migration"; sed '1d;$d' scripts/pr827-schema-catalog.sql; echo "SELECT 'PR827_DDL_APPROVED';"; } >&"$tx_in"
 approved=''; while IFS= read -r line <&"$tx_out"; do [[ $line == PR827_DDL_APPROVED ]] && { approved=1; break; }; printf '%s\n' "$line" >>"$transaction_catalog"; done
 if [[ -z $approved ]] || ! node scripts/pr827-schema-catalog-validate.mjs "$transaction_catalog" >/dev/null 2>&1; then exec {tx_in}>&-; wait "$tx_pid" || :; rm -rf "$stage"; die 'DDL/exact catalog approval failed before history publication'; fi
 if ! mv "$stage" "$out"; then echo 'ROLLBACK;' >&"$tx_in" || :; exec {tx_in}>&-; wait "$tx_pid" || :; rm -rf "$stage" "$out"; die 'atomic history publication failed; DDL rolled back'; fi
 python3 - "$history" <<'PY'
import os, sys
fd=os.open(sys.argv[1], os.O_RDONLY); os.fsync(fd); os.close(fd)
PY
 echo 'COMMIT;' >&"$tx_in"; exec {tx_in}>&-
 if ! wait "$tx_pid"; then rm -rf "$out"; die 'database commit failed; history publication withdrawn'; fi
fi
psql_admin -qAtF $'\t' -f - <scripts/pr827-schema-catalog.sql >"$catalog_file"; node scripts/pr827-schema-catalog-validate.mjs "$catalog_file" >/dev/null || die 'catalog postcondition failed'
tmp=$(mktemp -d); docker run --rm --pull=never --network container:"$PRODUCTION_DB_CONTAINER_EXPECTED" -e DATABASE_URL "$API_IMAGE" ./node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/post.raw.sql"
node scripts/pr827-post-diff-filter.mjs "$tmp/post.raw.sql" "$tmp/post.sql"; [[ ! -s $tmp/post.sql ]] || die 'PR827 managed post-diff is not empty'
echo PR827_MIGRATION_APPLY=PASS; echo PR827_LEGACY_HISTORY=PASS; echo PR827_MIGRATION_CATALOG=PASS; echo PR827_MIGRATION_POST_DIFF=PASS; echo PR827_MIGRATION_IDEMPOTENCY=PASS
