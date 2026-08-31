#!/usr/bin/env bash
# Strict readers for the two versioned legacy evidence formats.
history_failure=UNKNOWN; history_format=UNKNOWN
record_failure(){ history_failure=$1; return 1; }
pr827_validate_record(){
 local f=$1 wanted=$2 wanted_sum=$3 d ts sha path extra recorded recorded_path git_sum bundle_mode applied_mode sidecar_mode canonical_ts
 [[ -e $f ]] || record_failure APPLIED_TSV_MISSING || return 1
 [[ -f $f && ! -L $f ]] || record_failure APPLIED_TSV_FORMAT_INVALID || return 1
 d=${f%/*}; [[ -d $d && ! -L $d && $(stat -c '%U:%G' "$d") == "${APPLIED_TSV_EXPECTED_OWNER:-root:root}" ]] || record_failure BUNDLE_METADATA_INVALID || return 1
 [[ $(stat -c '%U:%G' "$f") == "${APPLIED_TSV_EXPECTED_OWNER:-root:root}" ]] || record_failure BUNDLE_METADATA_INVALID || return 1
 bundle_mode=$(stat -c '%a' "$d"); applied_mode=$(stat -c '%a' "$f")
 [[ $(wc -l <"$f") -eq 1 ]] || record_failure APPLIED_TSV_FORMAT_INVALID || return 1
 IFS=$'\t' read -r ts sha path extra <"$f" || record_failure APPLIED_TSV_FORMAT_INVALID || return 1
 [[ -n $ts && -n $sha && -n $path && -z ${extra:-} ]] || record_failure APPLIED_TSV_FORMAT_INVALID || return 1
 [[ $ts =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || record_failure TIMESTAMP_INVALID || return 1
 canonical_ts=$(date -u -d "$ts" +%FT%TZ 2>/dev/null) || record_failure TIMESTAMP_INVALID || return 1
 [[ $canonical_ts == "$ts" ]] || record_failure TIMESTAMP_INVALID || return 1
 [[ $sha =~ ^[0-9a-f]{40}$ ]] || record_failure COMMIT_SHA_INVALID || return 1
 [[ $path == "$wanted" ]] || record_failure MIGRATION_PATH_INVALID || return 1
 [[ ${d##*/} == "$sha" ]] || record_failure BUNDLE_METADATA_INVALID || return 1
 git cat-file -e "$sha^{commit}" 2>/dev/null || record_failure COMMIT_NOT_FOUND || return 1
 git cat-file -e "$sha:$wanted" 2>/dev/null || record_failure MIGRATION_NOT_FOUND_AT_COMMIT || return 1
 [[ -e $d/migration.sha256 ]] || record_failure SIDECAR_MISSING || return 1
 [[ -f $d/migration.sha256 && ! -L $d/migration.sha256 && $(stat -c '%U:%G' "$d/migration.sha256") == "${APPLIED_TSV_EXPECTED_OWNER:-root:root}" ]] || record_failure SIDECAR_FORMAT_INVALID || return 1
 sidecar_mode=$(stat -c '%a' "$d/migration.sha256")
 # v1 is the exact output of production-schema-apply.sh under the official root umask;
 # v2 is the explicitly protected/atomic format emitted by this runner.
 case "$bundle_mode:$applied_mode:$sidecar_mode" in
  755:644:644) history_format=PRODUCTION_SCHEMA_APPLY_V1 ;;
  700:600:600) history_format=PR827_ATOMIC_V2 ;;
  *) record_failure BUNDLE_METADATA_INVALID || return 1 ;;
 esac
 [[ $(wc -l <"$d/migration.sha256") -eq 1 ]] || record_failure SIDECAR_FORMAT_INVALID || return 1
 read -r recorded recorded_path extra <"$d/migration.sha256" || record_failure SIDECAR_FORMAT_INVALID || return 1
 [[ $recorded =~ ^[0-9a-f]{64}$ && $recorded_path == "$wanted" && -z ${extra:-} ]] || record_failure SIDECAR_FORMAT_INVALID || return 1
 git_sum=$(git show "$sha:$wanted" | sha256sum | cut -d' ' -f1)
 if [[ $git_sum != "$recorded" ]]; then
  if [[ $recorded == "$wanted_sum" ]]; then record_failure CHECKSUM_GIT_MISMATCH
  else record_failure CHECKSUM_SIDECAR_MISMATCH; fi
  return 1
 fi
 [[ $recorded == "$wanted_sum" ]] || record_failure EXPECTED_CHECKSUM_MISMATCH || return 1
 history_failure=NONE
}
