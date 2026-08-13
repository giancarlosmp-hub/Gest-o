#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
SHA=443be81e35a15e37158a93161b105c1aa81690b2
OTHER=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SECRET=deploy-entrypoint-secret-must-not-leak

make_fixture() {
  rm -rf "$TMP/app" "$TMP/bin"
  mkdir -p "$TMP/app/scripts" "$TMP/bin"
  cp "$ROOT/scripts/production-deploy-entrypoint.sh" "$TMP/app/entrypoint.sh"
  cat >"$TMP/bin/git" <<'EOF'
#!/usr/bin/env bash
case "$1 ${2:-}" in
  'fetch origin'|'switch main'|'pull --ff-only') exit 0 ;;
  'rev-parse HEAD') [[ "${HEAD_READABLE:-yes}" == yes ]] || exit 128; printf '%s\n' "${ACTUAL_SHA:-}" ;;
  'status --porcelain') printf '%s' "${WORKTREE_STATUS:-}" ;;
  *) exit 90 ;;
esac
EOF
  chmod +x "$TMP/bin/git"
  cat >"$TMP/app/scripts/deploy-production.sh" <<'EOF'
#!/usr/bin/env bash
printf 'DEPLOY_SCRIPT_ENTERED=PASS\n'
printf 'DEPLOY_MODE=%s\n' "$MODE"
printf 'DEPLOY_EXPECTED_SHA_FORMAT=PASS\n'
printf 'DEPLOY_ENV_RESOLUTION=STARTED\n'
printf 'ERP_PRODUCTION_ENV_SOURCE=canonical\n' >&2
EOF
  chmod +x "$TMP/app/scripts/deploy-production.sh"
}

run_entrypoint() {
  PATH="$TMP/bin:$PATH" APP_DIR="$TMP/app" DEPLOY_MODE=build \
    EXPECTED_SHA="${EXPECTED_VALUE-}" ACTUAL_SHA="${ACTUAL_VALUE-$SHA}" \
    HEAD_READABLE="${HEAD_READABLE_VALUE-yes}" WORKTREE_STATUS="${WORKTREE_VALUE-}" \
    SECRET="$SECRET" bash "$TMP/app/entrypoint.sh"
}

# A: fast-forward + SHA literal igual alcança o deploy, sem cutover/recriação.
make_fixture; EXPECTED_VALUE=$SHA ACTUAL_VALUE=$SHA run_entrypoint >"$TMP/a.out" 2>"$TMP/a.err"
for marker in DEPLOY_GIT_FETCH DEPLOY_GIT_SWITCH DEPLOY_GIT_FAST_FORWARD DEPLOY_EXPECTED_SHA_FORMAT DEPLOY_CHECKOUT_SHA_MATCH DEPLOY_WORKTREE_CLEAN DEPLOY_SCRIPT_PRESENT; do
  grep -q "^$marker=PASS$" "$TMP/a.out"
done
grep -q '^DEPLOY_SCRIPT_STARTING=build$' "$TMP/a.out"
grep -q '^DEPLOY_SCRIPT_ENTERED=PASS$' "$TMP/a.out"
grep -q '^ERP_PRODUCTION_ENV_SOURCE=canonical$' "$TMP/a.err"

# B/C/D: divergente, vazio e incompleto falham com estágio explícito.
make_fixture; ! EXPECTED_VALUE=$OTHER ACTUAL_VALUE=$SHA run_entrypoint >"$TMP/b.out" 2>"$TMP/b.err"
grep -q "DEPLOY_CHECKOUT_SHA_MATCH=FAIL EXPECTED_SHA=$OTHER ACTUAL_SHA=$SHA" "$TMP/b.err"
for value in '' 443be81; do
  make_fixture; ! EXPECTED_VALUE=$value run_entrypoint >"$TMP/format.out" 2>"$TMP/format.err"
  grep -q '^DEPLOY_FAILURE_STAGE=expected_sha_format$' "$TMP/format.err"
done

# HEAD ilegível, worktree suja e script ausente também são observáveis.
make_fixture; ! EXPECTED_VALUE=$SHA HEAD_READABLE_VALUE=no run_entrypoint >"$TMP/head.out" 2>"$TMP/head.err"
grep -q '^DEPLOY_FAILURE_COMMAND=read_checkout_sha$' "$TMP/head.err"
make_fixture; ! EXPECTED_VALUE=$SHA WORKTREE_VALUE=' M protected' run_entrypoint >"$TMP/tree.out" 2>"$TMP/tree.err"
grep -q '^DEPLOY_WORKTREE_CLEAN=FAIL$' "$TMP/tree.err"
make_fixture; rm "$TMP/app/scripts/deploy-production.sh"; ! EXPECTED_VALUE=$SHA run_entrypoint >"$TMP/script.out" 2>"$TMP/script.err"
grep -q '^DEPLOY_SCRIPT_PRESENT=FAIL$' "$TMP/script.err"

# F: o deploy preserva o motivo sanitizado e o exit code real do resolver.
mkdir -p "$TMP/resolver-failure/scripts"
cp "$ROOT/scripts/deploy-production.sh" "$TMP/resolver-failure/scripts/deploy-production.sh"
cat >"$TMP/resolver-failure/scripts/resolve-production-env.sh" <<'EOF'
#!/usr/bin/env bash
printf '[production-env-resolution] FAIL: canonical source metadata is invalid\n' >&2
exit 23
EOF
(
  cd "$TMP/resolver-failure"
  ! APP_DIR="$TMP/resolver-failure" MODE=build EXPECTED_SHA="$SHA" bash scripts/deploy-production.sh \
    >"$TMP/resolver.out" 2>"$TMP/resolver.err"
)
grep -q '^\[production-env-resolution\] FAIL: canonical source metadata is invalid$' "$TMP/resolver.err"
grep -q '^DEPLOY_FAILURE_STAGE=environment_resolution$' "$TMP/resolver.err"
grep -q '^DEPLOY_FAILURE_EXIT_CODE=23$' "$TMP/resolver.err"

# O harness não contém nem permite efeitos produtivos e não vaza o sentinel.
! grep -FRq "$SECRET" "$TMP"/*.out "$TMP"/*.err
! grep -Eq 'docker (compose )?(up|stop|rm)|PRODUCTION_CUTOVER' "$TMP"/*.out "$TMP"/*.err
printf '%s\n' 'production deploy entrypoint safety passed'
