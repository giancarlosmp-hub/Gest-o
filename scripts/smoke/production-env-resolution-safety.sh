#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
OWNER="$(id -un):$(id -gn)"; resolver="$ROOT/scripts/resolve-production-env.sh"
canonical="$TMP/.env"; legacy="$TMP/production.env"; secret='resolution-secret-must-not-leak'
run(){ MODE="$1" PRODUCTION_CANONICAL_ENV_FILE="$canonical" PRODUCTION_LEGACY_ENV_FILE="$legacy" ERP_ENV_EXPECTED_OWNER="$OWNER" bash "$resolver"; }
write(){ printf 'ERP_SYNC_SCHEDULER_ENABLED=%s\nSECRET=%s\n' "$2" "$secret" >"$1"; chmod 600 "$1"; }

# A: canonical wins, including when both valid sources exist.
write "$canonical" true; write "$legacy" false
out="$(run build 2>"$TMP/a.err")"; [[ "$out" == "$canonical" ]]; grep -q 'ERP_PRODUCTION_ENV_SOURCE=canonical' "$TMP/a.err"
# B/H/I: legacy is selected read-only; canonical stays absent and its gate/content stays unchanged.
rm "$canonical"; before="$(sha256sum "$legacy")"; out="$(run build 2>"$TMP/b.err")"
[[ "$out" == "$legacy" && ! -e "$canonical" && "$(sha256sum "$legacy")" == "$before" ]]
grep -q 'ERP_PRODUCTION_ENV_SOURCE=legacy_build_only' "$TMP/b.err"; grep -q '^ERP_SYNC_SCHEDULER_ENABLED=false$' "$legacy"
# C: no source fails closed.
rm "$legacy"; ! run build >"$TMP/c.out" 2>"$TMP/c.err"
# D: invalid canonical is never bypassed.
write "$canonical" true; chmod 644 "$canonical"; write "$legacy" false; ! run build >"$TMP/d.out" 2>"$TMP/d.err"
# E: required legacy with invalid metadata fails.
rm "$canonical"; chmod 644 "$legacy"; ! run build >"$TMP/e.out" 2>"$TMP/e.err"
# F: symlinks fail for either selected source.
rm "$legacy"; write "$TMP/target" false; ln -s "$TMP/target" "$legacy"; ! run build >"$TMP/f1.out" 2>"$TMP/f1.err"
rm "$legacy"; ln -s "$TMP/target" "$canonical"; ! run build >"$TMP/f2.out" 2>"$TMP/f2.err"
# G: cutover remains canonical-only.
rm "$canonical"; write "$legacy" false; ! run cutover >"$TMP/g.out" 2>"$TMP/g.err"
# Ambiguous configured paths fail closed.
! MODE=build PRODUCTION_CANONICAL_ENV_FILE="$legacy" PRODUCTION_LEGACY_ENV_FILE="$legacy" ERP_ENV_EXPECTED_OWNER="$OWNER" bash "$resolver" >"$TMP/amb.out" 2>"$TMP/amb.err"
# J: values never appear in stdout/stderr, including failures.
! grep -FRq "$secret" "$TMP"/*.out "$TMP"/*.err
printf '%s\n' 'production env resolution safety passed (A-J)'
