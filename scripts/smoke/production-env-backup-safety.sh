#!/usr/bin/env bash
# backup-production-env.sh: .env sempre; whatsapp.env quando existir, mesmo padrão (pasta 700, cópias 600).
# restore-production-env.sh recusa um backup do WhatsApp no lugar do .env. Só arquivos fictícios.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP="$ROOT/scripts/backup-production-env.sh"
RESTORE="$ROOT/scripts/restore-production-env.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP:?}"' EXIT
fail(){ printf 'FALHA: %s\n' "$*" >&2; exit 1; }
export PRODUCTION_ENV_DIR="$TMP/env"
reset(){ rm -rf "${TMP:?}/env"; mkdir -p "$TMP/env"; printf 'JWT_SECRET=valor-ficticio-api\n' >"$TMP/env/.env"; chmod 600 "$TMP/env/.env"; }
run(){ set +e; OUT=$(bash "$BACKUP" 2>&1); RC=$?; set -e; }

# Sem whatsapp.env: só o .env, aviso informativo, sucesso.
reset; run
[[ "$RC" -eq 0 ]] || fail "sem whatsapp.env: $OUT"
[[ "$(ls "$TMP/env/backups" | grep -c '^env-.*\.backup$')" -eq 1 ]] || fail 'sem whatsapp.env: backup do .env'
! ls "$TMP/env/backups" | grep -q '^whatsapp-env-' || fail 'sem whatsapp.env: não deveria copiar nada do WhatsApp'
grep -q 'Env do WhatsApp ausente' <<<"$OUT" || fail 'sem whatsapp.env: aviso'

# Com whatsapp.env: as duas cópias, conteúdo idêntico, pasta 700, arquivos 600, sem imprimir valores.
reset; printf 'WHATSAPP_EVOLUTION_API_KEY=chave-ficticia\nEVOLUTION_DB_PASSWORD=SenhaFicticia\n' >"$TMP/env/whatsapp.env"; chmod 600 "$TMP/env/whatsapp.env"; run
[[ "$RC" -eq 0 ]] || fail "com whatsapp.env: $OUT"
api_copy=$(ls "$TMP/env/backups"/env-*.backup); wa_copy=$(ls "$TMP/env/backups"/whatsapp-env-*.backup)
cmp -s "$api_copy" "$TMP/env/.env" || fail 'com whatsapp.env: cópia do .env difere'
cmp -s "$wa_copy" "$TMP/env/whatsapp.env" || fail 'com whatsapp.env: cópia do whatsapp.env difere'
[[ "${api_copy#*/env-}" == "${wa_copy#*/whatsapp-env-}" ]] || fail 'com whatsapp.env: timestamps diferentes'
[[ "$(stat -c '%a' "$TMP/env/backups")" == 700 ]] || fail 'pasta de backups deveria ser 700'
[[ "$(stat -c '%a' "$api_copy")" == 600 && "$(stat -c '%a' "$wa_copy")" == 600 ]] || fail 'cópias deveriam ser 600'
! grep -qE 'valor-ficticio-api|chave-ficticia|SenhaFicticia' <<<"$OUT" || fail 'valor de env impresso'

# whatsapp.env que não é arquivo comum: falha antes de copiar qualquer coisa.
reset; mkdir "$TMP/env/whatsapp.env"; run
[[ "$RC" -ne 0 ]] || fail 'whatsapp.env diretório: deveria falhar'
[[ ! -d "$TMP/env/backups" ]] || [[ -z "$(ls "$TMP/env/backups")" ]] || fail 'whatsapp.env diretório: nada deveria ser copiado'
reset; printf 'x=1\n' >"$TMP/alvo.env"; ln -s "$TMP/alvo.env" "$TMP/env/whatsapp.env"
if [[ -L "$TMP/env/whatsapp.env" ]]; then
  run
  [[ "$RC" -ne 0 ]] || fail 'whatsapp.env symlink: deveria falhar'
  [[ ! -d "$TMP/env/backups" ]] || [[ -z "$(ls "$TMP/env/backups")" ]] || fail 'whatsapp.env symlink: nada deveria ser copiado'
fi

# Sem .env: falha como antes.
reset; rm "$TMP/env/.env"; run
[[ "$RC" -ne 0 ]] || fail 'sem .env: deveria falhar'

# restore recusa backup do WhatsApp antes de tocar em qualquer arquivo.
set +e; OUT=$(bash "$RESTORE" "$TMP/env/backups/whatsapp-env-20260101-000000.backup" 2>&1); RC=$?; set -e
[[ "$RC" -eq 1 ]] && grep -q 'backup do env do WhatsApp' <<<"$OUT" || fail "restore com backup do WhatsApp: $OUT"

printf 'production-env-backup-safety: OK\n'
