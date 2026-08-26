#!/usr/bin/env bash
set -euo pipefail

log(){ printf '[production-preflight] %s\n' "$*"; }
die(){ log "ERRO: $*" >&2; exit 1; }
fail_backup(){ printf 'PRODUCTION_PREFLIGHT_FAILURE=%s\n' "$1" >&2; die "$2"; }
need(){ command -v "$1" >/dev/null || die "comando obrigatório ausente: $1"; }

case "${PRODUCTION_PREFLIGHT_MODE:-}" in
  build|cutover) ;;
  *) fail_backup invalid_preflight_mode "modo de preflight ausente ou inválido" ;;
esac
printf 'PRODUCTION_PREFLIGHT_MODE=%s\n' "$PRODUCTION_PREFLIGHT_MODE"

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${PRODUCTION_DB_HOST_EXPECTED:?PRODUCTION_DB_HOST_EXPECTED is required}"
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?PRODUCTION_DB_CONTAINER_EXPECTED is required}"
: "${PRODUCTION_DB_VOLUME_EXPECTED:?PRODUCTION_DB_VOLUME_EXPECTED is required}"
: "${PRODUCTION_BACKUP_FILE:?PRODUCTION_BACKUP_FILE is required}"
: "${PRODUCTION_BACKUP_SHA256_FILE:?PRODUCTION_BACKUP_SHA256_FILE is required}"
source "$(dirname "${BASH_SOURCE[0]}")/lib/production-backup-common.sh"

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
backup_bind_canonical_pair || fail_backup backup_path_contract "diretório canônico de backup inválido"
[[ "$PRODUCTION_BACKUP_FILE" == "$PRODUCTION_BACKUP_CANONICAL_FILE" && "$PRODUCTION_BACKUP_SHA256_FILE" == "$PRODUCTION_BACKUP_CANONICAL_SHA256_FILE" ]] || fail_backup backup_path_mismatch "backup difere do par canônico promovido"
[[ -f "$PRODUCTION_BACKUP_FILE" && ! -L "$PRODUCTION_BACKUP_FILE" && -f "$PRODUCTION_BACKUP_SHA256_FILE" && ! -L "$PRODUCTION_BACKUP_SHA256_FILE" ]] || fail_backup backup_missing "backup ou prova de integridade ausente"
printf 'PRODUCTION_BACKUP_PRESENCE=PASS\n'
# Integridade significa a prova já adotada: o manifesto SHA256 existente valida o
# arquivo existente. Este preflight não cria nem renova backups ou manifestos.
(cd "$(dirname "$PRODUCTION_BACKUP_FILE")" && sha256sum -c "$(basename "$PRODUCTION_BACKUP_SHA256_FILE")" >/dev/null) || fail_backup backup_integrity "prova de integridade do backup inválida"
printf 'PRODUCTION_BACKUP_INTEGRITY=PASS\n'
if [[ "$PRODUCTION_PREFLIGHT_MODE" == cutover ]]; then
  max_age="${PRODUCTION_BACKUP_MAX_AGE_SECONDS:-86400}"
  pair_output=''
  if pair_output="$(backup_validate_canonical_pair_and_freshness "$PRODUCTION_BACKUP_FILE" "$PRODUCTION_BACKUP_SHA256_FILE" "$max_age")"; then
    :
  else
    rc=$?; case "$rc" in 11) reason=backup_timestamp_future;; 12) reason=backup_stale;; 2) reason=backup_path_mismatch;; 5|7) reason=backup_integrity;; 9) reason=backup_changed;; *) reason=backup_timestamp_invalid;; esac
    fail_backup "$reason" "contrato canônico/freshness do backup inválido"
  fi
  printf '%s\n' "$pair_output"
else
  printf 'PRODUCTION_BACKUP_FRESHNESS=NOT_REQUIRED_BUILD_ONLY\n'
fi
available_kb=$(df -Pk . | awk 'NR==2{print $4}'); (( available_kb >= ${PRODUCTION_MIN_DISK_KB:-5242880} )) || die "espaço em disco insuficiente"

for port in 4000 5173; do
  owner=$(docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' | awk -F'|' -v p=":$port->" '$3 ~ p {print $1}')
  if [[ -n "$owner" ]]; then docker inspect -f "port=$port container={{.Name}} image={{.Image}} started={{.State.StartedAt}} networks={{json .NetworkSettings.Networks}} restart={{.HostConfig.RestartPolicy.Name}}" "$owner"; else log "port=$port owner=none"; fi
done
log "OK: banco=$DB_NAME host confirmado (credenciais omitidas), backup e runtime validados"
printf 'PRODUCTION_PREFLIGHT=PASS\n'
