#!/usr/bin/env bash
# Validation library for immutable production schema evidence. This file only
# reads the checkout, Git objects, and the evidence bundle supplied by callers.

SCHEMA_MIGRATION_LEGACY="apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql"
SCHEMA_MIGRATION_PR827="apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql"
TENANCY_EXPAND_ROOTS_ID="20260808120000_tenancy_expand_roots"
TENANCY_EXPAND_ROOTS_MIGRATION="apps/api/prisma/migrations/$TENANCY_EXPAND_ROOTS_ID/migration.sql"

schema_protected_directory(){
  [[ -d "$1" && ! -L "$1" && "$(stat -c '%u:%a' -- "$1")" == "0:700" ]]
}

schema_protected_file(){
  [[ -f "$1" && ! -L "$1" && "$(stat -c '%u:%a' -- "$1")" == "0:600" ]]
}

validate_schema_evidence(){
  local applied=$1 evidence_dir=${1%/*} directory_commit applied_at evidence_commit evidence_migration
  local recorded_hash recorded_path current_hash commit_hash field_count
  schema_protected_directory "$evidence_dir" || return 1
  directory_commit=${evidence_dir##*/}
  [[ "$directory_commit" =~ ^[0-9a-f]{40}$ ]] || return 1
  schema_protected_file "$applied" || return 1
  [[ "$(wc -l <"$applied")" -eq 1 && "$(awk 'END { print NR }' "$applied")" -eq 1 ]] || return 1
  field_count=$(awk -F '\t' '{ print NF }' "$applied")
  [[ "$field_count" == 3 ]] || return 1
  IFS=$'\t' read -r applied_at evidence_commit evidence_migration <"$applied" || return 1
  [[ -n "$applied_at" && "$evidence_commit" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$evidence_commit" == "$directory_commit" ]] || return 1
  case "$evidence_migration" in
    "$SCHEMA_MIGRATION_LEGACY")
      schema_protected_file "$evidence_dir/post-apply-diff.sql" || return 1
      [[ ! -s "$evidence_dir/post-apply-diff.sql" ]] || return 1
      ;;
    "$SCHEMA_MIGRATION_PR827")
      # PRODUCTION_SCHEMA_APPLY_V1 deliberately published only these two files.
      [[ ! -e "$evidence_dir/post-apply-diff.sql" && ! -L "$evidence_dir/post-apply-diff.sql" ]] || return 1
      ;;
    *) return 1 ;;
  esac
  git cat-file -e "$evidence_commit^{commit}" 2>/dev/null || return 1
  schema_protected_file "$evidence_dir/migration.sha256" || return 1
  [[ "$(wc -l <"$evidence_dir/migration.sha256")" -eq 1 ]] || return 1
  read -r recorded_hash recorded_path <"$evidence_dir/migration.sha256" || return 1
  [[ "$recorded_hash" =~ ^[0-9a-f]{64}$ && "$recorded_path" == "$evidence_migration" ]] || return 1
  current_hash=$(sha256sum "$evidence_migration"); current_hash=${current_hash%% *}
  [[ "$recorded_hash" == "$current_hash" ]] || return 1
  commit_hash=$(git show "$evidence_commit:$evidence_migration" | sha256sum); commit_hash=${commit_hash%% *}
  [[ "$commit_hash" == "$current_hash" ]] || return 1
  SCHEMA_EVIDENCE_COMMIT=$evidence_commit
  SCHEMA_EVIDENCE_MIGRATION=$evidence_migration
}

# Validate the complete TENANCY_EXPAND_ROOTS_V1 bundle.  result.tsv is only one
# member of this contract and is deliberately never accepted on its own.
validate_tenancy_expand_roots_evidence(){
  local bundle=$1 app_commit=$2 evidence_root=${3:-${SCHEMA_EVIDENCE_DIR:-/var/log/gest-o/schema}}
  local bundle_commit metadata_sha metadata_id metadata_version recorded_hash recorded_path current_hash commit_hash
  local managed expected_files actual_files result state tenancy_mode business_rows_modified tmp registry registry_hash registry_version
  [[ "$app_commit" =~ ^[0-9a-f]{40}$ ]] || return 1
  schema_protected_directory_root(){
    [[ -d "$1" && ! -L "$1" && "$(stat -c '%u:%a' -- "$1")" =~ ^0:(700|750|755)$ ]]
  }
  schema_protected_directory_root "$evidence_root" || return 1
  bundle_commit=${bundle#"$evidence_root"/}; bundle_commit=${bundle_commit%%/*}
  [[ "$bundle" == "$evidence_root/$bundle_commit/migrations/$TENANCY_EXPAND_ROOTS_ID" ]] || return 1
  [[ "$bundle_commit" == "$app_commit" ]] || return 1
  schema_protected_directory "$evidence_root/$bundle_commit" || return 1
  schema_protected_directory "$evidence_root/$bundle_commit/migrations" || return 1
  schema_protected_directory "$bundle" || return 1
  expected_files=$'apply.log\ncatalog-after.tsv\ncatalog-before.tsv\nmetadata.tsv\nmigration.sha256\npost-apply-diff.sql\npreview-diff.sql\npreview-result.tsv\nresult.tsv'
  actual_files=$(find "$bundle" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort) || return 1
  [[ "$actual_files" == "$expected_files" ]] || return 1
  while IFS= read -r file; do schema_protected_file "$bundle/$file" || return 1; done <<<"$expected_files"

  [[ $(wc -l <"$bundle/metadata.tsv") -eq 3 ]] || return 1
  IFS=$'\t' read -r key metadata_sha extra <"$bundle/metadata.tsv"; [[ $key == sha && -z ${extra:-} ]] || return 1
  IFS=$'\t' read -r key metadata_id extra < <(sed -n '2p' "$bundle/metadata.tsv"); [[ $key == migration_id && -z ${extra:-} ]] || return 1
  IFS=$'\t' read -r key metadata_version extra < <(sed -n '3p' "$bundle/metadata.tsv"); [[ $key == evidence_version && -z ${extra:-} ]] || return 1
  [[ "$metadata_sha" == "$bundle_commit" && "$metadata_id" == "$TENANCY_EXPAND_ROOTS_ID" && "$metadata_version" == 1 ]] || return 1
  git cat-file -e "$bundle_commit^{commit}" 2>/dev/null || return 1

  [[ $(wc -l <"$bundle/migration.sha256") -eq 1 ]] || return 1
  read -r recorded_hash recorded_path extra <"$bundle/migration.sha256" || return 1
  [[ -z ${extra:-} && "$recorded_hash" =~ ^[0-9a-f]{64}$ && "$recorded_path" == "$TENANCY_EXPAND_ROOTS_MIGRATION" ]] || return 1
  current_hash=$(sha256sum "$TENANCY_EXPAND_ROOTS_MIGRATION"); current_hash=${current_hash%% *}
  commit_hash=$(git show "$bundle_commit:$TENANCY_EXPAND_ROOTS_MIGRATION" 2>/dev/null | sha256sum); commit_hash=${commit_hash%% *}
  registry=$(node scripts/production-schema-migrations.mjs "$TENANCY_EXPAND_ROOTS_ID" 2>/dev/null) || return 1
  registry_hash=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sha256)' "$registry") || return 1
  registry_version=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).evidenceVersion))' "$registry") || return 1
  [[ "$metadata_version" == "$registry_version" && "$recorded_hash" == "$registry_hash" && "$recorded_hash" == "$current_hash" && "$recorded_hash" == "$commit_hash" ]] || return 1

  [[ $(wc -l <"$bundle/result.tsv") -eq 4 ]] || return 1
  IFS=$'\t' read -r key result extra <"$bundle/result.tsv"; [[ $key == result && $result == PASS && -z ${extra:-} ]] || return 1
  IFS=$'\t' read -r key state extra < <(sed -n '2p' "$bundle/result.tsv"); [[ $key == state && -z ${extra:-} ]] || return 1
  [[ $state == APPLIED_ONCE || $state == ALREADY_APPLIED ]] || return 1
  IFS=$'\t' read -r key tenancy_mode extra < <(sed -n '3p' "$bundle/result.tsv"); [[ $key == tenancy_mode && $tenancy_mode == disabled && -z ${extra:-} ]] || return 1
  IFS=$'\t' read -r key business_rows_modified extra < <(sed -n '4p' "$bundle/result.tsv"); [[ $key == business_rows_modified && $business_rows_modified == NO && -z ${extra:-} ]] || return 1
  node scripts/tenancy-expand-roots-catalog-validate.mjs "$bundle/catalog-after.tsv" >/dev/null 2>&1 || return 1
  ! grep -Eiq '(postgres(ql)?://|password[[:space:]]*=|DATABASE_URL)' "$bundle/post-apply-diff.sql" || return 1
  tmp=$(mktemp -d) || return 1
  if ! node scripts/schema-diff-filter.mjs "$bundle/post-apply-diff.sql" "$tmp/managed.sql" post >/dev/null 2>&1; then rm -rf "$tmp"; return 1; fi
  [[ ! -s "$tmp/managed.sql" ]] || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  SCHEMA_EVIDENCE_COMMIT=$bundle_commit
  SCHEMA_EVIDENCE_MIGRATION=$TENANCY_EXPAND_ROOTS_MIGRATION
}
