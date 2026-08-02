#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR:-/apps/gest-o}"
ENV_FILE="${PRODUCTION_ENV_FILE:-/root/demetra-env/production.env}"
PRODUCTION_DB_CONTAINER_REQUIRED=gest-o-db-clean-v2-20260717
log(){ printf '[production-schema-apply] %s\n' "$*"; }
die(){ log "ERRO: $*" >&2; exit 1; }
[[ "${CONFIRM:-}" == PRODUCTION_SCHEMA_APPLY ]] || die "exige CONFIRM=PRODUCTION_SCHEMA_APPLY"
MIGRATION_ID="${MIGRATION_ID:-}"
[[ -n "$MIGRATION_ID" ]] || { printf '[production-schema-apply] ERRO: MIGRATION_ID obrigatório\n' >&2; exit 1; }
registry_line=$(node scripts/production-schema-migrations.mjs "$MIGRATION_ID") || exit 1
IFS=$'\t' read -r _ MIGRATION EXPECTED_MIGRATION_SHA REQUIRED_MIGRATION EVIDENCE_VERSION <<<"$registry_line"
[[ -f "$ENV_FILE" ]] || die "arquivo seguro de ambiente ausente: $ENV_FILE"
cd "$APP_DIR"; set -a; source "$ENV_FILE"; set +a
[[ "${PRODUCTION_DB_CONTAINER_EXPECTED:-}" == "$PRODUCTION_DB_CONTAINER_REQUIRED" ]] ||
  die "container autorizado deve ser exatamente $PRODUCTION_DB_CONTAINER_REQUIRED"
PSQL_DATABASE_URL=$(DATABASE_URL="$DATABASE_URL" node scripts/postgres-connection-url.mjs)
export PSQL_DATABASE_URL
DB_NAME=$(DATABASE_URL="$DATABASE_URL" node -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.pathname.replace(/^\//,""))')
[[ "$DB_NAME" == salesforce_pro ]] || die "database não autorizado"
[[ -n "${EXPECTED_SHA:-}" ]] || die "EXPECTED_SHA obrigatório"
APP_COMMIT="$EXPECTED_SHA"; export APP_COMMIT
[[ "$APP_COMMIT" == "$(git rev-parse HEAD)" ]] || die "EXPECTED_SHA difere do HEAD"
# This performs backup/SHA, origin/main, expected PostgreSQL/network/volume and runtime checks.
bash scripts/production-preflight.sh
docker image inspect "gest-o-api:$APP_COMMIT" >/dev/null 2>&1 || die "imagem API do SHA ausente"
image_revision=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "gest-o-api:$APP_COMMIT")
[[ "$image_revision" == "$APP_COMMIT" ]] || die "label OCI divergente"
[[ "$(sha256sum "$MIGRATION" | cut -d' ' -f1)" == "$EXPECTED_MIGRATION_SHA" ]] || die "checksum da migration diverge do registry"
MODE=validate SQL_FILE="$MIGRATION" bash scripts/production-schema-preview.sh

schema_root="${SCHEMA_EVIDENCE_DIR:-/var/log/gest-o/schema}/$APP_COMMIT"
evidence="$schema_root/migrations/$MIGRATION_ID"
[[ ! -e "$evidence/result.tsv" ]] || die "evidência PASS existente não pode ser sobrescrita"
if [[ -e "$evidence" ]]; then mv "$evidence" "$evidence.incomplete-$(date -u +%Y%m%dT%H%M%SZ)"; fi
install -d -m 700 "$evidence"
exec > >(tee "$evidence/apply.log") 2>&1
printf 'sha\t%s\nmigration_id\t%s\nevidence_version\t%s\n' "$APP_COMMIT" "$MIGRATION_ID" "$EVIDENCE_VERSION" >"$evidence/metadata.tsv"
printf '%s  %s\n' "$EXPECTED_MIGRATION_SHA" "$MIGRATION" >"$evidence/migration.sha256"
if [[ "$REQUIRED_MIGRATION" != - ]]; then
  prior="$schema_root/migrations/$REQUIRED_MIGRATION/result.tsv"
  legacy="$schema_root/applied.tsv"
  [[ -s "$prior" || -s "$legacy" ]] || die "migration anterior não comprovada"
fi
admin_psql(){
  docker exec --user postgres -i "$PRODUCTION_DB_CONTAINER_EXPECTED" \
    psql --dbname="$DB_NAME" -X -v ON_ERROR_STOP=1 "$@"
}
admin_identity(){
  local identity
  identity=$(admin_psql -Atc "SELECT current_database() || E'\\t' || current_user")
  [[ "$identity" == $'salesforce_pro\tpostgres' ]] ||
    die "identidade administrativa divergente (esperado salesforce_pro/postgres)"
}
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
  "$evidence/pre-apply-diff.sql" pre
cat >"$evidence/incident-counts.sql" <<'SQL'
SELECT format('%I.%I', schemaname, tablename) || E'\t' ||
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text
FROM pg_tables
WHERE schemaname='public' AND tablename LIKE 'incident\_%' ESCAPE '\'
ORDER BY tablename;
SQL
incident_counts(){
  docker run --rm --pull=never --network gest-o_default -e PSQL_DATABASE_URL \
    -v "$evidence/incident-counts.sql:/counts.sql:ro" postgres:16 \
    psql "$PSQL_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atf /counts.sql
}
incident_counts >"$evidence/incident.before.tsv"
[[ "$(wc -l <"$evidence/incident.before.tsv")" -eq 8 ]] || die "inventário incident_* divergente; apply bloqueado"

# Repeat every mutable safety gate immediately before granting the migration its short-lived
# administrative authority. The runtime URL remains in use for Prisma and incident reads.
[[ "${CONFIRM:-}" == PRODUCTION_SCHEMA_APPLY ]] || die "confirmação deixou de ser válida"
[[ "$(git rev-parse HEAD)" == "$APP_COMMIT" ]] || die "HEAD mudou durante o apply"
[[ "$(git rev-parse origin/main)" == "$APP_COMMIT" ]] || die "origin/main mudou durante o apply"
[[ -z "$(git status --porcelain)" ]] || die "worktree mudou durante o apply"
bash scripts/production-preflight.sh
[[ "$(sha256sum "$MIGRATION" | cut -d' ' -f1)" == "$EXPECTED_MIGRATION_SHA" ]] || die "migration mudou após registro"
admin_identity
admin_psql -Atc "SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('Tenant','TenantMembership') ORDER BY 2" >"$evidence/pre-objects.tsv"
log "aplicando migration versionada isoladamente; containers da aplicação não serão iniciados"
admin_psql --single-transaction -f - < "$MIGRATION"
if [[ "$MIGRATION_ID" == 20260802120000_tenancy_control_plane ]]; then
  admin_psql -Atc "SELECT c.relname, c.relkind FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('Tenant','TenantMembership') ORDER BY 1" >"$evidence/post-objects.tsv"
  [[ "$(wc -l <"$evidence/post-objects.tsv")" -eq 2 ]] || die "tabelas do control plane ausentes"
  [[ "$(admin_psql -Atc "SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname IN ('Tenant_pkey','TenantMembership_pkey') AND contype='p'")" == 2 ]] || die "PKs do control plane divergentes"
  [[ "$(admin_psql -Atc "SELECT count(*) FROM pg_type WHERE typnamespace='public'::regnamespace AND typname IN ('TenantStatus','TenantMembershipStatus','TenantRole')")" == 3 ]] || die "enums do control plane divergentes"
  [[ "$(admin_psql -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname IN ('Tenant_slug_key','TenantMembership_tenantId_userId_key','TenantMembership_userId_status_idx','TenantMembership_tenantId_status_idx')")" == 4 ]] || die "índices do control plane divergentes"
  [[ "$(admin_psql -Atc "SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname IN ('TenantMembership_tenantId_fkey','TenantMembership_userId_fkey') AND contype='f'")" == 2 ]] || die "FKs do control plane divergentes"
  [[ "$(admin_psql -Atc "SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname IN ('TenantMembership_version_positive','TenantMembership_lifecycle_coherent') AND contype='c'")" == 2 ]] || die "checks do control plane divergentes"
  [[ "$(admin_psql -Atc 'SELECT (SELECT count(*) FROM "Tenant") + (SELECT count(*) FROM "TenantMembership")')" == 0 ]] || die "DDL não pode preparar dados"
fi

# Postconditions are read-only: all incident table names and row counts must be byte-identical.
incident_counts >"$evidence/incident.after.tsv"
cmp "$evidence/incident.before.tsv" "$evidence/incident.after.tsv" || die "tabelas incident_* foram alteradas"
if [[ "$MIGRATION_ID" == 20260731150000_safe_production_schema_transition ]]; then
required=$(admin_psql -Atc \
  "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname IN ('ClientCodeAudit','CommunicationIntegrationAccount','CommunicationConversation','CommunicationMessage','CommunicationWebhookEvent')")
[[ "$required" == 5 ]] || die "objetos obrigatórios ausentes após migration"
enums=$(admin_psql -Atc "SELECT count(*) FROM pg_type WHERE typnamespace='public'::regnamespace AND typname IN ('CommunicationChannelType','CommunicationProviderType','CommunicationDirection','CommunicationMessageType','CommunicationMessageStatus','CommunicationConversationStatus','CommunicationWebhookStatus')")
[[ "$enums" == 7 ]] || die "enums obrigatórios ausentes após migration"
phone_columns=$(admin_psql -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='Contact' AND column_name IN ('phoneHash','phoneNormalized')")
[[ "$phone_columns" == 2 ]] || die "colunas normalizadas de telefone ausentes após migration"
printf 'required_tables\t%s\nrequired_enums\t%s\nphone_columns\t%s\n' "$required" "$enums" "$phone_columns" >"$evidence/post-validation.tsv"
fi
# Final authority is Prisma itself, from the same pinned API image/SHA. Preserve the raw
# evidence, remove exclusively the eight intentional unmanaged DROP TABLE statements, and
# require the requested post-apply-diff.sql to contain no managed DDL whatsoever.
prisma_diff >"$evidence/post-apply-diff.raw.sql"
node scripts/schema-diff-filter.mjs "$evidence/post-apply-diff.raw.sql" \
  "$evidence/post-apply-diff.sql" post
printf 'result\tPASS\ntimestamp\t%s\n' "$(date -u +%FT%TZ)" >"$evidence/result.tsv"
# Full-schema manifest is released only after the same pinned Prisma reports equivalence.
{
 printf 'validation_version\t%s\nsha\t%s\ntimestamp\t%s\npost_diff\tempty\n' "schema-operation-v2" "$APP_COMMIT" "$(date -u +%FT%TZ)"
 for id in 20260731150000_safe_production_schema_transition 20260802120000_tenancy_control_plane; do
   line=$(node scripts/production-schema-migrations.mjs "$id"); IFS=$'\t' read -r _ _ sum _ _ <<<"$line"
   status=MISSING; [[ -s "$schema_root/migrations/$id/result.tsv" ]] && status=PASS
   [[ "$id" == "$MIGRATION_ID" ]] && status=PASS
   printf 'migration\t%s\t%s\t%s\n' "$id" "$status" "$sum"
 done
} >"$schema_root/schema-state.tsv.tmp"
chmod 600 "$schema_root/schema-state.tsv.tmp"; mv "$schema_root/schema-state.tsv.tmp" "$schema_root/schema-state.tsv"
log "schema aplicado e validado; nenhum cutover foi executado"
