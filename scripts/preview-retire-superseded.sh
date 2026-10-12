#!/usr/bin/env bash
# Aposenta os previews de pushes anteriores do MESMO PR, depois que o deploy atual terminou com
# PREVIEW_DEPLOY_RESULT=PASS. Roda na VPS, chamado pelo Preview Deploy (.github/workflows/preview.yml).
#
# Escopo (fail closed; na dúvida, preserva):
#  - só projetos descobertos pelos dois rótulos com.gesto.preview=true e com.gesto.preview.pr=<PR>;
#  - nome exatamente gesto-pr-<PR>-<run>-<attempt>, diferente do projeto atual;
#  - todo container, rede e volume do projeto com os rótulos do mesmo PR, run, attempt e workflow;
#  - o projeto não é o destino da rota do nginx;
#  - pasta do preview com os arquivos de compose e .env apontando para o volume do próprio projeto.
# Nunca toca rede sem rótulo, produção nem outro PR. Não usa prune nem network rm.
#
# O compose roda num ambiente limpo (env -i): as variáveis do deploy atual (POSTGRES_VOLUME_NAME etc.)
# teriam precedência sobre o .env da pasta antiga, e o padrão do docker-compose.yml para o volume é o
# nome do volume de produção. O volume é passado explicitamente e conferido antes.
#
# Saída: 0 sempre que os parâmetros forem válidos (preservar não é erro). O chamador nunca deve deixar
# esta etapa derrubar o deploy que acabou de passar.
set -euo pipefail

: "${PR_NUMBER:?}" "${COMPOSE_PROJECT_NAME:?}"
PREVIEW_ROOT=${PREVIEW_ROOT:-/var/www/preview}
NGINX_SITES_DIR=${NGINX_SITES_DIR:-/etc/nginx}
WORKFLOW_LABEL=Preview-Deploy

if [[ ! "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || [[ ! "$COMPOSE_PROJECT_NAME" =~ ^gesto-pr-${PR_NUMBER}-[0-9]+-[0-9]+$ ]]; then
  echo "PREVIEW_SUPERSEDED_CLEANUP_RESULT=ERROR reason=invalid_current_identity"
  exit 1
fi

projects_file="$(mktemp)"
trap 'rm -f "$projects_file"' EXIT
for kind in "ps -a" "network ls" "volume ls"; do
  # shellcheck disable=SC2086
  docker $kind --filter "label=com.gesto.preview=true" --filter "label=com.gesto.preview.pr=${PR_NUMBER}" \
    --format '{{.Label "com.docker.compose.project"}}' >>"$projects_file"
done
sort -u "$projects_file" -o "$projects_file"

retired=0
preserved=0
preserve() {
  echo "PREVIEW_SUPERSEDED_CLEANUP=PRESERVED reason=$1 project=$2"
  preserved=$((preserved + 1))
}

# Rótulos de todos os recursos do projeto (containers, redes, volumes), um por linha.
resource_labels() {
  local project="$1" format='{{index .Labels "com.gesto.preview"}} {{index .Labels "com.gesto.preview.pr"}} {{index .Labels "com.gesto.preview.run-id"}} {{index .Labels "com.gesto.preview.run-attempt"}} {{index .Labels "com.gesto.preview.workflow"}}'
  docker ps -aq --filter "label=com.docker.compose.project=${project}" | while read -r id; do
    [ -n "$id" ] && docker inspect -f "${format//.Labels/.Config.Labels}" "$id"
  done
  docker network ls -q --filter "label=com.docker.compose.project=${project}" | while read -r id; do
    [ -n "$id" ] && docker network inspect -f "$format" "$id"
  done
  docker volume ls -q --filter "label=com.docker.compose.project=${project}" | while read -r name; do
    [ -n "$name" ] && docker volume inspect -f "$format" "$name"
  done
  return 0
}

while IFS= read -r project; do
  [ -n "$project" ] || continue
  [ "$project" != "$COMPOSE_PROJECT_NAME" ] || continue
  if [[ ! "$project" =~ ^gesto-pr-${PR_NUMBER}-([0-9]+)-([0-9]+)$ ]]; then
    # Nome fora do padrão deste PR: não é impresso (pode ser qualquer texto) e nada é tocado.
    echo "PREVIEW_SUPERSEDED_CLEANUP=PRESERVED reason=project_out_of_scope"
    preserved=$((preserved + 1))
    continue
  fi
  run="${BASH_REMATCH[1]}"
  attempt="${BASH_REMATCH[2]}"

  if ! labels="$(resource_labels "$project")"; then
    preserve inspect_failed "$project"
    continue
  fi
  if [ -z "$labels" ]; then
    echo "PREVIEW_SUPERSEDED_CLEANUP=ALREADY_ABSENT project=${project}"
    continue
  fi
  if printf '%s\n' "$labels" | grep -vxq "true ${PR_NUMBER} ${run} ${attempt} ${WORKFLOW_LABEL}"; then
    preserve identity_diverged "$project"
    continue
  fi

  nginx_site="${NGINX_SITES_DIR}/sites-available/crm-preview-pr-${PR_NUMBER}"
  if sudo test -f "$nginx_site" && sudo grep -Fq "owner-run=${run} owner-attempt=${attempt}" "$nginx_site"; then
    preserve nginx_route_target "$project"
    continue
  fi

  dir="${PREVIEW_ROOT}/pr-${PR_NUMBER}/${project}"
  expected_volume="gesto_pgdata_pr_${PR_NUMBER}_${run}_${attempt}"
  if [ ! -f "$dir/docker-compose.yml" ] || [ ! -f "$dir/docker-compose.preview.yml" ] || [ ! -f "$dir/.env" ]; then
    preserve trusted_compose_files_missing "$project"
    continue
  fi
  if [ "$(grep -c '^POSTGRES_VOLUME_NAME=' "$dir/.env")" != "1" ] || ! grep -Fxq "POSTGRES_VOLUME_NAME=${expected_volume}" "$dir/.env"; then
    preserve env_volume_mismatch "$project"
    continue
  fi

  if ! (cd "$dir" && env -i PATH="$PATH" HOME="${HOME:-/root}" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
      COMPOSE_PROJECT_NAME="$project" POSTGRES_VOLUME_NAME="$expected_volume" \
      PREVIEW_OWNER_PR="$PR_NUMBER" PREVIEW_OWNER_RUN_ID="$run" PREVIEW_OWNER_RUN_ATTEMPT="$attempt" \
      PREVIEW_OWNER_WORKFLOW="$WORKFLOW_LABEL" \
      docker compose -p "$project" -f docker-compose.yml -f docker-compose.preview.yml down -v --remove-orphans); then
    preserve compose_down_failed "$project"
    continue
  fi
  if ! remaining="$(resource_labels "$project")" || [ -n "$remaining" ]; then
    preserve resources_remain_after_down "$project"
    continue
  fi
  rm -rf -- "$dir"
  echo "PREVIEW_SUPERSEDED_CLEANUP=RETIRED project=${project}"
  retired=$((retired + 1))
done <"$projects_file"

if [ "$preserved" -gt 0 ]; then
  echo "PREVIEW_SUPERSEDED_CLEANUP_RESULT=PRESERVED retired=${retired} preserved=${preserved}"
  echo "::warning title=Preview Deploy::${preserved} preview(s) anterior(es) do PR ${PR_NUMBER} preservado(s); veja PREVIEW_SUPERSEDED_CLEANUP no log."
else
  echo "PREVIEW_SUPERSEDED_CLEANUP_RESULT=PASS retired=${retired} preserved=0"
fi
