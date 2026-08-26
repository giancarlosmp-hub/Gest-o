## Caminho real do dump após a PR #815 — run 32968702953 (26/08/2026)

O run produtivo pós-merge **32968702953**, job **98177088311**, do **Prepare Production Recovery Backup** selecionou `legacy_read_only` e aprovou, em ordem, entrada do container, contrato de `DATABASE_URL`, resolução/inspeção do container externo, network, volume, mount, capacidade de disco, lock e `PRODUCTION_BACKUP_SOURCE_VALIDATED=PASS`. Depois falhou em `BACKUP_FAILURE_STAGE=dump`, `BACKUP_FAILURE_COMMAND=create_validated_dump`, exit 1, com `service "db" is not running`. Isso não é falha do container validado, Docker daemon, credenciais ou PostgreSQL: esses gates já haviam passado.

O call graph real era workflow → `prepare-production-recovery-backup.sh` → estágio `create_validated_dump` → `backup_validate_database_health` → `check-prod-health.sh` → `query_count` → `docker compose exec -T db psql`. Portanto a seleção indevida de Compose ocorria na pré-validação compartilhada, antes do `docker exec ... pg_dump` textual do preparador, e o estágio agregado fez a mensagem aparecer como falha de criação do dump. A alegação anterior de caminho exclusivamente direto estava incompleta. O backup histórico `backup.sh` continua com sua estratégia legada separada.

O fluxo corrigido chama `backup_validate_database_health_in_validated_container` para suas leituras e chega a `docker exec -i <nome-exato-validado> psql`; em seguida revalida resolução exata, cardinalidade unitária, identidade completa mantida somente em memória, nome, running e health (quando presente), e só então executa `docker exec -i "$PRODUCTION_DB_CONTAINER_EXPECTED" pg_dump -U postgres -d salesforce_pro`. Não existe fallback para serviço `db` no preparador. Logs permanecem sanitizados; nenhuma identidade, nome, URL, path protegido ou credencial é emitida. Gzip, SHA-256, promoção/rollback atômicos, freshness e preflight final permanecem obrigatórios.

Nesse run nenhum backup foi criado ou promovido, Recovery e cutover não foram executados e produção não foi modificada. Esta correção não executa workflow produtivo nem acessa a VPS. `ERP_PRODUCTION_RECOVERY_WORKFLOW=NOT_EXECUTED`, `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING` e `READY_FOR_1_0B_2_O=NO`.

## Diagnóstico da resolução do PostgreSQL no backup — run 32852671136 (25/08/2026)

O **Prepare Production Recovery Backup** falhou no [run 32852671136](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/32852671136), [job 97817069520](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/32852671136/job/97817069520), sobre o SHA `f7be55edf271306e380e3eb71633e33ea0031c2f`. O último gate aprovado foi `PRODUCTION_BACKUP_DATABASE_URL_CONTRACT=PASS`; a falha ocorreu em `database_container/capture_validated_database_identity`. O marcador anterior agregava resolução, nome, cardinalidade, inspect, estado e health, portanto a evidência prova somente que o nome exato configurado não produziu um snapshot único, congruente, running e healthy (quando há healthcheck). Ela **não prova** qual desses subpredicados falhou e não autoriza inferir o nome ou a topologia reais. Nenhum backup foi criado ou promovido.

`PRODUCTION_DB_CONTAINER_EXPECTED` não vem de secret/variable do GitHub, não possui default e não é derivado de hostname, serviço Compose ou container ID. O workflow transmite pela sessão SSH somente confirmação e SHA; o preparador carrega a variável do arquivo protegido selecionado na VPS. Neste run, `PRODUCTION_BACKUP_ENV_SOURCE=legacy_read_only` e o gate de configuração obrigatória passou, logo a entrada veio de `/root/demetra-env/production.env` e era não vazia; seu valor e sua correspondência com o inventário real continuam protegidos e `NOT_PROVEN`. O environment GitHub correto continua `production-backup-recovery`, apenas com as credenciais SSH documentadas: não se deve cadastrar ali um nome presumido. Operação deve conferir fora dos logs que a linha `PRODUCTION_DB_CONTAINER_EXPECTED=<nome Docker exato, sem barra inicial>` no arquivo legado protegido identifica o único container PostgreSQL autorizado; nome Compose, service, hostname, alias, prefixo e ID não são aceitos. O arquivo permanece `root:root`, modo `600`, e nenhuma correção deve registrar o valor no repositório ou nos logs.

A correção consulta `docker ps -aq --no-trunc` com filtro de nome integral ancorado, exige cardinalidade um e só então inspeciona essa identidade. Diagnósticos sanitizados distinguem `expected_container_input_missing`, `expected_container_missing`, `expected_container_name_mismatch`, `expected_container_not_running`, `expected_container_unhealthy`, `expected_container_ambiguous` e `docker_inspect_failed`, sem imprimir nome, ID, URL ou env. A identidade completa permanece apenas em memória, é revalidada imediatamente antes de `docker exec -i ... pg_dump`, e alteração TOCTOU bloqueia o dump. Não há descoberta de “primeiro PostgreSQL”, `docker compose exec db`, fallback, start/restart/recreate, Recovery, cutover, migration, seed, backfill ou sincronização. Dump/manifesto atômicos, rollback do par anterior, freshness e preflight permanecem obrigatórios.

A alteração e as regressões são locais; produção não foi acessada nem modificada. Estados: `PRODUCTION_BACKUP_PREPARATION=NOT_PROVEN_ON_FIXED_HEAD`, `ERP_PRODUCTION_RECOVERY_WORKFLOW=NOT_EXECUTED`, `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING` e `READY_FOR_1_0B_2_O=NO`.

## Alvo validado do dump de Recovery — correção do run 32521442639 (21/08/2026)

A evidência operacional autoritativa do [run 32521442639](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/32521442639), [job 96894273835](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/32521442639/job/96894273835), aprovou a fonte `legacy_read_only`, os contratos de diretório e paths, o par anterior ausente, `DATABASE_URL`, container PostgreSQL, network, volume, mount, disco, lock e `PRODUCTION_BACKUP_SOURCE_VALIDATED=PASS`. Em seguida, `docker compose exec -T db pg_dump ...` falhou com `service "db" is not running`, em `BACKUP_FAILURE_STAGE=dump` / `BACKUP_FAILURE_COMMAND=create_validated_dump` / exit 1. O Compose produtivo possui apenas `api` e `web`; a causa raiz comprovada é o dump ter ignorado o PostgreSQL externo já validado em `PRODUCTION_DB_CONTAINER_EXPECTED` e mirado o serviço Compose inexistente `db`. Nenhum backup foi criado ou promovido, e Recovery não foi executado.

A correção captura no inventário a identidade completa do nome exato configurado, exige estado running e health `healthy` quando há healthcheck e preserva os gates de network, volume e mount. Imediatamente antes do dump, ela reconsulta o mesmo alvo, falha fechada se ausente, ambíguo, substituído, parado ou unhealthy, emite somente `PRODUCTION_BACKUP_DUMP_TARGET=VALIDATED_CONTAINER` e `PRODUCTION_BACKUP_DB_IDENTITY_REVALIDATED=PASS`, e executa `pg_dump` diretamente e de modo não interativo via `docker exec -i` no nome configurado. O ID completo não é impresso. Depois do conteúdo validado, permanece `PRODUCTION_BACKUP_DUMP=PASS`; gzip, manifesto, promoção atômica, freshness e preflight final permanecem na ordem existente. O preparador não cria, inicia, reinicia ou recria PostgreSQL.

Esta correção e seus testes são locais: não acessaram produção nem executaram workflow produtivo, Recovery, cutover, migration/schema apply, seed, backfill ou sincronização ERP. Portanto, não constituem sucesso produtivo: `PRODUCTION_BACKUP_PREPARATION=NOT_PROVEN_ON_FIXED_HEAD`, `ERP_PRODUCTION_RECOVERY_WORKFLOW=NOT_EXECUTED`, `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `ERP_SYNC_ENV_PERSISTENCE=NOT_PROVEN`, `ERP_SCHEDULER_INITIALIZED=NOT_PROVEN`, `ERP_NEXT_RUN_AT=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING` e `READY_FOR_1_0B_2_O=NO`.

## Rebinding source-aware dos paths históricos do backup de Recovery (21/08/2026)

O **Prepare Production Recovery Backup** no merge SHA `ab1fc586a22ae0a2669ac32a86ffce900c28850d` selecionou `legacy_read_only` e falhou no estágio `historical_path_contract` ([run 32494585462](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/32494585462), job `96809885927`), antes de dump, promoção, Recovery ou cutover. O fluxo versionado confirma a incompatibilidade sem expor os valores: ele ainda exigia dos paths históricos os basenames aprovados e um parent comum, embora o diretório autorizado já devesse determinar sozinho o destino.

A política corrigida é source-aware. `PRODUCTION_BACKUP_AUTHORIZED_DIRECTORY` é a única autoridade (com `PRODUCTION_BACKUP_AUTHORIZED_DIR` apenas como alias e `/root/backups` como default) e sempre deriva `production.sql.gz` e `production.sql.gz.sha256`. Na fonte `canonical`, paths históricos presentes permanecem assertions estritas e devem coincidir com o par derivado, sem fallback. Em `legacy_read_only`, são hints deprecated opcionais: valores presentes passam somente pelas verificações sintáticas fail-closed de não vazio, absoluto, ausência de controle/quebra de linha e traversal; parent e basename antigos são aceitos, seguidos por rebinding obrigatório e pelo marcador sanitizado `PRODUCTION_BACKUP_HISTORICAL_PATH_POLICY=REBOUND_LEGACY_READ_ONLY`. Nenhum hint histórico participa de leitura, escrita, remoção ou promoção.

A alteração e suas regressões são exclusivamente locais: a fonte legada permanece byte a byte intacta, o canônico não é criado e não houve acesso à produção, dump, promoção, Recovery, cutover, migration, schema apply, seed, backfill ou recriação de containers. A sincronização automática segue `NOT_PROVEN`; também permanecem `ERP_SYNC_ENV_PERSISTENCE=NOT_PROVEN`, `ERP_SCHEDULER_INITIALIZED=NOT_PROVEN`, `ERP_NEXT_RUN_AT=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING` e `READY_FOR_1_0B_2_O=NO`.

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

# Backup operacional (Gest-o)

O script `backup.sh` gera backups do PostgreSQL em formato **`.sql.gz`** com validação defensiva de conteúdo.

## O que o script valida antes de aceitar backup

Antes de considerar o backup válido, o script consulta contagens reais no banco (`db` do `docker compose`) e aplica regras:

1. `User` **não pode** estar zerada.
2. `Client`, `Opportunity` e `TimelineEvent` **não podem** estar todas zeradas ao mesmo tempo.
3. O dump SQL precisa ter tamanho mínimo (`MIN_SIZE_BYTES`, padrão 50 KB).

Se qualquer regra falhar:

- o backup é rejeitado;
- o arquivo inválido é removido automaticamente;
- o motivo da rejeição é registrado no log com timestamp.

## Logs

Arquivo de log padrão:

- `/root/backups/backup.log`

O log inclui:

- contagens usadas na validação (`User`, `Client`, `Opportunity`, `TimelineEvent`);
- motivo objetivo da rejeição;
- nome do arquivo rejeitado/removido;
- sucesso de criação e rotação dos backups válidos.

## Rotação

A rotação mantém os **48 backups válidos mais recentes** (`*.sql.gz`).

Importante:

- a rotação roda somente após um backup válido ser finalizado;
- um backup inválido **não** dispara limpeza que possa afetar backups bons recentes.

## Execução manual

```bash
./backup.sh
```

Pré-requisitos esperados no ambiente da VPS:

- `docker compose` funcional;
- serviço `db` ativo;
- acesso ao banco `salesforce_pro` com usuário `postgres` dentro do container.

## Correção do contrato de `docker inspect` do backup de Recovery (25/08/2026)

O diagnóstico sanitizado executado na VPS, com o mesmo usuário do workflow, comprovou: CLI Docker disponível, probe do daemon com exit 0 e stderr vazio, consulta ancorada pelo nome exato com exit 0/cardinalidade 1/stderr vazio, seguida de `docker inspect` com exit 1, stdout vazio e stderr classificado como `template_error`. Portanto, daemon, permissão, nome e cardinalidade estão operacionais; a causa comprovada é o template Go anterior, sanitizado como `docker inspect -f '{{.Name}}{{"\\t"}}{{.Id}}{{"\\t"}}{{.State.Running}}{{"\\t"}}{{if .State.Health}}{{.State.Health.Status}}{{end}}' <identidade-em-memória>`, que agregava acesso a campos e delimitadores em uma única avaliação de template.

A correção remove esse template da inspeção de identidade: `docker inspect <identidade-em-memória>` fornece o JSON nativo, validado como array unitário por parser estrito antes de extrair nome, ID completo, `State.Running` e health. Ausência/nulo de `State.Health` é a única aceitação de container sem healthcheck; healthcheck presente exige `healthy`. Falhas são classificadas, sem stderr bruto, como `template_error`, `object_not_found`, `permission_denied`, `daemon_unreachable` ou `malformed_inspect_output`. Permanecem inalterados nome exato e cardinalidade unitária, identidade completa somente em memória, revalidação TOCTOU imediatamente antes de `docker exec -i "$PRODUCTION_DB_CONTAINER_EXPECTED" pg_dump ...`, redaction e todos os gates posteriores.

Esta correção e suas regressões são locais. Nenhum workflow produtivo, backup, promoção produtiva, Recovery, cutover, migration, seed, backfill, sincronização, alteração de env protegido ou recriação de container foi executado; produção não foi acessada. `READY_TO_MERGE_DATABASE_INSPECT_TEMPLATE_FIX=NO`; `PRODUCTION_BACKUP_PREPARATION=NOT_PROVEN`; `ERP_PRODUCTION_RECOVERY_WORKFLOW=NOT_EXECUTED`; `ERP_AUTOMATIC_SYNC=NOT_PROVEN`; `INC_ERP_5050=INVESTIGATING`; `READY_FOR_1_0B_2_O=NO`; `PRODUCTION_ACCESSED=NO`.
