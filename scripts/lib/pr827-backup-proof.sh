#!/usr/bin/env bash

# Authoritative, versioned producer/consumer contract for production backups.
# FORMAT=2 deliberately has no compatibility fallback: FORMAT=1 did not name
# an immutable object and therefore cannot safely resolve a backup.
PR827_BACKUP_PROOF_FORMAT=2
PR827_BACKUP_RESULT_FILE_DEFAULT=/var/log/gest-o/backup/latest/result.tsv

pr827_backup_proof_contract() {
  PR827_BACKUP_PROOF_CONTRACT_ROOT=${PR827_BACKUP_PROOF_ROOT:-/var/log/gest-o/backup}
  PR827_BACKUP_PROOF_CONTRACT_OWNER=${PR827_BACKUP_PROOF_EXPECTED_OWNER:-root:root}
  [[ "$PR827_BACKUP_PROOF_CONTRACT_ROOT" == /* && "$PR827_BACKUP_PROOF_CONTRACT_ROOT" != / &&
     ! "$PR827_BACKUP_PROOF_CONTRACT_ROOT" =~ /\.\.?(/|$) ]] || return 1
  [[ "$PR827_BACKUP_PROOF_CONTRACT_OWNER" =~ ^[A-Za-z_][A-Za-z0-9_-]*:[A-Za-z_][A-Za-z0-9_-]*$ ]] || return 1
}

pr827_backup_fixture_authorize() {
  local fixture_real runner_real result_file=$3
  fixture_real=$(realpath "$1") || return 1; runner_real=$(realpath "$2") || return 1
  [[ "$fixture_real" == /tmp/* && "$runner_real" == "$fixture_real/checkout" &&
     "$result_file" == "$fixture_real/backup/latest/result.tsv" ]]
}

pr827_backup_check_dir() {
  [[ -d "$1" && ! -L "$1" && "$(stat -c '%U:%G:%a' -- "$1")" == "$PR827_BACKUP_PROOF_CONTRACT_OWNER:700" ]]
}
pr827_backup_check_file() {
  [[ -f "$1" && ! -L "$1" && -s "$1" && "$(stat -c '%h:%U:%G:%a' -- "$1")" == "1:$PR827_BACKUP_PROOF_CONTRACT_OWNER:600" ]]
}

# On success exports the only paths consumers are allowed to use, plus the
# identity observed both before and after the final checksum read.
pr827_backup_proof_validate() {
  local result_file=$1 expected_sha=$2 max_age=$3 root latest bundles bundle_dir
  local format='' status='' database='' sha='' created='' digest='' bundle_id=''
  local dump_rel='' manifest_rel='' device='' inode='' size='' mtime='' ctime='' key value extra
  local result_before result_after before after now age expected_manifest
  pr827_backup_proof_contract || return 1
  [[ "$result_file" == "$PR827_BACKUP_PROOF_CONTRACT_ROOT/latest/result.tsv" &&
     "$expected_sha" =~ ^[0-9a-f]{40}$ && "$max_age" =~ ^[0-9]+$ && "$max_age" -gt 0 ]] || return 1
  root=$PR827_BACKUP_PROOF_CONTRACT_ROOT; latest=$root/latest; bundles=$root/bundles
  for component in "$root" "$latest" "$bundles"; do pr827_backup_check_dir "$component" || return 1; done
  pr827_backup_check_file "$result_file" || return 1
  result_before=$(stat -c '%d:%i:%s:%Y' -- "$result_file") || return 1
  while IFS=$'\t' read -r key value extra; do
    [[ -n "$key" && -n "$value" && -z "$extra" ]] || return 1
    case "$key" in
      FORMAT) [[ -z "$format" ]] || return 1; format=$value;; STATUS) [[ -z "$status" ]] || return 1; status=$value;;
      DATABASE) [[ -z "$database" ]] || return 1; database=$value;; SHA) [[ -z "$sha" ]] || return 1; sha=$value;;
      CREATED_AT_EPOCH) [[ -z "$created" ]] || return 1; created=$value;; DUMP_SHA256) [[ -z "$digest" ]] || return 1; digest=$value;;
      BUNDLE_ID) [[ -z "$bundle_id" ]] || return 1; bundle_id=$value;; DUMP_PATH) [[ -z "$dump_rel" ]] || return 1; dump_rel=$value;;
      MANIFEST_PATH) [[ -z "$manifest_rel" ]] || return 1; manifest_rel=$value;; DEVICE) [[ -z "$device" ]] || return 1; device=$value;;
      INODE) [[ -z "$inode" ]] || return 1; inode=$value;; SIZE) [[ -z "$size" ]] || return 1; size=$value;;
      MTIME_EPOCH) [[ -z "$mtime" ]] || return 1; mtime=$value;; CTIME_EPOCH) [[ -z "$ctime" ]] || return 1; ctime=$value;; *) return 1;;
    esac
  done <"$result_file"
  result_after=$(stat -c '%d:%i:%s:%Y' -- "$result_file") || return 1; [[ "$result_before" == "$result_after" ]] || return 1
  [[ "$format" == 2 && "$status" == PASS && "$database" == salesforce_pro && "$sha" == "$expected_sha" ]] || return 1
  [[ "$created" =~ ^[0-9]+$ && "$digest" =~ ^[0-9a-f]{64}$ && "$bundle_id" == "$sha-$created-$digest" ]] || return 1
  [[ "$dump_rel" == "bundles/$bundle_id/dump.sql.gz" && "$manifest_rel" == "bundles/$bundle_id/dump.sql.gz.sha256" ]] || return 1
  [[ "$dump_rel" != /* && "$dump_rel" != *..* && "$manifest_rel" != /* && "$manifest_rel" != *..* ]] || return 1
  bundle_dir=$root/bundles/$bundle_id
  [[ "$(readlink -m -- "$bundle_dir")" == "$bundle_dir" ]] || return 1
  pr827_backup_check_dir "$bundle_dir" || return 1
  [[ "$(find "$bundle_dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)" == $'dump.sql.gz\ndump.sql.gz.sha256' ]] || return 1
  PR827_BACKUP_RESOLVED_DUMP=$root/$dump_rel; PR827_BACKUP_RESOLVED_MANIFEST=$root/$manifest_rel
  pr827_backup_check_file "$PR827_BACKUP_RESOLVED_DUMP" || return 1; pr827_backup_check_file "$PR827_BACKUP_RESOLVED_MANIFEST" || return 1
  expected_manifest="$digest  dump.sql.gz"
  [[ "$(cat "$PR827_BACKUP_RESOLVED_MANIFEST")" == "$expected_manifest" ]] || return 1
  before=$(stat -c '%d:%i:%s:%Y:%Z' -- "$PR827_BACKUP_RESOLVED_DUMP") || return 1
  [[ "$before" == "$device:$inode:$size:$mtime:$ctime" && "$mtime" == "$created" ]] || return 1
  (cd "$bundle_dir" && sha256sum -c dump.sql.gz.sha256 >/dev/null) || return 1
  after=$(stat -c '%d:%i:%s:%Y:%Z' -- "$PR827_BACKUP_RESOLVED_DUMP") || return 1; [[ "$before" == "$after" ]] || return 1
  now=$(date +%s); age=$((now-created)); (( age >= 0 && age <= max_age )) || return 1
  PR827_BACKUP_RESOLVED_BUNDLE_ID=$bundle_id; PR827_BACKUP_RESOLVED_SHA256=$digest
  PR827_BACKUP_RESOLVED_IDENTITY=$after; PR827_BACKUP_RESOLVED_CREATED_AT_EPOCH=$created
  export PR827_BACKUP_RESOLVED_DUMP PR827_BACKUP_RESOLVED_MANIFEST PR827_BACKUP_RESOLVED_BUNDLE_ID PR827_BACKUP_RESOLVED_SHA256 PR827_BACKUP_RESOLVED_IDENTITY PR827_BACKUP_RESOLVED_CREATED_AT_EPOCH
}

pr827_backup_proof_publish() {
  local source_dump=$1 expected_sha=$2 result_file=$3 max_age=$4 root bundles latest stage pointer='' previous created digest bundle_id identity owner group
  pr827_backup_proof_contract || return 1
  [[ "$result_file" == "$PR827_BACKUP_PROOF_CONTRACT_ROOT/latest/result.tsv" && -f "$source_dump" && ! -L "$source_dump" ]] || return 1
  root=$PR827_BACKUP_PROOF_CONTRACT_ROOT; bundles=$root/bundles; latest=$root/latest
  owner=${PR827_BACKUP_PROOF_CONTRACT_OWNER%%:*}; group=${PR827_BACKUP_PROOF_CONTRACT_OWNER#*:}
  install -d -o "$owner" -g "$group" -m 700 "$root" "$bundles"
  pr827_backup_check_dir "$root" && pr827_backup_check_dir "$bundles" || return 1
  created=$(date +%s); stage=$(mktemp -d "$bundles/.bundle.XXXXXXXX")
  install -o "$owner" -g "$group" -m 600 "$source_dump" "$stage/dump.sql.gz"
  touch -d "@$created" "$stage/dump.sql.gz"; digest=$(sha256sum "$stage/dump.sql.gz" | awk '{print $1}')
  printf '%s  dump.sql.gz\n' "$digest" >"$stage/dump.sql.gz.sha256"; chown "$owner:$group" "$stage/dump.sql.gz.sha256"; chmod 600 "$stage/dump.sql.gz.sha256"
  bundle_id="$expected_sha-$created-$digest"; identity=$(stat -c '%d:%i:%s:%Y' "$stage/dump.sql.gz")
  python3 - "$stage" <<'PY'
import os,sys
for n in ('dump.sql.gz','dump.sql.gz.sha256'):
 with open(os.path.join(sys.argv[1],n),'rb') as f: os.fsync(f.fileno())
d=os.open(sys.argv[1],os.O_RDONLY); os.fsync(d); os.close(d)
PY
  [[ ! -e "$bundles/$bundle_id" && ! -L "$bundles/$bundle_id" ]] || return 1
  mv "$stage" "$bundles/$bundle_id"; stage=''; sync -f "$bundles"
  # inode is stable across rename on the same filesystem; record the published identity.
  identity=$(stat -c '%d:%i:%s:%Y:%Z' "$bundles/$bundle_id/dump.sql.gz")
  pointer=$(mktemp -d "$root/.latest.XXXXXXXX")
  IFS=: read -r device inode size mtime ctime <<<"$identity"
  printf 'FORMAT\t2\nSTATUS\tPASS\nDATABASE\tsalesforce_pro\nSHA\t%s\nCREATED_AT_EPOCH\t%s\nDUMP_SHA256\t%s\nBUNDLE_ID\t%s\nDUMP_PATH\tbundles/%s/dump.sql.gz\nMANIFEST_PATH\tbundles/%s/dump.sql.gz.sha256\nDEVICE\t%s\nINODE\t%s\nSIZE\t%s\nMTIME_EPOCH\t%s\nCTIME_EPOCH\t%s\n' "$expected_sha" "$created" "$digest" "$bundle_id" "$bundle_id" "$bundle_id" "$device" "$inode" "$size" "$mtime" "$ctime" >"$pointer/result.tsv"
  chown "$owner:$group" "$pointer" "$pointer/result.tsv"; chmod 700 "$pointer"; chmod 600 "$pointer/result.tsv"
  python3 - "$pointer/result.tsv" "$pointer" <<'PY'
import os,sys
for p in sys.argv[1:]:
 f=os.open(p,os.O_RDONLY); os.fsync(f); os.close(f)
PY
  if [[ "${PR827_BACKUP_TEST_FAIL_PUBLICATION:-false}" == true ]]; then rm -rf -- "$pointer"; return 1; fi
  previous=$root/.previous.$$
  [[ ! -e "$previous" && ! -L "$previous" ]] || return 1
  [[ ! -e "$latest" ]] || { [[ -d "$latest" && ! -L "$latest" ]] || return 1; mv "$latest" "$previous"; }
  mv "$pointer" "$latest"; pointer=''; sync -f "$root"
  if ! pr827_backup_proof_validate "$result_file" "$expected_sha" "$max_age"; then
    rm -rf -- "$latest"; [[ ! -e "$previous" ]] || mv "$previous" "$latest"; sync -f "$root"; return 1
  fi
  rm -rf -- "$previous"
}
