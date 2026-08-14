#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/prepare-production-recovery-backup.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

APP="$TMP/app"; AUTH="$TMP/backups"; CANONICAL="$TMP/.env"; LEGACY="$TMP/production.env"
mkdir -p "$APP/scripts/lib" "$AUTH"
mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\nexit 1\n' >"$TMP/bin/docker"; chmod +x "$TMP/bin/docker"
cp "$SCRIPT" "$APP/scripts/prepare-production-recovery-backup.sh"
cp "$ROOT/scripts/lib/production-backup-common.sh" "$APP/scripts/lib/production-backup-common.sh"
git -C "$APP" init -q -b main
git -C "$APP" config user.email test@example.invalid
git -C "$APP" config user.name backup-contract-test
git -C "$APP" add . && git -C "$APP" commit -qm initial
SHA="$(git -C "$APP" rev-parse HEAD)"
git -C "$APP" update-ref refs/remotes/origin/main "$SHA"

env_body() {
  cat <<EOF
DATABASE_URL=postgresql://backup-sentinel:password-sentinel@database.example.invalid:5432/salesforce_pro
PRODUCTION_DB_HOST_EXPECTED=database.example.invalid
PRODUCTION_DB_CONTAINER_EXPECTED=postgres-production
PRODUCTION_DB_VOLUME_EXPECTED=production-data
PRODUCTION_BACKUP_FILE=$AUTH/production.sql.gz
PRODUCTION_BACKUP_SHA256_FILE=$AUTH/production.sql.gz.sha256
EOF
}
write_env(){ env_body >"$1"; chmod 600 "$1"; }
run_case(){
  local output=$1; shift
  set +e
  PATH="$TMP/bin:$PATH" APP_DIR="$APP" PRODUCTION_BACKUP_AUTHORIZED_DIR="$AUTH" \
    PRODUCTION_BACKUP_ENV_FILE="$CANONICAL" PRODUCTION_BACKUP_LEGACY_ENV_FILE="$LEGACY" \
    CONFIRM=PREPARE_PRODUCTION_RECOVERY_BACKUP EXPECTED_SHA="$SHA" \
    bash "$SCRIPT" "$@" >"$output" 2>&1
  CASE_RC=$?
  set -e
}
assert_contains(){ grep -Fq -- "$2" "$1" || { printf 'missing marker: %s\n' "$2" >&2; exit 1; }; }
assert_redacted(){ ! grep -Eq 'backup-sentinel|password-sentinel|database\.example\.invalid|/tmp/' "$1"; }

# A: canonical wins. The mocked host intentionally stops at the later inventory gate.
write_env "$CANONICAL"; write_env "$LEGACY"; out="$TMP/a"; run_case "$out"
assert_contains "$out" 'PRODUCTION_BACKUP_ENV_SOURCE=canonical'; assert_redacted "$out"

# B/K/L: an absent canonical selects the immutable, read-only legacy source.
rm -f "$CANONICAL"; before="$(sha256sum "$LEGACY")"; out="$TMP/b"; run_case "$out"
assert_contains "$out" 'PRODUCTION_BACKUP_ENV_SOURCE=legacy_read_only'
[[ "$before" == "$(sha256sum "$LEGACY")" && ! -e "$CANONICAL" ]]; assert_redacted "$out"

# C: a present but invalid canonical is authoritative and cannot fall back.
printf 'MALFORMED LINE\n' >"$CANONICAL"; chmod 600 "$CANONICAL"; out="$TMP/c"; run_case "$out"
assert_contains "$out" 'BACKUP_FAILURE_STAGE=env_syntax'; ! grep -Fq 'PRODUCTION_BACKUP_ENV_SOURCE=' "$out"; assert_redacted "$out"

# D: absence of both sources fails closed at resolution.
rm -f "$CANONICAL" "$LEGACY"; out="$TMP/d"; run_case "$out"
assert_contains "$out" 'BACKUP_FAILURE_STAGE=env_resolution'; assert_redacted "$out"

# E: a legacy symlink is selected as an entry but rejected by metadata validation.
write_env "$CANONICAL"; mv "$CANONICAL" "$TMP/target"; ln -s "$TMP/target" "$LEGACY"; rm -f "$CANONICAL"
out="$TMP/e"; run_case "$out"; assert_contains "$out" 'BACKUP_FAILURE_STAGE=env_metadata'; assert_redacted "$out"

# F: wrong mode (and therefore an invalid protected file) is rejected.
rm -f "$LEGACY"; write_env "$LEGACY"; chmod 640 "$LEGACY"; out="$TMP/f"; run_case "$out"
assert_contains "$out" 'BACKUP_FAILURE_STAGE=env_metadata'; assert_redacted "$out"
write_env "$LEGACY"; chown 65534:65534 "$LEGACY"; out="$TMP/f-owner"; run_case "$out"
assert_contains "$out" 'BACKUP_FAILURE_STAGE=env_metadata'; assert_redacted "$out"

# G: malformed legacy shell syntax is rejected without exposing its path/content.
rm -f "$LEGACY"; printf 'DATABASE_URL="unterminated\n' >"$LEGACY"; chmod 600 "$LEGACY"; out="$TMP/g"; run_case "$out"
assert_contains "$out" 'BACKUP_FAILURE_STAGE=env_syntax'; assert_redacted "$out"

# H: required configuration failure has only sanitized logical diagnostics.
printf 'DATABASE_URL=x\n' >"$LEGACY"; chmod 600 "$LEGACY"; out="$TMP/h"; run_case "$out"
assert_contains "$out" 'BACKUP_FAILURE_STAGE=required_configuration'
assert_contains "$out" 'BACKUP_FAILURE_COMMAND=validate_backup_configuration_contract'; assert_redacted "$out"

# I: malformed SHA is attributed before checkout or environment access.
out="$TMP/i"; set +e
APP_DIR="$APP" CONFIRM=PREPARE_PRODUCTION_RECOVERY_BACKUP EXPECTED_SHA=bad bash "$SCRIPT" >"$out" 2>&1; rc=$?
set -e; (( rc != 0 )); assert_contains "$out" 'BACKUP_FAILURE_STAGE=expected_sha'; assert_redacted "$out"

# J: a dirty worktree is attributed to checkout and never reaches env resolution.
write_env "$LEGACY"; touch "$APP/dirty"; out="$TMP/j"; run_case "$out"
assert_contains "$out" 'BACKUP_FAILURE_STAGE=checkout'; ! grep -Fq 'PRODUCTION_BACKUP_ENV_SOURCE=' "$out"; assert_redacted "$out"
rm -f "$APP/dirty"

printf '%s\n' 'Production backup environment resolution: PASS (A-N safety contract)'
