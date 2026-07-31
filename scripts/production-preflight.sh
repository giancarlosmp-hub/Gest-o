#!/usr/bin/env bash
set -euo pipefail

log(){ printf '[production-preflight] %s\n' "$*"; }
die(){ log "ERRO: $*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null || die "comando obrigatório ausente: $1"; }

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${PRODUCTION_DB_HOST_EXPECTED:?PRODUCTION_DB_HOST_EXPECTED is required}"
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?PRODUCTION_DB_CONTAINER_EXPECTED is required}"
: "${PRODUCTION_DB_VOLUME_EXPECTED:?PRODUCTION_DB_VOLUME_EXPECTED is required}"
: "${PRODUCTION_BACKUP_FILE:?PRODUCTION_BACKUP_FILE is required}"
: "${PRODUCTION_BACKUP_SHA256_FILE:?PRODUCTION_BACKUP_SHA256_FILE is required}"

read -r DB_HOST DB_PORT DB_NAME < <(DATABASE_URL="$DATABASE_URL" node -e '
 const u=new URL(process.env.DATABASE_URL); console.log(u.hostname, u.port||"5432", u.pathname.replace(/^\//,""))')
[[ "$DB_HOST" == "$PRODUCTION_DB_HOST_EXPECTED" ]] || die "hostname do banco não autorizado"
[[ "$DB_HOST" != db && "$DB_HOST" != localhost && "$DB_HOST" != 127.0.0.1 ]] || die "hostname de banco proibido"
[[ "$DB_NAME" == salesforce_pro ]] || die "database não autorizado"

for command in git docker node sha256sum df timeout; do need "$command"; done

[[ -z "$(git status --porcelain)" ]] || die "worktree não está limpa"
[[ "$(git branch --show-current)" == main ]] || die "branch ativa não é main"
git show-ref --verify --quiet refs/remotes/origin/main || die "origin/main não disponível"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "HEAD difere de origin/main"
docker network inspect gest-o_default >/dev/null 2>&1 || die "rede gest-o_default ausente"
[[ "$(docker inspect -f '{{.State.Running}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" 2>/dev/null)" == true ]] || die "container PostgreSQL esperado não está em execução"
docker inspect -f '{{json .NetworkSettings.Networks}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(Object.hasOwn(JSON.parse(s),"gest-o_default")?0:1))' || die "PostgreSQL fora da rede esperada"
docker volume inspect "$PRODUCTION_DB_VOLUME_EXPECTED" >/dev/null 2>&1 || die "volume PostgreSQL esperado ausente"
docker inspect -f '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$PRODUCTION_DB_CONTAINER_EXPECTED" |
  awk -v v="$PRODUCTION_DB_VOLUME_EXPECTED" '$1==v && $2=="/var/lib/postgresql/data"{ok=1} END{exit !ok}' || die "mount PostgreSQL esperado divergente"
[[ "$PRODUCTION_DB_VOLUME_EXPECTED" != gest-o_pgdata ]] || die "volume legado não é autorizado"
docker image inspect postgres:16 >/dev/null 2>&1 || die "imagem local postgres:16 ausente; não será feito pull automático"
timeout "${PRODUCTION_DB_READY_TIMEOUT_SECONDS:-15}s" \
  docker run --rm --pull=never \
    --network gest-o_default \
    postgres:16 \
    pg_isready -h "$DB_HOST" -p "$DB_PORT" -d "$DB_NAME" >/dev/null 2>&1 ||
  die "PostgreSQL não está aceitando conexões na rede gest-o_default"
[[ -f "$PRODUCTION_BACKUP_FILE" && -f "$PRODUCTION_BACKUP_SHA256_FILE" ]] || die "backup ou SHA256 ausente"
(cd "$(dirname "$PRODUCTION_BACKUP_FILE")" && sha256sum -c "$(basename "$PRODUCTION_BACKUP_SHA256_FILE")" >/dev/null) || die "SHA256 do backup inválido"
max_age="${PRODUCTION_BACKUP_MAX_AGE_SECONDS:-86400}"; age=$(( $(date +%s) - $(stat -c %Y "$PRODUCTION_BACKUP_FILE") )); (( age <= max_age )) || die "backup não é recente"
available_kb=$(df -Pk . | awk 'NR==2{print $4}'); (( available_kb >= ${PRODUCTION_MIN_DISK_KB:-5242880} )) || die "espaço em disco insuficiente"

for port in 4000 5173; do
  owner=$(docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' | awk -F'|' -v p=":$port->" '$3 ~ p {print $1}')
  if [[ -n "$owner" ]]; then docker inspect -f "port=$port container={{.Name}} image={{.Image}} started={{.State.StartedAt}} networks={{json .NetworkSettings.Networks}} restart={{.HostConfig.RestartPolicy.Name}}" "$owner"; else log "port=$port owner=none"; fi
done
log "OK: banco=$DB_NAME host confirmado (credenciais omitidas), backup e runtime validados"
