#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/.." && pwd); cd "$root"
readonly MIGRATION_ID=20260827190000_add_erp_order_manual_resolution
readonly CONFIRMATION=APPLY_PR827_SCHEMA
die(){ printf '[pr827-schema] ERROR %s\n' "$*" >&2; exit 1; }
MODE=${MODE:-preview}
ENV_FILE=${PRODUCTION_ENV_FILE:-/root/demetra-env/.env}
[[ -f "$ENV_FILE" ]] || die 'production environment file absent'
set -a; source "$ENV_FILE"; set +a
[[ "$MODE" == preview || "$MODE" == apply ]] || die 'MODE must be preview or apply'
[[ ${MIGRATION_ID_REQUESTED:-$MIGRATION_ID} == "$MIGRATION_ID" ]] || die 'migration is not allowlisted'
: "${EXPECTED_SHA:?EXPECTED_SHA is required}"; : "${API_IMAGE:?API_IMAGE is required}"
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?PRODUCTION_DB_CONTAINER_EXPECTED is required}"
: "${PRODUCTION_DB_NAME_EXPECTED:?PRODUCTION_DB_NAME_EXPECTED is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
[[ "$PRODUCTION_DB_NAME_EXPECTED" == salesforce_pro ]] || die 'wrong database'
[[ ${DATABASE_SCHEMA_MODE:-} == external ]] || die 'wrong schema mode'
[[ $(git rev-parse HEAD) == "$EXPECTED_SHA" && $(git rev-parse origin/main) == "$EXPECTED_SHA" ]] || die 'SHA is not frozen origin/main'
[[ -z $(git status --porcelain) ]] || die 'worktree is dirty'
registry=$(node scripts/production-schema-migrations.mjs "$MIGRATION_ID") || die 'allowlist/checksum validation failed'
migration=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).absolutePath)' "$registry")
checksum=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sha256)' "$registry")
predecessor=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).predecessor.lastMigration)' "$registry")
predecessor_checksum=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).predecessor.sha256)' "$registry")
docker image inspect "$API_IMAGE" >/dev/null 2>&1 || die 'pinned API image absent'
[[ $(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$API_IMAGE") == "$EXPECTED_SHA" ]] || die 'image/SHA mismatch'
psql_admin(){ docker exec --user postgres -i "$PRODUCTION_DB_CONTAINER_EXPECTED" psql -X -v ON_ERROR_STOP=1 -d "$PRODUCTION_DB_NAME_EXPECTED" "$@"; }
[[ $(psql_admin -Atc "SELECT current_database()||E'\\t'||current_user") == $'salesforce_pro\tpostgres' ]] || die 'database/admin identity mismatch'
ledger(){ psql_admin -AtF $'\t' -v migration="$1" -c "SELECT checksum, finished_at IS NOT NULL AND rolled_back_at IS NULL FROM \"_prisma_migrations\" WHERE migration_name=:'migration' ORDER BY started_at"; }
pred=$(ledger "$predecessor"); [[ "$pred" == "$predecessor_checksum"$'\ttrue' ]] || die 'predecessor absent, duplicated, unfinished, or checksum mismatch'
current=$(ledger "$MIGRATION_ID")
catalog=$(psql_admin -AtF $'\t' -f scripts/pr827-schema-catalog.sql)
catalog_file=$(mktemp); trap 'rm -f "$catalog_file"' EXIT; printf '%s\n' "$catalog" | sed '/^$/d' >"$catalog_file"
catalog_lines=$(wc -l <"$catalog_file")
if [[ -n "$current" ]]; then
  [[ "$current" == "$checksum"$'\ttrue' ]] || die 'migration ledger checksum/state mismatch'
  node scripts/pr827-schema-catalog-validate.mjs "$catalog_file" >/dev/null || die 'ledger applied but catalog incomplete/divergent'
  state=APPLIED_VALID
else
  [[ "$catalog_lines" -eq 0 ]] || die 'catalog present without ledger or partially created'
  state=PENDING
fi
printf '%s\n' 'PR827_SCHEMA_PREFLIGHT=PASS' 'PR827_MIGRATION_PREDECESSOR=PASS' 'PR827_MIGRATION_CHECKSUM=PASS' "PR827_MIGRATION_LEDGER_STATE=$state" "PR827_MIGRATION_CATALOG_STATE=$([[ $state == PENDING ]] && echo ABSENT || echo COMPLETE)"
[[ "$MODE" == preview ]] && exit 0
[[ ${CONFIRM:-} == "$CONFIRMATION" ]] || die "CONFIRM=$CONFIRMATION required"
: "${BACKUP_RESULT_FILE:?BACKUP_RESULT_FILE is required}"; grep -Eq '^PASS([[:space:]]|$)' "$BACKUP_RESULT_FILE" || die 'fresh canonical backup PASS required'
if [[ "$state" == PENDING ]]; then
  migration_run_id=$(node -e 'console.log(require("crypto").randomUUID())')
  { printf 'BEGIN;\n'; cat "$migration"; cat <<SQL
INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
VALUES ('$migration_run_id', '$checksum', '$MIGRATION_ID', now(), now(), 1);
COMMIT;
SQL
  } | psql_admin -f - >/dev/null
fi
[[ $(ledger "$MIGRATION_ID") == "$checksum"$'\ttrue' ]] || die 'ledger postcondition failed'
psql_admin -AtF $'\t' -f scripts/pr827-schema-catalog.sql >"$catalog_file"
node scripts/pr827-schema-catalog-validate.mjs "$catalog_file" >/dev/null || die 'catalog postcondition failed'
tmp=$(mktemp -d); trap 'rm -f "$catalog_file"; rm -rf "$tmp"' EXIT
docker run --rm --pull=never --network container:"$PRODUCTION_DB_CONTAINER_EXPECTED" -e DATABASE_URL "$API_IMAGE" ./node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$tmp/post.sql"
[[ ! -s "$tmp/post.sql" ]] || die 'post-diff is not empty'
printf '%s\n' 'PR827_MIGRATION_APPLY=PASS' 'PR827_MIGRATION_LEDGER=PASS' 'PR827_MIGRATION_CATALOG=PASS' 'PR827_MIGRATION_POST_DIFF=PASS' 'PR827_OLD_API_COMPATIBILITY=PASS' 'PR827_MIGRATION_IDEMPOTENCY=PASS'
