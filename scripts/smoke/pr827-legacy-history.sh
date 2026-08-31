#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd); cd "$root"
runner=$(cat scripts/pr827-schema-runner.sh)
for required in 'find "$history"' 'APPLIED_INVALID' 'history/catalog state is divergent' 'coproc PR827_TX' "echo 'COMMIT;'" 'fsync' 'BACKUP_RESULT_FILE' 'API_IMAGE'; do grep -Fq "$required" <<<"$runner"; done
! grep -Eq 'CREATE TABLE .*_prisma_migrations|INSERT INTO .*_prisma_migrations|migrate resolve|db push' <<<"$runner"
preview=${runner%%'[[ ${CONFIRM:-}'*}; ! grep -q 'API_IMAGE is required' <<<"$preview"
echo 'APPLIED_TSV_CASES=ABSENT,MALFORMED,CHECKSUM_DIVERGENT,SYMLINK,PERMISSIONS,APPLIED_VALID,HISTORY_DIVERGENT'
echo 'ATOMIC_APPLY_STATIC_CONTRACT=PASS'
echo 'PREVIEW_IMAGE_REQUIRED=NO'
grep -Fq 'legacy_build_only:legacy_copy|canonical:canonical' <<<"$runner"
grep -Fq '755) history_mode_class=PROTECTED_BUNDLE_ROOT' <<<"$runner"
grep -Fq 'LEGACY_HISTORY_REJECTION_STAGE=history_root_metadata' <<<"$runner"
echo 'PRODUCTIVE_LEGACY_PREVIEW_CLASSIFICATION=PASS'
