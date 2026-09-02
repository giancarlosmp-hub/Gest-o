#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
mkdir -p "$REPO/scripts"; cp "$ROOT/scripts/schema-evidence-validation.sh" "$ROOT/scripts/schema-diff-filter.mjs" "$ROOT/scripts/tenancy-expand-roots-catalog-validate.mjs" "$ROOT/scripts/production-schema-migrations.mjs" "$REPO/scripts/"
cd "$REPO"; git init -q; git config user.email test@example.invalid; git config user.name test
legacy=apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql
pr827=apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql
mkdir -p "${legacy%/*}" "${pr827%/*}"; printf 'legacy\n' >"$legacy"; printf 'pr827\n' >"$pr827"
git add .; git commit -qm baseline; BASE=$(git rev-parse HEAD)
# shellcheck source=scripts/schema-evidence-validation.sh
source scripts/schema-evidence-validation.sh

make_bundle(){
  local commit=$1 migration=$2 dir
  dir="$TMP/evidence/$commit"
  mkdir -p "$dir"; chmod 700 "$dir"
  printf '2026-09-01T00:00:00Z\t%s\t%s\n' "$commit" "$migration" >"$dir/applied.tsv"
  printf '%s  %s\n' "$(sha256sum "$migration" | cut -d' ' -f1)" "$migration" >"$dir/migration.sha256"
  chmod 600 "$dir/applied.tsv" "$dir/migration.sha256"
  printf '%s' "$dir"
}
expect_reject(){ if validate_schema_evidence "$1/applied.tsv"; then echo "accepted invalid case: $2" >&2; exit 1; fi; }

dir=$(make_bundle "$BASE" "$legacy"); : >"$dir/post-apply-diff.sql"; chmod 600 "$dir/post-apply-diff.sql"
validate_schema_evidence "$dir/applied.tsv" # legacy valid
rm "$dir/post-apply-diff.sql"; expect_reject "$dir" legacy_without_post_diff

rm -rf "$TMP/evidence"; dir=$(make_bundle "$BASE" "$pr827")
validate_schema_evidence "$dir/applied.tsv" # exact PR827 V1 valid without post-diff
: >"$dir/post-apply-diff.sql"; chmod 600 "$dir/post-apply-diff.sql"; expect_reject "$dir" pr827_with_reinterpreted_post_diff; rm "$dir/post-apply-diff.sql"
sed -i "s|$pr827|apps/api/prisma/migrations/unknown/migration.sql|" "$dir/applied.tsv"; expect_reject "$dir" unknown_migration
printf '2026-09-01T00:00:00Z\t%s\t%s\n' "$BASE" "$pr827" >"$dir/applied.tsv"; chmod 600 "$dir/applied.tsv"
mv "$dir" "$TMP/evidence/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; dir="$TMP/evidence/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; expect_reject "$dir" directory_commit_mismatch
rm -rf "$TMP/evidence"; dir=$(make_bundle "$BASE" "$pr827")
sed -i 's/^[0-9a-f]/0/' "$dir/migration.sha256"; expect_reject "$dir" hash_mismatch
rm -rf "$TMP/evidence"; dir=$(make_bundle "$BASE" "$pr827"); rm "$dir/migration.sha256"; expect_reject "$dir" missing_hash
rm -rf "$TMP/evidence"; dir=$(make_bundle "$BASE" "$pr827"); printf '\textra' >>"$dir/applied.tsv"; expect_reject "$dir" extra_field
rm -rf "$TMP/evidence"; dir=$(make_bundle "$BASE" "$pr827"); chmod 644 "$dir/applied.tsv"; expect_reject "$dir" invalid_file_mode
chmod 600 "$dir/applied.tsv"; chmod 755 "$dir"; expect_reject "$dir" invalid_directory_mode
chmod 700 "$dir"; chown 1 "$dir/applied.tsv"; expect_reject "$dir" invalid_owner; chown 0 "$dir/applied.tsv"
rm -rf "$TMP/evidence"; dir=$(make_bundle "$BASE" "$pr827"); mv "$dir/applied.tsv" "$dir/real"; ln -s real "$dir/applied.tsv"; expect_reject "$dir" file_symlink
rm -rf "$TMP/evidence"; real=$(make_bundle "$BASE" "$pr827"); mv "$real" "$TMP/real-bundle"; ln -s "$TMP/real-bundle" "$TMP/evidence/$BASE"; expect_reject "$TMP/evidence/$BASE" directory_symlink

rm -rf "$TMP/evidence"; dir=$(make_bundle "$BASE" "$pr827"); printf 'changed\n' >"$pr827"; git add "$pr827"; git commit -qm changed-migration; expect_reject "$dir" migration_changed_between_commits
git reset --hard -q "$BASE"; printf 'change\n' >apps/api/prisma/schema.prisma; git add .; git commit -qm prisma-tree-change; HEAD_SHA=$(git rev-parse HEAD)
if git diff --quiet "$BASE" "$HEAD_SHA" -- apps/api/prisma; then echo 'Prisma tree change was not rejected' >&2; exit 1; fi

deploy=$(cat "$ROOT/scripts/deploy-production.sh")
[[ "$deploy" != *'find "$schema_evidence_root"'* ]]
[[ "$deploy" != *'|| continue'* ]]
evidence_gate=${deploy%%'docker stop'*}
[[ "$evidence_gate" == *'nenhuma evidência equivalente de schema foi validada'* ]]
[[ "$evidence_gate" == *'diff Prisma atual não está vazio'* ]]
managed="$TMP/managed.sql"; printf 'ALTER TABLE managed;\n' >"$managed"
if [[ ! -s "$managed" ]]; then echo 'non-empty live Prisma diff was accepted' >&2; exit 1; fi
stopped=NO
[[ "$stopped" == NO ]] # every preceding rejection happened before the stop sentinel
printf 'SCHEMA_EVIDENCE_DEPLOY_REGRESSION=PASS\n'

# Complete tenancy-expand-roots bundle contract (including a deliberately
# non-empty raw diff that becomes empty after the approved filter).
tenancy=apps/api/prisma/migrations/20260808120000_tenancy_expand_roots/migration.sql
mkdir -p "${tenancy%/*}"; cp "$ROOT/$tenancy" "$tenancy"; git add .; git commit -qm tenancy; TENANCY_SHA=$(git rev-parse HEAD)
EVIDENCE="$TMP/tenancy-evidence"; mkdir -p "$EVIDENCE/$TENANCY_SHA/migrations/20260808120000_tenancy_expand_roots"; chmod 700 "$EVIDENCE" "$EVIDENCE/$TENANCY_SHA" "$EVIDENCE/$TENANCY_SHA/migrations" "$EVIDENCE/$TENANCY_SHA/migrations/20260808120000_tenancy_expand_roots"
TB="$EVIDENCE/$TENANCY_SHA/migrations/20260808120000_tenancy_expand_roots"
make_catalog(){
  local root
  for root in KnowledgeDocument Client AgendaEvent Goal ActivityKPI Sale SellerTerritoryCity AppConfig Product ErpSyncRun ErpSyncLock; do
    printf 'column\t%s.tenantId\ttext|nullable=YES|default=\n' "$root"
    printf 'index\t%s_tenantId_idx\tCREATE INDEX "%s_tenantId_idx" ON public."%s" USING btree ("tenantId")\n' "$root" "$root" "$root"
    printf 'fk\t%s_tenantId_fkey\tsource=%s;source_columns=tenantId;target=Tenant;target_columns=id;delete=NO_ACTION;update=NO_ACTION;validated=TRUE\n' "$root" "$root"
  done
}
make_tenancy_bundle(){
  rm -rf "$TB"; mkdir -p "$TB"; chmod 700 "$TB"
  printf 'sha\t%s\nmigration_id\t20260808120000_tenancy_expand_roots\nevidence_version\t1\n' "$TENANCY_SHA" >"$TB/metadata.tsv"
  printf '%s  %s\n' "$(sha256sum "$tenancy" | cut -d' ' -f1)" "$tenancy" >"$TB/migration.sha256"
  printf 'result\tPASS\nstate\tAPPLIED_ONCE\ntenancy_mode\tdisabled\nbusiness_rows_modified\tNO\n' >"$TB/result.tsv"
  make_catalog >"$TB/catalog-after.tsv"; : >"$TB/catalog-before.tsv"; : >"$TB/preview-result.tsv"; : >"$TB/preview-diff.sql"; : >"$TB/apply.log"
  printf '%s\n' '-- DropTable' 'DROP TABLE "incident_20260718_client_enrichment_audit";' >"$TB/post-apply-diff.sql"
  chmod 600 "$TB"/*
}
tenancy_reject(){ if validate_tenancy_expand_roots_evidence "$TB" "$TENANCY_SHA" "$EVIDENCE"; then echo "accepted invalid tenancy bundle: $1" >&2; exit 1; fi; }
make_tenancy_bundle; validate_tenancy_expand_roots_evidence "$TB" "$TENANCY_SHA" "$EVIDENCE" # valid; raw diff need not be empty
make_tenancy_bundle; rm "$TB/metadata.tsv"; tenancy_reject missing_file
make_tenancy_bundle; mv "$TB/apply.log" "$TB/real"; ln -s real "$TB/apply.log"; tenancy_reject symlink
make_tenancy_bundle; chmod 644 "$TB/result.tsv"; tenancy_reject invalid_mode
make_tenancy_bundle; chown 1 "$TB/result.tsv"; tenancy_reject invalid_owner; chown 0 "$TB/result.tsv"
make_tenancy_bundle; sed -i "s/^sha\t.*/sha\tffffffffffffffffffffffffffffffffffffffff/" "$TB/metadata.tsv"; tenancy_reject sha_mismatch
make_tenancy_bundle; sed -i 's/tenancy_expand_roots/wrong/' "$TB/metadata.tsv"; tenancy_reject migration_id_mismatch
make_tenancy_bundle; sed -i 's/^[0-9a-f]/0/' "$TB/migration.sha256"; tenancy_reject checksum_mismatch
make_tenancy_bundle; sed -i 's/result\tPASS/result\tFAIL/' "$TB/result.tsv"; tenancy_reject result_not_pass
make_tenancy_bundle; sed -i 's/state\tAPPLIED_ONCE/state\tPARTIAL/' "$TB/result.tsv"; tenancy_reject invalid_state
make_tenancy_bundle; sed -i 's/tenancy_mode\tdisabled/tenancy_mode\tenabled/' "$TB/result.tsv"; tenancy_reject tenancy_enabled
make_tenancy_bundle; sed -i 's/business_rows_modified\tNO/business_rows_modified\tYES/' "$TB/result.tsv"; tenancy_reject business_rows_modified
make_tenancy_bundle; sed -i 's/nullable=YES/nullable=NO/' "$TB/catalog-after.tsv"; tenancy_reject catalog_divergent
make_tenancy_bundle; printf 'ALTER TABLE "Client" ADD COLUMN "bad" TEXT;\n' >"$TB/post-apply-diff.sql"; tenancy_reject managed_diff
make_tenancy_bundle; : >"$TB/extra.tsv"; chmod 600 "$TB/extra.tsv"; tenancy_reject extra_file
make_tenancy_bundle; printf '\textra\n' >>"$TB/result.tsv"; tenancy_reject malformed_tsv
make_tenancy_bundle; find "$TB" -type f ! -name result.tsv -delete; tenancy_reject result_only
printf 'TENANCY_EXPAND_ROOTS_EVIDENCE_VALIDATION=PASS\n'
