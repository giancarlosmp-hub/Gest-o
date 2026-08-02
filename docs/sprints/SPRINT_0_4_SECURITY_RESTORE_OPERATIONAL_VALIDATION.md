# Sprint 0.4 — validação operacional de segurança e restore autorizado

**Estágio:** 🔵 PR em 02/08/2026. Preparação versionada; nenhum deploy, acesso à VPS ou restore real.

## Objetivo e estado inicial

Preparar a execução humana mínima que publica a `main` pelo pipeline oficial, prova TD-ER-001 e
TD-ER-002 contra o SHA implantado e, somente depois, permite ensaiar uma cópia real aprovada de
backup em PostgreSQL 16 descartável. O `HEAD` inicial é o merge `30f7d0d` da PR #767; o histórico
local contém também o merge `c9de405` da PR #766. O checkout chegou sem remote; `origin` foi
configurado e a atualização de `main` foi tentada, mas o proxy respondeu HTTP 403. Merge/checks
foram verificados somente pelo histórico local; estado atual do GitHub e checks reais não puderam
ser consultados e continuam gates obrigatórios. Merge não comprova deploy.

As PRs envolvidas são #766 (remoção de `/debug/admin` e logs de autenticação sanitizados) e #767
(harness isolado). TD-ER-001/002 aguardam deploy e evidência por SHA; TD-ER-003 aguarda check Docker,
cópia autorizada e ensaio operacional. `INC-PROD-2026-07` permanece corrigido aguardando
encerramento; nenhum débito ou incidente é encerrado por esta Sprint.

## Riscos e limitações probatórias

- credencial operacional pode vazar: somente variáveis protegidas entram no processo; corpos de
  login, headers, cookies, tokens e logs brutos não entram em evidência;
- uma falsa versão pode ser validada: checkout, `origin/main`, API local/pública e WEB
  local/pública devem convergir no SHA completo;
- um teste pode afetar produção: a validação é read-only, faz três tentativas de login no total e um
  único GET autenticado; rate limit é evidência de CI, nunca carga contra produção;
- a inspeção do intervalo pode conter tráfego concorrente e aumentar contagens; ausência de PII e
  presença dos eventos esperados são provadas, mas retenção histórica/global não é;
- o restore prova somente a cópia selecionada, no laboratório descartável. Não prova off-site,
  criptografia, pessoas, capacidade completa, RPO nem RTO operacional;
- a imagem `postgres:16` deve existir localmente. SKIP 77 não aprova restore e exige check real verde.

## Ordem operacional e separação de etapas

1. **Deploy:** aprovar e acompanhar `Deploy Production` para o SHA da `main`, sem outro deploy em
   paralelo, conforme [`OPERACAO.md`](../OPERACAO.md). Falha aciona o rollback oficial da release;
   restore de banco nunca é rollback de aplicação.
2. **Validação de segurança:** em janela própria, fornecer as variáveis protegidas e executar
   `scripts/production-auth-security-validate.sh`. Uma falha remove/impede `result.tsv`, bloqueia a
   promoção e exige triagem; não repetir agressivamente login.
3. **Estabilidade:** revisar health, erros e sinais vigentes pelo runbook oficial. A evidência curta
   de segurança não substitui monitoramento prolongado.
4. **Restore separado:** somente após PASS de segurança e nova autorização humana, executar o
   harness com uma cópia aprovada, sem carregar variáveis de produção ou reutilizar recurso
   operacional. Não incorporar ao workflow de deploy.
5. **Decisão humana:** anexar apenas evidências sanitizadas aos tickets e revisar todos os critérios
   formais. Não encerrar automaticamente TD-ER-001, TD-ER-002, TD-ER-003 ou INC-PROD-2026-07.

## Comando de validação de segurança

As credenciais devem vir de mecanismo protegido do shell, sem aparecer no histórico. O operador
também informa as identidades já aprovadas do PostgreSQL/volume:

```bash
cd /apps/gest-o
EXPECTED_SHA='<sha-completo-da-main>' \
CONFIRM=PRODUCTION_AUTH_SECURITY_VALIDATE \
AUTH_TEST_EMAIL="$AUTH_TEST_EMAIL" \
AUTH_TEST_PASSWORD="$AUTH_TEST_PASSWORD" \
PRODUCTION_DB_CONTAINER_EXPECTED="$PRODUCTION_DB_CONTAINER_EXPECTED" \
PRODUCTION_DB_VOLUME_EXPECTED="$PRODUCTION_DB_VOLUME_EXPECTED" \
bash scripts/production-auth-security-validate.sh
```

Conta inativa não integra o comando padrão: só pode ser acrescentada em execução autorizada com
fixture identificada fora da evidência e deve produzir o mesmo contrato público 401.

## Critérios de aceite e evidências

- checkout, `origin/main` e worktree convergem; API/WEB estão running/healthy; PostgreSQL e volume
  esperados estão preservados;
- `/health/version` e `build-info.json`, locais e públicos, informam o SHA esperado;
- ambas as variantes de `/debug/admin`, locais e públicas, retornam 404 sem campos sensíveis;
- login válido funciona; senha inválida e usuário fictício retornam 401 e resposta pública
  normalizada idêntica; GET protegido autenticado retorna 200 e sem token retorna 401;
- eventos `auth_login_success`/`auth_login_failure` existem no intervalo e o scan não encontra
  identidade testada, senha ou material de autenticação proibido;
- `metadata.tsv`, `runtime.tsv`, `api-version.json`, `web-build-info.json`,
  `endpoint-results.tsv`, `login-results.tsv` e `log-scan-results.tsv` são revisáveis; `result.tsv`
  existe somente no PASS integral em `/var/log/gest-o/security/<SHA>/`.

Esses artefatos não contêm e-mail completo, senha, token, cookie, header, corpo de login, log bruto
ou dado pessoal. Hash SHA-256 da resposta pública inválida serve somente para comparar o contrato.

## Restore autorizado separado

Pré-condição: copiar o dump e sidecar para uma área aprovada fora do repositório/artifacts, limpar
do ambiente todas as variáveis de produção e confirmar que `postgres:16` já existe. O diretório de
evidência deve ser novo e explícito:

```bash
env -i PATH="$PATH" HOME="$HOME" \
  BACKUP_FILE='/caminho/aprovado/backup.dump' \
  BACKUP_SHA256_FILE='/caminho/aprovado/backup.dump.sha256' \
  RESTORE_EVIDENCE_ROOT='/caminho/aprovado/evidencias-restore' \
  RESTORE_TEST_ID='<sha>-restore-autorizado-<utc>' \
  bash scripts/smoke/production-backup-restore-postgres.sh
```

O harness usa imagem local, rede interna aleatória, containers aleatórios e `tmpfs`, sem porta,
volume, Compose, database ou container operacional. Checklist humano obrigatório:

- [ ] backup selecionado e cadeia de custódia registrada sem publicar dump/dados;
- [ ] autorização separada identificada, após PASS da segurança;
- [ ] sidecar SHA256 explícito conferido;
- [ ] formato custom catalogável e compatível com PostgreSQL 16;
- [ ] espaço em disco para cópia temporária e evidências verificado;
- [ ] nenhuma variável de produção carregada e nenhum dump/dado publicado como artifact;
- [ ] `result.tsv` final revisado, ou falha preservada sem alegação de aprovação;
- [ ] duração medida comparada à proposta técnica de RTO de 4 h, sem tratá-la como RTO aprovado.

## Rollback

No deploy, seguir exclusivamente `scripts/production-rollback.sh` e a evidência da release; ele
reverte API/WEB e preserva PostgreSQL. Na validação read-only não há rollback de dados: falhar,
preservar sumários parciais e não emitir PASS. No restore descartável, o trap remove apenas recursos
aleatórios da execução. Reverter esta PR remove script, smoke e documentação, sem efeito em runtime.
