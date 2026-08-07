#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd); cd "$root"
die(){ printf '[control-plane-apply] ERROR %s\n' "$*" >&2; exit 1; }
[[ ${CONFIRM:-} == PRODUCTION_SCHEMA_APPLY ]] || die 'CONFIRM=PRODUCTION_SCHEMA_APPLY required'
: "${EXPECTED_SHA:?EXPECTED_SHA is required}"; : "${MIGRATION_ID:?MIGRATION_ID is required}"
: "${API_IMAGE:?API_IMAGE is required}"
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?PRODUCTION_DB_CONTAINER_EXPECTED is required}"
: "${PRODUCTION_DB_NAME_EXPECTED:?PRODUCTION_DB_NAME_EXPECTED is required}"
: "${BACKUP_RESULT_FILE:?BACKUP_RESULT_FILE is required}"; : "${PREFLIGHT_RESULT_FILE:?PREFLIGHT_RESULT_FILE is required}"
[[ $(git rev-parse HEAD) == "$EXPECTED_SHA" ]] || die 'HEAD/SHA mismatch'
[[ -z $(git status --porcelain) ]] || die 'worktree is dirty'
[[ $(git rev-parse origin/main) == "$EXPECTED_SHA" ]] || die 'origin/main/SHA mismatch'
[[ ${RUNTIME_TENANCY_MODE:-} == disabled ]] || die 'RUNTIME_TENANCY_MODE=disabled evidence is required'
[[ ${DATABASE_SCHEMA_MODE:-} == external ]] || die 'DATABASE_SCHEMA_MODE=external is required'
docker image inspect "$API_IMAGE" >/dev/null 2>&1 || die 'pinned API image is not local'
[[ $(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$API_IMAGE") == "$EXPECTED_SHA" ]] || die 'API image revision label mismatch'
grep -Eq '^PASS([[:space:]]|$)' "$BACKUP_RESULT_FILE" || die 'recent backup PASS required'
grep -Eq '^PASS([[:space:]]|$)' "$PREFLIGHT_RESULT_FILE" || die 'preflight PASS required'
registry=$(node scripts/production-schema-migrations.mjs "$MIGRATION_ID") || die 'registry/checksum failed'
migration=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).absolutePath)' "$registry")
evidence_root=${SCHEMA_EVIDENCE_DIR:-/var/log/gest-o/schema}; evidence="$evidence_root/$EXPECTED_SHA/migrations/$MIGRATION_ID"
[[ -f "$evidence/preview-result.tsv" ]] || die 'preview evidence required'
state=$(awk -F '\t' '$1=="state"{print $2}' "$evidence/preview-result.tsv")
[[ $(awk -F '\t' '$1=="sha"{print $2}' "$evidence/preview-result.tsv") == "$EXPECTED_SHA" ]] || die 'preview SHA mismatch'
psql_admin(){ docker exec --user postgres -i "$PRODUCTION_DB_CONTAINER_EXPECTED" psql -X -v ON_ERROR_STOP=1 -d "$PRODUCTION_DB_NAME_EXPECTED" "$@"; }
[[ $(psql_admin -Atc "SELECT current_database()||E'\\t'||current_user") == "$PRODUCTION_DB_NAME_EXPECTED"$'\tpostgres' ]] || die 'admin identity mismatch'
[[ $(psql_admin -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='User'") == 1 ]] || die 'predecessor absent'
if [[ "$state" == ALREADY_APPLIED ]]; then printf 'result\tPASS\nstate\tALREADY_APPLIED\n' >"$evidence/result.tsv"; exit 0; fi
[[ "$state" == ABSENT_COMPATIBLE ]] || die 'preview did not approve absent state'
{ printf 'BEGIN;\n'; cat "$migration"; printf '\nCOMMIT;\n'; } | psql_admin >"$evidence/apply.log" 2>&1
psql_admin -AtF $'\t' -f - <scripts/control-plane-catalog.sql >"$evidence/post-objects.tsv"
node scripts/control-plane-catalog-validate.mjs "$evidence/post-objects.tsv" >/dev/null
[[ $(psql_admin -Atc 'SELECT (SELECT count(*) FROM "Tenant")+(SELECT count(*) FROM "TenantMembership")') == 0 ]] || die 'control plane is not empty before preparation'
docker run --rm --pull=never --network container:"$PRODUCTION_DB_CONTAINER_EXPECTED" -e DATABASE_URL "$API_IMAGE" \
  ./node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$evidence/post-apply-diff.raw.sql"
node scripts/schema-diff-filter.mjs \
  "$evidence/post-apply-diff.raw.sql" \
  "$evidence/post-apply-diff.sql" \
  post
printf 'result\tPASS\nstate\tAPPLIED_ONCE\n' >"$evidence/result.tsv"
