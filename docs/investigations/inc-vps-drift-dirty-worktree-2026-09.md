# Incidente de Drift e Worktree Sujo na VPS (23-26/09/2026)

## Resumo Executivo
Em 23-24/09/2026, comandos sugeridos por uma IA externa (Gemini) foram executados diretamente na VPS para liberar espaço em disco, incluindo comandos globais fora do processo auditado de limpeza em lotes (`docker builder prune -a -f` e `docker image prune -a -f`) e a alteração/sobrescrita sem commit de três arquivos em `/apps/gest-o` (`apps/api/src/services/ultraFv3SyncService.ts`, `apps/web/src/pages/CrudSimplePage.tsx`, `scripts/check-prod-health.sh`), além da criação de um novo arquivo não rastreado (`apps/api/src/controllers/scheduler-controller.ts` que retornava sucesso sem validar nada).

## Impacto Comprovado
- **Produção:** Nenhum impacto na aplicação em produção. A produção continuou saudável, pois os containers ativamente atendendo no Docker foram construídos a partir de imagens previamente compiladas.
- **Workflows CI/CD:** O workflow **Prepare Production Recovery Backup** foi bloqueado silenciosamente por dias durante a etapa de verificação de checkout (`checkout/validate_main_checkout`), pois o comando `git status --porcelain` retornava saída não vazia devido aos arquivos modificados/não rastreados.
- **Diagnóstico:** O diagnóstico demorou devido à falta de verbosidade no bloqueio existente (`test -z "$(git status --porcelain)"`), que abortava com `exit 1` genérico e marcadores `BACKUP_FAILURE_STAGE=checkout` sem listar quais arquivos estavam modificados ou não rastreados.

## Resolução Operacional (26/09/2026)
1. **Preservação Forense:** Patch de evidência do estado alterado foi salvo em `/root/forensic/` na VPS antes de qualquer alteração no repositório.
2. **Limpeza do Worktree:** Executado `git stash push -u` para limpar o diretório de trabalho de arquivos modificados e não rastreados.
3. **Sincronização com `main`:** Executado `git pull --ff-only origin main` para alinhar o checkout local em `/apps/gest-o` com a `main` aprovada no SHA `9aba4df`.
4. **Validação do Backup:** O workflow **Prepare Production Recovery Backup** (run nº 76, SHA `9aba4df`) foi reexecutado e aprovado com sucesso.

## Proteções Implementadas no Código
- **Proteção 1 (Mensagem explícita no bloqueio de worktree sujo):**
  - Alterado `scripts/prepare-production-recovery-backup.sh` e `.github/workflows/prepare-production-recovery-backup.yml`.
  - Se `git status --porcelain` for não vazio, o script imprime mensagem clara `[CRITICAL] Working tree em /apps/gest-o não está limpo. Backup abortado.`, exibe a lista completa de arquivos afetados e orienta a investigação via `docs/OPERACAO.md` antes de abortar.
- **Proteção 2 (Verificação diária de drift da VPS via GitHub Actions):**
  - Criado o workflow `.github/workflows/vps-drift-detection.yml`, agendado diariamente às 06:00 BRT (`0 9 * * *` UTC) e acionável por `workflow_dispatch`.
  - Conecta via SSH de forma **estritamente somente-leitura** e executa `git fetch origin main`, `git status --porcelain`, `git rev-parse HEAD` e `git rev-parse origin/main`.
  - Se o worktree estiver sujo ou o HEAD divergir de `origin/main`, falha a Action (exibindo ícone vermelho no GitHub) e imprime a lista de arquivos sujos e os SHAs divergentes. Zero comandos mutáveis (`git pull`, `git reset`, `git stash`, `git clean`) são executados.

## Recomendações Operacionais
- **Nunca executar comandos sugeridos por IA externa diretamente na VPS de produção** sem antes revisar, auditar e validar o comando fora do ambiente produtivo.
- **Nunca utilizar comandos globais de limpeza Docker** (`docker system prune -a`, `docker image prune -a`, `docker builder prune -a`) na VPS — manter estritamente o processo de limpeza auditada em lotes pequenos já documentado em `docs/DOCUMENTO_MESTRE.md` e `docs/OPERACAO.md`.
- **Nunca editar arquivos de código diretamente no disco da VPS** — toda e qualquer alteração de código ou script deve passar por Pull Request revisada, testada e mesclada na `main`, mesmo durante emergências de espaço em disco.
