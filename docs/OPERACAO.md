# PR827: preview e apply sobre histórico legado

## Incidente de validação do bundle V1 no cutover (01/09/2026)

O apply produtivo da PR827 foi comprovado como bem-sucedido e idempotente, mas o cutover foi bloqueado antes de parar containers porque o deploy reconhecia apenas a migration de transição de julho e exigia `post-apply-diff.sql`. O validador agora preserva esse contrato legado integralmente e aceita a ausência do post-diff **somente** para o bundle `PRODUCTION_SCHEMA_APPLY_V1` da migration PR827 exatamente allowlisted (`applied.tsv` + `migration.sha256`). Diretório, arquivos, owner, mode, commit, campos, hashes e equivalência integral de `apps/api/prisma` são fail-closed; o diff Prisma managed ao vivo vazio continua obrigatório antes de qualquer `docker stop`.

Esta alteração apenas corrige e testa o checkout local. Não acessou nem modificou produção, não criou ou reinterpretou evidência, não executou cutover e não autoriza retry. `READY_TO_MERGE=NO` até checks verdes. `READY_TO_RETRY_CUTOVER=NO` até merge, `main` verde e build do novo SHA.

O preview pode seguir após merge e `main` verde: não requer build/imagem nem backup novo porque só lê ambiente protegido, `applied.tsv` e catálogos em `READ ONLY`. `READY_TO_APPLY` exige exatamente uma evidência válida da transição de julho, PR827 ausente no histórico e catálogo, baseline material válido e `_prisma_migrations` ausente. O apply separado exige `APPLY_PR827_SCHEMA`, SHA congelado, backup recente/integral/aprovado e imagem do SHA. Estado parcial, histórico divergente, checksum/mode/owner/symlink inválido ou catálogo sem histórico bloqueiam. Não executar tenancy, ledger Prisma, baseline artificial, `db push`, seed ou backfill.

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

# Desbloqueio controlado do build para o ERP Production Recovery

No run `31707019441`, o SSH, fast-forward e SHA passaram; a chamada inicial `MODE=build EXPECTED_SHA="$EXPECTED_SHA" bash scripts/deploy-production.sh` falhou de forma compatível com a ausência comprovada de `/root/demetra-env/.env`. Para **build apenas**, o resolver usa: `/root/demetra-env/.env` válido → `/root/demetra-env/production.env` válido quando o canônico está ausente → falha fechada. Não combina fontes, não contorna canônico inválido e registra somente `ERP_PRODUCTION_ENV_SOURCE=canonical|legacy_build_only`. O legado é lido sem escrita e seu `ERP_SYNC_SCHEDULER_ENABLED=false` permanece intacto. Cutover não possui fallback. Nenhuma operação produtiva foi feita nesta PR; após merge, repetir Deploy Production `phase=build` e somente então executar o workflow ERP Production Recovery aprovado, que permanece pendente.

# Validação semântica da Saúde ERP — PR #799 (13/08/2026)

O gate oficial executa testes comportamentais da projeção antes do guard estático. Na validação
read-only, conferir pais `syncAll/manual` e `automatic/scheduler`, etapas classificadas, correlação e
ausência de soma pai+filhos. Zero exige coleta `available`; sem vendedor/carteira devem aparecer
como não instrumentados. Checks verdes não comprovam execução automática produtiva. Não disparar
sync ou recovery para validar esta PR.

# Gate operacional — Saúde ERP v2 (12/08/2026)

Antes de promover esta estabilização, execute `npm run test:platform-health-erp-observability` e os
checks oficiais. Depois do deploy autorizado, validar por leitura autenticada: snapshot, histórico,
scheduler, `nextRunAt` e lock liberado. Não disparar sync/recovery como health check e não converter
manual em automática. Falha/503 deve aparecer como indisponível, nunca zero. Rollback: revert da
entrega e publicação normal somente de API/WEB; não há ação de banco.

# Operação 1.0B.2-K — prova sintética do preview

Somente o Preview Deploy executa a janela bounded de 10 ciclos × 4 chamadas. Cada request deve ter HTTP 200/exit 0, ID interno único e exatamente um MATCH; logs são limitados por timestamps e pelos 40 IDs retornados. Atraso de log tem cinco retentativas de um segundo; rate limit/timeout falham fechados. No primeiro erro, registrar metadados técnicos, restaurar `TENANCY_MODE=disabled`/`TENANT_READ_PILOT_ENABLED=false`, recriar somente a API e falhar o deploy. Rerun preserva o volume e repete seed/certificação determinísticos sem reparo automático. Esta não é operação produtiva nem autorização de soak, mutation, backfill ou cutover. Veja [Sprint 1.0B.2-K](sprints/SPRINT_1_0B_2_K_PREVIEW_SHADOW_STABILITY.md).

# GATE DOCUMENTAL — DESENVOLVIMENTO 1.0B.2 (08/08/2026)

A decisão humana explícita aprova somente o desenvolvimento incremental do estágio EXPAND:
`READY_FOR_1_0B_2_DEVELOPMENT = YES`. Operação produtiva não foi autorizada:
`READY_FOR_MULTI_TENANT_CUTOVER = NO`, `DATABASE_SCHEMA_MODE=external` e
`TENANCY_MODE=disabled`. Não executar deploy, DDL, DML, backfill ou cutover com base neste gate.
**DEVELOPMENT APPROVED ≠ PRODUCTION CUTOVER APPROVED.** Consulte o
[registro de aprovação](sprints/SPRINT_1_0B_1_GATE_APPROVAL_FOR_1_0B_2.md).

# ENCERRAMENTO OPERACIONAL — OP-EXEC (08/08/2026)

No SHA `36be802887a005431dc5e1d9f4f7129d2145f102`, a evidência operacional fornecida comprova a
conclusão do control plane default-only. Esta seção registra resultados; não é autorização nem
comando para nova execução.

- [x] schema preview;
- [x] schema apply da migration `20260802120000_tenancy_control_plane` (`APPLIED_ONCE`);
- [x] validação posterior (`ALREADY_APPLIED`, sem reaplicação; managed diff 0 bytes);
- [x] dry-run do tenant default sem DML;
- [x] revisão humana (Gate Humano 2);
- [x] tenant apply: `tenant-default-v1` e 8 memberships;
- [x] reconciliação PASS, zero tenant inesperado, órfã ou duplicidade;
- [x] remoção das autoridades temporárias, credenciais e HBA (`TEMP_ROLE_COUNT=0`,
  `TEMP_HBA_COUNT=0`).

O runtime continua `DATABASE_SCHEMA_MODE=external` e `TENANCY_MODE=disabled`. Não houve cutover e
Multiempresa continua 🔴. **Próxima etapa futura:** avaliar o gate documental e humano para a
Sprint 1.0B.2; este runbook não autoriza nem fornece comandos de cutover.

# HISTÓRICO — CONTRATO DE PRODUÇÃO OP-EXEC (07/08/2026)

> **Contrato histórico preservado.** Produção deve usar
> `DATABASE_SCHEMA_MODE=external` e `TENANCY_MODE=disabled`. O bootstrap da API não executa
> `prisma db push`, seed, sequence setup ou qualquer DDL/DML de preparação. Schema só muda pelo
> fluxo administrativo versionado do [Brief OP-EXEC](sprints/SPRINT_1_0B_1_OP_EXEC_CONTROL_PLANE_CERTIFICATION.md),
> com backup, preflight, preview read-only, pausa humana e confirmação separada. A PR #774 está
> **🟡 Merge**, não em produção; esta entrega está **🔵 PR**. Toda descrição posterior de bootstrap
> com `db push` documenta operação anterior e não autoriza seu uso vigente.

# ADENDO OPERACIONAL PÓS-RECUPERAÇÃO

## Control plane default-only — R2 em PR

O fluxo futuro usa `production-tenancy-control-plane-preview.sh` (somente leitura),
`production-tenancy-control-plane-apply.sh` (DDL administrativo confirmado) e
`production-tenant-default-prepare.sh` (dry-run/apply DML separados). O registry não aceita paths
livres. Esta inclusão não autoriza execução: merge/check do mesmo SHA, backup, preflight, imagem OCI
pinada, identidades aprovadas e revisão das evidências são gates. Runtime continua `disabled`.

> 🔵 PR ainda não aplicada. Use exclusivamente `scripts/deploy-production.sh` e `docker-compose.production.yml` em futura janela aprovada. O PostgreSQL recuperado permanece separado; o Compose genérico é proibido para deploy. Preflight, cutover, rollback, evidências e comandos exatos estão no adendo de `DEPLOY_GUIDE.md`. O incidente não está encerrado.

O preflight corrige um falso negativo sem alterar a produção: como o hostname do PostgreSQL existe somente no DNS da rede Docker, a sondagem usa um container efêmero local `postgres:16`, sem pull automático, dentro de `gest-o_default`. Ela não consulta o DNS do host, não fixa IP e não recebe senha nem a `DATABASE_URL`. Nenhum deploy foi realizado; o estágio permanece 🔵 PR.


**Rollback:** nomes de containers não são artefatos de release. Antes de cada cutover, as imagens anteriores de API e WEB são etiquetadas separadamente e inventariadas. O rollback remove somente API/WEB novas e recria os serviços com as tags salvas; não depende de o container anterior existir e não administra o PostgreSQL. Consulte `DEPLOY_GUIDE.md`.

---

# Operação pós-merge do Gest-o

> **Pergunta que este runbook responde:** “Acabei de mesclar uma PR. O que faço agora?”

Este é o roteiro curto e executável do operador. A explicação completa da arquitetura, dos riscos, do rollback e dos diagnósticos está em [`DEPLOY_GUIDE.md`](DEPLOY_GUIDE.md).

## Resposta rápida

```text
anotar o SHA do merge
        ↓
acompanhar o workflow Deploy Production
        ↓
confirmar Git da VPS
        ↓
confirmar build e containers
        ↓
confirmar schema do banco
        ↓
health checks
        ↓
smoke tests
        ↓
confirmar commit da API
        ↓
confirmar frontend/menu
        ↓
confirmar scheduler e UltraFV3
        ↓
registrar o resultado
```

Para as correções já mescladas de segurança e restore, a ordem não cria um segundo deploy nem
mistura recuperação à publicação: **deploy oficial → convergência do SHA → validação read-only de
segurança → estabilidade → restore descartável em etapa separada e novamente autorizada**. Após o
deploy, use o [Brief da Sprint 0.4](sprints/SPRINT_0_4_SECURITY_RESTORE_OPERATIONAL_VALIDATION.md) e
`scripts/production-auth-security-validate.sh`; o restore nunca integra o deploy ou seu rollback.

## Regra principal

Um merge em `main` dispara automaticamente o workflow **Deploy Production**. O caminho preferencial é acompanhar esse workflow, não executar um segundo deploy em paralelo.

O deploy só está concluído quando:

1. o workflow terminou com sucesso;
2. o SHA em `origin/main`, na VPS, dentro da API e no domínio é o mesmo;
3. API, WEB e banco estão saudáveis;
4. o frontend público contém a build nova;
5. o scheduler está inicializado e coerente.

“PR mesclada”, “Git atualizado”, “workflow verde” e “container Up”, isoladamente, **não** comprovam que a versão chegou à produção.

## 1. Antes de começar

No GitHub, copie o SHA completo do merge e guarde-o como `SHA_ESPERADO`. Na VPS:

```bash
export SHA_ESPERADO='<sha-completo-do-merge>'
cd /apps/gest-o
set -a
[ ! -f /root/demetra-env/.env ] || . /root/demetra-env/.env
set +a
```

Não continue sem saber qual SHA deve estar em produção.

Também confirme:

- que ninguém está executando outro deploy;
- que o backup de produção está recente e válido;
- que não há incidente ativo no banco ou no UltraFV3;
- que há espaço disponível para construir novas imagens:

```bash
df -h
docker system df
```

## 2. Acompanhar o deploy automático

1. Abra **GitHub → Actions → Deploy Production**.
2. Localize a execução associada ao merge em `main`.
3. Confira que o job entrou em `/apps/gest-o`.
4. Aguarde o término do build de `api` e `web`.
5. Se o workflow falhar, pare e examine o log. Não trate a release como publicada.

O workflow executa remotamente:

```bash
cd /apps/gest-o
git fetch origin main
git checkout main
git pull --ff-only origin main
bash scripts/deploy-production.sh
```

## 3. Deploy manual, somente quando necessário

Use esta opção quando o deploy automático não tiver sido disparado e não houver outro job em execução. Preferencialmente, use **Run workflow**, informe `production` e acompanhe o GitHub Actions.

Se for necessário operar diretamente na VPS:

```bash
set -euo pipefail
cd /apps/gest-o
git status --short --branch
git fetch origin main
git checkout main
git pull --ff-only origin main
bash scripts/deploy-production.sh
```

O script oficial executa a sequência equivalente a:

```bash
git pull --ff-only origin main
        ↓
docker compose build api web
        ↓
docker compose up -d api web
        ↓
bootstrap da API: prisma db push
        ↓
bootstrap da API: garantia da sequence ERP
        ↓
API começa a atender e inicia o scheduler ERP
```

### Importante sobre migrations

Não há um comando adicional de migration para o operador rodar depois do `up`.

O container `api` executa automaticamente `prisma db push` **antes de abrir a API**. Embora existam arquivos SQL em `apps/api/prisma/migrations`, o deploy atual não usa `prisma migrate deploy`. Portanto:

- não rode `prisma migrate deploy` manualmente como parte deste fluxo;
- não rode `prisma migrate reset`;
- não rode `docker compose down -v`;
- não remova `gest-o_pgdata`;
- não execute seed em produção.

Se `prisma db push` falhar, o container da API deve falhar/reiniciar e o deploy deve ser considerado malsucedido.

## 4. Confirmar Git, imagens e containers

```bash
cd /apps/gest-o
git fetch origin main

printf 'esperado:    %s\n' "$SHA_ESPERADO"
printf 'checkout:    %s\n' "$(git rev-parse HEAD)"
printf 'origin/main: %s\n' "$(git rev-parse origin/main)"
git status --short --branch

docker compose ps
docker compose images api web
docker inspect "$(docker compose ps -q api)" \
  --format 'api image={{.Image}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
docker inspect "$(docker compose ps -q web)" \
  --format 'web image={{.Image}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
```

Pare se `HEAD`, `origin/main` e `SHA_ESPERADO` forem diferentes. `api`, `web` e `db` devem estar ativos; aguarde os healthchecks ficarem `healthy`.

## 5. Confirmar banco/schema

O check operacional mínimo é:

```bash
docker compose exec -T db \
  pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-salesforce_pro}"

bash scripts/check-prod-health.sh --strict

docker compose logs --since=15m api \
  | rg 'prisma db push|Database is now in sync|ERP order sequence|SCHEMA BOOTSTRAP FAILED|DB CONNECTION FAILED'
```

Resultado esperado:

- `pg_isready` aceita conexões;
- o check de tabelas críticas termina com sucesso;
- os logs não contêm `SCHEMA BOOTSTRAP FAILED` nem `DB CONNECTION FAILED`;
- o bootstrap registra a sincronização do schema e a preparação da sequence ERP.

O projeto não possui hoje um ledger confiável de “última migration aplicada”, pois usa `db push`. Para a auditoria detalhada de `_prisma_migrations`, drift e objetos SQL, siga a seção **Banco e migrations** do [`DEPLOY_GUIDE.md`](DEPLOY_GUIDE.md).

## 6. Health checks da API e da WEB

Execute:

```bash
curl -fsS "http://127.0.0.1:${API_PORT:-4000}/health"
curl -fsS "http://127.0.0.1:${API_PORT:-4000}/health/version" | jq .
curl -fsS "http://127.0.0.1:${WEB_PORT:-5173}/healthz"

curl -fsS https://crm.demetraagronegocios.com.br/ -o /dev/null
curl -fsS https://crm.demetraagronegocios.com.br/api/health/version | jq .
```

Qualquer erro HTTP, timeout ou JSON inválido bloqueia a conclusão do deploy.

## 7. Confirmar o commit realmente executado

```bash
COMMIT_CONTAINER="$(docker compose exec -T api \
  node -p "require('./apps/api/dist/build-info.json').commit" | tr -d '\r')"
COMMIT_LOCAL="$(curl -fsS "http://127.0.0.1:${API_PORT:-4000}/health/version" | jq -r .commit)"
COMMIT_PUBLICO="$(curl -fsS https://crm.demetraagronegocios.com.br/api/health/version | jq -r .commit)"

printf 'esperado:  %s\ncontainer: %s\nlocal:     %s\npúblico:   %s\n' \
  "$SHA_ESPERADO" "$COMMIT_CONTAINER" "$COMMIT_LOCAL" "$COMMIT_PUBLICO"

test "$COMMIT_CONTAINER" = "$SHA_ESPERADO"
test "$COMMIT_LOCAL" = "$SHA_ESPERADO"
test "$COMMIT_PUBLICO" = "$SHA_ESPERADO"
```

Os três `test` devem terminar com status zero. `unknown`, SHA antigo ou respostas divergentes significam que a publicação não foi comprovada.

## 8. Smoke tests

### Smoke técnico, sem alterar dados

```bash
curl -fsS https://crm.demetraagronegocios.com.br/ | head -n 5
curl -fsS https://crm.demetraagronegocios.com.br/api/health/version | jq .
docker compose logs --since=10m api web | rg -i 'error|exception|fatal|unhealthy' || true
```

O último comando é diagnóstico: examine cada ocorrência; `rg` encontrar a palavra `error` não significa automaticamente falha, pois pode haver mensagens históricas ou respostas externas tratadas.

### Smoke funcional no navegador

Em janela anônima:

- [ ] abrir `https://crm.demetraagronegocios.com.br`;
- [ ] autenticar com um usuário operacional de teste autorizado;
- [ ] confirmar que o menu lateral corresponde à PR mesclada;
- [ ] navegar por uma tela de leitura;
- [ ] confirmar que não há erro no console nem requisições 5xx;
- [ ] sair da sessão.

Não crie, altere, sincronize ou exclua dados apenas para provar o deploy, salvo se existir um caso de teste previamente aprovado.

## 9. Confirmar frontend e menu

O Git atualizado não atualiza sozinho o frontend: os assets Vite ficam dentro da imagem `web`. Compare o HTML servido pelo container e pelo domínio:

```bash
HTML_LOCAL="$(mktemp)"
HTML_PUBLICO="$(mktemp)"

curl -fsS "http://127.0.0.1:${WEB_PORT:-5173}/" -o "$HTML_LOCAL"
curl -fsS https://crm.demetraagronegocios.com.br/ -o "$HTML_PUBLICO"

printf '%s\n' 'Assets locais:'
rg -o 'assets/[^" ]+\.(js|css)' "$HTML_LOCAL" | sort -u
printf '%s\n' 'Assets públicos:'
rg -o 'assets/[^" ]+\.(js|css)' "$HTML_PUBLICO" | sort -u

rm -f "$HTML_LOCAL" "$HTML_PUBLICO"
```

As listas devem ser equivalentes. Depois, confirme visualmente o menu em janela anônima.

Se o menu permanecer antigo:

1. confira o image ID e `StartedAt` do `web`;
2. confira se os assets públicos são os mesmos do container;
3. confira `sudo nginx -T` e o upstream do domínio;
4. confira se existe outra stack ocupando a porta;
5. teste janela anônima/DevTools com cache desabilitado;
6. confira Application → Service Workers — não há service worker versionado, mas pode existir registro legado no navegador.

## 10. Confirmar scheduler

O scheduler ERP não é um container separado: ele roda dentro de `api`. Também não existe um serviço Compose separado chamado `worker`.

```bash
docker compose config --services
docker compose exec -T api sh -lc \
  'printf "ERP_SYNC_SCHEDULER_ENABLED=%s\n" "$ERP_SYNC_SCHEDULER_ENABLED"'
docker compose logs --since=30m api | rg 'erp-sync/scheduler|scheduler'
```

Com um token administrativo autorizado, valide o estado persistido sem disparar sincronização:

```bash
test -n "${ADMIN_ACCESS_TOKEN:-}"
curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/scheduler/status | jq .
curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  'https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/sync/history?limit=10' | jq .
```

Confirme `initialized`, `enabled`, `nextRunAt`, último sucesso/erro e `reasonCode`. API saudável não garante, por si só, que o scheduler executou com sucesso.

## 11. Confirmar UltraFV3 sem executar operações

```bash
docker compose exec -T api sh -lc '
  printf "BASE_URL_SET=%s USER_SET=%s PASSWORD_SET=%s KEY_SET=%s\n" \
    "${ULTRAFV3_BASE_URL:+true}" "${ULTRAFV3_USERNAME:+true}" \
    "${ULTRAFV3_PASSWORD:+true}" "${ERP_CREDENTIAL_ENCRYPTION_KEY:+true}"
'

curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  https://crm.demetraagronegocios.com.br/api/erp/ultrafv3/diagnostics | jq .
```

Não imprima credenciais ou tokens e não use POST de pedido/sincronização como health check.

## 12. Encerrar e registrar

Registre no ticket, PR ou diário operacional:

```text
Deploy UTC:
Operador:
PR:
SHA esperado:
SHA checkout:
SHA API local:
SHA API pública:
Image ID API:
Image ID WEB:
Banco:
API:
WEB:
Menu:
Scheduler:
UltraFV3:
Observações:
```

Marque o deploy como concluído somente quando todos os itens obrigatórios estiverem confirmados.

## Se algo falhar

1. Pare; não execute comandos destrutivos para “tentar de novo”.
2. Preserve logs, SHA e image IDs.
3. Determine se a falha está no Git, build, container, banco, Nginx, DNS ou navegador.
4. Consulte os cenários de versão antiga e o checklist de rollback em [`DEPLOY_GUIDE.md`](DEPLOY_GUIDE.md).
5. Para rollback, prefira um revert revisado e mesclado em `main`; nunca use `down -v`, `migrate reset` ou remoção do volume do banco.

## Gate operacional de schema antes do cutover

Não use `prisma db push` em produção. Depois de preflight e build, execute o preview com
`MODE=validate`, revise todo o SQL e, com aprovação humana/backup SHA256, execute separadamente
`CONFIRM=PRODUCTION_SCHEMA_APPLY bash scripts/production-schema-apply.sh`. Revise logs, hash,
`applied.tsv`, objetos criados e contagens `incident_*` em `/var/log/gest-o/schema/<SHA>/`. Só uma
janela posterior pode executar cutover. Rollback de containers não reverte schema; nunca apague
volume ou tabela de incidente. Comandos completos: [investigação](investigations/production-schema-transition-july-2026.md).

### Evidência estrutural pós-apply

Revisar `pre-apply-diff.raw.sql`, `pre-apply-managed-diff.sql`, `post-apply-diff.raw.sql` e o
`post-apply-diff.sql` vazio. O raw pós-apply pode conter exclusivamente os oito drops históricos que
o Prisma propõe por não gerenciá-los; qualquer outro DDL impede `applied.tsv` e o cutover.

## `DATABASE_SCHEMA_MODE`

- Produção real: `external`, fixo no `docker-compose.production.yml`; alteração de schema somente pelo
  apply separado e nunca por bootstrap.
- CI/preview descartável: `ephemeral-push`, explícito no Compose/workflow; o banco novo recebe `db
  push` antes de admin/smoke/preview seed.

`NODE_ENV` não é sinal de propriedade do banco. Nunca mude produção para `ephemeral-push`, nem use
flags de seed como autorização indireta. Ausência ou valor inválido deve falhar fechado.


## Validação operacional Enterprise — Sprint 0.5

A pergunta “esta instalação está saudável?” possui uma única rotina oficial. Ela é somente leitura,
não consulta o banco e não substitui deploy, restore, monitoramento prolongado ou decisão humana.
Execute apenas no host autorizado, depois de confirmar o SHA por fonte independente e preparar uma
conta de teste com privilégio mínimo. Não publique credenciais nem os logs brutos.

```bash
cd /apps/gest-o
EXPECTED_SHA='<sha-completo-esperado>' \
CONFIRM=PRODUCTION_HEALTH_VALIDATE \
AUTH_TEST_EMAIL="$AUTH_TEST_EMAIL" \
AUTH_TEST_PASSWORD="$AUTH_TEST_PASSWORD" \
DB_VOLUME='<volume-postgresql-aprovado>' \
SCHEMA_EVIDENCE_FILE='<applied.tsv-ou-manifesto-aprovado>' \
bash scripts/production-health-validation.sh
```

Pré-condições: checkout limpo no SHA, Docker disponível, containers conhecidos, DNS/TLS público,
evidência anterior de schema legível e diretório `/var/log/gest-o/health` gravável pelo operador.
A rotina falha se o diretório daquele SHA já existir, evitando sobrescrever prova. As credenciais e
token ficam somente em memória. O arquivo de schema é lido como evidência externa: nenhuma conexão
PostgreSQL é aberta.

A revisão deve conferir `health.tsv`, `runtime.tsv`, `containers.tsv`, `images.tsv`, `network.tsv`,
`storage.tsv`, `system.tsv`, `security.tsv`, `erp.tsv` e `summary.tsv`. `result.tsv` é criado somente
depois de todas as verificações; qualquer `FAIL` significa instalação **não certificada**, exige
triagem e não autoriza ação corretiva automática. Ausência de Docker é SKIP apenas no ambiente de
desenvolvimento/CI e nunca equivale a PASS operacional. Preserve permissões 0700 e não anexe
credenciais, corpos de autenticação ou logs brutos a tickets.

## Piloto read-only Client (1.0B.2-I)

Produção: `TENANCY_MODE=disabled` e `TENANT_READ_PILOT_ENABLED=false`. O procedimento test/preview, abort e rollback está em `docs/tenancy/TENANT_READ_PILOT_OPERATION.md`; a ausência de dataset preview certificado impede ativação nesta entrega.

### Piloto Client no Preview (1.0B.2-J)
Executar `npm run test:tenant-read-pilot-preview-seed`. A ativação é exclusiva do workflow preview e posterior aos checkpoints de seed/dataset. Em abort/MISMATCH, restaurar `TENANT_READ_PILOT_ENABLED=false` e `TENANCY_MODE=disabled`, recriar somente a API preview e confirmar ausência de evento shadow; nunca inspecionar payload ou acessar produção.
# Preflight tenant data readiness (somente ambiente descartável)

Execute `npm run test:tenant-data-readiness` e, com Docker, `npm run test:tenant-data-readiness:postgres`. O segundo comando recusa `DATABASE_URL`, não publica porta e deve terminar em `TENANT_DATA_READINESS_POSTGRES=PASS`. Não aponte esse harness à produção e não interprete PASS sintético como prontidão produtiva. Rollback é reverter código/gate; não existe rollback de dados porque o diagnóstico não escreve.
# Planejamento gated 1.0B.2-M

Executar `npm run test:preflight-gated-backfill-plan` e, em host Docker isolado, `npm run test:preflight-gated-backfill-plan:postgres`. O harness recusa `DATABASE_URL` herdada e não publica porta. READY gera apenas plano `dryRunOnly`; nunca autoriza apply. BLOCKED, quarentena, evidência expirada/adulterada ou replay conflitante exigem preservar hashes e códigos sanitizados, interromper e obter nova evidência formal. Rollback remove apenas tooling/gate/documentação; não existe DML ou ledger produtivo a desfazer.
# Prova descartável 1.0B.2-N

Execute `npm run test:preflight-plan-ledger:postgres` somente em host Docker de desenvolvimento/CI,
sem `DATABASE_URL` ou `TEST_DATABASE_URL`. O runner cria `postgres:16` sem porta, valida concorrência,
SQLSTATE, crash, grants e catálogo, desfaz todo o DDL e exige
`PREFLIGHT_PLAN_LEDGER_POSTGRES=PASS`. Nunca aponte esse harness para produção.

O head remoto `029fab54d32413d0e94308227c0ae591144b7ee7` foi comprovado no Preview Deploy
31432019343 e no Docker Compose CI 31432019733 (`compose-smoke` 93597451158), ambos PASS. Isso
certifica o procedimento descartável, não autoriza executar o candidato fora do CI/desenvolvimento.

## Controles duráveis dos harnesses

- `pg_isready` não prova que o database solicitado aceita sessão: readiness autoritativa abre o
  database exato com `psql -X`, `ON_ERROR_STOP=1`, `SELECT 1`, exit zero e stdout literal validado.
- Constraints sobrepostas tornam `ON CONFLICT` parcial inadequado para replay concorrente. Evidência
  e plano usam advisory transaction locks namespaced, ordem determinística, replay
  `IDEMPOTENT_REPLAY` e conflito divergente `23505`.
- Papel e grants são auditados respectivamente por `pg_catalog.pg_roles` e
  `information_schema.table_privileges`, sobre inventário fechado e literal — nunca por `LIKE`.
- Cada concorrência captura dois PIDs, waits, exit codes e stdout/stderr separados; `HARNESS_STEP` e
  `HARNESS_COMMAND` mudam antes de cada fase para impedir diagnóstico stale.
- Cenários usam IDs/hashes exclusivos; `p3` é reservado ao crash/rollback. O teardown é testado com
  rollback, executado realmente e seguido de comparação exata com o catálogo baseline.
# Recuperação controlada do scheduler UltraFV3

O workflow manual **ERP Production Recovery** é exclusivo para `INC_ERP_5050`. Ele não substitui o
deploy geral. Antes de dispará-lo, mescle a PR de recuperação, execute a fase `build` do workflow
**Deploy Production** para o mesmo SHA e confirme que a imagem `gest-o-api:<SHA>` foi preparada na
VPS. Em **Actions → ERP Production Recovery → Run workflow**:

1. selecione a branch `main` já mesclada;
2. informe `confirm` exatamente como `RESTORE_ERP_AUTOMATIC_SYNC`;
3. informe em `expected_main_sha` os 40 caracteres do SHA aprovado da `main`;
4. aguarde a aprovação humana do environment `production-cutover`;
5. acompanhe somente os checkpoints sanitizados do job.

As credenciais do login de validação são os secrets `AUTH_TEST_EMAIL` e `AUTH_TEST_PASSWORD` do
environment `production-cutover`. Elas entram somente na memória da sessão SSH, não são inputs do
dispatch, não pertencem a `/root/demetra-env/.env` e não são persistidas em evidências. Antes de criar
backup, candidato ou alterar containers, o script exige essas entradas, descobre a única API/WEB em
execução, deriva a imagem WEB real e comprova `gest-o-api:<expected_main_sha>` e sua label de revisão.

O job atualiza `/apps/gest-o` exclusivamente por fast-forward, exige igualdade do SHA e executa
`scripts/erp-production-recovery.sh`. O script inspeciona apenas metadados dos caminhos canônico e
legado, cria backups protegidos, altera atomicamente somente `ERP_SYNC_SCHEDULER_ENABLED`, executa os
dois preflights e valida o Compose sem mostrá-lo. Depois preserva a imagem anterior e as identidades
de WEB/PostgreSQL/volume, recria somente `api` com `--no-deps --no-build --force-recreate`, valida
health, login, configuração persistida, credencial global ou de vendedor de referência, lock e
`nextRunAt`, e aguarda de forma bounded uma execução real com `trigger=scheduler`.

O gate `ERP_SYNC_SCHEDULER_ENABLED` deve existir exatamente uma vez na fonte protegida. Ausência ou
duplicidade aborta a preparação; a recuperação não cria um contrato de env incompleto implicitamente.

Interpretação operacional:

- `ERP_ENV_RECOVERY_SOURCE=NOT_AVAILABLE`: abort antes de container; nenhuma credencial é criada;
- checkpoints `=PASS`: aquela validação foi comprovada, mas o incidente só pode ser resolvido quando
  também houver `ERP_AUTOMATIC_SYNC=PASS`, `ERP_SYNC_LOCK=RELEASED` e persistência do env;
- `ERP_RECOVERY_ROLLBACK=STARTED/COMPLETED`: uma validação crítica falhou; env e API anteriores foram
  restaurados, e `INC_ERP_5050` continua `INVESTIGATING`;
- ausência do resultado final: tratar como falha/interrupção, revisar o estágio sanitizado e não
  repetir até verificar health e a exclusão mútua do workflow.

O rollback é automático para health, login, scheduler, `nextRunAt`, credencial de referência, lock,
múltiplas APIs ou expiração da janela automática. É proibido disparar sincronização manual como
prova, executar `down`, remover volumes, recriar WEB/PostgreSQL, rodar migrations, `prisma db push`,
seed ou backfill. O job nunca aceita secrets como inputs nem imprime env, resposta de login ou dados
empresariais.

### Interpretação do lock ERP

`ErpSyncLock` usa uma linha exclusiva por escopo. A aquisição cria a linha ou assume atomicamente uma
linha cujo `lockedUntil` já expirou; não há renovação periódica. A liberação remove a linha por
`scope+runId` no `finally`. Assim, linha futura é lock ativo legítimo e bloqueia a recriação; linha
expirada é `expired_recoverable`, não “órfã” automática; ausência após a execução é `free/released`.
Crash pode deixar a linha até o TTL, quando a próxima aquisição pode recuperá-la. A prova continua
exigindo execução `scope=automatic`, `trigger=scheduler`, sucesso posterior à recriação e estado final
sem linha de lock.
# Diagnóstico observável antes do build — run 31713219051

O run fez fast-forward até `443be81e35a15e37158a93161b105c1aa81690b2` e parou no antigo
`test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"`, antes do resolver. O log não registrou os operandos,
logo não autoriza afirmar qual deles divergiu. Em uma futura execução autorizada, exigir na ordem
`DEPLOY_GIT_FETCH`, `DEPLOY_GIT_SWITCH`, `DEPLOY_GIT_FAST_FORWARD`,
`DEPLOY_EXPECTED_SHA_FORMAT`, `DEPLOY_CHECKOUT_SHA_MATCH`, `DEPLOY_WORKTREE_CLEAN`,
`DEPLOY_SCRIPT_PRESENT` e `DEPLOY_SCRIPT_STARTING=build`. Ausência ou `FAIL` bloqueia o deploy e deve
ser analisada pelos campos sanitizados `DEPLOY_FAILURE_*`. Esta correção não autoriza retry, cutover
ou Recovery; nenhuma dessas operações foi executada.
# Run 31720219813 — procedimento de retomada do build

No job `94515047904` (SHA `a3f900b05cbbcc2ab9ee8bba306c4a2cea524d97`), os checkpoints
`DEPLOY_GIT_FAST_FORWARD`, `DEPLOY_EXPECTED_SHA_FORMAT`, `DEPLOY_CHECKOUT_SHA_MATCH`,
`DEPLOY_WORKTREE_CLEAN`, `DEPLOY_SCRIPT_PRESENT`, entrada/`MODE=build`, resolução
`legacy_build_only` e scheduler desativado passaram. A execução parou no preflight:
`TENANCY_MODE does not match the production policy`. Não houve build/cutover/Recovery nem acesso ou
mudança de produção.

O deploy cria o env efetivo somente para `MODE=build + legacy_build_only`, fora do checkout e do
diretório canônico, mode 600, com cleanup por trap. Ele rejeita gates duplicados/malformados,
normaliza somente a cópia, executa preflight/Compose/build com ela e comprova a imutabilidade da
fonte por SHA-256. O cutover rejeita legado e overlay; canônico inválido nunca usa fallback. Após
merge e checks verdes, a única retomada autorizada é repetir Deploy Production com `phase=build`.

# Operação do preflight por modo

Sempre invocar o preflight com exatamente `PRODUCTION_PREFLIGHT_MODE=build` ou
`PRODUCTION_PREFLIGHT_MODE=cutover`; ausência e outros valores falham fechado. Os dois modos fazem
as verificações read-only de checkout, PostgreSQL, rede, container, volume, disco e exigem backup e
manifesto válidos por `sha256sum -c`. O preflight nunca cria, toca, move, renova ou remove backup.

No build, exigir `PRODUCTION_BACKUP_FRESHNESS=NOT_REQUIRED_BUILD_ONLY`; o build somente produz
imagens, não interrompe/recria containers e não autoriza cutover. No cutover, exigir
`PRODUCTION_BACKUP_FRESHNESS=PASS`; backup antigo falha como `backup_stale` antes de ação mutável.
`backup_missing`, `backup_integrity` e `invalid_preflight_mode` distinguem os outros bloqueios sem
expor valores protegidos. `PRODUCTION_PREFLIGHT=PASS` só aparece ao final de todos os gates.

O run `31723282307` não mudou produção. Recovery segue separado, dependente de imagem aprovada e
de suas precondições; build verde não comprova scheduler, sincronização, persistência ou `nextRunAt`.

## Correção do contrato de `docker inspect` do backup de Recovery (25/08/2026)

O diagnóstico sanitizado executado na VPS, com o mesmo usuário do workflow, comprovou: CLI Docker disponível, probe do daemon com exit 0 e stderr vazio, consulta ancorada pelo nome exato com exit 0/cardinalidade 1/stderr vazio, seguida de `docker inspect` com exit 1, stdout vazio e stderr classificado como `template_error`. Portanto, daemon, permissão, nome e cardinalidade estão operacionais; a causa comprovada é o template Go anterior, sanitizado como `docker inspect -f '{{.Name}}{{"\\t"}}{{.Id}}{{"\\t"}}{{.State.Running}}{{"\\t"}}{{if .State.Health}}{{.State.Health.Status}}{{end}}' <identidade-em-memória>`, que agregava acesso a campos e delimitadores em uma única avaliação de template.

A correção remove esse template da inspeção de identidade: `docker inspect <identidade-em-memória>` fornece o JSON nativo, validado como array unitário por parser estrito antes de extrair nome, ID completo, `State.Running` e health. Ausência/nulo de `State.Health` é a única aceitação de container sem healthcheck; healthcheck presente exige `healthy`. Falhas são classificadas, sem stderr bruto, como `template_error`, `object_not_found`, `permission_denied`, `daemon_unreachable` ou `malformed_inspect_output`. Permanecem inalterados nome exato e cardinalidade unitária, identidade completa somente em memória, revalidação TOCTOU imediatamente antes de `docker exec -i "$PRODUCTION_DB_CONTAINER_EXPECTED" pg_dump ...`, redaction e todos os gates posteriores.

Esta correção e suas regressões são locais. Nenhum workflow produtivo, backup, promoção produtiva, Recovery, cutover, migration, seed, backfill, sincronização, alteração de env protegido ou recriação de container foi executado; produção não foi acessada. `READY_TO_MERGE_DATABASE_INSPECT_TEMPLATE_FIX=NO`; `PRODUCTION_BACKUP_PREPARATION=NOT_PROVEN`; `ERP_PRODUCTION_RECOVERY_WORKFLOW=NOT_EXECUTED`; `ERP_AUTOMATIC_SYNC=NOT_PROVEN`; `INC_ERP_5050=INVESTIGATING`; `READY_FOR_1_0B_2_O=NO`; `PRODUCTION_ACCESSED=NO`.
# Operação futura do schema da PR #827

## Preparação canônica do environment após a PR827

A falha do cutover em `environment_resolution` ocorre porque a VPS possui somente a fonte
legada protegida, classificada como `legacy_build_only`; o resolvedor permite essa fonte no
`build`, onde um overlay temporário desativa efeitos, mas exige a fonte canônica no `cutover`.
O caminho canônico autorizado é `/root/demetra-env/.env`; ambos os arquivos devem ser regulares,
sem symlink, `root:root` e modo `600`.

Após merge e `main` verde, execute **Prepare Canonical Production Environment**, no environment
protegido `production-cutover`, informando exatamente `PREPARE_CANONICAL_PRODUCTION_ENV`. O fluxo
valida sintaxe, nomes únicos, presença/formato sanitizado das chaves de banco, autenticação, ERP,
JWT e gates fechados; copia os bytes sem alterar valores, faz `fsync` e `rename` atômico e confirma
a imutabilidade do legado. Não copie `.env` manualmente. Aceite somente os sete marcadores finais,
de `PRODUCTION_ENV_SOURCE=canonical` até `READY_FOR_CUTOVER=YES`. Depois disso, valide a execução;
o cutover continua sendo um workflow separado e **não deve ser disparado sem nova confirmação**.

1. Com `main` congelada e checks verdes, execute o workflow **Production Schema PR827** em `preview`; não informe confirmação.
2. Exija os cinco gates `PR827_SCHEMA_*`/`PR827_MIGRATION_*` de preflight, predecessor, checksum, ledger e catálogo.
3. Somente após aprovação humana e backup canônico fresco, execute `apply` digitando `APPLY_PR827_SCHEMA` no environment protegido.
4. Exija os seis gates pós-apply, inclusive ledger, catálogo, diff vazio, compatibilidade antiga e idempotência. Não prossiga ao cutover em qualquer divergência.

O runner aceita somente `20260827190000_add_erp_order_manual_resolution`, uma migration por execução. Se já aplicada corretamente, não reaplica SQL. Nunca usar `prisma db push`, `migrate dev`, `migrate reset`, seed ou backfill. Em falha após aplicação, reverta apenas API/WEB; não remova o schema expandido nem altere o ledger. Estes são comandos para uma janela futura, não foram executados nesta tarefa.

## Diagnóstico read-only do ledger PR827

Não tente criar `_prisma_migrations`, usar `migrate resolve` nem alterar `search_path`.
O modo `preview` do workflow PR827 consulta somente o banco allowlisted e publica
classes, nunca URL/host/porta/credenciais ou nomes de schemas não allowlisted. Exija os
marcadores `CONNECTED_DATABASE_CLASS`, `CONNECTED_SCHEMA_CLASS`, `SEARCH_PATH_CLASS`,
`PRISMA_LEDGER_LOCATION`, `PRISMA_LEDGER_VISIBILITY`, `PREDECESSOR_CATALOG_STATE` e
`PR827_CATALOG_STATE`. `ABSENT`, `OTHER_SCHEMA_REDACTED`, `PERMISSION_DENIED`,
`PARTIAL` ou divergência são bloqueio, não sucesso.

O Deploy Production não ocorre automaticamente após merge: seu único trigger é
`workflow_dispatch`. Apenas CI/preview associados a `push`/PR são automáticos. Não
repita manualmente `phase=build` se já existir uma execução verde do mesmo SHA e os
mesmos gates com imagens OCI pinadas ainda presentes; valide e reutilize essa evidência.
No estado desta investigação, não foi possível consultar runs de Deploy autenticados,
logo build do SHA atual não está comprovado.

Proposta documental, não implementada: um orquestrador recebe o SHA de `main` verde,
valida uma prova de build existente ou dispara uma única build, prepara backup canônico
e então chama preview. Somente a transição para apply usa environment com aprovação
humana e confirmação literal. Falha em qualquer artefato/SHA encerra o fluxo.
# Gate PR827 PostgreSQL 16

Antes de considerar a correção diagnóstica pronta, o Docker Compose CI deve executar com sucesso `npm run test:pr827-preview:postgres`. SKIP 77 é tolerado somente em ambiente local sem a imagem; não é aceite remoto. Não executar preview produtivo, apply, migration, backup, deploy, Recovery ou cutover nesta correção.

## PR827 final — histórico legado e incidente UltraFV3/Tailscale (31/08/2026)

O run `33383729453`/job `99461567959` falhou no estágio de metadata da raiz do histórico, antes de PostgreSQL e sem escrita: `SCHEMA_EVIDENCE_DIR_MODE` recebeu a classe produtiva `755_PROTECTED_BUNDLE_ROOT`, enquanto o runner permitia apenas `700_OWNER_PRIVATE` e `750_GROUP_TRAVERSE`. Isso não era `ERP_PRODUCTION_ENV_SOURCE=legacy_build_only`, `PR827_ENV_SOURCE=legacy_copy`, nem o modo `preview/apply`; era a permissão da raiz que contém os bundles protegidos. O contrato agora valida explicitamente o par `legacy_build_only:legacy_copy`, aceita somente 700/750/755 na raiz, mantém diretórios de bundle em 700 e `applied.tsv`/`migration.sha256` em 600, e registra apenas variável, classes, classe recebida e estágio. Valores desconhecidos falham sem fallback. Preview e apply suportam exclusivamente `applied.tsv` + `migration.sha256`; `_prisma_migrations` e `tenancy_expand_roots` não são exigidos. Preview não exige imagem e não escreve.

A causa operacional comprovada da indisponibilidade foi o peer Windows “servidor” offline no Tailscale; a VPS permaneceu conectada. Após reconectar o Windows e iniciar o UltraFV3Rest, as simulações passaram e um único novo pedido real foi confirmado como ERP **900113**. Isso não caracteriza defeito do Tailscale e não autoriza novo pedido para evidência. O pedido antigo `6f5edc8a-55a7-4502-a816-a8b94b8e67c2`, confirmado ausente por operador no UltraFV3, permanece imutável e bloqueado até o diretor registrar resolução append-only e o fluxo criar exatamente uma tentativa com `supersedesErpOrderSyncId`; nunca há resolução ou reenvio automático.

Antes de simulação/envio, `GET /salesmen` funciona como preflight read-only limitado a 10 s. Falha de timeout/conexão/autenticação bloqueia antes de qualquer `ErpOrderSync` e apresenta: “UltraFV3 indisponível. Verifique se o servidor, Tailscale e UltraFV3Rest estão conectados antes de tentar novamente.” Logs registram somente `correlationId`, classe `ERP_REACHABILITY`, classe de endpoint, duração e razão `timeout|connect|auth|5xx`. `scripts/diagnose-ultrafv3-reachability.sh` faz diagnóstico periódico GET-only, publica estado sanitizado para Saúde da Plataforma e retorna falha para o alertador; recuperação jamais chama `POST /orders`. No Windows, `scripts/windows/Ensure-UltraFV3Connectivity.ps1` configura o serviço Tailscale como Automatic, verifica conexão e inicia UltraFV3Rest apenas se parado, de forma idempotente e sem dados de rede no log. Instalação/execução remota não faz parte desta entrega.

Alternativas documentadas, não implementadas: manter Tailscale com autostart/watchdog é a recomendação atual; Cloudflare Tunnel autenticado e WireGuard site-to-site são alternativas futuras; IP público fixo/porta exposta não é recomendado sem reverse proxy, TLS, firewall, autenticação forte e allowlist.

### Instalação manual do watchdog (não executar por esta PR)

Na VPS, após revisão do operador, instalar o probe a cada minuto com um timer systemd que execute `ULTRAFV3_BASE_URL` via arquivo de ambiente protegido e `scripts/diagnose-ultrafv3-reachability.sh`. Tratar exit code diferente de zero como alerta e montar `/var/run/gest-o/ultrafv3-reachability.json` read-only na API. O probe usa somente `GET /salesmen`, timeout 1–10 s e jamais autentica, persiste tentativa ou reenvia pedido.

No Windows, revisar os paths e criar uma tarefa **SYSTEM**, no boot, para PowerShell `-NoProfile -ExecutionPolicy AllSigned -File C:\Gest-o\Ensure-UltraFV3Connectivity.ps1`. A mesma tarefa pode repetir a cada minuto: o script é idempotente, mantém `Tailscale` em `Automatic`, só inicia UltraFV3Rest quando não há processo e registra estado sanitizado. Não instalar remotamente nesta entrega.
## Prova de backup exigida pelo apply PR827

Dispare **Prepare Production Recovery Backup** somente após merge e `main` verde, com confirmação e SHA completo aprovados. O workflow deve terminar com `PRODUCTION_BACKUP_PR827_PROOF=PASS` e `PRODUCTION_BACKUP_FINAL_FILESYSTEM_VALIDATION=PASS`. O único contrato aceito é `/var/log/gest-o/backup/latest/result.tsv`, dentro do bundle v1 que contém também `dump.sql.gz` e `dump.sql.gz.sha256`. Não crie o resultado manualmente, não copie resultados antigos e não use evidências de `schema`, `tenancy` ou `control-plane`. O apply continua proibido até que uma execução nova publique e releia com o parser compartilhado uma prova íntegra, protegida, do SHA aprovado, banco `salesforce_pro` e dentro da janela de freshness.
