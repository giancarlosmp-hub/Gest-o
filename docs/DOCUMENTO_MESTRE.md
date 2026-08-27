## INC-ERP-5050 — contrato do endpoint protegido (run 33024714232)

O ERP Production Recovery do run `33024714232`, job `98363243593`, aprovou preflight, sete gates, recriação/saúde da API, login, token e identidade. A primeira falha foi `protected_endpoint_http`: HTTP **403**, após identidade autenticada com role `vendedor`, ao chamar `GET /erp/ultrafv3/sync/status`, protegido por Bearer e RBAC `diretor|gerente`. Scheduler e `nextRunAt` não foram avaliados; portanto a hipótese de corrida não é causal nesse run. O rollback terminou e `ERP_ROLLBACK_API_HEALTH=PASS`, restaurando a API anterior saudável.

A correção não reduz RBAC: o Recovery passa a consultar `GET /erp/ultrafv3/scheduler/status`, fonte canônica registrada pela aplicação para estado do scheduler, ainda protegida por `authMiddleware` e `authorize("diretor", "gerente")`. O contrato dedicado agora fornece `initialized`, `enabled`, `enabledByEnv`, `configurationOk`, `authMode` e `nextRunAt`; o validador preserva Bearer, distingue de forma sanitizada 400/401/403/404/405/409/422/outros 4xx, registra somente a role e nunca corpo, token, credenciais, headers ou URL. O segredo de validação deve identificar `diretor` ou `gerente`; não se aceita elevar `vendedor` nem tornar a rota pública. Nenhum Recovery/cutover/sync foi executado nesta correção. `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING`, `READY_TO_MERGE_PROTECTED_ENDPOINT_FIX=NO` até checks remotos verdes e `READY_FOR_1_0B_2_O=NO`.

## INC-ERP-5050 — rollback em `authenticated_validation` (run 33023119827)

O job `98358069745` aprovou o preflight, validou a imagem esperada `67c49052a92a52ef5a8581b838ca9116158510df` antes do cutover e iniciou a nova API com o env reconciliado (`ERP_SYNC_SCHEDULER_ENABLED=true`). A saúde e a identidade do runtime são gates anteriores à validação autenticada. O processo opaco que agrupava login, token, identidade, endpoint protegido, scheduler e `nextRunAt` retornou falha sem emitir o predicado interno; portanto a evidência preservada prova como último gate **API saudável/SHA esperado**, mas não permite atribuir retrospectivamente a falha a um subgate específico. `ERP_NEXT_RUN_AT=not_proven` foi emitido antes do cutover como estado inicial e não é prova causal.

O call graph real é: Recovery → commit do env → recriação exclusiva da API → health → SHA/restart/instância → login → token → `/auth/me` → status ERP protegido/schema → scheduler initialized/enabled/configuração/auth mode → `nextRunAt` → prova automática → persistência do env/lock; qualquer reprovação após a mutação percorre o rollback fail-closed. Há uma corrida comprovada no código: o listener torna `/health` saudável antes de `startErpSyncScheduler()` assíncrono terminar. A correção limita repetição somente à convergência autenticada/bootstrap, com timeout e categorias sanitizadas; HTTP/contrato/autorização/configuração reais continuam falhando.

O rollback concluiu e restaurou a imagem e o env anteriores; `ERP_ROLLBACK_API_HEALTH=PASS`. Produção está no estado anterior saudável. Nenhum workflow produtivo foi executado nesta correção local. Estados: `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING`, `READY_TO_MERGE_AUTHENTICATED_VALIDATION_FIX=NO` até checks remotos verdes e `READY_FOR_1_0B_2_O=NO`.

## Correção da identidade peer do backup produtivo (26/08/2026)

## Deploy Production — correção do call graph real (run 33020006633)

O **Deploy Production** `phase=build` do run **33020006633**, job **98347796478**, executou a `main` no SHA completo `84f32ca2d32846ab9966cd4ea5f6560bb75b12fc`. Esse SHA contém como ancestral a correção anterior `0cfdab43ef37db895936ccfca6049deabae3e343`, mas o run voltou a falhar em `run_deploy_script`, no `production-preflight`, com `backup_path_mismatch`. Logo, a tentativa anterior estava presente, porém não corrigiu o call graph do Deploy: ela derivava o par canônico apenas para compará-lo com `PRODUCTION_BACKUP_FILE` e `PRODUCTION_BACKUP_SHA256_FILE` históricos carregados depois pelo overlay `legacy_copy`, tratando hints como assertions e rejeitando-os. O último par canônico existia no helper; o primeiro retorno aos paths históricos era o `source "$ENV_FILE"` em `deploy-production.sh`, e não havia novo rebinding antes da chamada real.

Call graph comprovado: workflow `Deploy Production` → `appleboy/ssh-action` → script SSH em `/apps/gest-o` → fetch/switch/pull `main` → `/apps/gest-o/scripts/production-deploy-entrypoint.sh` → `scripts/deploy-production.sh` → resolução do env/overlay legado → `source "$ENV_FILE"` → `erp-production-env-preflight.sh` → `/apps/gest-o/scripts/production-preflight.sh`. A correção faz o preflight real carregar o helper pelo diretório absoluto derivado do próprio script e, depois de todo carregamento legado e imediatamente antes das validações, substituir os hints pelo único par derivado do diretório autorizado. Os checkpoints sanitizados registram origem no checkout, resolução, override dos hints e validação do par, sem paths. Diretório inválido, traversal/normalização, symlink, SHA/manifesto inválido, stale em cutover e TOCTOU continuam fail-closed.

A regressão executável agora entra pelo mesmo `production-deploy-entrypoint.sh`, percorre o `deploy-production.sh` real, carrega paths históricos divergentes, alcança o `production-preflight.sh` real e exige o par canônico validado sem `backup_path_mismatch`; o modo é exclusivamente build e os comandos Docker são mocks que rejeitam efeitos de cutover/containers. Neste run o build não começou, Recovery não foi executado e produção não foi modificada. Esta correção é somente local e não dispara workflows produtivos. Estados: `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING`, `READY_FOR_1_0B_2_O=NO` e `READY_TO_MERGE_REAL_DEPLOY_FIX=NO` até checks remotos verdes.


## INC-ERP-5050 — falso `backup_stale` no Recovery nº 4 (2026-08-26)

Evidência confirmada: o **Prepare Production Recovery Backup nº 16** terminou verde em `main` e, aproximadamente um minuto depois, o **ERP Production Recovery nº 4** (run `33010209868`, job `98314206477`) aceitou o SHA esperado, mas parou no preflight com `backup_stale`. O rollback de preflight foi concluído antes de qualquer mutação. O backup nº 17 também terminou verde; o Recovery não foi repetido e produção não foi modificada. `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING` e `READY_FOR_1_0B_2_O=NO`.

Diagnóstico dos call graphs: o preparador derivava e promovia o par canônico `<authorized-directory>/production.sql.gz` + `.sha256`, ignorando como destino os hints do env legado, e calculava freshness pelo `mtime` do dump promovido em epoch segundos. O Recovery nº 4 carregou `ERP_ENV_SOURCE=legacy_copy`; o preflight recebia diretamente `PRODUCTION_BACKUP_FILE` e `PRODUCTION_BACKUP_SHA256_FILE` desse env e, portanto, avaliou o `mtime` de outro arquivo histórico. Não houve erro de operador, SHA, PostgreSQL, timezone ou idade real: houve divergência de seleção entre o par promovido e o path legado lido.

A correção fail-closed centraliza no helper comum a derivação do par pelo diretório autorizado, valida arquivo regular/não-symlink, manifesto de uma linha e SHA-256, captura identidade/tamanho/mtime antes e depois do hash contra troca TOCTOU, e calcula idade como `now_epoch_seconds - dump_mtime_epoch_seconds`. Timestamp futuro, milissegundos, inválido, ausente, stale, path divergente ou troca do arquivo falham. Preparador e Recovery agora usam o mesmo helper e emitem somente checkpoints sanitizados de par, fonte do timestamp, idade e limite; nenhum path, ID ou secret é registrado. O Recovery continua bloqueado antes da primeira mutação e não deve ser executado até a PR corretiva ter checks remotos verdes e aprovação.


No novo run pós-merge relatado pelo operador, cujos identificadores de **run e job não foram incluídos no relato recebido**, o workflow **Prepare Production Recovery Backup** aprovou `PRODUCTION_BACKUP_DB_CONTAINER_STATUS=validated`, `PRODUCTION_BACKUP_DB_CONTAINER=PASS`, `PRODUCTION_BACKUP_DB_NETWORK=PASS`, `PRODUCTION_BACKUP_DB_VOLUME=PASS`, `PRODUCTION_BACKUP_DB_MOUNT=PASS` e `PRODUCTION_BACKUP_SOURCE_VALIDATED=PASS`. Depois falhou em `BACKUP_FAILURE_STAGE=dump` / `BACKUP_FAILURE_COMMAND=create_validated_dump`: o PostgreSQL rejeitou `psql` no socket local com `Peer authentication failed for user "postgres"`. A evidência confirma que o container correto foi selecionado, mas o processo Linux usado por `docker exec` não era `postgres`.

O call graph confirmado é workflow → `prepare-production-recovery-backup.sh` → `backup_validate_database_health_in_validated_container` → `backup_validate_database_health` → `check-prod-health.sh` → `query_count` → `docker exec ... psql`; depois da saúde, revalidação TOCTOU → `docker exec ... pg_dump`. A correção valida fail-closed, antes da primeira consulta, que o usuário Linux fixo `postgres` existe e pode ser selecionado sem UID 0, e usa `docker exec --user postgres -i` tanto para `psql` quanto para `pg_dump`. Os diagnósticos sanitizados distinguem usuário ausente, seleção de usuário, falha peer, falha de `psql` e falha de `pg_dump`, sem stderr bruto, identidade, nome configurável, URL, credencial ou path protegido.

O run relatado não criou nem promoveu backup. Recovery não foi executado e esta correção é apenas local: produção não foi acessada nem modificada e nenhum workflow produtivo foi disparado. Gzip, manifesto, promoção atômica, preflight e exit code real continuam preservados. `ERP_PRODUCTION_RECOVERY_WORKFLOW=NOT_EXECUTED`, `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING` e `READY_FOR_1_0B_2_O=NO`.

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

## Correção do preflight legado do ERP Production Recovery — run 31736308709 (13/08/2026)

A tentativa 2 do [run 31736308709](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31736308709), [job 94572767335](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31736308709/job/94572767335), executada no SHA `7005ddf65add085c53f8e80a0fcb9e4aee6017a1`, comprovou `AUTH_TEST_EMAIL`/`AUTH_TEST_PASSWORD` disponíveis, API saudável com cardinalidade 1 e restart count 0, AppConfig `enabled` e lock `free`. A fonte autorizada foi `legacy_copy`; o candidato reconciliava somente o scheduler e falhou no preflight antes de `environment_commit` e `api_recreate`. O rollback terminou (`COMPLETED`), nenhum env produtivo foi alterado e nenhum container foi recriado. A causa atual não são as credenciais do CRM.

A correção propõe a política explícita `recovery_legacy`: ela preserva a fonte e toda configuração empresarial, cria candidato temporário protegido e reconcilia exclusivamente scheduler habilitado e os seis gates produtivos seguros. A primitiva compartilhada mantém `build_legacy` estritamente build-only, com scheduler desabilitado; o candidato de Recovery não é autorizado no deploy normal. Canônico existente continua autoritativo e inválido falha sem fallback legado. O candidato só pode ser instalado depois de todos os preflights e o rollback continua fail-closed, restrito ao env e à API. **O Recovery corrigido ainda não foi executado com sucesso e a sincronização automática permanece não comprovada.**

Estados: `ERP_RECOVERY_AUTH_INPUT=AVAILABLE`; `ERP_RECOVERY_PREFLIGHT=NOT_PROVEN`; `ERP_PRODUCTION_RECOVERY_WORKFLOW=FAILED_PRE_COMMIT`; `PRODUCTION_ENV_MODIFIED=NO`; `CONTAINERS_RECREATED=NO`; `ERP_AUTOMATIC_SYNC=NOT_PROVEN`; `ERP_SYNC_ENV_PERSISTENCE=NOT_PROVEN`; `ERP_SCHEDULER_INITIALIZED=NOT_PROVEN`; `ERP_NEXT_RUN_AT=NOT_PROVEN`; `INC_ERP_5050=INVESTIGATING`; `READY_FOR_1_0B_2_O=NO`.

# Exceção operacional temporária e restrita ao build (13/08/2026)

O run `31707019441` confirmou a circularidade: Deploy Production precisava do canônico ausente para construir `gest-o-api:<SHA>`, enquanto ERP Production Recovery precisava dessa imagem para instalar o canônico e ativar o scheduler. A resolução autorizada é read-only e determinística: canônico válido; se ausente, legado válido somente para `MODE=build`; caso contrário, falha fechada. Presença inválida do canônico proíbe fallback e as fontes nunca são combinadas. `MODE=cutover` e Recovery continuam canonical-only após a instalação controlada. Esta PR não executou produção/recovery; repetir o build depois do merge e manter Recovery pendente.

# Contrato semântico vigente da Saúde ERP — PR #799 (13/08/2026)

A unidade executiva é a execução-pai: `manual/syncAll` ou `scheduler/automatic`. Filhos ligados por
`correlationId` são etapas e não participam das taxas, duração média, retries ou quantidade
executiva. Etapa sem pai não prova sync completa. Vendedor inativo é consultável; ausência de
vendedor e carteira são não instrumentadas no schema atual. Testes locais não são evidência de
automação produtiva, e a 1.0B.2-O permanece bloqueada.

# Prioridade vigente — estabilização da observabilidade ERP (12/08/2026)

Antes da Sprint 1.0B.2-O, a prioridade é reconciliar `ErpSyncRun`, scheduler, API e Saúde. A sync
manual fornecida permanece manual; automática, inicialização e `nextRunAt` não estão comprovados.
A causa local, fontes, estados e rollback estão no [contrato técnico](platform-health-erp-observability.md).
Produção não foi acessada; recovery não foi executado; tenancy permanece disabled.

# Sprint 1.0B.2-K — observação bounded do shadow preview

O contrato adiciona 40 amostras sintéticas (10 ciclos de quatro GET `/clients` concorrentes), com correlação exclusiva por IDs internos retornados, janela de logs limitada e rollback `disabled/false`. Rerun com volume reutilizado não pode contar eventos antigos nem alterar cardinalidades. A amostra curta não comprova estabilidade temporal/produtiva; rate limit, timeout e atraso de logs permanecem riscos. Sem checks reais verdes: `READY_FOR_1_0B_2_K_REVIEW = NO`, `TENANT_READ_PREVIEW_STABILITY = NOT_PROVEN`; sem produção, mutation, backfill ou cutover. Consulte o [Sprint Brief](sprints/SPRINT_1_0B_2_K_PREVIEW_SHADOW_STABILITY.md).

# Sprint 1.0B.2-H — descendentes de Agenda

Após a PR #789 verde, AgendaStop e o canal restrito Activity somente-Agenda possuem prova isolada tenant-scoped. Multi-parent não foi liberado; adapters seguem fora do runtime, sem DDL ou produção.

# Sprint 1.0B.2-E — ownership relacional tenant-scoped aditivo

O estágio E adiciona, sem ligação ao runtime, repositories de Opportunity e Activity cujo ownership
deriva de Client. Activity aceita somente Client XOR Opportunity. Como Prisma não compara com
segurança `Activity.clientId` e `Activity.opportunity.clientId`, todo dual-parent é negado, mesmo se
aparentemente convergente; suporte futuro exige enforcement comprovado no banco. Órfãos,
cross-tenant e `tenantId=NULL` falham fechados. Inventário, matriz e rollback:
[Sprint Brief](sprints/SPRINT_1_0B_2_E_TENANT_RELATIONAL_OWNERSHIP.md).

O gate `test:tenant-relational-ownership` sucede o estágio D no CI. `READY_FOR_TENANT_AWARE_RUNTIME = NO`; `TENANCY_MODE=disabled`; não houve produção.

## Predecessor preservado — Sprint 1.0B.2-D

# Sprint 1.0B.2-D — data access tenant-scoped aditivo

Um piloto isolado de Client prova predicados Prisma A×B; controllers, JWT, jobs, webhooks e
`TENANCY_MODE=disabled` permanecem preservados. A camada não está ativa no runtime. Consulte o
[Sprint Brief](sprints/SPRINT_1_0B_2_D_TENANT_DATA_ACCESS_PROPAGATION.md).

# Sprint 1.0B.2-B — tooling de backfill em desenvolvimento

Plan/dry-run, ledger imutável, batches, hashes, quarentena e reconciliação dos 11 roots foram
preparados com apply exclusivamente sintético. Produção, runtime, backfill e cutover permanecem
inalterados e bloqueados. Consulte o
[Sprint Brief](sprints/SPRINT_1_0B_2_B_BACKFILL_TOOLING_LEDGER.md).
O harness prova exclusão de escopo somente no banco descartável; o arquivo imutável não fornece lock
distribuído produtivo. A 1.0B.2-C permanece dedicada a TenantContext/Auth compatibility, enquanto
ledger/lock produtivo exige decisão operacional futura anterior a qualquer backfill de produção.

# ADENDO HISTÓRICO — segurança de deploy pós-recuperação

> 🔵 Entrega em PR (31/07/2026), sem VPS ou produção. A topologia isolada API/WEB exige identidade do banco recuperado, separa build/preflight do cutover humano, permite rollback dos containers históricos e prova o SHA. O banco recuperado segue vigente até migração formal e o incidente continua aberto. Consulte `DEPLOY_GUIDE.md`.

> Este adendo preserva o estado intermediário de 31/07. O estado vigente após o cutover de 01/08
> está no painel [Estado Atual da Produção](#estado-atual-da-produção).

> O preflight de PostgreSQL deve resolver o hostname interno por um container efêmero na rede `gest-o_default`, nunca pelo DNS do host ou por IP fixo. A imagem `postgres:16` precisa existir localmente e não pode ser baixada automaticamente durante a janela.

---

# Gest-o — Documento Mestre

> **Fonte única de verdade do projeto.** Comece por este documento. Investigações, ADRs e runbooks
> guardam detalhe e evidência, mas o estado oficial, a prioridade e os gates são os registrados aqui.
> Em caso de divergência, corrija este documento na mesma PR da mudança.

## Índice oficial

- [Estado atual](STATUS_ATUAL.md)
- [Operação pós-merge](OPERACAO.md)
- [Guia de deploy](DEPLOY_GUIDE.md)
- [Governança de desenvolvimento](GOVERNANCA_DESENVOLVIMENTO.md)
- [Enterprise Readiness — baseline oficial](ENTERPRISE_READINESS.md)
- [Sprint 0.1 — Auditoria Enterprise](sprints/SPRINT_0_1_ENTERPRISE_READINESS.md)
- [Sprint 0.5 — Validação operacional Enterprise](sprints/SPRINT_0_5_ENTERPRISE_OPERATIONAL_VALIDATION.md)
- [Dívida técnica auditada](TECH_DEBT.md)
- [ADRs](adr/README.md)
- [Sprint 1.0A — Multi-Tenancy Foundation](sprints/SPRINT_1_0A_MULTI_TENANCY_FOUNDATION.md)
- [Threat Model Multi-Tenancy](security/MULTI_TENANCY_THREAT_MODEL.md)
- [Plano da migration expand](tenancy/MIGRATION_EXPAND_PLAN.md)
- [Sprint 1.0B.1 — persistência do control plane](sprints/SPRINT_1_0B_1_CONTROL_PLANE_PERSISTENCE.md)
- [Preparação do control plane](tenancy/CONTROL_PLANE_PREPARATION.md)
- [Sprint 1.0B.1-OP-R2 — operação limpa do control plane](sprints/SPRINT_1_0B_1_OP_R2_CONTROL_PLANE_OPERATION.md)
- [Gate de aprovação para a Sprint 1.0B.2](sprints/SPRINT_1_0B_1_GATE_APPROVAL_FOR_1_0B_2.md)

## ADENDO VIGENTE — GATE DE APROVAÇÃO DA SPRINT 1.0B.2

Em 08/08/2026 foi fornecida a decisão humana explícita
`COMMITTEE_DECISION=APPROVE_1_0B_2_DEVELOPMENT`. Mantidos os gates técnicos certificados,
`READY_FOR_1_0B_2_DEVELOPMENT = YES`; a autorização limita-se ao primeiro estágio EXPAND,
incremental, nullable, sem backfill e com runtime disabled. `READY_FOR_MULTI_TENANT_CUTOVER = NO`.
**DEVELOPMENT APPROVED ≠ PRODUCTION CUTOVER APPROVED.**

## ADENDO VIGENTE — SPRINT 1.0B.1-OP-EXEC

A execução operacional do control plane default-only foi concluída no SHA
`36be802887a005431dc5e1d9f4f7129d2145f102`, conforme evidência produtiva fornecida e preservada;
esta conclusão não foi inferida do Git. A migration `20260802120000_tenancy_control_plane` ficou
`APPLIED_ONCE` e depois foi revalidada como `ALREADY_APPLIED`, sem reaplicação. O tenant
`tenant-default-v1` e 8 memberships foram preparados e reconciliados com PASS e hash coincidente.
As autoridades temporárias e regras HBA foram removidas. O runtime permaneceu
`DATABASE_SCHEMA_MODE=external` e `TENANCY_MODE=disabled`; não houve cutover, segundo tenant ou
ativação multiempresa. Na conclusão da OP-EXEC, a Sprint 1.0B.2 ainda não havia sido iniciada.

### Lições operacionais comprovadas

1. **`docker exec` + stdin.** **PROBLEMA:** faltava `-i` em caminhos com `psql -f -`, heredoc ou
   stdin. **EFEITO:** SQL não chegava ao container, observado na fixture PostgreSQL e no catálogo do
   preview. **DIAGNÓSTICO:** execução direta com `-i` produziu o catálogo esperado. **CORREÇÃO:**
   conectar stdin explicitamente. **PREVENÇÃO:** exigir `-i` e regressão em todo caminho dependente
   de stdin.
2. **`process.argv`.** **PROBLEMA:** o parser processava `process.argv` inteiro. **EFEITO:** `node` e
   o entrypoint viravam argumentos inválidos. **DIAGNÓSTICO:** a falha incluía os dois argumentos do
   processo. **CORREÇÃO:** `process.argv.slice(2)`. **PREVENÇÃO:** parser puro e testes unitários de
   aceitação/rejeição.
3. **Ownership de bind mount.** **PROBLEMA:** o container gravava evidência com UID diferente do
   runner. **EFEITO:** o host não lia `dry-run-result.tsv`. **DIAGNÓSTICO:** owner do artefato
   divergia. **CORREÇÃO:** `--user HOST_UID:HOST_GID`. **PREVENÇÃO:** validar owner e mode.
4. **Idempotência e evidência.** **PROBLEMA:** a segunda tentativa exigia artefatos de dry-run e
   removia `result.tsv`. **EFEITO:** o contrato idempotente invalidava evidência PASS anterior.
   **DIAGNÓSTICO:** attempt-2 dependia indevidamente de attempt-1. **CORREÇÃO:** contratos próprios
   para attempt-1/attempt-2 e PASS anterior imutável. **PREVENÇÃO:** testar reaplicação e
   imutabilidade separadamente.
5. **Dependência `rg`.** **PROBLEMA:** o harness pressupunha ripgrep. **EFEITO:** runner sem a
   ferramenta falhava. **DIAGNÓSTICO:** dependência ambiental não declarada. **CORREÇÃO:** `grep`
   POSIX/GNU disponível. **PREVENÇÃO:** não exigir ferramenta sem garanti-la no ambiente.
6. **FK e `pg_constraint` `"char"`.** **PROBLEMA:** `confdeltype`/`confupdtype` internos causavam
   ambiguidade na concatenação. **EFEITO:** consulta de validação falhava. **DIAGNÓSTICO:** tipos
   internos incompatíveis. **CORREÇÃO:** casts explícitos e representação semântica canônica.
   **PREVENÇÃO:** normalizar tipos internos antes de comparar/concatenar.
7. **Validação de FK.** **PROBLEMA:** `pg_get_constraintdef` textual era autoridade frágil.
   **EFEITO:** formatação podia causar falso resultado. **DIAGNÓSTICO:** texto não expressava contrato
   estável. **CORREÇÃO:** validar `pg_constraint`, `conkey`/`confkey`, origem/destino, ações e
   `validated`. **PREVENÇÃO:** preferir semântica de catálogo a texto renderizado.
8. **TSV.** **PROBLEMA:** transporte do catálogo permitia interpretação ambígua. **EFEITO:** campos
   podiam ser lidos incorretamente. **DIAGNÓSTICO:** formato do `psql` e aridade não estavam
   fechados. **CORREÇÃO:** `--no-align`, `--tuples-only`, TAB explícito, pager off e parser de
   exatamente quatro campos. **PREVENÇÃO:** validar framing e aridade.
9. **`incident_*` no pre-diff.** **PROBLEMA:** oito `DROP TABLE` forenses conhecidos pareciam drift
   destrutivo. **EFEITO:** preview bloqueava incorretamente. **DIAGNÓSTICO:** raw era tratado como
   managed. **CORREÇÃO:** `schema-diff-filter.mjs` como autoridade. **PREVENÇÃO:** preservar raw e
   decidir somente pelo managed diff filtrado.
10. **`incident_*` no post-diff.** **PROBLEMA:** o mesmo ruído afetava o pós-apply. **EFEITO:** PASS
    poderia ser negado após DDL válida. **DIAGNÓSTICO:** faltava o filtro no modo post.
    **CORREÇÃO:** raw preservado e managed filtrado antes do PASS. **PREVENÇÃO:** aplicar a mesma
    autoridade nos dois lados.
11. **Separação de autoridades.** **PROBLEMA:** misturar autoridades amplia privilégio e auditoria.
    **EFEITO:** runtime ou leitura poderiam ganhar escrita indevida. **DIAGNÓSTICO:** DDL, dry-run,
    preparação e runtime têm necessidades distintas. **CORREÇÃO:** administrativa para DDL,
    read-only para dry-run, DML temporária mínima para preparação e `gesto_app` para runtime.
    **PREVENÇÃO:** nunca misturar essas autoridades.
12. **`pg_hba.conf`.** **PROBLEMA:** criar role não garante conexão. **EFEITO:** grants corretos
    ainda eram rejeitados; SSL estava off e a rede Docker só admitia `gesto_app`. **DIAGNÓSTICO:**
    `pg_hba_file_rules` mostrou rejects. **CORREÇÃO:** regras temporárias específicas, depois
    removidas. **PREVENÇÃO:** validar HBA antes de atribuir falha a Prisma/grants.
13. **Connection limit.** **PROBLEMA:** `Promise.all` excedeu o limite 2 da role read-only.
    **EFEITO:** `too many connections for role`. **DIAGNÓSTICO:** teste concorrente abriu conexões
    demais. **CORREÇÃO:** teste sequencial/`connection_limit=1` no client. **PREVENÇÃO:** adaptar o
    teste ao menor privilégio, sem ampliar a role.
14. **`.env`/`source`.** **PROBLEMA:** URL com `&` era carregada como shell. **EFEITO:** caracteres
    especiais eram interpretados como código. **DIAGNÓSTICO:** `source arquivo.env` violava a
    fronteira dado/código. **CORREÇÃO:** ler com `sed`/`awk` ou parser de env. **PREVENÇÃO:** nunca
    tratar segredo/configuração como código shell.
15. **Falha de execução não é ausência.** **PROBLEMA:** catálogo vazio por falha de stdin parecia
    zero objetos. **EFEITO:** falso `ABSENT_COMPATIBLE`. **DIAGNÓSTICO:** consulta direta provou os
    objetos. **CORREÇÃO:** `CATALOG_QUERY_FAILED`. **PREVENÇÃO:** reservar `ABSENT_COMPATIBLE`
    exclusivamente à ausência real comprovada.

## ADENDO DA SPRINT 0.5 — CERTIFICAÇÃO OPERACIONAL

A rotina oficial de certificação de uma instalação é `scripts/production-health-validation.sh`,
descrita em [`OPERACAO.md`](OPERACAO.md). Ela coleta evidência por SHA sem consultar ou alterar o
banco e sem executar publicação ou recuperação. A existência do validador no Git não comprova sua
execução nem muda o estado conhecido da produção; promoção depende de `result.tsv` PASS revisado
no host autorizado. O estágio desta entrega permanece 🔵 PR.

## ADENDO DA SPRINT 1.0A — DECISÃO E CONTROL PLANE

A [ADR 003](adr/003-shared-schema-tenant-boundary.md) foi aceita em 02/08/2026 pelo Comitê
registrado por papéis, condicionada a contexto fail-closed, data access tenant-required, expansão
progressiva, constraints compostas, RLS defensiva e provas A×B. A entrega adiciona somente contratos
e testes default-only; não altera schema, banco, deploy ou produção e não habilita outra empresa.
Multiempresa continua 🔴 até o roadmap 1.0B–1.0F e a evidência operacional. O threat model, RACI e
gates estão no [Brief 1.0A](sprints/SPRINT_1_0A_MULTI_TENANCY_FOUNDATION.md).

## ADENDO DA SPRINT 1.0B.1 — PERSISTÊNCIA DEFAULT-ONLY

Esta entrega em 🔵 PR persiste o control plane e prepara um único tenant default por runner
explícito, transacional e reconciliável. Não aplicou migration em produção, não executou deploy e
não altera models empresariais, autenticação ou handlers. O runtime legado continua single-tenant e
Multiempresa permanece 🔴 até os gates das etapas seguintes.

## 1. RESUMO EXECUTIVO

| Campo | Estado oficial em 02/08/2026 |
|---|---|
| **Versão atual** | Documento Mestre **4.0**; última revisão operacional conhecida `a08a62670c4940322ce037d0c86c54959db32f71` |
| **Último commit em produção** | Cutover local comprovado para `a08a62670c4940322ce037d0c86c54959db32f71`; confirmação pública por `/health/version` e `build-info.json` permanece não comprovada caso as saídas não tenham sido preservadas. |
| **Última PR mesclada** | **#763**, merge `a08a626` em 01/08/2026, como revisão operacional do cutover; a baseline documental está na PR #765. |
| **Sprint atual** | **Estabilização, identidade UltraFV3 e verificabilidade de produção** |
| **Status do sistema** | Produção funcionalmente validada após cutover; **🟡 Atenção** permanece para estabilidade prolongada, restore, P0 de segurança e incidentes ainda não encerrados. |
| **Última atualização** | 02/08/2026 |
| **Responsável** | **Não designado no repositório**; até designação formal, o responsável por cada deploy/PR deve atualizar este documento. |

**Leitura em cinco minutos:** schema e cutover local foram concluídos para `a08a626`; novos
containers iniciaram e o usuário validou login, navegação, sincronização, presença do 5050 e Saúde da
Plataforma. Isso comprova recuperação funcional, não certificação Enterprise nem encerramento dos
incidentes. Persistem confirmação pública por SHA, estabilidade prolongada, restore e P0 de segurança.

## ESTADO ATUAL DA PRODUÇÃO

> **Painel fixo de rastreabilidade.** Atualizar após toda publicação ou tentativa de publicação.
> Nenhum valor pode ser inferido do Git local: preencher somente com evidência obtida pelo
> [`OPERACAO.md`](OPERACAO.md). Enquanto não houver evidência, manter “Não comprovado”.

| Campo | Estado comprovado |
|---|---|
| **Versão implantada** | **Não comprovada.** A versão declarada no repositório é `1.0.0`, mas ainda precisa ser conferida no runtime. |
| **Commit implantado** | Cutover local associado a `a08a62670c4940322ce037d0c86c54959db32f71`; falta consolidar prova pública por `/health/version` e `build-info.json`, caso não preservada. |
| **Último deploy** | 01/08/2026: schema aplicado, cutover local concluído e containers API/WEB iniciados. Horário UTC e operador não constam desta reconciliação. |
| **Última PR publicada** | Revisão operacional conhecida da PR #763 (`a08a626`); publicação pública por SHA ainda requer evidência técnica preservada. |
| **Última PR apenas mesclada** | PR #764 (`e2a41a7`) no histórico local; publicação não inferida. PR #765 segue em 🔵 PR. |
| **Última PR aguardando deploy** | PR #765, exclusivamente documental; seu merge/deploy não é inferido. |
| **Última validação operacional** | Usuário confirmou CRM, login, navegação, sync de clientes, ERP 5050 e Saúde da Plataforma; estabilidade prolongada, restore e prova pública completa por SHA permanecem pendentes. |

Uma mesma PR pode aparecer como “apenas mesclada” e “aguardando deploy”: ela só sai desses campos
quando a publicação for comprovada. Depois do deploy, mas antes dos testes, seu estágio é
**🟠 Deploy**; somente após toda a REGRA 001 ela pode constar como **🟢 Produção**.

## 2. ONDE PARAMOS

| Pergunta | Resposta oficial |
|---|---|
| **Última funcionalidade concluída** | Dashboard Saúde da Plataforma, mesclado na PR **#749** (`2f9cfd2`), com visão operacional de saúde e auditoria. |
| **Última funcionalidade parcialmente concluída** | Correção do matching de identidade UltraFV3 para filiais 5050×4484: regra, regressões A–H, auditoria de escritores e monitoramento foram implementados; a validação com filiais independentes ainda não terminou. |
| **Próxima funcionalidade** | Convergência **Activity First**, inicialmente apenas inventário dos contratos legados, plano de migração e testes de não regressão. Implementação só começa depois dos gates abaixo. |
| **Bloqueadores** | (1) preservar confirmação pública de SHA de API/WEB; (2) homologar 5050×4484 incluindo 4484 e perfis; (3) produzir veredito do ERP 5050; (4) provar restore e revisar hardening; (5) corrigir TD-ER-001 e TD-ER-002. |
| **Decisões tomadas** | Documento completo e código exato são identidades fortes; nome+cidade+UF só é fallback sem documento e sem código conflitante; documentos completos distintos nunca são mesclados; integrações passam pelo backend; atividades são a direção da agenda; deploy nunca reseta dados; evidências precedem saneamento. |

### Não iniciar antes de concluir os bloqueadores

- outbound ou automações de WhatsApp, Facebook ou Instagram;
- novo chat/RAG, expansão da IA Comercial ou automação baseada em IA;
- novos domínios de Financeiro, Fretes ou ERP futuro;
- aplicativo, tenancy, marketplace ou plataforma multiempresa;
- saneamento destrutivo dos clientes 5050/4484 ou merges em massa;
- implementação Activity First além do planejamento e dos testes de compatibilidade.

## 3. FUNCIONALIDADES

### Estágios oficiais de entrega

Esta classificação registra **até onde uma entrega comprovadamente avançou**. Ela não substitui o
status funcional da tabela abaixo: um módulo pode estar operacional enquanto uma nova alteração
desse módulo ainda está em Codex, PR, Merge ou Deploy.

| Status | Significado |
|---|---|
| 🟣 **Codex** | Apenas desenvolvido; ainda não há Pull Request criada. |
| 🔵 **PR** | Pull Request criada, em revisão ou aguardando merge. |
| 🟡 **Merge** | Mesclado no GitHub, ainda sem publicação comprovada na VPS. |
| 🟠 **Deploy** | Publicado na VPS, ainda sem validação completa em produção. |
| 🟢 **Produção** | Deploy, operação, health checks e smoke tests validados em produção. |

Os estágios são progressivos e baseados em evidência. **“Pronto” sem deploy e validação nunca
significa Produção.** Por exemplo, uma entrega mesclada, mas ainda não validada na VPS, permanece
em **🟡 Merge**, e não em **🟢 Produção**. A promoção para Produção obedece obrigatoriamente à
[REGRA 001](#regra-001--encerramento-obrigatório-do-ciclo-da-pull-request).

Os únicos status válidos nesta tabela são **Não iniciado**, **Em desenvolvimento**, **Em
homologação**, **Em produção** e **Pausado**. “Em produção” descreve disponibilidade conhecida, não
elimina dívida ou próximos passos. `—` significa que não há commit/PR específico comprovado no
registro atual; nunca preencher por suposição.

| Módulo | Status | Dependências | Último commit | Última PR | Próximo passo |
|---|---|---|---|---|---|
| CRM | Em produção | PostgreSQL, API, autenticação, UltraFV3 | `fdfce21` (referência do repo; revisão de produção a confirmar) | #750 | Fechar incidentes e regressões antes de ampliar o núcleo. |
| UltraFV3 | Em homologação | Credenciais ERP, identidade, auditoria, banco e scheduler | `03cba5e` | #748 | Executar A–H, confirmar 5050 e 4484 independentes e reconciliar perfis. |
| Dashboard Comercial | Em produção | CRM, oportunidades, metas e vendas | Não catalogado | Não catalogada | Registrar revisão implantada e executar smoke do fluxo comercial. |
| Dashboard Saúde | Em produção | API de saúde, métricas, auditoria e permissões | `2f9cfd2` | #749 | Validar dados reais e definir SLOs sem expandir escopo. |
| IA Comercial | Em desenvolvimento | Provider/Ollama, permissões, capacidade e governança | Não catalogado | Não catalogada | Manter pausada a expansão até aprovar provider, limites e segurança. |
| Base Conhecimento IA | Em desenvolvimento | IA Comercial, documentos, curadoria e autorização | `fdfce21` (estado documental) | #750 | Definir curadoria, acesso e qualidade antes de RAG novo. |
| Categorias IA | Não iniciado | Base de Conhecimento IA e modelo de governança | — | — | Especificar somente após concluir os gates da IA. |
| WhatsApp | Em desenvolvimento | Fundação omnichannel, Meta, tenancy, retenção e observabilidade | Não catalogado | Não catalogada | Homologar inbound; não iniciar outbound. |
| Meta WhatsApp | Em homologação | App Meta, webhook, segredos e checklist de go-live | Não catalogado | Não catalogada | Concluir gate de produção e validação operacional inbound. |
| Facebook | Não iniciado | Fundação omnichannel e aprovação de canal | — | — | Não iniciar antes dos bloqueadores e gates de segurança. |
| Instagram | Não iniciado | Fundação omnichannel e aprovação de canal | — | — | Não iniciar antes dos bloqueadores e gates de segurança. |
| Activity First | Pausado | Inventário legado, migração compatível e testes | Não catalogado | Não catalogada | Preparar inventário/plano; aguardar gates para implementar. |
| Financeiro | Em desenvolvimento | UltraFV3, identidade confiável e reconciliação | Não catalogado | Não catalogada | Estabilizar perfis/títulos atuais; não ampliar domínio. |
| Fretes | Não iniciado | Contrato de domínio e fonte de verdade ERP | — | — | Manter no backlog até estabilização do ciclo ERP. |
| Aplicativo | Não iniciado | APIs estáveis, autenticação e prioridades móveis | — | — | Validar caso de negócio após a fundação atual. |
| ERP futuro | Não iniciado | Ciclo UltraFV3 estável, contratos, idempotência e auditoria | — | — | Definir fonte de verdade por domínio, sem implementação agora. |

## 4. INCIDENTES

**Regra:** o incidente **5050×4484 permanece EM HOMOLOGAÇÃO enquanto qualquer filial esperada
continuar ausente**, ainda que os testes de código estejam verdes.

| ID | Título | Status | Critérios para encerramento | Evidências | Último teste |
|---|---|---|---|---|---|
| INC-5050-4484 | Merge indevido de filiais UltraFV3 5050 e 4484 | **EM HOMOLOGAÇÃO** | Revisão implantada confirmada; casos A–H aprovados; 5050 e 4484 presentes com IDs, códigos e documentos próprios; perfis financeiros reconciliados; nenhuma filial ausente; métricas/logs preservados sem PII. | [Investigação 5050×4484](investigations/ultrafv3-partner-identity-5050-4484.md), ADR 001 e auditoria `Client.code` | Sincronização aprovada e 5050 presente; ainda faltam comprovação de 4484, perfis, A–H completos e demais evidências formais. |
| INC-ERP-5050 | Arquivamento/ausência de clientes associado ao ERP 5050 | **INVESTIGANDO** | Evidência read-only correlacionada com revisão, runtime e `ErpSyncRun`; causa/veredito revisável; correção validada; documentação e monitoramento atualizados. | [Análise forense](investigations/erp-5050-forensic-analysis.md) e [runbook](runbooks/erp-5050-forensic.md) | Recuperação funcional comprovada: sync aprovado e 5050 presente; causa raiz/veredito formal continuam pendentes. |
| INC-PROD-2026-07 | Comprometimento e recuperação do PostgreSQL de produção | **CORRIGIDO — AGUARDANDO ENCERRAMENTO** | Backup restaurável exercitado, hardening revisado, revisão implantada registrada e monitoramento sem recorrência; então mover para Encerrado. | [Recuperação](incidents/2026-07-19-final-recovery-runbook.md) e [reconciliação](incidents/2026-07-17-prod-recovery-reconciliation.md) | Schema/cutover e validação funcional concluídos sem relato de perda; estabilidade prolongada e restore isolado pendentes. |

Fluxo permitido: **ABERTO → INVESTIGANDO → CORRIGIDO → HOMOLOGANDO → ENCERRADO**. Um incidente só é
encerrado com critérios satisfeitos, evidências ligadas, data/resultado do último teste registrados
e cumprimento da [REGRA 002](#regra-002--encerramento-de-incidentes).

## 5. PRÓXIMA SPRINT

1. Corrigir TD-ER-001 e TD-ER-002 na primeira Sprint de implementação após esta baseline.
2. Homologar a identidade UltraFV3 com os casos A–H e uma sincronização controlada, sem saneamento destrutivo.
3. Confirmar que 5050 e 4484 existem como filiais independentes e reconciliar seus perfis financeiros.
4. Correlacionar a coleta forense com `ErpSyncRun` e publicar o veredito do incidente ERP 5050.
5. Restaurar um dump validado por SHA256 em ambiente isolado e registrar o resultado.
6. Revisar hardening e acessos mínimos da VPS/PostgreSQL.
7. Inventariar contratos legados de agenda/atividade e aprovar o plano Activity First com testes de não regressão.

## 6. BACKLOG

### P0 — impede avanço seguro
- Corrigir TD-ER-001 (`/debug/admin`) e TD-ER-002 (logs sensíveis de login).
- Homologar e encerrar 5050×4484 sem filiais ausentes.
- Confirmar revisão/topologia de produção e concluir o veredito ERP 5050.
- Exercitar restauração de backup e revisar hardening do VPS.

### P1 — próximo após P0
- Planejar e executar a convergência Activity First com compatibilidade.
- Completar ciclo comercial UltraFV3 com idempotência, auditoria e reconciliação.
- Governar IA Comercial/Base de Conhecimento antes de novo RAG.
- Levar Meta WhatsApp inbound pelo gate de produção.

### P2 — expansão condicionada
- Categorias IA; Inbox e outbound WhatsApp governados.
- Financeiro completo e Fretes, após contrato/fonte de verdade aprovados.
- Facebook e Instagram após maturidade omnichannel.

### P3 — estratégico
- Aplicativo, ERP futuro ampliado, tenancy/multiempresa, marketplace e ecossistema.

## 7. PROCEDIMENTOS VPS

> Execute os comandos exatos dos runbooks ligados; este checklist é o gate oficial. Nunca exiba
> segredos, nunca use reset destrutivo e nunca trate nome de container como prova de destino.

### Checklist oficial de deploy
- [ ] Identificar responsável, janela, PR/commit candidato e plano de rollback.
- [ ] Confirmar acesso, espaço em disco, saúde atual, containers, rede, volumes e database destino.
- [ ] Criar backup lógico pelo usuário local `postgres`, validar o dump e registrar SHA256 fora do volume alterado.
- [ ] Confirmar que segredos estão somente no ambiente e preservar o volume PostgreSQL oficial.
- [ ] Revisar migrations; aplicar apenas o fluxo versionado e não destrutivo.
- [ ] Publicar a imagem/commit aprovado conforme [deploy de produção](deploy-production.md).
- [ ] Registrar horário, operador, commit, imagem, containers e resultado no registro operacional/PR.

### Checklist oficial pós-deploy
- [ ] Verificar endpoint de saúde, frontend, login e logs sem erro crítico.
- [ ] Confirmar commit/build efetivo, conexão sanitizada, database, rede, volume e migrations aplicadas.
- [ ] Executar smokes de API e fluxos críticos (CRM, oportunidade e integração afetada).
- [ ] Quando UltraFV3 for afetado, validar A–H e métricas antes de sincronização ampla.
- [ ] Confirmar integridade/contagens, ausência de escrita destrutiva e preservação de filiais.
- [ ] Atualizar este documento, `STATUS_ATUAL.md`, incidente e evidências com resultado e horário.
- [ ] Monitorar durante a janela acordada; só então declarar deploy concluído.

### Checklist oficial de rollback
- [ ] Interromper novas escritas/schedulers afetados e registrar motivo/horário.
- [ ] Preservar logs, manifestos, hashes e estado atual antes de qualquer reversão.
- [ ] Reimplantar a última imagem **comprovadamente saudável**; não usar apenas “a anterior” por nome.
- [ ] Não reverter migration destrutivamente; restaurar banco somente por decisão explícita e ensaio isolado.
- [ ] Se restauração for necessária, validar dump/SHA256, restaurar primeiro isoladamente e conferir integridade.
- [ ] Reexecutar todo o checklist pós-deploy e registrar o resultado do rollback.
- [ ] Abrir/atualizar incidente e manter o sistema em atenção até cumprir critérios de encerramento.

## 8. COMO CONTINUAR O PROJETO

1. Leia as seções 1–6 e não comece item marcado como bloqueado.
2. Confirme `git status`, branch e `git log`; nunca confunda o `HEAD` local com produção.
3. Leia o [README](../README.md), a [arquitetura](architecture/README.md), o ADR aplicável e o runbook da operação.
4. Escolha o primeiro P0 sem responsável; registre escopo, aceite, risco, dependências e evidências esperadas.
5. Para produção, descubra a topologia real antes de agir. A referência conhecida é API
   `gest-o-api-recovery-20260718` → rede `gest-o_default` → PostgreSQL
   `gest-o-db-clean-v2-20260717` → database `salesforce_pro`.
6. Faça mudanças mínimas e compatíveis. Integrações externas ficam no backend; segredos não entram
   no Git; dados/documentos completos não entram em logs.
7. Rode testes do módulo e smokes críticos. Alterações de identidade UltraFV3 exigem os casos A–H;
   alterações de deploy exigem backup e rollback ensaiáveis.
8. Atualize, na mesma PR, a linha do módulo, incidentes, próxima sprint, changelog (se grande entrega),
   `STATUS_ATUAL.md` e documentos especializados. Documentação faz parte da Definition of Done.
9. Na entrega, informe commit/PR, evidências, limitações e próximo passo. Não marque concluído sem
   aceite objetivo; hipótese não vira fato.

### Regras permanentes
- O Documento Mestre governa estado e prioridade; ADR governa o porquê; runbook governa execução;
  investigação guarda hipótese/evidência; arquitetura governa limites técnicos.
- Backups administrativos usam `docker exec -u postgres`, `psql -U postgres` e `pg_dump -U postgres`
  com autenticação peer; não dependem de `POSTGRES_USER`, `POSTGRES_PASSWORD` ou `DATABASE_URL`.
- Dados reais, código do repositório e revisão implantada são fontes distintas e devem ser correlacionadas.

### REGRA 001 — encerramento obrigatório do ciclo da Pull Request

Nenhuma Pull Request poderá ser considerada concluída até que **todas** as etapas abaixo estejam
concluídas:

- [ ] Merge realizado.
- [ ] Deploy realizado.
- [ ] [`OPERACAO.md`](OPERACAO.md) executado.
- [ ] Health check aprovado.
- [ ] Smoke tests aprovados.
- [ ] Produção validada.
- [ ] `STATUS_ATUAL.md` atualizado.
- [ ] Documento Mestre atualizado.
- [ ] Incidente atualizado, quando aplicável.

Somente após todos esses itens a funcionalidade poderá receber o estágio **🟢 Produção**. Até lá,
deve permanecer no último estágio objetivamente comprovado da tabela de estágios oficiais de
entrega, mesmo que o desenvolvimento e o merge já tenham terminado.

A descrição da PR ou o registro operacional deve declarar explicitamente a evidência de cada item.
“Não aplicável” é aceito somente para incidente, com justificativa. A revisão do `STATUS_ATUAL.md`,
do Documento Mestre, da seção **NEXT_SPRINT** e do **CHANGELOG Executivo** nunca pode ser omitida;
quando não houver mudança, registrar expressamente “revisado, sem alteração necessária”.

### REGRA 002 — encerramento de incidentes

Nenhum incidente poderá ser encerrado enquanto existir qualquer teste funcional pendente em
produção.

A existência de código corrigido, teste local aprovado, Pull Request criada ou PR mesclada não é
evidência suficiente. O encerramento depende de validação operacional no ambiente de produção, com
resultado, data e evidências registrados no incidente.

Se a correção estiver mesclada ou implantada, mas o teste funcional em produção ainda estiver
pendente, o incidente deve permanecer em **CORRIGIDO** ou **HOMOLOGANDO**, conforme o estágio
comprovado. Somente a validação completa permite **ENCERRADO**.

### REGRA 003 — início obrigatório de Sprint

Toda Sprint começa obrigatoriamente lendo, nesta ordem:

1. [`STATUS_ATUAL.md`](STATUS_ATUAL.md) — retomada operacional e alertas imediatos;
2. **Documento Mestre** — estado oficial, decisões, prioridades e gates;
3. **Incidentes abertos** — seção [Incidentes](#4-incidentes) e respectivas evidências;
4. **Última PR publicada** — identificada no painel [Estado Atual da Produção](#estado-atual-da-produção), com evidência operacional;
5. **Backlog P0** — seção [Backlog](#6-backlog), antes de escolher qualquer novo desenvolvimento.

Somente depois dessa leitura e da confirmação de que as informações continuam válidas pode começar
novo desenvolvimento. Itens incompletos devem ser encerrados ou transportados explicitamente, e a
seção Próxima Sprint deve registrar objetivo, ordem e critérios verificáveis. Conversas antigas não
substituem essa sequência.

## 9. CHANGELOG EXECUTIVO

- **02/08/2026 — Sprint 0.4 em 🔵 PR:** preparação read-only separa explicitamente merge, deploy
  oficial, validação de TD-ER-001/002 por SHA, estabilidade e restore autorizado descartável. Os
  merges #766/#767 não comprovam publicação; nenhum restore, débito ou incidente foi encerrado.

- **02/08/2026 — Sprint 0.3 em 🔵 PR:** ensaio sintético e isolado de restore em PostgreSQL 16,
  checksum, catálogo, pós-condições e evidência metadatal, com RPO/RTO apenas propostos. Não houve
  restore real; `INC-PROD-2026-07` e `TD-ER-003` permanecem abertos até validação operacional.

- **02/08/2026 — Sprint 0.2 em 🔵 PR:** remove `/debug/admin` e minimiza logs de autenticação.
  TD-ER-001/002 seguem abertos até merge, deploy e validação por SHA; não há inferência de produção
  nem declaração de Segurança/LGPD resolvidas.

| Data | Grande entrega |
|---|---|
| 02/08/2026 | Sprint 0.4 prepara evidência sanitizada pós-deploy e comando de restore autorizado separado, sem VPS, deploy, restore real ou mudança de classificação. |
| 02/08/2026 | Sprint 0.3 cria ensaio descartável de recuperação e CI sintético, sem VPS ou produção; continuidade, restore real e RPO/RTO aprovados continuam não comprovados. |
| 02/08/2026 | Baseline reconciliada com a operação de 01/08: schema aplicado, pós-diff gerenciado vazio, oito `incident_*` preservadas, cutover local em `a08a626` e validação funcional de login, sync, 5050 e Saúde; prova pública completa por SHA, estabilidade, restore, P0 e encerramento de incidentes permanecem pendentes. |
| 02/08/2026 | Baseline oficial de Enterprise Readiness e Sprint 0.1 criadas em 🔵 PR, com 17 dimensões e backlog baseado em evidências; auditoria exclusivamente documental/read-only, sem alteração ou declaração sobre produção e sem encerramento de incidentes. |
| 01/08/2026 | Governança de desenvolvimento institucionalizada: Comitê de Arquitetura, Sprint Brief, ciclo de ADR, Enterprise Readiness, revisão, testes, rollback e Definition of Done consolidados em norma permanente, sem alteração de runtime ou produção. |
| 01/08/2026 | Diagnóstico confirmou evidência de schema íntegra e Prisma equivalente; allowlist operacional incompleta foi o único bloqueio. Produção e containers antigos preservados, sem deploy ou cutover; correção em 🔵 PR e cutover pendente. |
| 01/08/2026 | Schema aplicado/validado e evidência revalidada para `c178a69e`; segundo ensaio parou antes de containers por ausência da imagem histórica da API. Produção antiga preservada, cutover pendente e rollback híbrido em 🔵 PR; incidente aberto. |
| 01/08/2026 | Schema apply permanece pendente: a tentativa controlada foi bloqueada com segurança, antes de qualquer SQL, pela incompatibilidade da URI Prisma com `psql`; correção operacional em PR, produção e tabelas `incident_*` preservadas e cutover ainda bloqueado. |
| 31/07/2026 | Criado o painel fixo Estado Atual da Produção e instituídas as REGRA 002 (incidentes) e REGRA 003 (início de Sprint). |
| 31/07/2026 | Instituída a REGRA 001 para fechamento obrigatório do ciclo pós-merge e a escala Codex → PR → Merge → Deploy → Produção. |
| 31/07/2026 | Documento Mestre 4.0 convertido em fonte única operacional, com estado, gates, backlog e procedimentos VPS; criado resumo `STATUS_ATUAL.md`. |
| 30/07/2026 | Dashboard Saúde da Plataforma entregue (PR #749). |
| 30/07/2026 | Observabilidade/auditoria da identidade UltraFV3 e trilha de `Client.code` entregues (PR #748). |
| 30/07/2026 | Regra segura de identidade 5050×4484 consolidada, com regressões A–H e ADR. |
| 17–19/07/2026 | Produção recuperada em PostgreSQL limpo, órfãos reconciliados e FKs restauradas. |
| 21/07/2026 | Fundação omnichannel segura congelada com gates explícitos de evolução. |

O histórico detalhado anterior foi preservado integralmente em
[`historico/documento-mestre-v3.md`](historico/documento-mestre-v3.md); commits e PRs continuam no Git.

## 10. DOCUMENTOS IMPORTANTES

| Documento | Função |
|---|---|
| **Documento Mestre** | [Fonte única de estado, prioridade e continuidade](DOCUMENTO_MESTRE.md) |
| **Status Atual** | [Resumo operacional de uma página](STATUS_ATUAL.md) |
| **Operação pós-merge** | [Checklist obrigatório da REGRA 001](OPERACAO.md) |
| **Guia de deploy** | [Arquitetura, deploy, validação e rollback](DEPLOY_GUIDE.md) |
| **Governança de desenvolvimento** | [Comitê de Arquitetura, Sprint Brief, decisões e Definition of Done](GOVERNANCA_DESENVOLVIMENTO.md) |
| **Enterprise Readiness** | [Baseline oficial baseada em evidências](ENTERPRISE_READINESS.md) |
| **Sprint 0.1** | [Brief da Auditoria Enterprise](sprints/SPRINT_0_1_ENTERPRISE_READINESS.md) |
| **Sprint 0.3** | [Brief de backup e restore isolado](sprints/SPRINT_0_3_BACKUP_RESTORE_READINESS.md) |
| **Prontidão de restore** | [Diagnóstico, procedimento, evidências e RPO/RTO propostos](ops/backup-restore-readiness.md) |
| **Dívida técnica** | [Achados priorizados da auditoria](TECH_DEBT.md) |
| **Roadmap** | [Horizontes estratégicos](roadmap/README.md) |
| **Dashboard Saúde** | [Estado e operação do módulo](dashboard-saude-plataforma.md) |
| **Arquitetura** | [Limites e topologia técnica](architecture/README.md) |
| **ADR** | [Índice de decisões arquiteturais](adr/README.md) |
| **Investigação UltraFV3** | [Identidade 5050×4484](investigations/ultrafv3-partner-identity-5050-4484.md) e [fluxo ERP→CRM](investigations/investigacao-erp-5050-fluxo-completo.md) |

### Governança desta fonte

- Atualizar a data, o responsável, “Onde paramos”, módulos, incidentes e `STATUS_ATUAL.md` em toda PR relevante.
- Registrar somente grandes entregas no changelog; o Git preserva o detalhe.
- Não apagar histórico: mover versões substituídas para `docs/historico/` e ligar a partir daqui.
- Revisar links e fatos a cada deploy. Campos não comprovados permanecem explicitamente “não comprovado”.

## Adendo — gate obrigatório de schema (31/07/2026)

O deploy permanece bloqueado até revisão e execução separada do schema apply. Produção não deve
executar `prisma db push`; o primeiro cutover usa somente a migration aditiva versionada, preserva
todas as `incident_*` e exige evidência por SHA antes do cutover. As imagens de `a2daeb5...` foram
construídas, não publicadas, e o banco recuperado continua preservado. Não houve deploy nesta mudança
e INC-5050-4484 permanece em homologação. Processo e riscos estão na
[auditoria de transição](investigations/production-schema-transition-july-2026.md).

## Decisão permanente: autoridade runtime × migration (01/08/2026)

A tentativa controlada no SHA `6041ddac...` falhou com segurança no primeiro `CREATE TYPE`: a role
runtime não possui `CREATE` em `public`. Nada persistiu, nenhuma migration ou cutover ocorreu e as
oito `incident_*` foram preservadas. O apply passa a manter `DATABASE_URL` para Prisma e leituras,
usando `docker exec --user postgres` no container PostgreSQL já validado somente durante a migration
transacional e verificações administrativas mínimas. É proibido conceder DDL ao runtime, trocar
owners ou expor credenciais/portas. O estágio continua 🔵 PR, com schema pendente e incidente aberto.
Veja [ADR 002](adr/002-runtime-migration-authority-separation.md) e a
[auditoria](investigations/production-schema-transition-july-2026.md).
# Adendo 4.1 — Sprint 0.6: arquitetura oficial para Multi-Tenancy

Em 02/08/2026, a auditoria documental da Sprint 0.6 concluiu que o Gest-o permanece single-tenant.
Dos 27 models Prisma, somente os quatro de Communications carregam `tenantId` parcial; não existe
entidade `Tenant`, membership, contexto autenticado, repository, RLS ou isolamento completo de
consultas, caches, jobs, logs, JWT e UltraFV3. A comercialização como multiempresa continua
bloqueada.

O inventário, riscos, estratégia expand/backfill/contract, compatibilidade, rollout, rollback e
roadmap 1.0A–1.0F estão em [`TENANCY_ASSESSMENT.md`](TENANCY_ASSESSMENT.md). A
[ADR 003](adr/003-shared-schema-tenant-boundary.md) propõe schema PostgreSQL compartilhado com
isolamento por linha, `Tenant`/memberships, chaves compostas, data-access obrigatório e RLS
defensiva. Ela deve ser aceita pelo Comitê antes da Sprint 1.0.

Este adendo não implementa tenancy, não cria migration, não altera APIs/banco/regras, não executa
Docker/deploy e não presume produção. Incidentes e débitos mantêm seus estados vigentes.

## Decisão arquitetural — expand de roots da 1.0B.2

A primeira onda de ownership empresarial abrange Client, AgendaEvent, Product, AppConfig, Goal, ActivityKPI, Sale, SellerTerritoryCity, KnowledgeDocument, ErpSyncRun e ErpSyncLock. O campo `tenantId` nasce nullable e sem default: NULL significa exclusivamente “registro ainda não migrado”. Uniques globais são preservados até a fase constrain; backfill ocorre em subfase separada e não existe fallback automático para `tenant-default-v1`.

### Lições comprovadas do harness PostgreSQL da fase expand

A execução descartável da 1.0B.2-A comprovou dois guardrails operacionais. Primeiro, heredoc enviado
por `docker exec` sem `-i` não conectava o stdin do host ao `psql`: o processo recebia EOF, não
executava as fixtures e ainda podia encerrar com sucesso. O diagnóstico objetivo foi a ausência de
`incident_synthetic` no primeiro count. A correção usa `docker exec -i`, `psql -X` e
`ON_ERROR_STOP=1`; a prevenção obrigatória é validar cada fixture imediatamente antes de produzir
baseline ou aplicar migration.

Segundo, o harness dependia de `rg`, ferramenta não garantida no runner, e falhou no post-diff com
exit 127. A contagem foi substituída por `grep -Fxc`. Harnesses operacionais devem usar ferramentas
garantidas pelo ambiente ou declarar e provisionar explicitamente suas dependências.

`public."incident_synthetic"` é uma fixture exclusivamente sintética e descartável. A prova valida
existência, coluna `id`, tipo `integer`, `NOT NULL`, primary key e count antes e depois da migration,
na ordem **create → verify → baseline → apply → preserve**. Essa evidência é apenas de PostgreSQL 16
em CI: a migration continua exclusivamente aditiva e não foi aplicada em produção por esta PR. Não
houve backfill, runtime tenant-aware, deploy ou cutover; `TENANCY_MODE=disabled` e
`READY_FOR_MULTI_TENANT_CUTOVER = NO` permanecem invariantes.
# Atualização 1.0B.2-C — TenantContext/Auth compatibility (08/08/2026)

A fundação fail-closed de TenantContext foi consolidada apenas como scaffolding backend testável.
Tokens, RBAC por `User.role`, handlers e consultas atuais permanecem inalterados, e membership role
não ganhou autoridade produtiva. A entrega não acessou produção nem executou deploy/backfill/cutover;
`TENANCY_MODE=disabled` e os gates de multiempresa continuam fechados. Detalhes no
[Sprint Brief](sprints/SPRINT_1_0B_2_C_TENANT_CONTEXT_AUTH_COMPATIBILITY.md).

## Decisão técnica 1.0B.2-F — Activity dual-parent

Uma prova isolada recomenda unique `Opportunity(id, clientId)` e FK composta nullable de Activity. Ela demonstra enforcement atômico de writes sem alterar a política XOR produtiva. `NOT VALID` permite instalação após diagnóstico, mas não valida conflitos históricos; migration e ativação runtime exigem Sprint/autorização futuras. Consulte o [plano](tenancy/ACTIVITY_DUAL_PARENT_ENFORCEMENT_PLAN.md).

## Decisão técnica 1.0B.2-G — Agenda e Timeline

AgendaEvent autoriza exatamente uma fonte entre tenant direto, Client e Opportunity; TimelineEvent, exatamente uma entre Client e Opportunity. Múltiplos pais são negados porque o Prisma não compara fontes irmãs com segurança. Seller não é ownership e root scoped não autoriza includes. Os adapters são provas isoladas, não runtime.

### 1.0B.2-I — primeiro adapter no runtime, sob gate

A listagem autenticada de Client mantém resposta legada e pode executar somente count shadow em test/preview autorizado. Produção fixa ambos os gates desligados; demais endpoints permanecem legados. A operação e limitações estão no Sprint Brief 1.0B.2-I.

### Marco 1.0B.2-J
O preview possui contrato sintético determinístico e gate seed → validate → enable → GET `/clients` → MATCH. Isso não autoriza produção, mutations, backfill ou cutover.
# Adendo 1.0B.2-L — readiness não é autorização

O [preflight de dados](tenancy/TENANT_DATA_READINESS_PREFLIGHT.md) acrescenta diagnóstico injetável/read-only dos 11 roots e control plane. Mesmo `READY` permite somente discutir planejamento; não autoriza backfill, runtime ou produção. Estado inicial: `TENANT_DATA_READINESS_PREFLIGHT = NOT_PROVEN` e `PRODUCTION_ACCESSED = NO`.
# Sprint 1.0B.2-M — plano de backfill gated

O contrato aditivo transforma somente evidência preflight READY válida em plano determinístico dos 11 roots. `evidenceHash`/`planHash` são inseparáveis; blockers, quarentena, expiração, replay conflitante ou envelope incompleto bloqueiam. Plano é dry-run only e não autoriza apply. A evidência executada é sintética, produção não foi acessada e runtime/cutover permanecem desabilitados.
# Sprint 1.0B.2-N — registry/ledger PostgreSQL descartável

A prova candidata persiste somente IDs, versões, hashes, estados e timestamps, com funções
transacionais, grants mínimos e append-only. Resolve na prova a lacuna distribuída de B/M, sem criar
migration ou adapter produtivo e sem autorizar backfill/apply. Consulte
[PREFLIGHT_PLAN_LEDGER](tenancy/PREFLIGHT_PLAN_LEDGER.md).

**Evidência real:** no head `029fab54d32413d0e94308227c0ae591144b7ee7` da PR #796, Preview
Deploy 31432019343 e Docker Compose CI 31432019733/job 93597451158 passaram. O compose-smoke
comprovou build, typecheck, API health, smokes, tenancy expand, planejamento condicionado e o step
`Prove preflight evidence and plan ledger on PostgreSQL 16`. Assim,
`READY_FOR_1_0B_2_N_REVIEW = YES` e `PREFLIGHT_PLAN_LEDGER_POSTGRES = PASS`, sem converter a prova
descartável em migration, apply, backfill ou autorização produtiva.
# Invariante arquitetural do ambiente ERP produtivo

Configuração produtiva sensível não pode depender do checkout. O único caminho canônico é
`/root/demetra-env/.env`, externo ao Git, com owner `root:root` e mode `600`; qualquer fonte legado
autorizada é preservada e copiada, nunca movida. O contrato deve ser validado antes de build ou
cutover, e o scheduler produtivo não pode ter default implícito: seu gate precisa ser literalmente
`true` no arquivo protegido.

Checks de pull request não comprovam o estado da VPS. A prova do scheduler exige uma execução real,
posterior à recriação, persistida com `trigger=scheduler`, término bem-sucedido e lock liberado. Quando
não houver SSH direto, a recuperação deve usar um canal aprovado, auditável e fail-closed; para este
incidente, esse canal é o workflow manual **ERP Production Recovery**, protegido pelo environment
`production-cutover`. A existência do workflow não resolve o incidente: `INC_ERP_5050` permanece
`INVESTIGATING` até a prova automática produtiva.

Variáveis transitórias exportadas por uma sessão de deploy não constituem configuração persistente.
Todo workflow operacional independente deve reconstruir deterministicamente `APP_COMMIT` e
`API_IMAGE` a partir do SHA aprovado, `APP_VERSION` do checkout, `APP_BUILT_AT` da sessão corrente e
`WEB_IMAGE` do único container WEB real. Credenciais de validação pertencem ao canal protegido do
environment GitHub, não ao env empresarial. CI verde comprova esse contrato versionado, nunca a sua
execução produtiva.

O contrato histórico de deploy em duas fases não é redesenhado por esta exceção. A recuperação ERP
permanece isolada: consome a imagem já criada pelo build oficial, recria somente a API e preserva a
identidade da WEB, do PostgreSQL e de seus volumes.
# Falha pré-deploy do run 31713219051 (13/08/2026)

Após o fast-forward comprovado `3c068fa..443be81`, o único comando executável entre o pull e a
entrada no deploy era a comparação silenciosa por `test`, que retornou status 1 sem registrar seus
operandos. Portanto a PR #800 não foi reprovada pelo resolver: ele não foi iniciado. O workflow usa
agora um entrypoint fail-closed que registra fetch, switch, fast-forward, formato/igualdade dos SHAs,
worktree, presença e início do script; falhas expõem apenas estágio, comando lógico e exit code.
`deploy-production.sh` anuncia entrada, modo e início da resolução. A política canônico/legado da
PR #800 permanece integral e o ERP Production Recovery permanece pendente e não executado.
# Correção operacional isolada — legacy_build_only (13/08/2026)

O Deploy Production run `31720219813`, job `94515047904`, executou o SHA
`a3f900b05cbbcc2ab9ee8bba306c4a2cea524d97`: os gates Git/checkout/worktree/entrypoint, o resolver
`legacy_build_only` e `ERP_SYNC_SCHEDULER_ENABLED=false` passaram; o preflight bloqueou em
`TENANCY_MODE does not match the production policy`. Nenhuma imagem, container, restauração,
cutover ou alteração produtiva ocorreu.

Para romper o ciclo build→Recovery sem promover o legado a canônico, apenas o build legado cria
overlay efêmero protegido com os sete gates seguros. A fonte fica read-only e tem identidade
SHA-256 conferida antes/depois; conteúdo e hashes não são logados. Canônico existente permanece
autoritativo/fail-closed, cutover permanece canonical-only e Recovery permanece inalterado. Um novo
`phase=build` só deve ocorrer depois do merge e de todos os checks verdes.

# Contrato de frescor do backup por fase (13/08/2026)

`build` produz exclusivamente as imagens API/WEB enquanto os containers atuais seguem atendendo;
ele não é cutover. O preflight recebe modo explícito e falha fechado se ausente ou inválido. Em
ambos os modos, backup e manifesto precisam existir e o `sha256sum -c` já adotado precisa validar o
arquivo — este é o significado real da prova de integridade, sem uma nova política de checksum.
Apenas `build` dispensa frescor. `cutover` conserva integralmente o limite
`PRODUCTION_BACKUP_MAX_AGE_SECONDS`, e backup antigo o bloqueia antes de efeitos mutáveis.

Essa separação não muda resolver canônico/`legacy_build_only`, overlay efêmero, cutover
canonical-only, deploy em duas fases, Prisma/migrations ou Recovery. Recovery ainda exige imagem
aprovada e suas próprias precondições. O run `31723282307` não alterou produção; build verde não
prova scheduler, sincronização automática, persistência do env ou próximo agendamento.

## Correção do contrato de `docker inspect` do backup de Recovery (25/08/2026)

O diagnóstico sanitizado executado na VPS, com o mesmo usuário do workflow, comprovou: CLI Docker disponível, probe do daemon com exit 0 e stderr vazio, consulta ancorada pelo nome exato com exit 0/cardinalidade 1/stderr vazio, seguida de `docker inspect` com exit 1, stdout vazio e stderr classificado como `template_error`. Portanto, daemon, permissão, nome e cardinalidade estão operacionais; a causa comprovada é o template Go anterior, sanitizado como `docker inspect -f '{{.Name}}{{"\\t"}}{{.Id}}{{"\\t"}}{{.State.Running}}{{"\\t"}}{{if .State.Health}}{{.State.Health.Status}}{{end}}' <identidade-em-memória>`, que agregava acesso a campos e delimitadores em uma única avaliação de template.

A correção remove esse template da inspeção de identidade: `docker inspect <identidade-em-memória>` fornece o JSON nativo, validado como array unitário por parser estrito antes de extrair nome, ID completo, `State.Running` e health. Ausência/nulo de `State.Health` é a única aceitação de container sem healthcheck; healthcheck presente exige `healthy`. Falhas são classificadas, sem stderr bruto, como `template_error`, `object_not_found`, `permission_denied`, `daemon_unreachable` ou `malformed_inspect_output`. Permanecem inalterados nome exato e cardinalidade unitária, identidade completa somente em memória, revalidação TOCTOU imediatamente antes de `docker exec -i "$PRODUCTION_DB_CONTAINER_EXPECTED" pg_dump ...`, redaction e todos os gates posteriores.

Esta correção e suas regressões são locais. Nenhum workflow produtivo, backup, promoção produtiva, Recovery, cutover, migration, seed, backfill, sincronização, alteração de env protegido ou recriação de container foi executado; produção não foi acessada. `READY_TO_MERGE_DATABASE_INSPECT_TEMPLATE_FIX=NO`; `PRODUCTION_BACKUP_PREPARATION=NOT_PROVEN`; `ERP_PRODUCTION_RECOVERY_WORKFLOW=NOT_EXECUTED`; `ERP_AUTOMATIC_SYNC=NOT_PROVEN`; `INC_ERP_5050=INVESTIGATING`; `READY_FOR_1_0B_2_O=NO`; `PRODUCTION_ACCESSED=NO`.
