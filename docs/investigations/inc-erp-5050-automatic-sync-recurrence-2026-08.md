## Correção do contrato do diretório pai do backup de recuperação — run 31825814535 (14/08/2026)

O **Prepare Production Recovery Backup** falhou no [run 31825814535](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31825814535), [job 94849576856](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31825814535/job/94849576856). O último checkpoint aprovado no contrato de path do dump foi `PRODUCTION_BACKUP_DUMP_PATH_NORMALIZED=PASS`; o primeiro estágio reprovado foi `dump_path_contract/validate_dump_path_parent`, exit 1, antes da criação do dump. A causa técnica comprovada é a divergência entre o diretório autorizado resolved (`AUTHORIZED_DIR`, `/root/backups`) e o caminho do destino do dump configurado ou herdado (`PRODUCTION_BACKUP_FILE`, ex: `/var/backups/...`), resultando em pai inconsistente. Nenhum backup foi criado ou promovido.

O contrato corrigido resolve primeiro o diretório autorizado e deriva deterministicamente os caminhos finais do dump (`$AUTHORIZED_DIR/$dump_base`) e do manifesto (`$AUTHORIZED_DIR/$manifest_base`) como seus filhos diretos. As validações exigem individualmente: caminho absoluto, ausência de traversal (`..`), normalização (`readlink -m`), pai equivalente ao diretório autorizado e tipo regular não-symlink. Configurações divergentes ou externas são rejeitadas e o legado permanece estritamente somente leitura. Os checkpoints sanitizados individuais incluem `PRODUCTION_BACKUP_DUMP_PATH_PARENT=PASS` e `PRODUCTION_BACKUP_MANIFEST_PATH_PARENT=PASS`.

Esta implementação não acessou nem alterou produção, não executou o workflow produtivo de Recovery, cutover, migration, seed ou backfill, não recriou containers e não criou/promoveu backup. Permanecem: `PRODUCTION_BACKUP_PREPARATION=NOT_PROVEN`, `ERP_PRODUCTION_RECOVERY_WORKFLOW=NOT_EXECUTED`, `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `ERP_SYNC_ENV_PERSISTENCE=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING` e `READY_FOR_1_0B_2_O=NO`.

## Diagnóstico granular de `dump_path_contract` — run 31821917817 (14/08/2026)

O **Prepare Production Recovery Backup** falhou no [run 31821917817](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31821917817), [job 94836948252](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31821917817/job/94836948252). A fonte selecionada foi `legacy_read_only`, o último checkpoint aprovado foi `PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY=PASS` e o primeiro estágio reprovado foi `dump_path_contract/validate_dump_path_contract`, exit 1. Isso prova que `future_path_in_authorized_dir` rejeitou o dump antes das verificações de symlink e tipo do entry, mas o run não contém checkpoints internos capazes de distinguir absoluto, traversal, normalização, parent direto ou basename. A topologia e o valor configurado permanecem protegidos e não podem ser reconstruídos do log; atribuir uma dessas causas seria inventar evidência.

A instrumentação corretiva mantém o contrato fail-closed e individualiza, sem valores, os predicados de path absoluto, ausência de `..`/`.` textual, normalização, parent autorizado direto, basename produtivo `production.sql.gz`, symlink e tipo do entry. O manifesto permanece `production.sql.gz.sha256`, distinto e sujeito ao diretório autorizado. Destino futuro ausente é válido; entry existente precisa ser arquivo regular não-symlink e o par anterior continua somente `absent` ou `complete_valid`, com `root:root`, mode `600` e SHA-256 íntegro. O diretório autorizado continua absoluto, normalizado, existente, não-root e não-symlink; canônico existente inválido nunca usa fallback.

Esta PR não executa o workflow produtivo e, portanto, não afirma qual predicado granular falharia na VPS. Não houve acesso à produção, backup, promoção, Recovery ou cutover. Permanecem `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `ERP_SYNC_ENV_PERSISTENCE=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING` e `READY_FOR_1_0B_2_O=NO`. Uma execução futura, separada e humanamente autorizada é necessária para produzir a evidência granular; ela não é autorizada por esta mudança.

## Correção do contrato de path do backup — run 31817030215 (14/08/2026)

O **Prepare Production Recovery Backup** falhou no [run 31817030215](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31817030215), [job 94821079069](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31817030215/job/94821079069). O último checkpoint aprovado foi `PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY=PASS`; o primeiro estágio reprovado foi `backup_path_contract/validate_backup_path`, exit 1, antes do dump. A causa comprovável no SHA executado é o predicado composto: ele atribuía ao “path do dump” tanto a colisão dump/manifesto quanto a estrutura e o estado do entry de destino, sem checkpoint entre os predicados. Assim, a evidência do run comprova a falha desse contrato, mas não autoriza inventar qual subpredicado ou a topologia da VPS a disparou. Nenhum backup foi criado ou promovido.

O contrato corrigido valida, em ordem, o diretório autorizado absoluto, normalizado, não-root e não-symlink; o destino futuro absoluto, normalizado, filho direto e não-symlink do dump; o equivalente do manifesto e sua não colisão; e, separadamente, o estado do par anterior. Um destino futuro pode estar ausente. O par anterior é somente `absent` ou `complete_valid`: presença parcial, symlink, tipo inesperado, owner/mode diferente de `root:root`/`600` ou manifesto SHA-256 inválido falham fechados. Os checkpoints sanitizados são `PRODUCTION_BACKUP_DUMP_PATH_CONTRACT=PASS`, `PRODUCTION_BACKUP_MANIFEST_PATH_CONTRACT=PASS` e `PRODUCTION_BACKUP_EXISTING_PAIR_STATE=absent|complete_valid`; paths, hashes, URL e sentinelas não são impressos.

Esta implementação não acessou produção, não executou o workflow produtivo, Recovery, cutover, migration, seed ou backfill e não criou/promoveu backup. Lock, saúde do banco, dump, gzip, SHA-256, promoção atômica, rollback, freshness e preflight cutover permanecem obrigatórios. A sincronização automática e a persistência do env continuam não comprovadas: `PRODUCTION_BACKUP_PREPARATION=NOT_PROVEN`, `ERP_PRODUCTION_RECOVERY_WORKFLOW=NOT_EXECUTED`, `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `ERP_SYNC_ENV_PERSISTENCE=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING` e `READY_FOR_1_0B_2_O=NO`.

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

## Correção do preflight legado do ERP Production Recovery — run 31736308709 (13/08/2026)

A tentativa 2 do [run 31736308709](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31736308709), [job 94572767335](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31736308709/job/94572767335), executada no SHA `7005ddf65add085c53f8e80a0fcb9e4aee6017a1`, comprovou `AUTH_TEST_EMAIL`/`AUTH_TEST_PASSWORD` disponíveis, API saudável com cardinalidade 1 e restart count 0, AppConfig `enabled` e lock `free`. A fonte autorizada foi `legacy_copy`; o candidato reconciliava somente o scheduler e falhou no preflight antes de `environment_commit` e `api_recreate`. O rollback terminou (`COMPLETED`), nenhum env produtivo foi alterado e nenhum container foi recriado. A causa atual não são as credenciais do CRM.

A correção propõe a política explícita `recovery_legacy`: ela preserva a fonte e toda configuração empresarial, cria candidato temporário protegido e reconcilia exclusivamente scheduler habilitado e os seis gates produtivos seguros. A primitiva compartilhada mantém `build_legacy` estritamente build-only, com scheduler desabilitado; o candidato de Recovery não é autorizado no deploy normal. Canônico existente continua autoritativo e inválido falha sem fallback legado. O candidato só pode ser instalado depois de todos os preflights e o rollback continua fail-closed, restrito ao env e à API. **O Recovery corrigido ainda não foi executado com sucesso e a sincronização automática permanece não comprovada.**

Estados: `ERP_RECOVERY_AUTH_INPUT=AVAILABLE`; `ERP_RECOVERY_PREFLIGHT=NOT_PROVEN`; `ERP_PRODUCTION_RECOVERY_WORKFLOW=FAILED_PRE_COMMIT`; `PRODUCTION_ENV_MODIFIED=NO`; `CONTAINERS_RECREATED=NO`; `ERP_AUTOMATIC_SYNC=NOT_PROVEN`; `ERP_SYNC_ENV_PERSISTENCE=NOT_PROVEN`; `ERP_SCHEDULER_INITIALIZED=NOT_PROVEN`; `ERP_NEXT_RUN_AT=NOT_PROVEN`; `INC_ERP_5050=INVESTIGATING`; `READY_FOR_1_0B_2_O=NO`.

# Adendo — bloqueio circular do run 31707019441 (13/08/2026)

O run real passou por SSH, atualização fast-forward e conferência do SHA, mas falhou no comando `MODE=build EXPECTED_SHA="$EXPECTED_SHA" bash scripts/deploy-production.sh`. A ausência já registrada do canônico é compatível com a guarda inicial anterior. Isso bloqueava a imagem exigida pelo ERP Production Recovery que, por sua vez, é a autoridade exclusiva para criar o canônico e mudar uma única ocorrência do gate para `true`. A correção mantém essa autoridade: build apenas pode ler o legado root:root/600 se o canônico estiver totalmente ausente, mantendo o scheduler `false`; canônico válido vence, canônico inválido bloqueia e cutover não aceita legado. Logs contêm somente o marcador da fonte, nunca conteúdo ou Compose renderizado. Nenhuma produção/restauração foi executada nesta PR; repetir o build após merge e manter Recovery e `INC_ERP_5050` pendentes.

# Correção semântica da observabilidade — 13/08/2026

A revisão da PR #799 remove dupla contagem: pais são somente `manual/syncAll` e
`scheduler/automatic`; demais scopes são etapas correlacionadas. Manual não satisfaz evidência
automática. O gate agora executa 20 fixtures comportamentais reais; seu PASS comprova o contrato
local, não scheduler/lock/execução em produção. Produção e recovery não foram acessados.

# INC-ERP-5050 — recorrência da sincronização automática (11/08/2026)

## Limite da investigação

Este checkout gerenciado está na branch local `work`, sem remote configurado e sem canal SSH/VPS disponível. A produção **não foi acessada** por esta investigação. Portanto, SHA do runtime, containers, AppConfig, locks, logs, próxima janela e execução com `trigger=scheduler` permanecem não comprovados. As observações produtivas abaixo são exclusivamente as evidências sanitizadas fornecidas pelo operador em 10/08/2026; não são inferidas do Git.

## Classificação antes de alteração

| Item | Esperado | Observado em 10/08 (evidência fornecida) | Resultado | Evidência sanitizada |
|---|---|---|---|---|
| Gate do scheduler | `true` no container | desabilitado pelo ambiente | FAIL — A | painel: `scheduler_disabled` |
| Env externo | `/root/demetra-env/.env` presente | ausente | FAIL — B | presença técnica: AUSENTE |
| Credencial global | par completo ou modo alternativo válido | usuário/senha ausentes; vendedor de referência configurado | PENDENTE — C/D | valores não inspecionados |
| Configuração persistida | habilitada | botão oferece desativar | APARENTA PASS — exige leitura DB | UI, sem payload |
| Bootstrap | chama scheduler | backend inicializado | PASS no código; runtime não comprovado | `server.ts` chama o start |
| Próxima execução | preenchida | vazia | FAIL, consequência do gate | painel |
| Última automática | execução horária recente | 18/07/2026 18:00 | FAIL | painel |
| Instâncias/lock/conectividade | uma instância, lock íntegro, ERP acessível | não auditado | NOT PROVEN — G/H/I | acesso VPS indisponível |

**Causa comprovada pelas evidências fornecidas:** combinação **A + B**. O contrato de deploy também possuía uma divergência reprodutível: o deploy/cutover procurava `/root/demetra-env/production.env`, enquanto runtime, backup, restauração e runbook oficial usavam `/root/demetra-env/.env`. Essa inconsistência permitia que um arquivo correto e persistente não fosse carregado pelo mecanismo oficial.

## Correção versionada e prevenção

- caminho canônico único: `/root/demetra-env/.env`, fora de `/apps/gest-o`;
- preflight fail-closed antes do build, com owner/mode, variáveis, gates e render do Compose;
- scheduler sem default implícito no Compose de produção: deve ser declarado literalmente `true`;
- teste cobre arquivo ausente, scheduler falso, secret vazio, passagem válida e ausência de secrets na saída;
- backup/restauração permanecem protegidos, fora do Git e com mode `600`.

Nenhuma migration, schema Prisma, tenancy, ledger, backfill ou dado empresarial foi alterado.

## Procedimento operacional ainda pendente

Um operador com acesso autorizado e fonte segura deve restaurar o env (sem recriar credenciais), executar o preflight, validar o Compose sem exibir sua saída, recriar **somente** `api`, e então coletar a matriz read-only requerida. Se a fonte segura não existir, a operação deve parar antes de modificar o host. Não usar `down -v`, não remover volumes, não aplicar schema e não classificar uma execução manual como automática.

## Estado

```text
ERP_AUTOMATIC_SYNC = NOT_PROVEN
ERP_SYNC_ENV_PERSISTENCE = NOT_PROVEN
INC_ERP_5050 = INVESTIGATING
PRODUCTION_ACCESSED = NO
TENANCY_MODE_PRODUCTION = disabled (evidência fornecida; não reverificada)
TENANT_READ_PILOT_ENABLED_PRODUCTION = false (evidência fornecida; não reverificada)
READY_FOR_MULTI_TENANT_CUTOVER = NO
```

## Cronologia do canal de recuperação

- **PR #797:** prevenção versionada e contrato fail-closed do env; não é prova da VPS.
- **ERP Production Recovery:** novo canal manual, aprovado e auditável para copiar a fonte legado
  autorizada quando necessário, habilitar o gate, recriar somente a API e coletar a prova automática.
- **Execução produtiva:** ainda pendente. O workflow só pode ser disparado depois do merge desta PR e
  da preparação da imagem do mesmo SHA; o incidente permanece `INVESTIGATING` até uma execução real
  e bem-sucedida com `trigger=scheduler` e persistência do ambiente comprovada.
- **Revisão pré-merge da PR #798:** remove a dependência incorreta de `API_IMAGE`, `WEB_IMAGE` e
  `APP_*` transitórios no env e separa as credenciais de validação no canal protegido do GitHub. O
  workflow permanece não executado e produção não foi acessada por essa correção.

```text
ERP_AUTOMATIC_SYNC = NOT_PROVEN
ERP_SYNC_ENV_PERSISTENCE = NOT_PROVEN
ERP_SCHEDULER_INITIALIZED = NOT_PROVEN
ERP_NEXT_RUN_AT = NOT_PROVEN
INC_ERP_5050 = INVESTIGATING
PRODUCTION_ACCESSED = NO
READY_TO_MERGE_RECOVERY_PR = NO
```

## Reconciliação de observabilidade — 12/08/2026

A evidência fornecida de sync completa é classificada exclusivamente como `manual`. A investigação
local comprovou mascaramento de erro/ausência no frontend e lacunas de contrato da Saúde; a correção
v2 e a matriz de fontes estão em `docs/platform-health-erp-observability.md`. Isso não executou nem
comprovou scheduler/recovery/produção. `INC_ERP_5050` permanece `INVESTIGATING`.
# Adendo — falha silenciosa anterior ao resolver no run 31713219051 (13/08/2026)

O SSH e o fast-forward `3c068fa..443be81` passaram e os 12 arquivos da PR #800 chegaram à VPS. O
status 1 ocorreu antes de `DEPLOY_CHECKOUT_SHA`, fonte do env, erro do resolver ou início do deploy.
A ordem do shell torna o antigo `test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"` o comando que
interrompeu o run; como ele não imprimia operandos, a condição subjacente não pode ser reconstruída
do log. A correção substitui esse ponto por checkpoints explícitos, validação de SHA completo,
worktree/script e diagnóstico sanitizado, além de marcar entrada e resolução no deploy. O resolver
da PR #800 e sua política permanecem semanticamente inalterados. Build, cutover, recriação e ERP
Production Recovery não ocorreram; `ERP_AUTOMATIC_SYNC` e persistência continuam `NOT_PROVEN`,
`INC_ERP_5050 = INVESTIGATING` e `READY_FOR_1_0B_2_O = NO`.
# Evidência adicional — bloqueio do build no run 31720219813

O job `94515047904`, SHA `a3f900b05cbbcc2ab9ee8bba306c4a2cea524d97`, confirmou os gates
Git/checkout/worktree/entrypoint, `MODE=build`, fonte `legacy_build_only` e scheduler desativado, mas
falhou em `TENANCY_MODE does not match the production policy`. Não construiu imagens, não recriou
containers, não executou cutover/Recovery e não modificou o env ou a produção; portanto não prova
sincronização automática nem persistência do env.

A correção limita-se a um overlay `mktemp` mode 600 durante build legado, com sete gates seguros,
cleanup e prova SHA-256 de imutabilidade da fonte. Canônico permanece autoritativo, cutover
canonical-only e Recovery inalterado. Após merge e checks verdes ainda será necessário repetir
somente o `phase=build`. `INC_ERP_5050=INVESTIGATING`, `ERP_AUTOMATIC_SYNC=NOT_PROVEN`,
`ERP_SYNC_ENV_PERSISTENCE=NOT_PROVEN` e `READY_FOR_1_0B_2_O=NO`.

# Evidência adicional — frescor bloqueou o build no run 31723282307

O run `31723282307` confirmou Git/checkout/worktree, entrada em `MODE=build`, fonte
`legacy_build_only`, sete gates do overlay e preflights ERP, mas parou em “backup não é recente”.
API/WEB não foram construídas; não houve env persistente, parada/recriação de containers, migration,
seed, backfill, cutover ou Recovery. Portanto o run não alterou produção.

O preflight passa a receber modo explícito. Presença e integridade pelo manifesto SHA-256 existente
continuam obrigatórias nos dois modos; apenas a idade deixa de bloquear o build, que somente produz
imagens e não é cutover. Backup antigo tolerado no build não autoriza cutover, cujo frescor continua
obrigatório antes de efeitos mutáveis. Recovery permanece dependente de imagem aprovada e de suas
precondições. Mesmo um futuro build verde não provará scheduler automático, persistência do env ou
`nextRunAt`: `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `ERP_SYNC_ENV_PERSISTENCE=NOT_PROVEN`,
`ERP_SCHEDULER_INITIALIZED=NOT_PROVEN`, `ERP_NEXT_RUN_AT=NOT_PROVEN`,
`INC_ERP_5050=INVESTIGATING` e `READY_FOR_1_0B_2_O=NO`.
