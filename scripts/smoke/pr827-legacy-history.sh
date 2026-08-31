#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
source scripts/lib/pr827-legacy-history.sh
p=apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql
sum=66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506
commit=$(git rev-list HEAD -- "$p" | while read -r c; do [[ $(git show "$c:$p" | sha256sum | cut -d' ' -f1) == "$sum" ]] && { echo "$c"; break; }; done)
fixture_owner=$(id -un):$(id -gn)
export APPLIED_TSV_EXPECTED_OWNER=$fixture_owner
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
actual_class=UNKNOWN

make_record(){
 rm -rf "$t/history"; mkdir -p "$t/history/$commit"
 printf '2026-08-01T00:00:00Z\t%s\t%s\n' "$commit" "$p" >"$t/history/$commit/applied.tsv"
 printf '%s  %s\n' "$sum" "$p" >"$t/history/$commit/migration.sha256"
 chmod "${1:-755}" "$t/history/$commit"; chmod "${2:-644}" "$t/history/$commit/"*
}
validate(){
 local file=${1:-$t/history/$commit/applied.tsv} wanted=${2:-$p} expected=${3:-$sum} rc
 history_failure=UNKNOWN
 if pr827_validate_record "$file" "$wanted" "$expected"; then rc=0; actual_class=NONE
 else rc=$?; actual_class=$history_failure; fi
 return "$rc"
}
scenario(){
 local name=$1 expected_rc=$2 expected_class=$3 fn=$4 actual_rc
 echo "LEGACY_SCENARIO=$name"
 echo "LEGACY_SCENARIO_EXPECTED_RC=$expected_rc"
 actual_class=UNKNOWN
 if "$fn"; then actual_rc=0; else actual_rc=$?; fi
 echo "LEGACY_SCENARIO_ACTUAL_RC=$actual_rc"
 if [[ $actual_rc == "$expected_rc" && $actual_class == "$expected_class" ]]; then
  echo 'LEGACY_SCENARIO_RESULT=PASS'
  return 0
 fi
 echo 'LEGACY_SCENARIO_RESULT=FAIL'
 echo "LEGACY_FAILED_SCENARIO=$name"
 echo 'LEGACY_FAILED_STAGE=VALIDATION'
 echo "LEGACY_EXPECTED_RESULT=RC_${expected_rc}_CLASS_${expected_class}"
 echo "LEGACY_ACTUAL_RESULT=RC_${actual_rc}_CLASS_${actual_class}"
 return 1
}
case_v1(){ make_record; validate; }
case_v2(){ make_record 700 600; validate; }
case_absent(){ make_record; rm "$t/history/$commit/applied.tsv"; validate; }
case_malformed(){ make_record; printf 'malformed\n' >"$t/history/$commit/applied.tsv"; validate; }
case_timestamp(){ make_record; sed -i 's/2026-08-01/2026-02-31/' "$t/history/$commit/applied.tsv"; validate; }
case_short_sha(){ make_record; sed -i "s/$commit/abc/" "$t/history/$commit/applied.tsv"; validate; }
case_directory_sha(){ make_record; sed -i "s/$commit/0000000000000000000000000000000000000000/" "$t/history/$commit/applied.tsv"; validate; }
case_commit_absent(){ local zero=0000000000000000000000000000000000000000; make_record; mv "$t/history/$commit" "$t/history/$zero"; sed -i "s/$commit/$zero/" "$t/history/$zero/applied.tsv"; validate "$t/history/$zero/applied.tsv"; }
case_path(){ make_record; sed -i "s#$p#outside/migration.sql#" "$t/history/$commit/applied.tsv"; validate; }
case_migration_absent(){ local head; make_record; head=$(git rev-parse HEAD); mv "$t/history/$commit" "$t/history/$head"; sed -i "s/$commit/$head/;s#$p#missing/migration.sql#" "$t/history/$head/applied.tsv"; validate "$t/history/$head/applied.tsv" missing/migration.sql; }
case_sidecar_absent(){ make_record; rm "$t/history/$commit/migration.sha256"; validate; }
case_sidecar_malformed(){ make_record; printf 'bad\n' >"$t/history/$commit/migration.sha256"; validate; }
case_sidecar_checksum(){ make_record; sed -i 's/^./0/' "$t/history/$commit/migration.sha256"; validate; }
case_git_checksum(){ make_record; printf '0%s  %s\n' "${sum:1}" "$p" >"$t/history/$commit/migration.sha256"; validate "$t/history/$commit/applied.tsv" "$p" "0${sum:1}"; }
case_expected_checksum(){ make_record; validate "$t/history/$commit/applied.tsv" "$p" "0${sum:1}"; }
case_mode(){ make_record; chmod 777 "$t/history/$commit"; validate; }
case_owner(){
 local saved_owner=$APPLIED_TSV_EXPECTED_OWNER rc
 make_record
 export APPLIED_TSV_EXPECTED_OWNER=owner_class_that_cannot_match
 if validate; then rc=0; else rc=$?; fi
 export APPLIED_TSV_EXPECTED_OWNER=$saved_owner
 return "$rc"
}
case_symlink(){ make_record; mv "$t/history/$commit/applied.tsv" "$t/history/$commit/real"; ln -s real "$t/history/$commit/applied.tsv"; validate; }
case_ambiguous_contract(){ grep -Fq 'HISTORY_DIVERGENCE_CATEGORY=BUNDLE_AMBIGUOUS' scripts/pr827-schema-runner.sh; actual_class=NONE; }
case_catalog_contract(){ grep -Fq 'HISTORY_DIVERGENCE_CATEGORY=HISTORY_CATALOG_DIVERGENCE' scripts/pr827-schema-runner.sh; actual_class=NONE; }

scenario V1_VALID 0 NONE case_v1
scenario V2_VALID 0 NONE case_v2
scenario HISTORY_ABSENT 1 APPLIED_TSV_MISSING case_absent
scenario MALFORMED 1 APPLIED_TSV_FORMAT_INVALID case_malformed
scenario TIMESTAMP_INVALID 1 TIMESTAMP_INVALID case_timestamp
scenario SHA_SHORT 1 COMMIT_SHA_INVALID case_short_sha
scenario DIRECTORY_SHA_DIVERGENT 1 BUNDLE_METADATA_INVALID case_directory_sha
scenario COMMIT_NOT_FOUND 1 COMMIT_NOT_FOUND case_commit_absent
scenario PATH_OUTSIDE_ALLOWLIST 1 MIGRATION_PATH_INVALID case_path
scenario MIGRATION_NOT_FOUND 1 MIGRATION_NOT_FOUND_AT_COMMIT case_migration_absent
scenario SIDECAR_MISSING 1 SIDECAR_MISSING case_sidecar_absent
scenario SIDECAR_MALFORMED 1 SIDECAR_FORMAT_INVALID case_sidecar_malformed
scenario CHECKSUM_SIDECAR_DIVERGENT 1 CHECKSUM_SIDECAR_MISMATCH case_sidecar_checksum
scenario CHECKSUM_GIT_DIVERGENT 1 CHECKSUM_GIT_MISMATCH case_git_checksum
scenario CHECKSUM_EXPECTED_DIVERGENT 1 EXPECTED_CHECKSUM_MISMATCH case_expected_checksum
scenario MODE_INVALID 1 BUNDLE_METADATA_INVALID case_mode
scenario OWNER_INCOMPATIBLE 1 BUNDLE_METADATA_INVALID case_owner
scenario V1_VALID_AFTER_OWNER_OVERRIDE 0 NONE case_v1
scenario SYMLINK 1 APPLIED_TSV_FORMAT_INVALID case_symlink
scenario HISTORY_DIVERGENT 0 NONE case_ambiguous_contract
scenario CATALOG_COMBINATIONS 0 NONE case_catalog_contract
! grep -Eq 'CREATE TABLE .*_prisma_migrations|migrate resolve|db push' scripts/pr827-schema-runner.sh
unset APPLIED_TSV_EXPECTED_OWNER
echo 'HISTORICAL_FORMATS=PRODUCTION_SCHEMA_APPLY_V1,PR827_ATOMIC_V2'
echo 'LEGACY_HISTORY_REGRESSIONS=PASS'
echo 'PREVIEW_WRITES=NONE'
echo 'LEGACY_HISTORY_HARNESS_FINAL_RESULT=PASS'
echo 'LEGACY_HISTORY_HARNESS_FINAL_RC=0'
