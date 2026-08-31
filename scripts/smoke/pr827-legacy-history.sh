#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
source scripts/lib/pr827-legacy-history.sh
p=apps/api/prisma/migrations/20260731150000_safe_production_schema_transition/migration.sql
commit=$(git rev-list HEAD -- "$p" | while read -r c; do [[ $(git show "$c:$p" | sha256sum | cut -d' ' -f1) == 66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506 ]] && { echo "$c"; break; }; done)
sum=66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
make_record(){
 rm -rf "$t/history"; mkdir -p "$t/history/$commit"
 printf '2026-08-01T00:00:00Z\t%s\t%s\n' "$commit" "$p" >"$t/history/$commit/applied.tsv"
 printf '%s  %s\n' "$sum" "$p" >"$t/history/$commit/migration.sha256"
 chmod "${1:-755}" "$t/history/$commit"; chmod "${2:-644}" "$t/history/$commit/"*
}
expect(){ local category=$1 wanted=${2:-$p} expected=${3:-$sum}; history_failure=UNKNOWN; if pr827_validate_record "$t/history/$commit/applied.tsv" "$wanted" "$expected"; then [[ $category == NONE ]]; else [[ $history_failure == "$category" ]]; fi; }
make_record; expect NONE; test "$history_format" = PRODUCTION_SCHEMA_APPLY_V1
make_record 700 600; expect NONE; test "$history_format" = PR827_ATOMIC_V2
make_record; printf 'bad\n' >"$t/history/$commit/applied.tsv"; expect APPLIED_TSV_FORMAT_INVALID
make_record; sed -i 's/2026-08-01/2026-02-31/' "$t/history/$commit/applied.tsv"; expect TIMESTAMP_INVALID
make_record; sed -i "s/$commit/abc/" "$t/history/$commit/applied.tsv"; expect COMMIT_SHA_INVALID
make_record; sed -i "s/$commit/0000000000000000000000000000000000000000/" "$t/history/$commit/applied.tsv"; expect BUNDLE_METADATA_INVALID
make_record; zero=0000000000000000000000000000000000000000; mv "$t/history/$commit" "$t/history/$zero"; sed -i "s/$commit/$zero/" "$t/history/$zero/applied.tsv"; history_failure=UNKNOWN; ! pr827_validate_record "$t/history/$zero/applied.tsv" "$p" "$sum"; test "$history_failure" = COMMIT_NOT_FOUND
make_record; sed -i "s#$p#outside/migration.sql#" "$t/history/$commit/applied.tsv"; expect MIGRATION_PATH_INVALID
make_record; head=$(git rev-parse HEAD); mv "$t/history/$commit" "$t/history/$head"; sed -i "s/$commit/$head/;s#$p#missing/migration.sql#" "$t/history/$head/applied.tsv"; history_failure=UNKNOWN; ! pr827_validate_record "$t/history/$head/applied.tsv" missing/migration.sql "$sum"; test "$history_failure" = MIGRATION_NOT_FOUND_AT_COMMIT
make_record; rm "$t/history/$commit/migration.sha256"; expect SIDECAR_MISSING
make_record; printf 'bad\n' >"$t/history/$commit/migration.sha256"; expect SIDECAR_FORMAT_INVALID
make_record; sed -i 's/^./0/' "$t/history/$commit/migration.sha256"; expect CHECKSUM_SIDECAR_MISMATCH
make_record; printf '0%s  %s\n' "${sum:1}" "$p" >"$t/history/$commit/migration.sha256"; expect CHECKSUM_GIT_MISMATCH "$p" "0${sum:1}"
make_record; expect EXPECTED_CHECKSUM_MISMATCH "$p" "0${sum:1}"
make_record; chmod 777 "$t/history/$commit"; expect BUNDLE_METADATA_INVALID
make_record; APPLIED_TSV_EXPECTED_OWNER=owner_class_that_cannot_match expect BUNDLE_METADATA_INVALID
make_record; mv "$t/history/$commit/applied.tsv" "$t/history/$commit/real"; ln -s real "$t/history/$commit/applied.tsv"; expect APPLIED_TSV_FORMAT_INVALID
# Cardinality and catalog divergence are classified by the caller; keep their fail-closed tokens executable/static.
grep -Fq 'HISTORY_DIVERGENCE_CATEGORY=BUNDLE_AMBIGUOUS' scripts/pr827-schema-runner.sh
grep -Fq 'HISTORY_DIVERGENCE_CATEGORY=HISTORY_CATALOG_DIVERGENCE' scripts/pr827-schema-runner.sh
! grep -Eq 'CREATE TABLE .*_prisma_migrations|migrate resolve|db push' scripts/pr827-schema-runner.sh
echo 'HISTORICAL_FORMATS=PRODUCTION_SCHEMA_APPLY_V1,PR827_ATOMIC_V2'
echo 'LEGACY_HISTORY_REGRESSIONS=PASS'
echo 'PREVIEW_WRITES=NONE'
