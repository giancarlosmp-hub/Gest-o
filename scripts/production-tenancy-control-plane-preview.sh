#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd); cd "$root"
die(){ printf '[control-plane-preview] ERROR %s\n' "$*" >&2; exit 1; }
: "${MIGRATION_ID:?MIGRATION_ID is required}"; : "${EXPECTED_SHA:?EXPECTED_SHA is required}"
: "${API_IMAGE:?API_IMAGE is required}"; : "${DATABASE_URL:?DATABASE_URL is required}"
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?PRODUCTION_DB_CONTAINER_EXPECTED is required}"
: "${PRODUCTION_DB_NAME_EXPECTED:?PRODUCTION_DB_NAME_EXPECTED is required}"
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'EXPECTED_SHA must be a full SHA'
[[ $(git rev-parse HEAD) == "$EXPECTED_SHA" ]] || die 'HEAD/SHA mismatch'
[[ -z $(git status --porcelain) ]] || die 'worktree is dirty'
[[ $(git rev-parse origin/main) == "$EXPECTED_SHA" ]] || die 'origin/main/SHA mismatch'
[[ ${RUNTIME_TENANCY_MODE:-} == disabled ]] || die 'RUNTIME_TENANCY_MODE=disabled evidence is required'
[[ ${DATABASE_SCHEMA_MODE:-} == external ]] || die 'DATABASE_SCHEMA_MODE=external is required'
registry=$(node scripts/production-schema-migrations.mjs "$MIGRATION_ID") || die 'unknown migration or checksum mismatch'
[[ $(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$registry") == "$MIGRATION_ID" ]] || die 'registry mismatch'
docker image inspect "$API_IMAGE" >/dev/null 2>&1 || die 'pinned API image is not local'
label=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$API_IMAGE")
[[ "$label" == "$EXPECTED_SHA" ]] || die 'API image revision label mismatch'
evidence_root=${SCHEMA_EVIDENCE_DIR:-/var/log/gest-o/schema}
evidence="$evidence_root/$EXPECTED_SHA/migrations/$MIGRATION_ID"
[[ ! -e "$evidence/result.tsv" ]] || die 'completed evidence is immutable'
mkdir -p "$evidence"; chmod 700 "$evidence"
printf 'sha\t%s\nmigration_id\t%s\nevidence_version\t1\n' "$EXPECTED_SHA" "$MIGRATION_ID" >"$evidence/metadata.tsv"
node -e 'const x=JSON.parse(process.argv[1]); console.log(`${x.actualSha256}  ${x.path}`)' "$registry" >"$evidence/migration.sha256"
psql_admin(){ docker exec --user postgres "$PRODUCTION_DB_CONTAINER_EXPECTED" psql -X -v ON_ERROR_STOP=1 -d "$PRODUCTION_DB_NAME_EXPECTED" "$@"; }
identity=$(psql_admin -Atc "SELECT current_database()||E'\\t'||current_user")
[[ "$identity" == "$PRODUCTION_DB_NAME_EXPECTED"$'\tpostgres' ]] || die 'catalog identity is not approved admin/database'
psql_admin -AtF $'\t' -f - <scripts/control-plane-catalog.sql >"$evidence/pre-objects.tsv"
object_count=$(wc -l <"$evidence/pre-objects.tsv")
state=PARTIAL
if (( object_count == 0 )); then state=ABSENT_COMPATIBLE
elif node scripts/control-plane-catalog-validate.mjs "$evidence/pre-objects.tsv" >/dev/null; then state=ALREADY_APPLIED
else die 'partial or divergent control plane'; fi
# Prisma diff is read-only and comes exclusively from the local SHA-labelled image.
docker run --rm --pull=never --network container:"$PRODUCTION_DB_CONTAINER_EXPECTED" -e DATABASE_URL "$API_IMAGE" \
  ./node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel apps/api/prisma/schema.prisma --script >"$evidence/pre-apply-diff.raw.sql"
node scripts/schema-diff-filter.mjs \
  "$evidence/pre-apply-diff.raw.sql" \
  "$evidence/pre-apply-diff.sql" \
  pre
printf 'state\t%s\nsha\t%s\n' "$state" "$EXPECTED_SHA" >"$evidence/preview-result.tsv"
printf '%s\n' "$state"
