#!/usr/bin/env bash
set -Eeuo pipefail

# Promote the authorized legacy production environment without interpreting,
# rewriting, or logging any protected value.
umask 077
ENV_DIR="${PRODUCTION_ENV_DIR:-/root/demetra-env}"
CANONICAL="${PRODUCTION_CANONICAL_ENV_FILE:-$ENV_DIR/.env}"
LEGACY="${PRODUCTION_LEGACY_ENV_FILE:-$ENV_DIR/production.env}"
BACKUP_DIR="${PRODUCTION_ENV_BACKUP_DIR:-$ENV_DIR/backups}"
EXPECTED_OWNER="${ERP_ENV_EXPECTED_OWNER:-root:root}"
EXPECTED_MODE="${ERP_ENV_EXPECTED_MODE:-600}"
CONFIRMATION="${CONFIRM:-}"
die(){ printf '[canonical-env-preparation] FAIL: %s\n' "$1" >&2; exit 1; }
metadata(){ [[ -f "$1" && ! -L "$1" ]] && [[ "$(stat -c '%U:%G' "$1")" == "$EXPECTED_OWNER" ]] && [[ "$(stat -c '%a' "$1")" == "$EXPECTED_MODE" ]]; }

[[ "$CONFIRMATION" == PREPARE_CANONICAL_PRODUCTION_ENV ]] || die 'literal confirmation is required'
[[ "$CANONICAL" != "$LEGACY" ]] || die 'canonical and legacy paths are ambiguous'
[[ "${CANONICAL%/*}" == "$ENV_DIR" && "${LEGACY%/*}" == "$ENV_DIR" ]] || die 'environment paths are outside the authorized directory'
metadata "$LEGACY" || die 'legacy source metadata is invalid'
legacy_before=$(sha256sum "$LEGACY" | cut -d' ' -f1)

validate_contract(){
  local file=$1 keys required name
  awk '/^[[:space:]]*($|#)/{next} /^[A-Za-z_][A-Za-z0-9_]*=/{next} {exit 1}' "$file" || die 'environment syntax is invalid'
  keys=$(awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{print $1}' "$file" | LC_ALL=C sort)
  [[ -n "$keys" && "$(printf '%s\n' "$keys" | uniq -d | wc -l)" -eq 0 ]] || die 'environment key names are empty or duplicated'
  required=(DATABASE_URL JWT_SECRET JWT_ACCESS_SECRET JWT_REFRESH_SECRET ULTRAFV3_BASE_URL ERP_CREDENTIAL_ENCRYPTION_KEY ERP_SYNC_SCHEDULER_ENABLED TENANCY_MODE TENANT_READ_PILOT_ENABLED DATABASE_SCHEMA_MODE SEED_ON_BOOTSTRAP ENABLE_PREVIEW_SEED ENABLE_SMOKE_BOOTSTRAP)
  for name in "${required[@]}"; do
    awk -F= -v key="$name" '$1==key && length(substr($0,index($0,"=")+1))>0{ok=1} END{exit !ok}' "$file" || die 'a required key is absent or empty'
  done
  # Format checks expose only a classification on failure.
  awk -F= '$1=="DATABASE_URL"{v=substr($0,index($0,"=")+1); ok=(v ~ /^postgres(ql)?:\/\//)} END{exit !ok}' "$file" || die 'DATABASE_URL format is invalid'
  awk -F= '$1=="ULTRAFV3_BASE_URL"{v=substr($0,index($0,"=")+1); ok=(v ~ /^https?:\/\//)} END{exit !ok}' "$file" || die 'ERP URL format is invalid'
  for required in ERP_SYNC_SCHEDULER_ENABLED=true TENANCY_MODE=disabled TENANT_READ_PILOT_ENABLED=false DATABASE_SCHEMA_MODE=external SEED_ON_BOOTSTRAP=false ENABLE_PREVIEW_SEED=false ENABLE_SMOKE_BOOTSTRAP=false; do
    name=${required%%=*}; awk -F= -v key="$name" -v wanted="${required#*=}" '$1==key && substr($0,index($0,"=")+1)==wanted{ok=1} END{exit !ok}' "$file" || die 'a closed production gate has an invalid policy'
  done
  KEYSET_HASH=$(printf '%s\n' "$keys" | sha256sum | cut -d' ' -f1)
}

validate_contract "$LEGACY"; legacy_keyset=$KEYSET_HASH
if [[ -e "$CANONICAL" || -L "$CANONICAL" ]]; then
  metadata "$CANONICAL" || die 'canonical source metadata is invalid'
  validate_contract "$CANONICAL"
  [[ "$KEYSET_HASH" == "$legacy_keyset" ]] || die 'canonical and legacy key sets differ'
  cmp -s "$LEGACY" "$CANONICAL" || die 'canonical and legacy protected payloads differ'
  atomic=PASS
else
  install -d -m 700 "$BACKUP_DIR"
  rollback_backup="$BACKUP_DIR/environment-before-canonical-$(date -u +%Y%m%dT%H%M%SZ).backup"
  [[ ! -e "$rollback_backup" && ! -L "$rollback_backup" ]] || die 'rollback backup destination already exists'
  install -m 600 "$LEGACY" "$rollback_backup"
  if [[ "$EXPECTED_OWNER" == root:root ]]; then chown root:root "$rollback_backup"; fi
  metadata "$rollback_backup" || die 'rollback backup metadata is invalid'
  cmp -s "$LEGACY" "$rollback_backup" || die 'rollback backup payload differs from legacy source'
  python3 - "$rollback_backup" "$BACKUP_DIR" <<'PY'
import os, sys
fd=os.open(sys.argv[1], os.O_RDONLY); os.fsync(fd); os.close(fd)
fd=os.open(sys.argv[2], os.O_RDONLY); os.fsync(fd); os.close(fd)
PY
  tmp=$(mktemp "$ENV_DIR/.env.prepare.XXXXXX")
  trap 'rm -f "${tmp:-}"' EXIT
  cat -- "$LEGACY" >"$tmp"
  chmod 600 "$tmp"
  if [[ "$EXPECTED_OWNER" == root:root ]]; then chown root:root "$tmp"; fi
  metadata "$tmp" || die 'candidate metadata is invalid'
  validate_contract "$tmp"; [[ "$KEYSET_HASH" == "$legacy_keyset" ]] || die 'candidate key set differs'
  cmp -s "$LEGACY" "$tmp" || die 'candidate payload differs from legacy source'
  python3 - "$tmp" "$ENV_DIR" <<'PY'
import os, sys
fd=os.open(sys.argv[1], os.O_RDONLY); os.fsync(fd); os.close(fd)
os.replace(sys.argv[1], os.path.join(sys.argv[2], '.env'))
fd=os.open(sys.argv[2], os.O_RDONLY); os.fsync(fd); os.close(fd)
PY
  tmp=''; atomic=PASS
fi

metadata "$CANONICAL" || die 'published canonical metadata is invalid'
validate_contract "$CANONICAL"; [[ "$KEYSET_HASH" == "$legacy_keyset" ]] || die 'published key set differs'
cmp -s "$LEGACY" "$CANONICAL" || die 'published payload differs from legacy source'
[[ "$(sha256sum "$LEGACY" | cut -d' ' -f1)" == "$legacy_before" ]] || die 'legacy source changed'
printf '%s\n' \
  'PRODUCTION_ENV_SOURCE=canonical' 'PRODUCTION_ENV_METADATA=VALID' \
  'PRODUCTION_ENV_PERMISSIONS=PASS' 'PRODUCTION_ENV_REQUIRED_KEYS=PASS' \
  "PRODUCTION_ENV_ATOMIC_PUBLICATION=$atomic" \
  'PRODUCTION_ENV_LEGACY_SOURCE_IMMUTABLE=PASS' 'READY_FOR_CUTOVER=YES'
