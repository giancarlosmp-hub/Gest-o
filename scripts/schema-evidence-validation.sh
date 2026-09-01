#!/usr/bin/env bash
# Validation library for immutable production schema evidence. This file only
# reads the checkout, Git objects, and the evidence bundle supplied by callers.

SCHEMA_MIGRATION_LEGACY="apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql"
SCHEMA_MIGRATION_PR827="apps/api/prisma/migrations/20260827190000_add_erp_order_manual_resolution/migration.sql"

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
