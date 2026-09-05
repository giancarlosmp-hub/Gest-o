## Procedimento canônico de produção (03/09/2026)

Merge e CI verde não implantam produção. Use, nesta ordem: checks verdes da `main`; **Prepare Production Recovery Backup**; **Deploy Production / build**; conferência de SHA e resultado; **Deploy Production / cutover**; aprovação de `production-cutover`; validação de API, WEB, banco read-only e SHA. Build verde significa somente imagens/preflight. `backup_proof_invalid`, prova de schema, Prisma diff, health e SHA são gates fail-closed. Recovery e os workflows **Prepare Canonical Production Environment**, **Production Schema PR827** e **Production tenancy expand roots** nunca são tentativas de desbloqueio. Veja a seção autoritativa “Como implantar o Gest-o em produção” em `DOCUMENTO_MESTRE.md`.

## INC-ERP-5050 — reconciliação read-only após as PRs #826, #849 e #850 (03/09/2026)

O deploy produtivo está saudável no SHA `72edf598933dc3f8f38d16473d054b422da34b8a` (merge da PR #849). A PR #850 está mesclada na `main` no SHA `e83b0a451b9175b24bf96cd2a7fe4f61b8b4b020`, mas esse SHA ainda não foi comprovado em produção; a divergência conhecida é, portanto, a PR #850. O pedido ERP **900135** foi enviado com sucesso por ação manual. Esse fato comprova o caminho manual e a disponibilidade do ERP naquele envio, mas **não** comprova inicialização, disparo ou sucesso da sincronização automática.

A instrumentação `erp-automatic-proof` da PR #826 permanece no call graph real do workflow Recovery e seus testes continuam presentes. Ainda assim, nenhuma evidência operacional posterior fornecida comprova simultaneamente `trigger=scheduler`, execução-pai `scope=automatic` com resultado `SUCCESS`, lock liberado, scheduler inicializado, `nextRunAt` e reachability recente. Não repetir Recovery para investigar: executar primeiro o procedimento GET-only documentado em `docs/investigations/inc-erp-5050-automatic-sync-recurrence-2026-08.md`. Até que todos os predicados sejam observados na mesma coleta: `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING`, `RECOVERY_REQUIRED=NO` (não demonstrado necessário), `READY_FOR_NEXT_SPRINT=NO`.

As PRs antigas #820 e #818 foram superadas, respectivamente, pelas correções mescladas #821 e #819; a #810 foi reconciliada e superada pela #811. Essa avaliação não altera nem encerra automaticamente essas PRs.

# Gate de schema PR827 (legado)

## Gate de origem canônica do cutover

`Deploy Production` com `phase=build` pode resolver `/root/demetra-env/production.env` como
`legacy_build_only`, usando apenas um overlay efêmero e mantendo o legado byte a byte imutável.
`phase=cutover` nunca aceita essa classe: requer `/root/demetra-env/.env`, regular, não-symlink,
`root:root`, modo `600` e com o contrato produtivo válido.

Se o canônico estiver ausente, use exclusivamente o workflow manual **Prepare Canonical
Production Environment** e a confirmação `PREPARE_CANONICAL_PRODUCTION_ENV`. A promoção preserva
valores e o arquivo legado de rollback, compara o conjunto de nomes de chaves, valida somente
presença e formatos sanitizados e publica por temporário + `fsync` + rename. Não há cutover nesse
workflow. Somente considere uma tentativa separada depois de `READY_FOR_CUTOVER=YES`; canônico
ausente ou inválido permanece bloqueio.

Para mudanças exclusivamente no runner: `merge → CI/main verde → preview`; imagem API e backup não são gates do preview read-only. Permanecem obrigatórios no apply/cutover, junto do SHA idêntico, aprovação e `APPLY_PR827_SCHEMA`. O runner usa o histórico protegido `applied.tsv`, valida a transição de julho como baseline e não cria `_prisma_migrations` nem exige `tenancy_expand_roots`.

> **INC-ERP-5050 — expiração da prova automática (run `33085223211`, job `98562960884`).** O Recovery aprovou backup/preflight, cutover, recriação e saúde da API, login, autorização, endpoint protegido, inicialização do scheduler e presença de `nextRunAt`. A janela bounded de `automatic_proof` expirou após 90 minutos; o rollback fail-closed foi concluído com `ERP_ROLLBACK_API_HEALTH=PASS`, restaurando a API anterior saudável. A evidência disponível não distingue ausência de trigger de uma execução `FAILED`/`RUNNING`, porque a consulta anterior só promovia `SUCCESS` e descartava o estado observado. Também capturava o baseline depois do cutover e não verificava matematicamente se `nextRunAt` cabia nos 5.400 segundos. Portanto a causa comprovada é uma lacuna do contrato de prova; A–H permanecem não atribuíveis sem os novos marcadores sanitizados, e não se deve repetir o Recovery antes desse diagnóstico. `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING`, `READY_TO_MERGE_AUTOMATIC_PROOF_FIX=NO` até checks remotos verdes e `READY_FOR_1_0B_2_O=NO`.

> **INC_ERP_5050 — diagnóstico do HTTP 408 (run 33077238988 / job 98534543031, 2026-08-27).** A correção do falso HTTP 429 foi comprovada: autenticação, token, identidade e RBAC passaram com role `diretor`, e o request alcançou a API. A nova imagem e a `main` usaram o SHA `957615d1da32fdaa9bcdc6cff9c07047947ec190`. A API emitiu HTTP **408** no timeout global de **15 s** porque o endpoint canônico de status chamava `refreshErpAutomaticSyncConfig()`, que fazia refresh mutável e aguardava leituras do PostgreSQL (`AppConfig`, possível usuário de referência e histórico `ErpSyncRun`) durante a inicialização concorrente do scheduler. O header marcador da rota era definido antes dessa espera; portanto `ERP_SCHEDULER_STATUS_ROUTE_REACHED=YES`, `ERP_SCHEDULER_STATUS_TIMEOUT_STAGE=database` e `ERP_SCHEDULER_STATUS_ELAPSED_CLASS=15_to_30s`. O callback de `res.setTimeout` respondeu enquanto a Promise do handler continuava aguardando o banco. Não há chamada UltraFV3 nem lock explícito nesse caminho, e o cliente não impunha timeout próprio; o limite observado era exclusivamente o da API.

> A correção mínima torna `GET /erp/ultrafv3/scheduler/status` uma projeção somente leitura do estado runtime, sem banco, refresh, lock ou chamada externa. Durante bootstrap ela responde schema válido com `initialized=false` e `nextRunAt=null`; o Recovery mantém sua espera limitada e só aceita convergência real posterior. Auth, RBAC, rate limit, timeout global, rollback fail-closed e redaction permanecem ativos. O rollback do run foi concluído (`ERP_ROLLBACK_API_HEALTH=PASS`) e restaurou a API anterior saudável. Não repetir Recovery nem executar produção nesta tarefa. `ERP_AUTOMATIC_SYNC=NOT_PROVEN`, `INC_ERP_5050=INVESTIGATING`, `READY_TO_MERGE_HTTP_408_FIX=NO` até checks remotos verdes e `READY_FOR_1_0B_2_O=NO`.

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

## Correção do preflight legado do ERP Production Recovery — run 31736308709 (13/08/2026)

A tentativa 2 do [run 31736308709](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31736308709), [job 94572767335](https://github.com/giancarlosmp-hub/Gest-o/actions/runs/31736308709/job/94572767335), executada no SHA `7005ddf65add085c53f8e80a0fcb9e4aee6017a1`, comprovou `AUTH_TEST_EMAIL`/`AUTH_TEST_PASSWORD` disponíveis, API saudável com cardinalidade 1 e restart count 0, AppConfig `enabled` e lock `free`. A fonte autorizada foi `legacy_copy`; o candidato reconciliava somente o scheduler e falhou no preflight antes de `environment_commit` e `api_recreate`. O rollback terminou (`COMPLETED`), nenhum env produtivo foi alterado e nenhum container foi recriado. A causa atual não são as credenciais do CRM.

A correção propõe a política explícita `recovery_legacy`: ela preserva a fonte e toda configuração empresarial, cria candidato temporário protegido e reconcilia exclusivamente scheduler habilitado e os seis gates produtivos seguros. A primitiva compartilhada mantém `build_legacy` estritamente build-only, com scheduler desabilitado; o candidato de Recovery não é autorizado no deploy normal. Canônico existente continua autoritativo e inválido falha sem fallback legado. O candidato só pode ser instalado depois de todos os preflights e o rollback continua fail-closed, restrito ao env e à API. **O Recovery corrigido ainda não foi executado com sucesso e a sincronização automática permanece não comprovada.**

Estados: `ERP_RECOVERY_AUTH_INPUT=AVAILABLE`; `ERP_RECOVERY_PREFLIGHT=NOT_PROVEN`; `ERP_PRODUCTION_RECOVERY_WORKFLOW=FAILED_PRE_COMMIT`; `PRODUCTION_ENV_MODIFIED=NO`; `CONTAINERS_RECREATED=NO`; `ERP_AUTOMATIC_SYNC=NOT_PROVEN`; `ERP_SYNC_ENV_PERSISTENCE=NOT_PROVEN`; `ERP_SCHEDULER_INITIALIZED=NOT_PROVEN`; `ERP_NEXT_RUN_AT=NOT_PROVEN`; `INC_ERP_5050=INVESTIGATING`; `READY_FOR_1_0B_2_O=NO`.

# Resolução do env no build de recuperação

O run `31707019441` falhou exatamente ao iniciar `scripts/deploy-production.sh`, após checkout e SHA validados, pois o arquivo canônico estava ausente. `MODE=build` agora seleciona exclusivamente um caminho técnico, sem exibir valores: canônico root:root/600 regular e não-symlink; ou, somente se o canônico não existir, o legado autorizado com os mesmos metadados; senão falha. Se o canônico existe mas é inválido, não há fallback. A fase não copia/edita env nem liga o scheduler. `MODE=cutover` continua exigindo exclusivamente `/root/demetra-env/.env`. Depois do merge, repetir `phase=build`; o ERP Production Recovery ainda deverá instalar o canônico e provar a automação. Nenhum deploy ou recovery foi executado por esta mudança.

# Contrato de deploy — observabilidade ERP (12/08/2026)

Esta estabilização não inclui migration, DDL, backfill, recovery ou deploy. O gate
`test:platform-health-erp-observability` deve anteceder os smokes gerais no Compose CI. Em rollback,
reverter o commit e recriar API/WEB pelo fluxo oficial, preservando banco, env e os literais
`TENANCY_MODE=disabled` e `TENANT_READ_PILOT_ENABLED=false`. Uma execução manual nunca satisfaz o
gate produtivo do scheduler.

# AVISO CANÔNICO — SCHEMA EXTERNO EM PRODUÇÃO (07/08/2026)

> O contrato vigente é `DATABASE_SCHEMA_MODE=external` e `TENANCY_MODE=disabled`. Bootstrap e
> deploy da API **não** executam `prisma db push`, seed, sequence setup, DDL ou preparação do tenant.
> Use somente o fluxo futuro, administrativo e autorizado do
> [Brief OP-EXEC](sprints/SPRINT_1_0B_1_OP_EXEC_CONTROL_PLANE_CERTIFICATION.md). As seções abaixo que
> narram `db push` preservam o histórico do procedimento anterior; não são instruções vigentes. A PR
> #774 está **🟡 Merge**, sem evidência de deploy/produção; a revisão operacional comprovada segue
> `a08a626`.

# ADENDO CANÔNICO — deploy pós-recuperação (31/07/2026)

> 🔵 **PR, não produção.** O incidente permanece aberto. A topologia canônica candidata é `docker-compose.production.yml`, somente API/WEB na rede externa `gest-o_default`. O Compose genérico é legado/local e é proibido na VPS porque seu `depends_on` e fallback podem iniciar/apontar ao PostgreSQL padrão.

A divergência Git × runtime ocorreu porque o checkout chegou à `main`, mas containers históricos sem metadados continuaram nas portas. O banco vigente até migração formal é o recuperado `gest-o-db-clean-v2-20260717`, volume `gest-o_pgdata_clean_v2_20260717`, administrado separadamente. Fluxo: GitHub → workflow manual → SSH `/apps/gest-o` → preflight → build com SHA → aprovação `production-cutover` → troca só de API/WEB → Nginx host → domínio. Segredos ficam apenas em `/root/demetra-env/.env`.

```bash
# Futuro, na VPS, após aprovação; não executado nesta PR
cd /apps/gest-o
git fetch origin main && git switch main && git pull --ff-only origin main
MODE=build EXPECTED_SHA="$(git rev-parse HEAD)" bash scripts/deploy-production.sh
set -a; . /root/demetra-env/.env; set +a
bash scripts/production-schema-preview.sh > /var/log/gest-o/schema-preview.sql
MODE=cutover CONFIRM=PRODUCTION_CUTOVER EXPECTED_SHA="$(git rev-parse HEAD)" bash scripts/deploy-production.sh
```

A matriz completa e auditável de configuração está em [`PRODUCTION_ENV_MATRIX.md`](PRODUCTION_ENV_MATRIX.md). O preflight exige URL/host/container/volume esperados, database `salesforce_pro`, rede/mount, Git, disco e backup recente com SHA256, sem imprimir a URL. Como hostnames de containers são resolvidos dentro da rede Docker, a disponibilidade do PostgreSQL é testada por `pg_isready` em um container efêmero `postgres:16` conectado a `gest-o_default`, com timeout, sem senha, porta publicada, volume ou IP fixo; o DNS do host não participa. A imagem deve existir localmente e nunca é baixada pelo preflight. Isso corrige somente o falso negativo operacional do teste anterior. O build precede toda parada. O cutover registra inspect, etiqueta imagens e gera rollback; em falha reinicia os containers anteriores e nunca administra PostgreSQL. Depois, comparar `/health/version` local/público ao SHA, assets local/público, login/menu sem escrita e scheduler somente por consulta.

Containers são descartáveis: a unidade real de rollback é a imagem versionada, nunca o nome do container. Antes do cutover, API e WEB anteriores recebem tags distintas (`gest-o-api-rollback:<release>` e `gest-o-web-rollback:<release>`), e image IDs, nomes, portas, redes, restart policy e commit disponível são gravados nas evidências. O rollback persistido carrega o env seguro, remove somente os novos `api`/`web`, aguarda as portas e recria ambos via Compose com `API_IMAGE`/`WEB_IMAGE` apontando às tags salvas. Depois valida image IDs, API/WEB e reconfirma que o PostgreSQL segue running com o mesmo mount. Isso funciona tanto para containers históricos externos quanto para containers de um cutover Compose posterior, mesmo que os containers anteriores já não existam. O preview de schema executa `./node_modules/.bin/prisma` dentro de `gest-o-api:$APP_COMMIT`, sem download no host.

O bootstrap ainda executa `prisma db push`, prepara a sequence e somente então abre HTTP/scheduler; conexão/schema falhos fecham o processo. Backup e preview são gates. Uma futura adoção de `prisma migrate deploy` é recomendada, mas não integra esta correção emergencial. Para instalar o unit após aprovação: `sudo install -m 0644 docs/ops/gest-o.service /etc/systemd/system/gest-o.service && sudo systemctl daemon-reload`.

---

# Guia oficial de deploy e auditoria de produção — Gest-o

> **Escopo:** este documento descreve o que está versionado no repositório em 31/07/2026 e os comandos para comprovar o estado real da VPS. Ele não afirma ter observado a VPS, o DNS ou uma execução do GitHub Actions. Onde a configuração não está no repositório, a validação operacional é obrigatória.

## 1. Resumo executivo

- O deploy de produção é disparado por `push` em `main` (inclusive merge) ou manualmente no workflow **Deploy Production**.
- O GitHub Actions conecta por SSH à VPS, atualiza `/apps/gest-o` com fast-forward e chama `scripts/deploy-production.sh`.
- O script carrega `/root/demetra-env/.env`, injeta o SHA/data/versão da release, reconstrói as imagens `api` e `web` e recria esses containers.
- A API inicia somente depois de executar `prisma db push` e garantir a sequence de pedidos. O projeto possui SQLs em `prisma/migrations`, mas **o deploy atual não executa `prisma migrate deploy`** e, portanto, não mantém um ledger confiável de migrations aplicadas.
- O PostgreSQL usa o volume nomeado `gest-o_pgdata`. O deploy normal não recria o banco nem remove esse volume.
- O container `web` contém a build Vite e um Nginx interno. Ele encaminha `/api/` para `api:4000`. O Nginx do host/VPS e o DNS público não estão integralmente versionados; devem ser conferidos na VPS e no provedor DNS.
- Não há serviço Compose separado para worker ou scheduler. O scheduler ERP roda dentro do processo `api`; “worker” deve ser validado como inexistente no desenho atual, não como um container esperado.

## 2. Arquitetura ponta a ponta

```text
GitHub (main)
  └─ GitHub Actions: .github/workflows/deploy-production.yml
       └─ SSH :22022 (ou SSH_PORT) para a VPS
            └─ checkout /apps/gest-o
                 └─ Docker Compose (projeto derivado do diretório)
                      ├─ db: postgres:16 + volume gest-o_pgdata
                      ├─ api: Node 20, porta interna 4000, host 4000 por padrão
                      │    ├─ prisma db push no bootstrap
                      │    └─ scheduler ERP no mesmo processo
                      └─ web: Nginx Alpine + artefatos Vite, host 5173 por padrão
                           └─ /api/* → api:4000/*
            └─ Nginx do host (configuração de produção não versionada)
                 └─ TLS/domínio crm.demetraagronegocios.com.br
                      └─ DNS (configuração externa ao repositório)
```

### GitHub → VPS

O workflow usa `SSH_HOST/SSH_USER/SSH_KEY/SSH_PORT`, com fallback para `VPS_HOST/VPS_USER/VPS_KEY` e porta `22022`. Há exclusão mútua (`concurrency: deploy-production`, sem cancelamento do deploy em curso). Um merge só chega à produção se o workflow iniciar **e terminar com sucesso**. Confirmar em **Actions → Deploy Production** o run associado ao SHA do merge.

O alvo oficial versionado é `/apps/gest-o`. O unit file documentado em `docs/ops/gest-o.service` usa o mesmo diretório e pode restaurar a stack no boot. Confirmar que não há uma stack histórica em `/apps/production` ou outro Compose ainda ocupando as portas.

### VPS → Docker → API/WEB/Banco

`docker-compose.yml` não monta o código-fonte nos serviços `api` ou `web`: ambos executam conteúdo incorporado às imagens. Logo, `git pull` isolado nunca atualiza o código em execução. O único volume persistente da stack é o PostgreSQL.

O container `web` serve arquivos de `/usr/share/nginx/html`; o frontend não é servido diretamente do checkout. `VITE_API_URL` é argumento de build, portanto sua alteração também exige rebuild do `web`.

### Nginx → domínio

Há dois Nginx:

1. **interno ao container `web`**, versionado em `apps/web/nginx.conf`;
2. **do host**, que termina TLS e deve encaminhar o domínio para `${WEB_PORT:-5173}`. O vhost completo de produção não está neste repositório.

DNS e certificado são estado externo. Aponte o registro público para o IP correto da VPS e confira que o vhost efetivo usa o upstream da stack oficial. Nunca conclua que o domínio está atualizado apenas porque `curl localhost` funciona.

## 3. Procedimento oficial após merge

### Caminho automático (preferencial)

1. Mesclar em `main` e anotar o SHA completo.
2. Abrir GitHub Actions e confirmar que **Deploy Production** foi disparado para esse SHA.
3. Aguardar sucesso do job SSH. Se falhar, não considerar a release publicada.
4. Executar as verificações pós-deploy da seção 8 na VPS e externamente.

### Caminho manual controlado

O workflow pode ser disparado manualmente com `confirm_environment=production`. Para uma execução direta na VPS, esta é a ordem oficial:

```bash
set -euo pipefail
cd /apps/gest-o
git fetch origin main
git checkout main
git pull --ff-only origin main
bash scripts/deploy-production.sh
```

O script repete a sincronização de forma segura e então executa, em essência:

```bash
set -a
. /root/demetra-env/.env       # quando o arquivo existe
set +a
export APP_COMMIT="$(git rev-parse HEAD)"
export APP_BUILT_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
docker compose config >/dev/null
docker compose build api web
docker compose up -d api web
docker compose ps
docker compose images api web
```

Não é necessário `docker compose restart`: `up -d` recria os containers quando a imagem mudou. Um `restart` sozinho reinicia a **imagem antiga** e não publica o merge. Não execute `down -v`, `docker volume rm`, `prisma migrate reset` nem seed em produção.

### Observações sobre o script legado

`deploy.sh` é um fluxo legado mais amplo e usa `git reset --hard origin/main`, backup e `down`. O workflow oficial chama `scripts/deploy-production.sh`, não `deploy.sh`. Não misture os dois procedimentos durante a mesma publicação; usar o legado exige uma janela operacional e entendimento dos seus safeguards.

## 4. Onde uma versão antiga pode continuar rodando

| Estado | Como acontece | Como provar/corrigir |
|---|---|---|
| Git novo, API e WEB antigas | Foi feito apenas `git pull`; containers não têm bind mount | comparar HEAD, build-info, image ID e `StartedAt`; executar o script oficial |
| Imagem nova, container antigo | `docker compose build` sem `up -d` | comparar `docker compose images` com `.Image` do container; executar `up -d api web` |
| API nova, WEB antiga | build/up parcial apenas da API, falha no build web ou stack errada | verificar os dois containers, asset hash e logs do run |
| Checkout certo, domínio antigo | Nginx aponta para outra porta/stack/VPS ou DNS aponta para outro IP | comparar resposta local, `nginx -T`, DNS e resposta externa |
| Container recriado com camada antiga | build context errado, checkout diferente, cache indevido ou arquivo fora do contexto | confirmar `WorkingDir`, SHA e conteúdo da imagem; em incidente, `docker compose build --no-cache api web` e `up -d` |
| Workflow não publicou | secrets ausentes, SSH falhou, alterações locais bloquearam fast-forward ou build falhou | logs do Actions; `git status --short --branch` na VPS |
| Ambiente antigo após reboot | unit/systemd ou outro projeto Compose sobe uma stack histórica | `systemctl cat gest-o`; listar containers, labels Compose e portas |

O caminho normal (`build` seguido de `up -d`) evita imagem/container antigos, mas o script termina logo após `compose ps`: ele **não aguarda os healthchecks nem valida o domínio**. Assim, sucesso do job não substitui o checklist pós-deploy.

## 5. Auditoria específica do frontend/menu lateral

O menu pode continuar antigo com o Git atualizado quando o `web` não foi reconstruído/recriado, quando outra stack atende o domínio, ou quando uma aba aberta ainda executa o JavaScript já carregado.

- **Build/imagem:** Vite gera assets dentro da imagem. Não há volume sobre `/usr/share/nginx/html`; atualizar o checkout não altera esses arquivos.
- **Cache HTTP:** `/index.html` e rotas SPA recebem `no-cache, no-store`; `/assets/` recebe cache de um ano e `immutable`. Isso é seguro quando Vite muda o nome/hash do asset. Torna-se problema se o HTML antigo ainda for servido ou se um artefato for publicado sob o mesmo nome.
- **Browser:** uma aba que nunca recarregou mantém o bundle em memória. Faça reload normal e, para diagnóstico, DevTools → Network → Disable cache ou janela anônima. “Hard refresh” não conserta uma imagem antiga no servidor.
- **Proxy/CDN:** não há CDN documentada. Caso exista fora do repositório, conferir/purgar seu cache somente depois de provar que origem local está nova.
- **Service worker:** a auditoria do código não encontrou registro de service worker/Workbox. Portanto, não há mecanismo PWA versionado que explique persistência offline. Confirmar no navegador em Application → Service Workers e remover qualquer registro legado do domínio, se existir.

Prova objetiva do HTML/assets:

```bash
cd /apps/gest-o
docker compose exec -T web sh -lc 'stat /usr/share/nginx/html/index.html; sed -n "1,30p" /usr/share/nginx/html/index.html'
curl -fsS http://127.0.0.1:${WEB_PORT:-5173}/ | sha256sum
curl -fsS https://crm.demetraagronegocios.com.br/ | sha256sum
curl -fsS https://crm.demetraagronegocios.com.br/ \
  | sed -nE 's/.*(assets\/[^"'"'"' ]+\.(js|css)).*/\1/p'
curl -sSI https://crm.demetraagronegocios.com.br/ | sed -n '1,20p'
```

Os hashes local e externo devem representar o mesmo `index.html` (proxies podem alterar bytes; nesse caso compare os nomes dos assets). Um teste funcional do menu deve ser feito em janela anônima após essa prova.

## 6. Confirmar o backend realmente executado

A fonte de verdade é a combinação de SHA no checkout, metadado embutido e container efetivo:

```bash
cd /apps/gest-o
EXPECTED="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
printf 'expected=%s\norigin_main=%s\n' "$EXPECTED" "$REMOTE"

docker compose ps api
docker compose images api
docker inspect "$(docker compose ps -q api)" \
  --format 'container={{.Name}} image={{.Image}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
docker compose exec -T api sh -lc 'cat apps/api/dist/build-info.json; printf "APP_COMMIT=%s\nAPP_BUILT_AT=%s\n" "$APP_COMMIT" "$APP_BUILT_AT"'
curl -fsS http://127.0.0.1:${API_PORT:-4000}/health/version
curl -fsS https://crm.demetraagronegocios.com.br/api/health/version
```

Os campos `commit` internos e externos devem ser exatamente `$EXPECTED`, e `$EXPECTED` deve ser `origin/main`. `APP_COMMIT=unknown` significa imagem construída fora do procedimento oficial ou variável perdida; não aceite como prova de versão.

## 7. Banco e “migrations”

### O que o deploy realmente faz

O comando chamado `prisma:migrate` no `package.json` executa **`prisma db push`**. No bootstrap do container, ele sincroniza o schema Prisma diretamente e depois garante a sequence ERP. Ele não executa os SQLs em `apps/api/prisma/migrations` como uma cadeia e não registra cada pasta como aplicada.

Consequências:

- listar pastas mostra o que existe no Git, não o que foi aplicado;
- `_prisma_migrations` pode não existir, estar vazia ou refletir um processo histórico; não é prova suficiente no fluxo atual;
- a prova atual é ausência de drift entre `schema.prisma` da imagem e o banco, mais inspeção read-only dos objetos esperados;
- rollback do código pode não reverter schema, pois `db push` é progressivo e não fornece down migrations.

### Comandos de validação

```bash
cd /apps/gest-o

# Migrations disponíveis no commit (inventário, não ledger de aplicação)
find apps/api/prisma/migrations -mindepth 2 -maxdepth 2 -name migration.sql -printf '%h\n' | sort

# A tabela histórica existe? Se existir, listar sem assumir que é completa.
docker compose exec -T db psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-salesforce_pro}" \
  -c "SELECT to_regclass('public._prisma_migrations');"
docker compose exec -T db psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-salesforce_pro}" \
  -c 'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY finished_at;' \
  || echo '_prisma_migrations ausente/não utilizável: esperado quando o fluxo é db push'

# Drift: somente diagnóstico; não aceitar mudanças e não usar --force-reset.
docker compose exec -T api npx prisma db push --schema=apps/api/prisma/schema.prisma --skip-generate

# Conectividade e inventário read-only.
docker compose exec -T db pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-salesforce_pro}"
docker compose exec -T db psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-salesforce_pro}" -c '\dt'
bash scripts/check-prod-health.sh --strict
```

Embora `db push` sem mudança normalmente seja idempotente, rode o diagnóstico de drift em janela controlada: ele é um comando de sincronização, não uma ferramenta estritamente read-only. Para auditoria read-only absoluta, compare tabelas/colunas/índices via `psql` com os SQLs versionados.

## 8. Checklist definitivo de deploy

### Antes

- [ ] Identificar SHA do merge e confirmar que pertence a `main`.
- [ ] Confirmar backup PostgreSQL recente, válido e restaurável (`./backup.sh` conforme runbook).
- [ ] Confirmar Actions/secrets SSH e janela operacional.
- [ ] Na VPS, `cd /apps/gest-o`, confirmar branch `main` e working tree limpa.
- [ ] Registrar `docker compose ps`, image IDs, `/health/version`, contagens críticas e espaço em disco.
- [ ] Validar `/root/demetra-env/.env` sem imprimir segredos e `docker compose config` (atenção: a saída completa pode revelar secrets).

### Publicação

- [ ] Executar o workflow automático ou a sequência manual oficial da seção 3.
- [ ] Confirmar rebuild bem-sucedido de **api e web**.
- [ ] Confirmar que `up -d api web` recriou ambos quando necessário.
- [ ] Não remover volumes, não resetar banco e não executar seed.

### Depois

- [ ] `git rev-parse HEAD` = `git rev-parse origin/main` = SHA planejado.
- [ ] `docker compose ps` mostra `db`, `api` e `web` em execução/healthy.
- [ ] `/health/version` local e `/api/health/version` público retornam o SHA planejado.
- [ ] API, WEB e banco passam nos comandos da seção 10.
- [ ] Asset hash do HTML público corresponde ao container `web` novo.
- [ ] Nginx do host aponta para a porta/container oficial e `nginx -t` passa.
- [ ] Domínio/TLS/DNS respondem no IP esperado.
- [ ] Scheduler, histórico ERP e UltraFV3 passam na validação autenticada.
- [ ] Teste manual mínimo: login, menu lateral, uma leitura não destrutiva e logout.
- [ ] Registrar SHA, horário, image IDs, resultado dos checks e operador.

## 9. Rollback

Rollback é uma nova publicação de um commit conhecido, preservando banco e secrets. **Não use `git reset --hard` sem confirmar/guardar alterações locais e não faça rollback cego quando houve mudança incompatível de schema.**

### Preparação

- [ ] Declarar incidente e interromper novos deploys.
- [ ] Registrar SHA atual, image IDs, logs e sintomas.
- [ ] Tirar backup validado do banco antes de qualquer ação.
- [ ] Selecionar o SHA/tag bom e revisar diferenças de `schema.prisma`/SQLs.
- [ ] Se schema for incompatível, planejar restauração do banco em janela separada; restaurar dump perde dados posteriores ao backup.

### Rollback de aplicação

Reverta o commit em `main` por PR e deixe a esteira publicar o novo SHA. Essa é a forma oficial porque mantém GitHub, checkout, metadados da imagem e histórico de produção convergentes:

```bash
git checkout main
git pull --ff-only origin main
git revert <sha-ruim>             # resolver/revisar/testar em branch e abrir PR
git push origin <branch-do-revert>
# Após aprovação e merge, acompanhar Deploy Production e executar todos os checks.
```

Não faça checkout destacado seguido de `scripts/deploy-production.sh`: por proteção, o script volta para `main`. Uma reconstrução emergencial fora de `main` não faz parte do procedimento oficial e exige runbook/aprovação específicos.

### Validação e encerramento

- [ ] Repetir integralmente o checklist pós-deploy.
- [ ] Confirmar que contagens críticas não diminuíram inesperadamente.
- [ ] Confirmar compatibilidade do schema; não rodar `migrate reset`.
- [ ] Se necessário, seguir `restore.sh`/runbook de backup somente com aprovação e indisponibilidade planejada.
- [ ] Documentar causa, período, SHA ruim/bom e eventual perda/recuperação de dados.

## 10. Health checks operacionais

Execute a partir de `/apps/gest-o`, depois de carregar o ambiente de produção sem ecoar valores.

### Stack, API e WEB

```bash
docker compose ps
docker compose ps --format json | jq .
curl -fsS http://127.0.0.1:${API_PORT:-4000}/health
curl -fsS http://127.0.0.1:${API_PORT:-4000}/health/version | jq .
curl -fsS http://127.0.0.1:${WEB_PORT:-5173}/healthz
curl -fsS https://crm.demetraagronegocios.com.br/ -o /dev/null
curl -fsS https://crm.demetraagronegocios.com.br/api/health/version | jq .
docker compose logs --since=10m api web
```

### Banco

```bash
docker compose exec -T db pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-salesforce_pro}"
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-salesforce_pro}" -c 'SELECT now(), current_database();'
bash scripts/check-prod-health.sh --strict
```

### Scheduler

O scheduler ERP vive no container `api`. Validar configuração sem revelar credenciais, inicialização nos logs e estado pelo endpoint autenticado:

```bash
docker compose exec -T api sh -lc 'printf "ERP_SYNC_SCHEDULER_ENABLED=%s\n" "$ERP_SYNC_SCHEDULER_ENABLED"'
docker compose logs --since=30m api | rg 'erp-sync/scheduler|scheduler'
curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/scheduler/status | jq .
curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/sync/history?limit=10 | jq .
```

O endpoint deve mostrar `initialized`, `enabled`, `nextRunAt`, último resultado e razão coerentes. Não interprete apenas “processo API saudável” como “scheduler executando com sucesso”.

### Worker

Não existe serviço `worker` no Compose atual. A checagem correta é provar que não há expectativa divergente:

```bash
docker compose config --services
docker compose ps -a
docker ps --filter label=com.docker.compose.project --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

Se a operação espera um worker separado, isso é divergência arquitetural a ser tratada fora deste deploy; não crie ou reinicie um container ad hoc.

### UltraFV3

Primeiro confirme apenas presença de configuração (nunca imprima usuário, senha, token ou chave), depois use endpoints autenticados e read-only:

```bash
docker compose exec -T api sh -lc '
  printf "BASE_URL_SET=%s USER_SET=%s PASSWORD_SET=%s ENCRYPTION_KEY_SET=%s\n" \
    "${ULTRAFV3_BASE_URL:+true}" "${ULTRAFV3_USERNAME:+true}" \
    "${ULTRAFV3_PASSWORD:+true}" "${ERP_CREDENTIAL_ENCRYPTION_KEY:+true}"
'
curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/diagnostics | jq .
TMP_ULTRAFV3="$(mktemp)"
STATUS="$(curl -sS -o "$TMP_ULTRAFV3" -w '%{http_code}' \
  -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/healthcheck)"
jq . "$TMP_ULTRAFV3"
printf 'HTTP %s\n' "$STATUS"
rm -f "$TMP_ULTRAFV3"
```

O healthcheck pode responder `207` quando há erro operacional; registre HTTP e corpo. Não dispare sincronização, teste de pedido ou POST no ERP como mero health check.

## 11. Nginx, systemd, DNS e prova externa

```bash
sudo systemctl status gest-o --no-pager
sudo systemctl cat gest-o
sudo nginx -t
sudo nginx -T | sed -n '/server_name crm\.demetraagronegocios\.com\.br/,+100p'
sudo ss -lntp | rg ':(80|443|4000|5173)\b'
getent ahostsv4 crm.demetraagronegocios.com.br
curl -fsS https://api.ipify.org; echo
curl -vkI https://crm.demetraagronegocios.com.br/
```

Confirme: DNS resolve para a VPS esperada; certificado cobre o host e está válido; Nginx usa o upstream `${WEB_PORT:-5173}`; somente a stack em `/apps/gest-o` publica essa porta; e resposta externa contém os mesmos assets/versão verificados localmente.

## 12. Critério de aceite da auditoria

Uma release só está comprovadamente em produção quando todas as identidades convergem:

```text
SHA merge em main
= origin/main na VPS
= HEAD de /apps/gest-o
= APP_COMMIT/build-info dentro da API
= /api/health/version pelo domínio

e

imagem WEB recém-construída
= imagem do container WEB em execução
= asset hashes referenciados pelo domínio
```

Além disso, banco, proxy, scheduler e integração devem passar seus checks. “Workflow verde”, “Git atualizado” ou “container Up” isoladamente não são evidência suficiente.

## Etapa separada e obrigatória: schema de produção

O bootstrap de produção não reconcilia schema. O cutover exige evidência do apply para o mesmo SHA.
A ordem obrigatória é preflight, build, preview `MODE=validate`, aprovação humana, apply confirmado,
validação das evidências e apenas depois cutover. Use `production-schema-apply.sh`; ele aplica somente
a migration aditiva aprovada, não inicia API/WEB, não executa db push/seed e não toca em
`incident_*`. Não use `prisma migrate deploy` até o histórico do banco recuperado receber baseline
auditado. Consulte a [auditoria integral](investigations/production-schema-transition-july-2026.md).

### Pós-validação estrutural da PR #756

O apply faz diff Prisma antes e depois com `gest-o-api:<SHA>`. O diff bruto é preservado; somente os
oito drops `incident_*` conhecidos são excluídos da visão gerenciada. `post-apply-diff.sql` deve ficar
sem DDL antes da criação de `applied.tsv`. Execute `npm run test:production-schema:postgres` em CI com
Docker/PostgreSQL 16 antes de aprovar a janela.

## Autoridade explícita de schema

`NODE_ENV=production` configura o runtime da aplicação, mas não autoriza nem proíbe DDL.
`DATABASE_SCHEMA_MODE=external` é literal e obrigatório no Compose de produção: não há db push,
sequence setup ou seed/bootstrap de dados; use exclusivamente `production-schema-apply.sh`. Os
stacks descartáveis de CI/preview declaram `ephemeral-push`, permitindo criar o schema novo e executar
somente os seeds habilitados pelas flags de smoke. Valor ausente/inválido impede a API de iniciar.
# Procedimento excepcional de recuperação ERP

O workflow **ERP Production Recovery** é o procedimento aprovado para restaurar o gate do scheduler
quando o acesso operacional ocorre pelos secrets SSH do GitHub Actions. Ele deve ser usado somente
depois de seu merge em `main` e de `Deploy Production` em modo `build` preparar a imagem API do mesmo
SHA. O operador fornece apenas a confirmação literal e `expected_main_sha`; a aprovação ocorre no
environment `production-cutover`.

Esse fluxo não amplia o cutover: preserva WEB, PostgreSQL e volumes, recria somente `api` sem build e
faz rollback da API e do env diante de qualquer gate crítico. O deploy normal permanece inalterado.
Consulte **ERP Production Recovery** em `docs/OPERACAO.md` para checkpoints e interpretação. A
existência deste canal não constitui evidência de execução produtiva nem resolve `INC_ERP_5050`.

Uma nova sessão SSH não herda `API_IMAGE`, `WEB_IMAGE` ou `APP_*` exportados pelo build. A recuperação
os deriva novamente: SHA e tag API do commit aprovado, versão do `package.json`, timestamp UTC da
sessão e imagem WEB inspecionada no container produtivo único. O timestamp derivado não afirma quando
a imagem foi construída. O login de validação usa exclusivamente secrets do environment, sem gravá-los
no arquivo empresarial.

O workflow excepcional não executa build nem substitui as fases e evidências do deploy histórico. Ele
somente consome a imagem pinada já preparada e mantém WEB, PostgreSQL e mounts com as identidades
capturadas na descoberta read-only.
# Checkpoints pré-deploy após o run 31713219051

O fast-forward `3c068fa..443be81` terminou, mas o predicado silencioso de igualdade de SHA encerrou
o shell antes do primeiro marcador do resolver/deploy. O workflow agora delega o checkout ao
`scripts/production-deploy-entrypoint.sh`: ambos os SHAs devem ser hexadecimais de 40 caracteres e
literalmente iguais, a worktree deve estar limpa e o script deve existir. Cada gate emite `PASS`;
divergência emite somente estágio, SHA esperado/observado, resultado `FAIL`, comando lógico e exit
code. O deploy então registra entrada/modo/formato e `DEPLOY_ENV_RESOLUTION=STARTED`; o resolver
continua emitindo exclusivamente o marcador de fonte autorizado. O run investigado não iniciou
build, cutover, containers ou Recovery, e não autoriza executar nenhum deles nesta correção.
# Build recovery-safe com fonte legada

Evidência: run `31720219813`, job `94515047904`, SHA
`a3f900b05cbbcc2ab9ee8bba306c4a2cea524d97`. Fast-forward, SHA, checkout, worktree, script,
entrypoint, `MODE=build`, resolução `legacy_build_only` e scheduler seguro passaram; o gate
`TENANCY_MODE` falhou antes de qualquer build, container, cutover ou Recovery.

Quando e somente quando o resolver seleciona `legacy_build_only` em `MODE=build`, o deploy copia a
fonte protegida para `mktemp` mode 600, rejeita duplicidade/sintaxe malformada e reconcilia
`ERP_SYNC_SCHEDULER_ENABLED=false`, `TENANCY_MODE=disabled`,
`TENANT_READ_PILOT_ENABLED=false`, `DATABASE_SCHEMA_MODE=external` e os três gates de seed como
`false`. Preflight e Compose usam essa cópia, que é apagada no EXIT; hashes e valores não são
emitidos. O hash da fonte antes/depois deve coincidir. Canônico recebe zero overlay e segue
autoritativo; cutover é canonical-only. Repetir apenas `phase=build`, somente após merge/checks.

# Backup no build versus cutover

`deploy-production.sh` deve propagar seu `MODE` como `PRODUCTION_PREFLIGHT_MODE`; somente `build` e
`cutover` são aceitos. Backup e manifesto continuam obrigatórios e a integridade continua sendo a
validação do manifesto existente com `sha256sum -c`. O preflight é read-only e não cria nem renova
essa evidência.

Em `build`, backup íntegro antigo é aceito e emite
`PRODUCTION_BACKUP_FRESHNESS=NOT_REQUIRED_BUILD_ONLY`, porque a fase apenas produz imagens sem
interromper/recriar containers. Isso não autoriza cutover. Em `cutover`, o limite
`PRODUCTION_BACKUP_MAX_AGE_SECONDS` permanece obrigatório e backup antigo falha antes de qualquer
efeito. Só considerar o preflight aprovado ao receber `PRODUCTION_PREFLIGHT=PASS` após presença,
integridade, frescor aplicável e todos os demais gates.

O run `31723282307` parou antes do build e não alterou produção. Recovery não foi executado e segue
dependente de imagem aprovada e precondições próprias. Build verde não prova scheduler automático.

## Correção do contrato de `docker inspect` do backup de Recovery (25/08/2026)

O diagnóstico sanitizado executado na VPS, com o mesmo usuário do workflow, comprovou: CLI Docker disponível, probe do daemon com exit 0 e stderr vazio, consulta ancorada pelo nome exato com exit 0/cardinalidade 1/stderr vazio, seguida de `docker inspect` com exit 1, stdout vazio e stderr classificado como `template_error`. Portanto, daemon, permissão, nome e cardinalidade estão operacionais; a causa comprovada é o template Go anterior, sanitizado como `docker inspect -f '{{.Name}}{{"\\t"}}{{.Id}}{{"\\t"}}{{.State.Running}}{{"\\t"}}{{if .State.Health}}{{.State.Health.Status}}{{end}}' <identidade-em-memória>`, que agregava acesso a campos e delimitadores em uma única avaliação de template.

A correção remove esse template da inspeção de identidade: `docker inspect <identidade-em-memória>` fornece o JSON nativo, validado como array unitário por parser estrito antes de extrair nome, ID completo, `State.Running` e health. Ausência/nulo de `State.Health` é a única aceitação de container sem healthcheck; healthcheck presente exige `healthy`. Falhas são classificadas, sem stderr bruto, como `template_error`, `object_not_found`, `permission_denied`, `daemon_unreachable` ou `malformed_inspect_output`. Permanecem inalterados nome exato e cardinalidade unitária, identidade completa somente em memória, revalidação TOCTOU imediatamente antes de `docker exec -i "$PRODUCTION_DB_CONTAINER_EXPECTED" pg_dump ...`, redaction e todos os gates posteriores.

Esta correção e suas regressões são locais. Nenhum workflow produtivo, backup, promoção produtiva, Recovery, cutover, migration, seed, backfill, sincronização, alteração de env protegido ou recriação de container foi executado; produção não foi acessada. `READY_TO_MERGE_DATABASE_INSPECT_TEMPLATE_FIX=NO`; `PRODUCTION_BACKUP_PREPARATION=NOT_PROVEN`; `ERP_PRODUCTION_RECOVERY_WORKFLOW=NOT_EXECUTED`; `ERP_AUTOMATIC_SYNC=NOT_PROVEN`; `INC_ERP_5050=INVESTIGATING`; `READY_FOR_1_0B_2_O=NO`; `PRODUCTION_ACCESSED=NO`.
# Gate de schema da PR #827

Antes do `Deploy Production phase=cutover`, o workflow manual **Production Schema PR827** deve estar mesclado no SHA aprovado. Rode primeiro `mode=preview`; `mode=apply` requer o environment `production-schema` e a frase `APPLY_PR827_SCHEMA`. O runner verifica alvo, SHA, imagem, modo externo, backup, predecessor `20260808120000_tenancy_expand_roots`, checksums, ledger e catálogo. Ele nunca descobre/aplica automaticamente todas as migrations pendentes. DDL e registro Prisma são atômicos e o sucesso exige catálogo exato e `prisma migrate diff` vazio. Um estado já aplicado e íntegro retorna sucesso sem DDL. Checksum, ledger ou catálogo divergentes bloqueiam deploy e exigem investigação, não reparo improvisado.

## PR827 e ausência do ledger Prisma

O erro do run `33204493337` não autoriza baseline. A conexão alcançou a classe esperada
de database/admin, mas a consulta não qualificada prova apenas ausência de relação
visível no contexto. O preview corrigido consulta `to_regclass` em `public`, enumera
internamente ocorrências (publica apenas contagem e `OTHER_SCHEMA_REDACTED`), classifica
schema/search path/permissão e inventaria predecessor/PR827 sob transação read-only.
Nenhuma classificação desfavorável é convertida em sucesso.

Para legado confirmado sem ledger, catálogo + checksum + `applied.tsv` histórico são
uma precondição auditável proposta, não um ledger Prisma. O apply PR827 permanece
bloqueado até decisão operacional separada. Não execute `resolve`, DDL/DML, preview
produtivo ou build a partir desta alteração. Consulte as
[lições consolidadas](investigations/production-schema-pr827-lessons-learned.md).
# Bloqueio de deploy — correção PR827

O check remoto PostgreSQL 16 `test:pr827-preview:postgres` é obrigatório após a correção de `(current_schemas(false))[1]`. Até check verde, merge e `main` verde, `READY_TO_RERUN_PREVIEW=NO`; `READY_TO_APPLY_PR827=NO` permanece invariável. Este patch não cria ledger/baseline e não aplica migration.

## PR827 final — histórico legado e incidente UltraFV3/Tailscale (31/08/2026)

O run `33383729453`/job `99461567959` falhou no estágio de metadata da raiz do histórico, antes de PostgreSQL e sem escrita: `SCHEMA_EVIDENCE_DIR_MODE` recebeu a classe produtiva `755_PROTECTED_BUNDLE_ROOT`, enquanto o runner permitia apenas `700_OWNER_PRIVATE` e `750_GROUP_TRAVERSE`. Isso não era `ERP_PRODUCTION_ENV_SOURCE=legacy_build_only`, `PR827_ENV_SOURCE=legacy_copy`, nem o modo `preview/apply`; era a permissão da raiz que contém os bundles protegidos. O contrato agora valida explicitamente o par `legacy_build_only:legacy_copy`, aceita somente 700/750/755 na raiz, mantém diretórios de bundle em 700 e `applied.tsv`/`migration.sha256` em 600, e registra apenas variável, classes, classe recebida e estágio. Valores desconhecidos falham sem fallback. Preview e apply suportam exclusivamente `applied.tsv` + `migration.sha256`; `_prisma_migrations` e `tenancy_expand_roots` não são exigidos. Preview não exige imagem e não escreve.

A causa operacional comprovada da indisponibilidade foi o peer Windows “servidor” offline no Tailscale; a VPS permaneceu conectada. Após reconectar o Windows e iniciar o UltraFV3Rest, as simulações passaram e um único novo pedido real foi confirmado como ERP **900113**. Isso não caracteriza defeito do Tailscale e não autoriza novo pedido para evidência. O pedido antigo `6f5edc8a-55a7-4502-a816-a8b94b8e67c2`, confirmado ausente por operador no UltraFV3, permanece imutável e bloqueado até o diretor registrar resolução append-only e o fluxo criar exatamente uma tentativa com `supersedesErpOrderSyncId`; nunca há resolução ou reenvio automático.

Antes de simulação/envio, `GET /salesmen` funciona como preflight read-only limitado a 10 s. Falha de timeout/conexão/autenticação bloqueia antes de qualquer `ErpOrderSync` e apresenta: “UltraFV3 indisponível. Verifique se o servidor, Tailscale e UltraFV3Rest estão conectados antes de tentar novamente.” Logs registram somente `correlationId`, classe `ERP_REACHABILITY`, classe de endpoint, duração e razão `timeout|connect|auth|5xx`. `scripts/diagnose-ultrafv3-reachability.sh` faz diagnóstico periódico GET-only, publica estado sanitizado para Saúde da Plataforma e retorna falha para o alertador; recuperação jamais chama `POST /orders`. No Windows, `scripts/windows/Ensure-UltraFV3Connectivity.ps1` configura o serviço Tailscale como Automatic, verifica conexão e inicia UltraFV3Rest apenas se parado, de forma idempotente e sem dados de rede no log. Instalação/execução remota não faz parte desta entrega.

Alternativas documentadas, não implementadas: manter Tailscale com autostart/watchdog é a recomendação atual; Cloudflare Tunnel autenticado e WireGuard site-to-site são alternativas futuras; IP público fixo/porta exposta não é recomendado sem reverse proxy, TLS, firewall, autenticação forte e allowlist.

### Gate de conectividade UltraFV3

Antes de qualquer simulação ou envio, exigir estado `available` recente do probe GET-only. Estado `unknown`/`unavailable` bloqueia o operador; recuperação do peer não dispara sincronização nem `POST /orders`. O alerta da Saúde da Plataforma é operacional e nunca é mecanismo de retry.
## Gate de backup do PR827

Deploy e apply não fazem parte da preparação da prova. Depois do merge/main verde, o workflow dedicado publica atomicamente o bundle protegido v1 em `/var/log/gest-o/backup/latest`; somente seus `result.tsv`, dump e manifesto, revalidados no filesystem final pelo parser também usado no apply, podem satisfazer o gate. Arquivo ausente, resultado legado ou cópia manual nunca é aceito. Não repetir apply até existir nova prova recente para o mesmo SHA aprovado.

## Prova protegida do production preflight para expand roots (02/09/2026)

O apply de `tenancy_expand_roots` exige que o preflight real rode em modo `cutover`, no checkout
limpo e alinhado com `origin/main`, imediatamente antes do runner. Somente após validar source
canônico, allowlists de banco/container/rede/volume, backup canônico com checksum e freshness e
espaço em disco, o preflight publica `/var/log/gest-o/preflight/latest/result.tsv`. O contrato
compartilhado usa bundle `FORMAT=1`, SHA exato do workflow, modo, identidades do alvo, epoch e
`BUNDLE_ID`; diretórios são `root:root` 700 e o arquivo é 600.

A publicação cria staging no mesmo filesystem, faz `fsync` do arquivo e diretório, e troca `latest`
por rename, preservando/restaurando o bundle anterior se a validação final falhar. O consumidor
rejeita ausência, symlink em componentes do path, tipo/owner/mode divergente, formato incompleto,
duplicado ou extra, `STATUS` não-PASS, SHA/alvo/modo divergente, timestamp futuro/stale e bundle
parcial. Um arquivo manual com `PASS` não satisfaz o parser. A prova protegida e recente do backup,
o preview do mesmo SHA/checksum, `TENANCY_MODE=disabled` e `DATABASE_SCHEMA_MODE=external`
permanecem gates independentes e inalterados.

## Gate pós-deploy — Saúde da Plataforma

A release que contém o contrato v3 deve publicar API e WEB do mesmo SHA. Verifique que `/api/platform-health/snapshot?days=7` não recebe HTML do fallback SPA, atravessa o proxy com Bearer e retorna JSON v3; valide 401/403 e a ausência de ids, correlações, erros brutos, IPs e credenciais. A PR #850 deve ser comprovada visualmente de forma separada. Rollback é a reversão do commit e republicação conjunta de API/WEB; não há migration ou mudança de dados.

## Gate da migration Pedidos e GitHub Environment de preview (05/09/2026)

Antes de promover a PR #856, os dois comandos PostgreSQL 16 são obrigatórios e independentes: `npm run test:tenancy-expand:postgres` comprova o boundary histórico; `npm run test:orders-migration:postgres` comprova a sequência integral, upgrade, backfill fail-closed e diff Prisma vazio. A migration é transacional e não deve ser aplicada se houver `tenantId` não comprovável. Não há exclusão estrutural de objetos de Pedidos.

O job Preview Deploy referencia o Environment `preview`. Um owner autorizado deve criar `PREVIEW_AUTH_EMAIL` e `PREVIEW_AUTH_PASSWORD` em **Repository Settings → Environments → preview → Environment secrets**, opcionalmente habilitando required reviewers conforme a política da organização. Use somente identidade sintética e senha exclusiva do preview; não use secrets produtivos. O GitHub mascara o uso no job e não permite leitura posterior; a entrega ao testador ocorre fora do GitHub público, pelo canal privado corporativo definido pelo owner.
