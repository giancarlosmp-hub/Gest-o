## Cadastramento e gate da migration `20260927160000_product_price_source_observation` (28/09/2026)

Na Implantação da Produção nº 188 (commit `244cd1f`), o cutover foi bloqueado fail-closed pelo gate de evidência de schema porque a PR #899 adicionou a migration `20260927160000_product_price_source_observation`. A verificação de equivalência Git da árvore `apps/api/prisma` detectou legitimamente a alteração de schema em relação ao commit produtor de evidências anterior e impediu o cutover sem a aplicação da nova migration em produção.

A migration `20260927160000_product_price_source_observation` está devidamente cadastrada no registro imutável `scripts/production-schema-migrations.mjs` (SHA-256 `5f15e0ec506452ee9f341fa836ad9857baf1bf523f5dd1c7e21bea8f93079e70`), com suporte completo no leitor `scripts/schema-evidence-validation.sh`, no aplicador `scripts/production-schema-apply.sh`, no filtro pre-apply `scripts/schema-diff-filter.mjs` e no workflow `.github/workflows/production-schema-pr827.yml`.

**Procedimento para liberação do próximo cutover:**
1. Acessar o GitHub Actions e selecionar o workflow **Production Schema PR827**.
2. Executar primeiro em `mode=preview` com `migration=20260927160000_product_price_source_observation` e `confirm` vazio.
3. Revisar o relatório do preview read-only.
4. Executar em `mode=apply` com `migration=20260927160000_product_price_source_observation` e `confirm=PRODUCTION_SCHEMA_APPLY`.
5. Após o término com sucesso do apply e a publicação da evidência em `/var/log/gest-o/schema/`, disparar o **Deploy Production** com `phase=cutover`.

## Validação e aplicação da regra LIBERAR_INTERNET no CRM (Setembro/2026)

A alteração para impor a regra `LIBERAR_INTERNET` em Operações e Condições de Recebimento no CRM
é puramente lógica no código (API backend e Frontend web). **Não exige migration de banco de dados.**
Após o deploy normal da aplicação:
1. Executar o teste de fumaça de validação: `npx tsx scripts/smoke/liberar-internet-safety.mjs`.
2. Verificar se a listagem de operações de oportunidade omite opções com `LIBERAR_INTERNET != "S"` (ex.: Operação 99) e Operações com `VENDAS != "S"` (ex.: Operações 320 e 340).
3. Confirmar que requisições diretas com códigos não autorizados ou ausentes/nulos/inválidos são rejeitadas com erro HTTP 400.
4. Confirmar que pedidos históricos gravados em `ErpOrderSync` continuam 100% legíveis e inalterados.

## Imagens de preview após fechamento de PR (16/09/2026)

O `Preview Deploy` incorpora labels de proveniência na imagem final API/WEB e publica manifesto com IMAGE IDs completos. O `Preview Cleanup` é a única automação de encerramento: possui concorrência por PR, valida metadados autenticados do GitHub, executa o `compose down -v` escopado e revalida imediatamente containers, tags, digests, labels e evidências protegidas antes da remoção sem force. Qualquer falha preserva. Não criar cleanup paralelo, não usar prune e não usar imagens de preview como rollback produtivo. Imagens legadas continuam fora do apply automático.

## Gate de evidência de Pedidos e retomada do cutover (08/09/2026)

O Production Schema PR827 #26 (run `34243463045`) aplicou e pós-validou a migration `20260904120000_orders_operational_view` na main `ee6211b4809ae9dac109dea8bae8dafcd4d4c486`; portanto o schema de Pedidos já existe. O bundle não satisfez o contrato: a primeira rejeição de `validate_schema_evidence` foi o diretório do SHA em modo 755, pois ele deve ser diretório real `root:700`; `applied.tsv`, `migration.sha256` e `post-apply-diff.sql` também devem ser arquivos regulares, não symlinks, `root:600`.

No Deploy Production `34278387474`/job `102236939425`, para `99b4473b900f88a6d6018f906b0bc3a0a3eff0c9`, preflight, imagens e build-info passaram e nenhum container foi parado. O consumidor encontrou o `applied.tsv` protegido produzido por `a4e0e4560870f07e44b75d88e761c909f00fb7f4`; toda `apps/api/prisma` era Git-equivalente, mas uma segunda regra recusou arquivos normais de API/WEB da PR #861 por não estarem na allowlist operacional. Essa regra era redundante e conflitava com a equivalência já usada pelo bundle tenancy.

O fallback de `applied.tsv` agora segue o mesmo limite de segurança: valida integralmente o bundle contra o SHA produtor (tipo, symlink, owner, modos, formato, migration existente e checksums), exige produtor e SHA atual existentes e aceita somente equivalência Git da árvore Prisma completa. Qualquer divergência falha fechada. A validação de catálogo e o `prisma migrate diff` ao vivo continuam obrigatórios antes de `docker stop`. Mudança apenas em aplicação, frontend ou documentação não autoriza nem requer executar **Production Schema PR827** para republicar evidência.

## Gate PR827 para histórico de Pedidos (08/09/2026)

- O run `34181699345` não deve ser repetido como apply: a exceção ocorreu antes do commit; por atomicidade, `UPDATE 226` e DDL foram revertidos, e `applied.tsv` não foi publicado.
- Abrir primeiro o modo `preview` no workflow existente, sem confirmação de apply. O diagnóstico é versionado, agregado e read-only; não criar workflow/environment alternativo.
- Autorizar apply apenas quando `authority_ready=1`, as contagens forem conciliadas e houver exatamente um Tenant existente e ativo. Mais de um tenant, Opportunity/Client ausente ou tenant inválido deve falhar fechado.
- Após eventual apply aprovado, exigir contagens idênticas para Client, Opportunity, ErpOrderSync, TimelineEvent, Activity e OpportunityChangeLog; zero tenant nulo; e exatamente um `migration-backfill` por pedido. Não fazer merge/cutover como parte da investigação.

## Production Schema PR827 — regressão de resolução do environment (08/09/2026)

O run `34179257031` falhou antes do runner com `[production-env-resolution] FAIL: more than one authorized environment source is present`. O estado é legítimo e foi criado pelo procedimento oficial: `/root/demetra-env/.env` é a fonte canônica, enquanto `/root/demetra-env/production.env` permanece preservado para legado/rollback. A correção remove somente a política `PRODUCTION_ENV_REQUIRE_EXACTLY_ONE=true` do workflow **Production Schema PR827**; nenhum arquivo da VPS deve ser alterado, excluído, movido ou renomeado.

A resolução permanece fail-closed e sem merge de fontes: a presença do canônico torna sua validação e seleção obrigatórias; um canônico inválido falha sem fallback; o legado só pode ser considerado quando o canônico estiver ausente. A regressão automatizada cobre canônico válido + legado válido, canônico inválido + legado válido e redaction de valores protegidos. Nenhuma migration, schema, banco, container, secret ou scheduler ERP foi alterado ou executado por esta correção. A nova PR deve ser validada contra `main` e não deve ser mesclada automaticamente.

## Retomada controlada de Pedidos após a PR #857 (08/09/2026)

A retomada autorizada é estritamente sequencial: **merge da PR #857 → obter o novo SHA de `main` → preparar novo backup protegido → executar Deploy Production em `phase=build` → executar preview read-only de Pedidos → obter aprovação → executar apply confirmado → validar a evidência protegida e o diff Prisma vazio → executar Deploy Production em `phase=cutover` → executar validação pós-deploy**. Um resultado de etapa anterior não autoriza pular a seguinte.

O cutover deve continuar bloqueado antes de `docker stop` se a evidência equivalente de schema não validar. Não use ERP Production Recovery para aplicar o schema, não habilite o scheduler e não recrie containers como substituto do fluxo. A PR #856 já mesclada entrega código, mas não prova que Pedidos esteja implantado.

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

# Guia de deploy do Gest-o

Consulte o [Documento Mestre](DOCUMENTO_MESTRE.md) para o estado oficial e a prioridade. Este guia guarda a arquitetura, os riscos e a execução dos procedimentos.
