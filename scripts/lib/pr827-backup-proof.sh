#!/usr/bin/env bash

# Versioned producer/consumer contract for the backup proof required by PR827.
PR827_BACKUP_PROOF_FORMAT=1
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
  fixture_real=$(realpath "$1") || return 1
  runner_real=$(realpath "$2") || return 1
  [[ "$fixture_real" == /tmp/* ]] || return 1
  [[ "$runner_real" == "$fixture_real/checkout" ]] || return 1
  [[ "$result_file" == "$fixture_real/backup/latest/result.tsv" ]] || return 1
}

pr827_backup_proof_validate() {
  local result_file=$1 expected_sha=$2 max_age=$3
  local latest root dump manifest now age before after
  local format='' status='' database='' sha='' created='' digest='' bundle_id=''

  pr827_backup_proof_contract || return 1
  [[ "$result_file" == "$PR827_BACKUP_PROOF_CONTRACT_ROOT/latest/result.tsv" ]] || return 1
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ && "$max_age" =~ ^[0-9]+$ && "$max_age" -gt 0 ]] || return 1
  latest=${result_file%/result.tsv}; root=${latest%/latest}
  [[ "$root" == "$PR827_BACKUP_PROOF_CONTRACT_ROOT" && "$latest" == "$root/latest" ]] || return 1

  # Every component controlled by this contract is a real directory/file.  A
  # symlink at any level must not redirect the privileged apply reader.
  local component
  for component in "$root" "$latest"; do
    [[ -d "$component" && ! -L "$component" ]] || return 1
  done
  if [[ "$root" == /var/log/gest-o/backup ]]; then
    for component in /var /var/log /var/log/gest-o; do
      [[ -d "$component" && ! -L "$component" ]] || return 1
    done
  fi
  [[ "$(stat -c '%U:%G:%a' "$root")" == "$PR827_BACKUP_PROOF_CONTRACT_OWNER:700" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "$latest")" == "$PR827_BACKUP_PROOF_CONTRACT_OWNER:700" ]] || return 1

  dump="$latest/dump.sql.gz"; manifest="$latest/dump.sql.gz.sha256"
  for component in "$dump" "$manifest" "$result_file"; do
    [[ -f "$component" && ! -L "$component" && -s "$component" ]] || return 1
    [[ "$(stat -c '%U:%G:%a' "$component")" == "$PR827_BACKUP_PROOF_CONTRACT_OWNER:600" ]] || return 1
  done

  while IFS=$'\t' read -r key value extra; do
    [[ -n "$key" && -n "$value" && -z "$extra" ]] || return 1
    case "$key" in
      FORMAT) [[ -z "$format" ]]; format=$value ;;
      STATUS) [[ -z "$status" ]]; status=$value ;;
      DATABASE) [[ -z "$database" ]]; database=$value ;;
      SHA) [[ -z "$sha" ]]; sha=$value ;;
      CREATED_AT_EPOCH) [[ -z "$created" ]]; created=$value ;;
      DUMP_SHA256) [[ -z "$digest" ]]; digest=$value ;;
      BUNDLE_ID) [[ -z "$bundle_id" ]]; bundle_id=$value ;;
      *) return 1 ;;
    esac
  done <"$result_file"
  [[ "$format" == "$PR827_BACKUP_PROOF_FORMAT" && "$status" == PASS && "$database" == salesforce_pro ]] || return 1
  [[ "$sha" == "$expected_sha" && "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$created" =~ ^[0-9]+$ && "$bundle_id" == "$sha-$created" ]] || return 1
  awk -v digest="$digest" 'NF==2 && $1==digest && $2=="dump.sql.gz"{n++} END{exit n==1?0:1}' "$manifest" || return 1
  before=$(stat -c '%d:%i:%s:%Y' "$dump") || return 1
  (cd "$latest" && sha256sum -c dump.sql.gz.sha256 >/dev/null) || return 1
  after=$(stat -c '%d:%i:%s:%Y' "$dump") || return 1
  [[ "$before" == "$after" ]] || return 1
  now=$(date +%s); age=$((now-created))
  (( age >= 0 && age <= max_age )) || return 1
}

pr827_backup_proof_publish() {
  local source_dump=$1 expected_sha=$2 result_file=$3 max_age=$4
  local latest root stage previous created digest bundle_id published=false
  pr827_backup_proof_contract || return 1
  [[ "$result_file" == "$PR827_BACKUP_PROOF_CONTRACT_ROOT/latest/result.tsv" ]] || return 1
  latest=${result_file%/result.tsv}; root=${latest%/latest}
  local expected_user=${PR827_BACKUP_PROOF_CONTRACT_OWNER%%:*} expected_group=${PR827_BACKUP_PROOF_CONTRACT_OWNER#*:}
  install -d -o "$expected_user" -g "$expected_group" -m 700 "$root"
  [[ ! -L "$root" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "$root")" == "$PR827_BACKUP_PROOF_CONTRACT_OWNER:700" ]] || return 1
  stage=$(mktemp -d "$root/.latest.XXXXXXXX"); previous="$root/.previous.$$"
  cleanup_proof_stage() { [[ "$published" == true ]] || rm -rf -- "$stage"; rm -rf -- "$previous"; }
  trap cleanup_proof_stage RETURN
  install -o "$expected_user" -g "$expected_group" -m 600 "$source_dump" "$stage/dump.sql.gz"
  digest=$(sha256sum "$stage/dump.sql.gz" | awk '{print $1}')
  printf '%s  dump.sql.gz\n' "$digest" >"$stage/dump.sql.gz.sha256"
  created=$(date +%s); bundle_id="$expected_sha-$created"
  printf 'FORMAT\t%s\nSTATUS\tPASS\nDATABASE\tsalesforce_pro\nSHA\t%s\nCREATED_AT_EPOCH\t%s\nDUMP_SHA256\t%s\nBUNDLE_ID\t%s\n' \
    "$PR827_BACKUP_PROOF_FORMAT" "$expected_sha" "$created" "$digest" "$bundle_id" >"$stage/result.tsv"
  chown "$PR827_BACKUP_PROOF_CONTRACT_OWNER" "$stage" "$stage"/*; chmod 700 "$stage"; chmod 600 "$stage"/*
  python3 - "$stage" <<'PY'
import os, sys
for name in ('dump.sql.gz', 'dump.sql.gz.sha256', 'result.tsv'):
    with open(os.path.join(sys.argv[1], name), 'rb') as stream:
        os.fsync(stream.fileno())
fd = os.open(sys.argv[1], os.O_RDONLY); os.fsync(fd); os.close(fd)
PY
  [[ "${PR827_BACKUP_TEST_FAIL_PUBLICATION:-false}" != true ]] || return 1
  if [[ -e "$latest" || -L "$latest" ]]; then
    [[ -d "$latest" && ! -L "$latest" ]] || return 1
    mv "$latest" "$previous"
  fi
  if ! mv "$stage" "$latest"; then
    [[ ! -e "$previous" ]] || mv "$previous" "$latest"
    return 1
  fi
  published=true
  sync -f "$root"
  if ! pr827_backup_proof_validate "$result_file" "$expected_sha" "$max_age"; then
    rm -rf -- "$latest"
    [[ ! -e "$previous" ]] || mv "$previous" "$latest"
    sync -f "$root"
    return 1
  fi
  rm -rf -- "$previous"
  trap - RETURN
}
