> **INC_ERP_5050 — evidência do Recovery 33073915591 / job 98523043769 (2026-08-27).** A identidade autenticada foi comprovada como `diretor`; `AUTH_TEST_EMAIL` e `AUTH_TEST_PASSWORD` estão corrigidos. A falha `protected_endpoint_http` anteriormente registrada como `other_4xx` foi identificada como HTTP **429 da própria API**: o `appUsageRateLimit` compartilhava a chave IP de loopback do probe interno. O rollback foi concluído e a API anterior permaneceu saudável. Scheduler e `nextRunAt` não foram avaliados; `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING` e não se deve repetir Recovery antes desta correção validada.

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

## Correção do contrato de `docker inspect` do backup de Recovery (25/08/2026)

O diagnóstico sanitizado executado na VPS, com o mesmo usuário do workflow, comprovou: CLI Docker disponível, probe do daemon com exit 0 e stderr vazio, consulta ancorada pelo nome exato com exit 0/cardinalidade 1/stderr vazio, seguida de `docker inspect` com exit 1, stdout vazio e stderr classificado como `template_error`. Portanto, daemon, permissão, nome e cardinalidade estão operacionais; a causa comprovada é o template Go anterior, sanitizado como `docker inspect -f '{{.Name}}{{"\\t"}}{{.Id}}{{"\\t"}}{{.State.Running}}{{"\\t"}}{{if .State.Health}}{{.State.Health.Status}}{{end}}' <identidade-em-memória>`, que agregava acesso a campos e delimitadores em uma única avaliação de template.

A correção remove esse template da inspeção de identidade: `docker inspect <identidade-em-memória>` fornece o JSON nativo, validado como array unitário por parser estrito antes de extrair nome, ID completo, `State.Running` e health. Ausência/nulo de `State.Health` é a única aceitação de container sem healthcheck; healthcheck presente exige `healthy`. Falhas são classificadas, sem stderr bruto, como `template_error`, `object_not_found`, `permission_denied`, `daemon_unreachable` ou `malformed_inspect_output`. Permanecem inalterados nome exato e cardinalidade unitária, identidade completa somente em memória, revalidação TOCTOU imediatamente antes de `docker exec -i "$PRODUCTION_DB_CONTAINER_EXPECTED" pg_dump ...`, redaction e todos os gates posteriores.

Esta correção e suas regressões são locais. Nenhum workflow produtivo, backup, promoção produtiva, Recovery, cutover, migration, seed, backfill, sincronização, alteração de env protegido ou recriação de container foi executado; produção não foi acessada. `READY_TO_MERGE_DATABASE_INSPECT_TEMPLATE_FIX=NO`; `PRODUCTION_BACKUP_PREPARATION=NOT_PROVEN`; `ERP_PRODUCTION_RECOVERY_WORKFLOW=NOT_EXECUTED`; `ERP_AUTOMATIC_SYNC=NOT_PROVEN`; `INC_ERP_5050=INVESTIGATING`; `READY_FOR_1_0B_2_O=NO`; `PRODUCTION_ACCESSED=NO`.
