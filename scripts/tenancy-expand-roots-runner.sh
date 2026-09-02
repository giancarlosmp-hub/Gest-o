#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root=$(cd "$(dirname "$0")/.." && pwd); cd "$root"
readonly MIGRATION_ID=20260808120000_tenancy_expand_roots
readonly CONFIRMATION=APPLY_TENANCY_EXPAND_ROOTS
die(){ printf '[tenancy-expand-roots] ERROR %s\n' "$*" >&2; exit 1; }
MODE=${MODE:-preview}; [[ $MODE == preview || $MODE == apply ]] || die 'MODE must be preview or apply'
: "${EXPECTED_SHA:?EXPECTED_SHA is required}"; [[ $EXPECTED_SHA =~ ^[0-9a-f]{40}$ ]] || die 'EXPECTED_SHA must be a full SHA'
: "${API_IMAGE:?API_IMAGE is required}"; : "${DATABASE_URL:?DATABASE_URL is required}"
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?container allowlist is required}"; : "${PRODUCTION_DB_NAME_EXPECTED:?database allowlist is required}"
: "${SCHEMA_EVIDENCE_DIR:?SCHEMA_EVIDENCE_DIR is required}"
[[ $PRODUCTION_DB_NAME_EXPECTED == salesforce_pro && $PRODUCTION_DB_CONTAINER_EXPECTED == gest-o-db-clean-v2-20260717 ]] || die 'database/container not allowlisted'
[[ ${DATABASE_SCHEMA_MODE:-} == external ]] || die 'DATABASE_SCHEMA_MODE=external required'
[[ ${RUNTIME_TENANCY_MODE:-} == disabled && ${TENANCY_MODE:-disabled} == disabled ]] || die 'tenancy must remain disabled'
[[ ${MIGRATION_ID_REQUESTED:-$MIGRATION_ID} == $MIGRATION_ID ]] || die 'migration is not allowlisted'
[[ $(git rev-parse HEAD) == "$EXPECTED_SHA" && $(git rev-parse origin/main) == "$EXPECTED_SHA" ]] || die 'HEAD/origin/main/SHA mismatch'
[[ -z $(git status --porcelain) ]] || die 'worktree is dirty'
registry=$(node scripts/production-schema-migrations.mjs "$MIGRATION_ID") || die 'registry/checksum invalid'
migration=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).absolutePath)' "$registry")
checksum=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sha256)' "$registry")
evidence_version=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).evidenceVersion))' "$registry")
docker image inspect "$API_IMAGE" >/dev/null 2>&1 || die 'local pinned API image absent'
[[ $(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$API_IMAGE") == "$EXPECTED_SHA" ]] || die 'image/SHA mismatch'
evidence_root=$SCHEMA_EVIDENCE_DIR; [[ -d $evidence_root && ! -L $evidence_root ]] || die 'evidence root must be an existing non-symlink directory'
case $(stat -c %a "$evidence_root") in 700|750|755) ;; *) die 'evidence root mode is not protected';; esac
bundle="$evidence_root/$EXPECTED_SHA/migrations/$MIGRATION_ID"; mkdir -p "$bundle"; [[ -d $bundle && ! -L $bundle ]] || die 'evidence bundle is invalid'; chmod 700 "$bundle"
psql_admin(){ docker exec --user postgres -i "$PRODUCTION_DB_CONTAINER_EXPECTED" psql -X -v ON_ERROR_STOP=1 -d "$PRODUCTION_DB_NAME_EXPECTED" "$@"; }
[[ $(psql_admin -Atc "SELECT current_database()||E'\\t'||current_user") == "$PRODUCTION_DB_NAME_EXPECTED"$'\tpostgres' ]] || die 'database/admin identity mismatch'
# The external contract is deliberately ledgerless. Control plane must be exact.
[[ $(psql_admin -Atc "SELECT to_regclass('public._prisma_migrations') IS NULL") == t ]] || die 'Prisma ledger must remain absent'
cp_catalog=$(mktemp); before=$(mktemp); after=$(mktemp); tmp=$(mktemp -d)
cleanup(){ rm -f "$cp_catalog" "$before" "$after"; rm -rf "$tmp"; }; trap cleanup EXIT
psql_admin -qAtF $'\t' -f - <scripts/control-plane-catalog.sql >"$cp_catalog"
node scripts/control-plane-catalog-validate.mjs "$cp_catalog" >/dev/null || die 'control-plane predecessor absent or divergent'
psql_admin -qAtF $'\t' -f - <scripts/pr827-schema-catalog.sql >"$tmp/pr827.tsv"
node scripts/pr827-schema-catalog-validate.mjs "$tmp/pr827.tsv" >/dev/null || die 'PR827 must remain applied and exact'
psql_admin -qAtF $'\t' -f - <scripts/tenancy-expand-roots-catalog.sql >"$before"
if [[ ! -s $before ]]; then state=ABSENT_COMPATIBLE
elif node scripts/tenancy-expand-roots-catalog-validate.mjs "$before" >/dev/null 2>&1; then state=ALREADY_APPLIED
else die 'target catalog is partial or divergent'; fi
write_file(){ local path=$1; shift; [[ ! -L $path ]]; printf '%s' "$*" >"$path"; chmod 600 "$path"; }
write_file "$bundle/metadata.tsv" $'sha\t'"$EXPECTED_SHA"$'\nmigration_id\t'"$MIGRATION_ID"$'\nevidence_version\t'"$evidence_version"$'\n'
write_file "$bundle/migration.sha256" "$checksum  apps/api/prisma/migrations/$MIGRATION_ID/migration.sql"$'\n'
cp "$before" "$bundle/catalog-before.tsv"; chmod 600 "$bundle/catalog-before.tsv"
docker run --rm --pull=never --network container:"$PRODUCTION_DB_CONTAINER_EXPECTED" -e DATABASE_URL "$API_IMAGE" ./node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/diff.raw.sql"
grep -Eiq '(postgres(?:ql)?://|password=|DATABASE_URL)' "$tmp/diff.raw.sql" && die 'unsanitized secret in diff'
cp "$tmp/diff.raw.sql" "$bundle/preview-diff.sql"; chmod 600 "$bundle/preview-diff.sql"
write_file "$bundle/preview-result.tsv" $'result\tPASS\nstate\t'"$state"$'\nsha\t'"$EXPECTED_SHA"$'\nmigration_id\t'"$MIGRATION_ID"$'\nchecksum\t'"$checksum"$'\n'
[[ $MODE == preview ]] && { echo "TENANCY_EXPAND_ROOTS_PREVIEW=PASS state=$state"; exit 0; }
[[ ${GITHUB_ENVIRONMENT:-} == production-schema ]] || die 'protected production-schema environment required'
[[ ${CONFIRM:-} == $CONFIRMATION ]] || die "CONFIRM=$CONFIRMATION required"
: "${BACKUP_RESULT_FILE:?BACKUP_RESULT_FILE required}"; : "${PREFLIGHT_RESULT_FILE:?PREFLIGHT_RESULT_FILE required}"
source scripts/lib/pr827-backup-proof.sh
pr827_backup_proof_validate "$BACKUP_RESULT_FILE" "$EXPECTED_SHA" "${BACKUP_MAX_AGE_SECONDS:-3600}" || die 'recent protected backup proof invalid'
source scripts/lib/production-preflight-proof.sh
production_preflight_proof_validate "$PREFLIGHT_RESULT_FILE" "$EXPECTED_SHA" "$PRODUCTION_DB_NAME_EXPECTED" \
  "$PRODUCTION_DB_CONTAINER_EXPECTED" "${PRODUCTION_DB_VOLUME_EXPECTED:?volume allowlist is required}" \
  "${PREFLIGHT_MAX_AGE_SECONDS:-900}" || die 'protected preflight result invalid'
[[ $(awk -F$'\t' '$1=="sha"{print $2}' "$bundle/preview-result.tsv") == "$EXPECTED_SHA" ]] || die 'same-SHA preview required'
[[ $(awk -F$'\t' '$1=="checksum"{print $2}' "$bundle/preview-result.tsv") == "$checksum" ]] || die 'preview checksum mismatch'
if [[ $state == ABSENT_COMPATIBLE ]]; then
  # Exactly one pinned SQL file, in one transaction. psql's ON_ERROR_STOP makes any
  # intermediate error roll the whole expansion back.
  { echo 'BEGIN;'; cat "$migration"; echo 'COMMIT;'; } | psql_admin >"$bundle/apply.log" 2>&1 || die 'atomic migration failed'
else write_file "$bundle/apply.log" $'ALREADY_APPLIED: no DDL executed\n'; fi
chmod 600 "$bundle/apply.log"
psql_admin -qAtF $'\t' -f - <scripts/tenancy-expand-roots-catalog.sql >"$after"
node scripts/tenancy-expand-roots-catalog-validate.mjs "$after" >/dev/null || die 'post-apply catalog not exact'
cp "$after" "$bundle/catalog-after.tsv"; chmod 600 "$bundle/catalog-after.tsv"
docker run --rm --pull=never --network container:"$PRODUCTION_DB_CONTAINER_EXPECTED" -e DATABASE_URL "$API_IMAGE" ./node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$bundle/post-apply-diff.sql"
chmod 600 "$bundle/post-apply-diff.sql"; node scripts/schema-diff-filter.mjs "$bundle/post-apply-diff.sql" "$tmp/managed.sql" post
[[ $(psql_admin -Atc "SELECT to_regclass('public._prisma_migrations') IS NULL") == t ]] || die 'Prisma ledger was created'
write_file "$bundle/result.tsv.tmp" $'result\tPASS\nstate\t'"$([[ $state == ALREADY_APPLIED ]] && echo ALREADY_APPLIED || echo APPLIED_ONCE)"$'\ntenancy_mode\tdisabled\nbusiness_rows_modified\tNO\n'
mv "$bundle/result.tsv.tmp" "$bundle/result.tsv"
# Reuse the cutover reader as the final publication contract check.
source scripts/schema-evidence-validation.sh
validate_tenancy_expand_roots_evidence "$bundle" "$EXPECTED_SHA" "$evidence_root" || die 'published evidence bundle failed shared validation'
echo TENANCY_EXPAND_ROOTS_APPLY=PASS
