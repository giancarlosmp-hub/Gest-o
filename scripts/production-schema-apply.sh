#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR:-/apps/gest-o}"
ENV_FILE="${PRODUCTION_ENV_FILE:-/root/demetra-env/production.env}"
MIGRATION="apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql"
log(){ printf '[production-schema-apply] %s\n' "$*"; }
die(){ log "ERRO: $*" >&2; exit 1; }
[[ "${CONFIRM:-}" == PRODUCTION_SCHEMA_APPLY ]] || die "exige CONFIRM=PRODUCTION_SCHEMA_APPLY"
[[ -f "$ENV_FILE" ]] || die "arquivo seguro de ambiente ausente: $ENV_FILE"
cd "$APP_DIR"; set -a; source "$ENV_FILE"; set +a
APP_COMMIT="${EXPECTED_SHA:-$(git rev-parse HEAD)}"; export APP_COMMIT
[[ "$APP_COMMIT" == "$(git rev-parse HEAD)" ]] || die "EXPECTED_SHA difere do HEAD"
# This performs backup/SHA, origin/main, expected PostgreSQL/network/volume and runtime checks.
bash scripts/production-preflight.sh
docker image inspect "gest-o-api:$APP_COMMIT" >/dev/null 2>&1 || die "imagem API do SHA ausente"
MODE=validate SQL_FILE="$MIGRATION" bash scripts/production-schema-preview.sh

evidence="${SCHEMA_EVIDENCE_DIR:-/var/log/gest-o/schema}/$APP_COMMIT"; mkdir -p "$evidence"
exec > >(tee -a "$evidence/apply.stdout.log") 2> >(tee -a "$evidence/apply.stderr.log" >&2)
sha256sum "$MIGRATION" | tee "$evidence/migration.sha256"
prisma_diff(){
  docker run --rm --pull=never --network gest-o_default -e DATABASE_URL \
    "gest-o-api:$APP_COMMIT" ./node_modules/.bin/prisma migrate diff \
    --from-schema-datasource apps/api/prisma/schema.prisma \
    --to-schema-datamodel apps/api/prisma/schema.prisma --script
}
# The raw catalog diff is the structural precondition. Only the eight known Prisma DROP
# statements are excluded from management; any partial/incompatible target object aborts.
prisma_diff >"$evidence/pre-apply-diff.raw.sql"
node scripts/schema-diff-filter.mjs "$evidence/pre-apply-diff.raw.sql" \
  "$evidence/pre-apply-managed-diff.sql" pre
cat >"$evidence/incident-counts.sql" <<'SQL'
SELECT format('%I.%I', schemaname, tablename) || E'\t' ||
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text
FROM pg_tables
WHERE schemaname='public' AND tablename LIKE 'incident\_%' ESCAPE '\'
ORDER BY tablename;
SQL
incident_counts(){
  docker run --rm --pull=never --network gest-o_default -e DATABASE_URL \
    -v "$evidence/incident-counts.sql:/counts.sql:ro" postgres:16 \
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atf /counts.sql
}
incident_counts >"$evidence/incident.before.tsv"
[[ "$(wc -l <"$evidence/incident.before.tsv")" -eq 8 ]] || die "inventário incident_* divergente; apply bloqueado"
log "aplicando migration versionada isoladamente; containers da aplicação não serão iniciados"
docker run --rm --pull=never --network gest-o_default -e DATABASE_URL \
  -v "$APP_DIR/$MIGRATION:/migration.sql:ro" postgres:16 \
  sh -ceu 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f /migration.sql'

# Postconditions are read-only: all incident table names and row counts must be byte-identical.
incident_counts >"$evidence/incident.after.tsv"
cmp "$evidence/incident.before.tsv" "$evidence/incident.after.tsv" || die "tabelas incident_* foram alteradas"
required=$(docker run --rm --pull=never --network gest-o_default -e DATABASE_URL postgres:16 \
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc \
  "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname IN ('ClientCodeAudit','CommunicationIntegrationAccount','CommunicationConversation','CommunicationMessage','CommunicationWebhookEvent')")
[[ "$required" == 5 ]] || die "objetos obrigatórios ausentes após migration"
printf 'required_tables\t%s\n' "$required" >"$evidence/post-validation.tsv"
# Final authority is Prisma itself, from the same pinned API image/SHA. Preserve the raw
# evidence, remove exclusively the eight intentional unmanaged DROP TABLE statements, and
# require the requested post-apply-diff.sql to contain no managed DDL whatsoever.
prisma_diff >"$evidence/post-apply-diff.raw.sql"
node scripts/schema-diff-filter.mjs "$evidence/post-apply-diff.raw.sql" \
  "$evidence/post-apply-diff.sql" post
printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$APP_COMMIT" "$MIGRATION" > "$evidence/applied.tsv"
log "schema aplicado e validado; nenhum cutover foi executado"
