#!/usr/bin/env bash
# Shared, fail-closed contract for the production preflight result bundle.

readonly PRODUCTION_PREFLIGHT_PROOF_FORMAT=1
readonly PRODUCTION_PREFLIGHT_PROOF_ROOT_DEFAULT=/var/log/gest-o/preflight
readonly PRODUCTION_PREFLIGHT_PROOF_RESULT_DEFAULT=/var/log/gest-o/preflight/latest/result.tsv

production_preflight_proof_contract() {
  PRODUCTION_PREFLIGHT_PROOF_ROOT=${PRODUCTION_PREFLIGHT_PROOF_ROOT:-$PRODUCTION_PREFLIGHT_PROOF_ROOT_DEFAULT}
  PRODUCTION_PREFLIGHT_PROOF_OWNER=${PRODUCTION_PREFLIGHT_PROOF_EXPECTED_OWNER:-root:root}
  [[ "$PRODUCTION_PREFLIGHT_PROOF_ROOT" == /* && "$PRODUCTION_PREFLIGHT_PROOF_ROOT" != / &&
     ! "$PRODUCTION_PREFLIGHT_PROOF_ROOT" =~ /\.\.?(/|$) ]] || return 1
  [[ "$PRODUCTION_PREFLIGHT_PROOF_OWNER" =~ ^[A-Za-z_][A-Za-z0-9_-]*:[A-Za-z_][A-Za-z0-9_-]*$ ]] || return 1
}

production_preflight_proof_no_symlink_path() {
  local path=$1 part current=''
  IFS='/' read -ra parts <<<"${path#/}"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    current="$current/$part"
    [[ ! -L "$current" ]] || return 1
  done
}

production_preflight_proof_validate() {
  local result_file=$1 expected_sha=$2 expected_database=$3 expected_container=$4 expected_volume=$5 max_age=$6
  local root latest now age component
  local format='' status='' sha='' mode='' database='' container='' volume='' created='' bundle_id=''
  production_preflight_proof_contract || return 1
  [[ "$result_file" == "$PRODUCTION_PREFLIGHT_PROOF_ROOT/latest/result.tsv" ]] || return 1
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ && "$max_age" =~ ^[0-9]+$ && "$max_age" -gt 0 ]] || return 1
  latest=${result_file%/result.tsv}; root=${latest%/latest}
  [[ "$root" == "$PRODUCTION_PREFLIGHT_PROOF_ROOT" ]] || return 1
  production_preflight_proof_no_symlink_path "$result_file" || return 1
  if [[ "$root" == "$PRODUCTION_PREFLIGHT_PROOF_ROOT_DEFAULT" ]]; then
    for component in /var /var/log /var/log/gest-o; do [[ -d "$component" && ! -L "$component" ]] || return 1; done
  fi
  for component in "$root" "$latest"; do
    [[ -d "$component" && ! -L "$component" ]] || return 1
    [[ "$(stat -c '%U:%G:%a' "$component")" == "$PRODUCTION_PREFLIGHT_PROOF_OWNER:700" ]] || return 1
  done
  [[ -f "$result_file" && ! -L "$result_file" && -s "$result_file" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "$result_file")" == "$PRODUCTION_PREFLIGHT_PROOF_OWNER:600" ]] || return 1
  while IFS=$'\t' read -r key value extra; do
    [[ -n "$key" && -n "$value" && -z "$extra" ]] || return 1
    case "$key" in
      FORMAT) [[ -z "$format" ]] || return 1; format=$value ;;
      STATUS) [[ -z "$status" ]] || return 1; status=$value ;;
      SHA) [[ -z "$sha" ]] || return 1; sha=$value ;;
      MODE) [[ -z "$mode" ]] || return 1; mode=$value ;;
      DATABASE) [[ -z "$database" ]] || return 1; database=$value ;;
      DB_CONTAINER) [[ -z "$container" ]] || return 1; container=$value ;;
      DB_VOLUME) [[ -z "$volume" ]] || return 1; volume=$value ;;
      CREATED_AT_EPOCH) [[ -z "$created" ]] || return 1; created=$value ;;
      BUNDLE_ID) [[ -z "$bundle_id" ]] || return 1; bundle_id=$value ;;
      *) return 1 ;;
    esac
  done <"$result_file"
  [[ "$format" == "$PRODUCTION_PREFLIGHT_PROOF_FORMAT" && "$status" == PASS && "$mode" == cutover ]] || return 1
  [[ "$sha" == "$expected_sha" && "$database" == "$expected_database" &&
     "$container" == "$expected_container" && "$volume" == "$expected_volume" ]] || return 1
  [[ "$created" =~ ^[0-9]+$ && "$bundle_id" == "$sha-$created" ]] || return 1
  now=$(date +%s); age=$((now-created)); (( age >= 0 && age <= max_age )) || return 1
}

production_preflight_proof_publish() {
  local result_file=$1 expected_sha=$2 database=$3 container=$4 volume=$5 max_age=$6
  local root latest stage previous created bundle_id published=false expected_user expected_group
  production_preflight_proof_contract || return 1
  [[ "$result_file" == "$PRODUCTION_PREFLIGHT_PROOF_ROOT/latest/result.tsv" && "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ -n "$database" && -n "$container" && -n "$volume" ]] || return 1
  root=$PRODUCTION_PREFLIGHT_PROOF_ROOT; latest=$root/latest
  expected_user=${PRODUCTION_PREFLIGHT_PROOF_OWNER%%:*}; expected_group=${PRODUCTION_PREFLIGHT_PROOF_OWNER#*:}
  production_preflight_proof_no_symlink_path "$(dirname "$root")" || return 1
  [[ ! -e "$root" && ! -L "$root" ]] || production_preflight_proof_no_symlink_path "$root" || return 1
  install -d -o "$expected_user" -g "$expected_group" -m 700 "$root"
  [[ -d "$root" && ! -L "$root" && "$(stat -c '%U:%G:%a' "$root")" == "$PRODUCTION_PREFLIGHT_PROOF_OWNER:700" ]] || return 1
  stage=$(mktemp -d "$root/.latest.XXXXXXXX"); previous="$root/.previous.$$"
  cleanup_preflight_stage(){
    [[ "${published:-false}" == true || -z "${stage:-}" ]] || rm -rf -- "$stage"
    [[ -z "${previous:-}" ]] || rm -rf -- "$previous"
    trap - RETURN
  }
  trap cleanup_preflight_stage RETURN
  created=$(date +%s); bundle_id="$expected_sha-$created"
  printf 'FORMAT\t%s\nSTATUS\tPASS\nSHA\t%s\nMODE\tcutover\nDATABASE\t%s\nDB_CONTAINER\t%s\nDB_VOLUME\t%s\nCREATED_AT_EPOCH\t%s\nBUNDLE_ID\t%s\n' \
    "$PRODUCTION_PREFLIGHT_PROOF_FORMAT" "$expected_sha" "$database" "$container" "$volume" "$created" "$bundle_id" >"$stage/result.tsv"
  chown "$PRODUCTION_PREFLIGHT_PROOF_OWNER" "$stage" "$stage/result.tsv"; chmod 700 "$stage"; chmod 600 "$stage/result.tsv"
  python3 - "$stage" <<'PY'
import os, sys
with open(os.path.join(sys.argv[1], 'result.tsv'), 'rb') as stream: os.fsync(stream.fileno())
fd=os.open(sys.argv[1], os.O_RDONLY); os.fsync(fd); os.close(fd)
PY
  [[ "${PRODUCTION_PREFLIGHT_TEST_FAIL_PUBLICATION:-false}" != true ]] || return 1
  if [[ -e "$latest" || -L "$latest" ]]; then
    [[ -d "$latest" && ! -L "$latest" ]] || return 1
    mv "$latest" "$previous"
  fi
  if ! mv "$stage" "$latest"; then [[ ! -e "$previous" ]] || mv "$previous" "$latest"; return 1; fi
  published=true; sync -f "$root"
  if ! production_preflight_proof_validate "$result_file" "$expected_sha" "$database" "$container" "$volume" "$max_age"; then
    rm -rf -- "$latest"; [[ ! -e "$previous" ]] || mv "$previous" "$latest"; sync -f "$root"; return 1
  fi
  rm -rf -- "$previous"; trap - RETURN
}
