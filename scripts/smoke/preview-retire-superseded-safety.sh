#!/usr/bin/env bash
# Prova sintética de scripts/preview-retire-superseded.sh com docker/sudo falsos. Nenhum daemon,
# host ou dado real: só nomes fictícios no padrão dos previews.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
script="$root/scripts/preview-retire-superseded.sh"
mkdir -p "$tmp/bin"

# Estado: uma linha por projeto "<projeto>\t<rótulos de todos os recursos>". Rótulos vazios = legado
# sem rótulo ou produção. Projetos removidos vão para $STATE.removed.
cat >"$tmp/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# O compose roda com env -i: o falso acha estado e log pelo próprio caminho, não pelo ambiente.
base=$(cd "$(dirname "$0")/.." && pwd)
STATE=${STATE:-$base/state}
MUTATION_LOG=${MUTATION_LOG:-$base/mutations}
labels_of() { awk -F'\t' -v p="$1" '$1==p {print $2}' "$STATE"; }
present() { [ -n "$(awk -F'\t' -v p="$1" '$1==p' "$STATE")" ] && ! grep -Fxq "$1" "$STATE.removed" 2>/dev/null; }
case "$1 ${2:-}" in
  "ps -a"|"network ls"|"volume ls")
    if [[ "$*" == *'--format'* ]]; then
      pr=$(printf '%s\n' "$@" | sed -n 's/^label=com\.gesto\.preview\.pr=//p')
      [[ "$*" == *'label=com.gesto.preview=true'* && -n "$pr" ]] || { echo "unfiltered discovery: $*" >&2; exit 2; }
      while IFS=$'\t' read -r project labels; do
        present "$project" || continue
        read -r preview label_pr _ <<<"$labels"
        [ "$preview" = true ] && [ "$label_pr" = "$pr" ] && printf '%s\n' "$project"
      done <"$STATE"
      for extra in ${FAKE_EXTRA_DISCOVERY:-}; do printf '%s\n' "$extra"; done
      exit 0
    fi
    project=$(printf '%s\n' "$@" | sed -n 's/^label=com\.docker\.compose\.project=//p')
    present "$project" || exit 0
    case "$1" in ps) prefix=ctr;; network) prefix=net;; volume) prefix=vol;; esac
    printf '%s-%s\n' "$prefix" "$project"; exit 0;;
  "ps -aq")
    project=$(printf '%s\n' "$@" | sed -n 's/^label=com\.docker\.compose\.project=//p')
    present "$project" && printf 'ctr-%s\n' "$project"; exit 0;;
  "network inspect"|"volume inspect") target=${*: -1}; labels_of "${target#*-}"; exit 0;;
  "inspect -f") target=${*: -1}; labels_of "${target#*-}"; exit 0;;
  "compose -p")
    project=$3
    printf 'down %s volume=%s bootstrap=%s owner=%s/%s/%s/%s\n' "$project" "${POSTGRES_VOLUME_NAME:-}" "${ADMIN_BOOTSTRAP_PASSWORD:-}" \
      "${PREVIEW_OWNER_PR:-}" "${PREVIEW_OWNER_RUN_ID:-}" "${PREVIEW_OWNER_RUN_ATTEMPT:-}" "${PREVIEW_OWNER_WORKFLOW:-}" >>"$MUTATION_LOG"
    ! grep -Fxq "$project" "$base/down_fail" 2>/dev/null || exit 1
    grep -Fxq "$project" "$base/down_leaves" 2>/dev/null || printf '%s\n' "$project" >>"$STATE.removed"
    exit 0;;
esac
echo "unexpected docker command: $*" >&2
exit 2
SH
cat >"$tmp/bin/sudo" <<'SH'
#!/usr/bin/env bash
"$@"
SH
chmod +x "$tmp/bin/"*

label() { printf 'true %s %s %s Preview-Deploy' "$1" "$2" "$3"; }
make_preview_dir() { # projeto pr run attempt [volume do .env]
  local dir="$tmp/preview/pr-$2/$1"
  mkdir -p "$dir"; : >"$dir/docker-compose.yml"; : >"$dir/docker-compose.preview.yml"
  printf 'COMPOSE_PROJECT_NAME=%s\nPOSTGRES_VOLUME_NAME=%s\n' "$1" "${5:-gesto_pgdata_pr_$2_$3_$4}" >"$dir/.env"
}
reset_state() {
  rm -rf "$tmp/preview" "$tmp/nginx" "$tmp/state"* "$tmp/mutations" "$tmp/down_fail" "$tmp/down_leaves"
  mkdir -p "$tmp/nginx/sites-available"
  # A rota ativa aponta para o deploy atual (run 300, attempt 1).
  printf '# owner-pr=42 owner-run=300 owner-attempt=1\n' >"$tmp/nginx/sites-available/crm-preview-pr-42"
  {
    printf 'gesto-pr-42-300-1\t%s\n' "$(label 42 300 1)"   # atual
    printf 'gesto-pr-42-100-1\t%s\n' "$(label 42 100 1)"   # push anterior
    printf 'gesto-pr-42-200-2\t%s\n' "$(label 42 200 2)"   # re-run de push anterior
    printf 'gesto-pr-99-100-1\t%s\n' "$(label 99 100 1)"   # outro PR
    printf 'gesto-pr-535\t\n'                              # legado sem rótulo
    printf 'gest-o\t\n'                                    # produção, sem rótulo de preview
    printf 'gest-o-production\t\n'
  } >"$tmp/state"
  for project in gesto-pr-42-300-1:300:1 gesto-pr-42-100-1:100:1 gesto-pr-42-200-2:200:2; do
    IFS=: read -r name run attempt <<<"$project"; make_preview_dir "$name" 42 "$run" "$attempt"
  done
  make_preview_dir gesto-pr-99-100-1 99 100 1
}
run_retire() { # saída em $tmp/out; código em $rc
  set +e
  env PATH="$tmp/bin:$PATH" STATE="$tmp/state" MUTATION_LOG="$tmp/mutations" PREVIEW_ROOT="$tmp/preview" NGINX_SITES_DIR="$tmp/nginx" \
    PR_NUMBER=42 COMPOSE_PROJECT_NAME="${CURRENT:-gesto-pr-42-300-1}" \
    POSTGRES_VOLUME_NAME=gesto_pgdata_pr_42_300_1 ADMIN_BOOTSTRAP_PASSWORD=synthetic-current-deploy-secret \
    PREVIEW_OWNER_RUN_ID=300 PREVIEW_OWNER_RUN_ATTEMPT=1 "$@" bash "$script" >"$tmp/out" 2>&1
  rc=$?
  set -e
}
downs() { [ -f "$tmp/mutations" ] && grep -c '^down ' "$tmp/mutations" || echo 0; }

# 1) Caminho principal: os dois previews anteriores do PR 42 são aposentados; o atual, o outro PR,
#    o legado sem rótulo e produção nunca são tocados. O compose roda em ambiente limpo.
reset_state
run_retire
test "$rc" -eq 0 || { cat "$tmp/out" >&2; exit 1; }
grep -Fxq 'PREVIEW_SUPERSEDED_CLEANUP=RETIRED project=gesto-pr-42-100-1' "$tmp/out"
grep -Fxq 'PREVIEW_SUPERSEDED_CLEANUP=RETIRED project=gesto-pr-42-200-2' "$tmp/out"
grep -Fxq 'PREVIEW_SUPERSEDED_CLEANUP_RESULT=PASS retired=2 preserved=0' "$tmp/out"
test "$(downs)" -eq 2
grep -Fxq 'down gesto-pr-42-100-1 volume=gesto_pgdata_pr_42_100_1 bootstrap= owner=42/100/1/Preview-Deploy' "$tmp/mutations"
grep -Fxq 'down gesto-pr-42-200-2 volume=gesto_pgdata_pr_42_200_2 bootstrap= owner=42/200/2/Preview-Deploy' "$tmp/mutations"
! grep -Eq 'down (gesto-pr-42-300-1|gesto-pr-99-|gesto-pr-535|gest-o)' "$tmp/mutations"
! grep -Fq 'gesto_pgdata_pr_42_300_1' "$tmp/mutations"   # nunca o volume do deploy atual
! grep -Eq 'volume=gest-o' "$tmp/mutations"               # nunca o padrão de produção
test ! -d "$tmp/preview/pr-42/gesto-pr-42-100-1" && test ! -d "$tmp/preview/pr-42/gesto-pr-42-200-2"
test -d "$tmp/preview/pr-42/gesto-pr-42-300-1" && test -d "$tmp/preview/pr-99/gesto-pr-99-100-1"
# Idempotência: rodar de novo não acha mais nada para aposentar.
run_retire
grep -Fxq 'PREVIEW_SUPERSEDED_CLEANUP_RESULT=PASS retired=0 preserved=0' "$tmp/out"
test "$(downs)" -eq 2

# 2) Descoberta devolvendo nomes fora do PR (rótulo enganoso): preservado sem mutação e sem eco do nome.
reset_state
printf 'gesto-pr-42-100-1\n' >"$tmp/state.removed"; printf 'gesto-pr-42-200-2\n' >>"$tmp/state.removed"
run_retire FAKE_EXTRA_DISCOVERY="gest-o gest-o-production gesto-pr-99-100-1 gesto-pr-420-100-1 gesto-pr-535"
test "$rc" -eq 0
test "$(grep -c '^PREVIEW_SUPERSEDED_CLEANUP=PRESERVED reason=project_out_of_scope$' "$tmp/out")" -eq 5
grep -Fxq 'PREVIEW_SUPERSEDED_CLEANUP_RESULT=PRESERVED retired=0 preserved=5' "$tmp/out"
grep -Fq '::warning title=Preview Deploy::' "$tmp/out"
test "$(downs)" -eq 0

# 3) Cada motivo de preservação: nada é derrubado e o deploy não falha.
check_preserved() { # motivo esperado
  test "$rc" -eq 0 || { cat "$tmp/out" >&2; exit 1; }
  grep -Fxq "PREVIEW_SUPERSEDED_CLEANUP=PRESERVED reason=$1 project=gesto-pr-42-100-1" "$tmp/out"
  ! grep -Fq 'RETIRED project=gesto-pr-42-100-1' "$tmp/out"
  test -d "$tmp/preview/pr-42/gesto-pr-42-100-1"
}
# Rótulo de run divergente em um dos recursos.
reset_state; printf 'gesto-pr-42-200-2\n' >"$tmp/state.removed"
sed -i "s/^gesto-pr-42-100-1\t.*/gesto-pr-42-100-1\t$(label 42 999 1)/" "$tmp/state"
run_retire; check_preserved identity_diverged; test "$(downs)" -eq 0
# Rota do nginx apontando para o projeto antigo.
reset_state; printf 'gesto-pr-42-200-2\n' >"$tmp/state.removed"
printf '# owner-pr=42 owner-run=100 owner-attempt=1\n' >"$tmp/nginx/sites-available/crm-preview-pr-42"
run_retire; check_preserved nginx_route_target; test "$(downs)" -eq 0
# Pasta sem .env.
reset_state; printf 'gesto-pr-42-200-2\n' >"$tmp/state.removed"; rm "$tmp/preview/pr-42/gesto-pr-42-100-1/.env"
run_retire; check_preserved trusted_compose_files_missing; test "$(downs)" -eq 0
# .env apontando para o volume de produção ou de outro projeto.
for wrong in gest-o_pgdata gesto_pgdata_pr_42_300_1; do
  reset_state; printf 'gesto-pr-42-200-2\n' >"$tmp/state.removed"
  make_preview_dir gesto-pr-42-100-1 42 100 1 "$wrong"
  run_retire; check_preserved env_volume_mismatch; test "$(downs)" -eq 0
done
# compose down falha ou deixa recurso para trás.
reset_state; printf 'gesto-pr-42-200-2\n' >"$tmp/state.removed"
printf 'gesto-pr-42-100-1\n' >"$tmp/down_fail"; run_retire; check_preserved compose_down_failed
reset_state; printf 'gesto-pr-42-200-2\n' >"$tmp/state.removed"
printf 'gesto-pr-42-100-1\n' >"$tmp/down_leaves"; run_retire; check_preserved resources_remain_after_down

# 4) Identidade atual inválida: sai com erro antes de qualquer descoberta ou mutação.
reset_state
CURRENT=gesto-pr-99-300-1 run_retire
test "$rc" -ne 0; grep -Fxq 'PREVIEW_SUPERSEDED_CLEANUP_RESULT=ERROR reason=invalid_current_identity' "$tmp/out"; test "$(downs)" -eq 0

# 5) Contrato do workflow e do script.
workflow=$(cat "$root/.github/workflows/preview.yml")
pass_at=$(grep -n 'echo "PREVIEW_DEPLOY_RESULT=PASS"' <<<"$workflow" | tail -1 | cut -d: -f1)
retire_at=$(grep -n 'bash "\$PREVIEW_DIR/scripts/preview-retire-superseded.sh"' <<<"$workflow" | cut -d: -f1)
comment_at=$(grep -n 'name: Comment preview link on PR' <<<"$workflow" | cut -d: -f1)
test -n "$pass_at" && test -n "$retire_at" && test "$pass_at" -lt "$retire_at" && test "$retire_at" -lt "$comment_at"
grep -Fq 'if ! bash "$PREVIEW_DIR/scripts/preview-retire-superseded.sh"; then' <<<"$workflow"
retire_text=$(cat "$script")
! grep -Eq 'prune|network rm|docker rm|volume rm|--force|-f docker' <<<"$retire_text"
grep -Fq 'env -i PATH=' <<<"$retire_text"

echo 'PREVIEW_RETIRE_SUPERSEDED_SAFETY=PASS retired_same_pr=2 current_untouched=PASS other_pr_untouched=PASS unlabeled_untouched=PASS production_untouched=PASS clean_env=PASS preserve_paths=7 after_pass_only=PASS'
