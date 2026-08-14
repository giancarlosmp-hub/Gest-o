## Diagnóstico fail-closed do inventário do backup de Recovery (14/08/2026)

A evidência operacional autoritativa registra o **Deploy Production #96 como SUCCESS** e o **Prepare Production Recovery Backup #2 como FAILURE** no [run 31809680286](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31809680286), [job 94797031649](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31809680286/job/94797031649), sobre a main `33896984ee25343d32de94a07502b1c318540724` (merge da PR #806). O último checkpoint aprovado foi `PRODUCTION_BACKUP_ENV_SOURCE=legacy_read_only`; a falha agregada seguinte foi `readonly_inventory/validate_inventory`, exit 1. Como o log antigo não individualiza os predicados, **o primeiro predicado real que falhou continua NOT_PROVEN**: não há evidência para classificar o caso como divergência legítima de topologia nem como estado operacional inseguro específico.

A correção mantém todos os bloqueios e divide o inventário em diagnósticos sanitizados para diretório autorizado, paths, metadados do par, URL do banco, container/health, rede, volume, mount, disco e lock. Nenhum valor protegido é emitido. O harness cobre falhas individuais, redaction, imutabilidade do legado, ausência do canônico e prova que nenhum `pg_dump` começa antes de todos os checkpoints. Esta implementação não acessou nem alterou produção, não criou/promoveu dump ou manifesto, não recriou containers e não executou Recovery, cutover, migration, seed, backfill ou sincronização ERP.

Após o merge, não reutilizar imagens do SHA anterior: (1) executar **Deploy Production** com `phase=build` no novo SHA completo; (2) confirmar build verde e imagens pinadas a esse SHA; (3) executar **Prepare Production Recovery Backup** uma única vez; (4) se houver falha, corrigir separadamente o estágio técnico comprovado, sem fallback; (5) somente se todos os marcadores forem PASS, considerar um disparo humano e separado de ERP Production Recovery. Esta tarefa não autoriza esse Recovery. Permanecem `PRODUCTION_BACKUP_PREPARATION=NOT_PROVEN`, `ERP_PRODUCTION_RECOVERY_WORKFLOW=NOT_EXECUTED`, `INC_ERP_5050=INVESTIGATING` e `READY_FOR_1_0B_2_O=NO`.

## Correção da resolução do env no preparador de backup (14/08/2026)

O **Deploy Production build #95 passou**, mas o workflow **Prepare Production Recovery Backup** do [run 31799520495](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31799520495), [job 94763949983](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31799520495/job/94763949983), parou antes de criar o dump com `BACKUP_FAILURE_STAGE=initial` e `BACKUP_FAILURE_COMMAND=initial_validation`. A causa exata no SHA base `ccfc538c564ed26fed6a0cb0a43a7e4cb7abbc2b` era a chamada direta de `protected_regular` sobre o default canônico `/root/demetra-env/.env`: como esse arquivo estava completamente ausente, o primeiro predicado `-f` retornou 1 dentro do bloco inicial ainda não segmentado. Portanto, nenhum dump ou manifesto foi criado ou promovido.

O contrato corrigido é estritamente **canônico → legado somente leitura**: qualquer entrada canônica existente é autoritativa e precisa ser arquivo regular não-symlink, `root:root`, mode `600` e sintaticamente válida; canônico inválido falha sem fallback. Apenas a ausência completa permite selecionar o único legado autorizado `/root/demetra-env/production.env`, sujeito às mesmas validações, classificado como `PRODUCTION_BACKUP_ENV_SOURCE=legacy_read_only`. A fonte legada é apenas carregada para obter a configuração do backup: não é modificada, copiada, reconciliada, promovida nem usada para criar o canônico. Ausência de ambas falha fechada. Os diagnósticos iniciais agora identificam confirmação, SHA, checkout, resolução, metadados, sintaxe e configuração obrigatória sem expor paths ou valores protegidos.

Esta correção não acessou produção, não executou o workflow produtivo, Recovery ou cutover e não criou backup. O Recovery continua não executado; a sincronização automática, persistência do env, inicialização do scheduler e `nextRunAt` continuam **NOT_PROVEN**. `INC_ERP_5050=INVESTIGATING` e `READY_FOR_1_0B_2_O=NO`.

## Contrato de preparação do backup para Recovery (13/08/2026)

O build produtivo do SHA `376c84eed4cfa2ba79e2383e41e6e0d2fb4b5ba0` passou no run 31742404113. O Recovery do run 31743043943 avançou após a correção da PR #804, mas o preflight bloqueou fail-closed em `backup_stale`; o rollback terminou antes de qualquer alteração persistente. Portanto, presença, integridade e freshness de um backup novo continuam pendentes e a sincronização automática permanece `NOT_PROVEN`.

O workflow manual **Prepare Production Recovery Backup** usa o environment protegido dedicado `production-backup-recovery` (secrets de conexão `SSH_HOST`/`VPS_HOST`, `SSH_USER`/`VPS_USER`, `SSH_KEY`/`VPS_KEY` e opcional `SSH_PORT`/`VPS_PORT`). Ele exige confirmação literal e SHA completo da `main`, prepara apenas o par backup/manifesto SHA-256, preserva o par anterior, executa o preflight cutover somente read-only e não executa deploy, cutover ou Recovery. Aprovação humana deve ser configurada nesse environment. O **ERP Production Recovery deve ser disparado separadamente**, somente depois de evidência recente e íntegra. Nesta mudança, produção e backup real não foram acessados.

Estados: `PRODUCTION_BACKUP_PREPARATION=NOT_EXECUTED`; `PRODUCTION_BACKUP_PRESENCE=NOT_PROVEN_ON_NEW_RUN`; `PRODUCTION_BACKUP_INTEGRITY=NOT_PROVEN_ON_NEW_RUN`; `PRODUCTION_BACKUP_FRESHNESS=NOT_PROVEN_ON_NEW_RUN`; `ERP_PRODUCTION_RECOVERY_WORKFLOW=FAILED_PRE_COMMIT_BACKUP_STALE`; `ERP_AUTOMATIC_SYNC=NOT_PROVEN`; `INC_ERP_5050=INVESTIGATING`.

# Prontidão de backup e restauração

> **Estado:** proposta técnica em 🔵 PR. Este documento não comprova restauração de produção, não
> aprova objetivos contratuais e não encerra `INC-PROD-2026-07` nem `TD-ER-003`.

## Diagnóstico do caminho atual

| Pergunta auditada | Resposta baseada no repositório |
|---|---|
| Script oficial | `backup.sh` é o caminho PostgreSQL documentado em `docs/ops/backup.md`; `restore.sh` é o restaurador legado. O dump custom do coletor ERP é um caminho forense, não a rotina oficial. |
| Formato | O oficial produz SQL texto e depois `.sql.gz`; o coletor forense produz formato custom. O novo ensaio aceita somente formato catalogável pelo `pg_restore` (custom/tar/directory materializado). |
| Checksum obrigatório | Não no `backup.sh`/`restore.sh`. O preflight de deploy exige SHA256 de um backup informado e o novo ensaio também exige sidecar SHA256. |
| Catálogo validado | Não no fluxo oficial `.sql.gz`; sim no caminho forense custom e no novo ensaio. |
| Criação atômica | Não. O SQL é escrito diretamente no nome final antes de validação/compressão. Falha tenta removê-lo, mas consumidores podem observar arquivo parcial. |
| Retenção | 48 dumps válidos locais; a periodicidade não está imposta pelo script e, portanto, não equivale a 48 dias. |
| Criptografia | Não foi encontrada para dumps PostgreSQL. Permissões do diretório/arquivo também não são explicitamente endurecidas pelo `backup.sh`. |
| Off-site | Não foi encontrada cópia off-site versionada. |
| Restore periódico | Não havia teste periódico versionado; esta PR propõe CI sintético e ensaio mínimo mensal autorizado. |
| Proteção do restore legado | Não. `restore.sh` fixa diretório, serviço, usuário e database operacional e redireciona SQL sem confirmação, checksum ou isolamento. |
| Validação pós-restore legado | Apenas o código de saída do `psql`; não há inventário estrutural, catálogo pós-restore ou segunda conexão. |
| Caminhos conflitantes | Sim: `.sql.gz` oficial, argumento `.sql` esperado pelo restore legado, custom dump forense e backups separados de arquivo de ambiente. |

Outros riscos: `restore.sh` não cita o argumento; SQL texto não permite `pg_restore --list`; o dump
usa usuário administrativo; não há timeout; e uma falha em SQL texto pode deixar objetos parciais.
Esses scripts foram preservados por compatibilidade. Sua migração/atomização, criptografia e destino
off-site entram no backlog, não são corrigidos silenciosamente nesta Sprint.

## Ensaio descartável

Execute apenas com dump sintético ou cópia formalmente autorizada:

```bash
# fixture sintética criada e destruída na própria execução
npm run test:production-backup-restore:postgres

# dump custom autorizado, sempre com checksum sidecar
BACKUP_FILE=/caminho/autorizado/backup.dump \
BACKUP_SHA256_FILE=/caminho/autorizado/backup.dump.sha256 \
bash scripts/smoke/production-backup-restore-postgres.sh
```

O script usa `postgres:16` já presente (`--pull=never`), rede interna de nome aleatório, containers
aleatórios, armazenamento `tmpfs`, usuário/database exclusivos e nenhuma porta. Variáveis de
produção herdadas causam falha antes do restore. Não há Compose, rede/volume/container externo nem
carregamento de arquivo de ambiente. O `trap` remove somente os recursos cujos nomes foram criados
pela execução.

Antes do restore são verificados: legibilidade, SHA256 obrigatório, tamanho, timestamp, versão do
cliente e catálogo `pg_restore --list`. O restore usa transação única, `--exit-on-error`, timeout e
`ON_ERROR_STOP` nas consultas. Depois são verificados conexão, `public`, tabelas, migrations Prisma
quando presentes, nomes/contagens de `incident_*`, constraints/FKs, índices, enums, contagens por
tabela, novo dump catalogável e segunda conexão. Números não são inventados: o inventário deriva do
catálogo restaurado. O diff Prisma fica marcado `SKIP` até existir imagem API pinada explicitamente.

## Evidências sem conteúdo de registros

Por padrão, os metadados ficam em `/tmp/gest-o-restore-evidence/<test-id>/`, modo `0700`:

- `restore-metadata.tsv`, `backup.sha256`, `pg-restore-list.txt` e `pre-restore.tsv`;
- `post-restore.tsv`, `object-counts.tsv`, `incident-tables.tsv` e `post-conditions.tsv`;
- logs do `pg_restore`, sem conteúdo de tabelas, e `prisma-diff.sql` com resultado ou `SKIP`;
- `result.tsv`, escrito por último e somente após todas as validações passarem.

As evidências contêm hashes, nomes/quantidades de objetos, versões e tempos; não contêm senha,
URLs, linhas, e-mails, tokens ou secrets. Dump e banco verificado ficam temporários e não são
artifacts. O CI gera sua fixture e dump durante o job e não publica nenhum deles.

## RPO e RTO

- **RPO** é a perda máxima aceitável de dados medida entre o último ponto recuperável e a falha.
  **Proposta técnica:** 24 horas, com backup diário. Ainda não aprovado por Product Owner/Operação.
- **RTO** é o tempo máximo aceitável entre a decisão de recuperar e o serviço validado. **Proposta
  técnica:** 4 horas. Ainda não aprovado nem demonstrado em ambiente operacional.
- **RPO medido no ensaio:** não mensurável; uma fixture sob demanda não mede idade/frequência de
  backups reais. O hash prova integridade do arquivo testado, não sua atualidade.
- **RTO medido:** `duration_seconds` mede apenas o restore/validações do ambiente descartável e é
  evidência de laboratório, não RTO de produção. Cada execução registra o valor em `result.tsv`.

Diferença atual: não há amostra operacional que sustente RPO 24 h ou RTO 4 h. Recomenda-se backup
diário, retenção local inicial de 48 backups válidos, cópia off-site criptografada com acesso mínimo
e retenção aprovada, criptografia em repouso e em trânsito, teste sintético em cada PR e restore de
cópia autorizada ao menos mensal. Frequência, retenção, chave, destino e objetivos dependem de
aprovação humana, orçamento e requisitos legais.

## Falha, rollback e limites

Falhar em qualquer gate impede `result.tsv`; o trap remove container, rede e temporários. O rollback
do ensaio é simplesmente destruir o ambiente descartável. Evidências metadatais já emitidas são
preservadas para auditoria da falha. Não há alteração de aplicação ou deploy.

Este teste prova que **o arquivo fornecido** pode ser catalogado e restaurado em PostgreSQL 16 sob
condições isoladas. Não prova acesso, tempo, permissões, capacidade, WAL, criptografia, off-site,
procedimento humano ou restauração da produção. Um teste com dados sintéticos tampouco certifica um
dump real. `INC-PROD-2026-07` e `TD-ER-003` permanecem abertos até merge, check Docker real,
execução autorizada futura e validação operacional aprovada.
