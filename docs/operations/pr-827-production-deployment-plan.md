# Plano operacional pós-merge da PR #827

## Adendo — runner habilitado no código (não executado)

A causa raiz era o caminho produtivo legado fixado em `20260731150000_safe_production_schema_transition`, enquanto o registro allowlisted terminava no control plane e não conhecia a migration da PR #827. O novo workflow chama `preview/apply` para uma única migration explícita, `20260827190000_add_erp_order_manual_resolution`, cujo predecessor obrigatório é `20260808120000_tenancy_expand_roots`. Os checksums esperados são, respectivamente, `61b4443a685471ea0425613d97da35a06cedf677d77c26807ce7ff27ccdb5b9e` e `90b25a912cd48ae03eb662355ebff271e9a84e63bc11b75f9ec0b41d2669d996`.

Call graph anterior: `Deploy Production(build) → production-deploy-entrypoint → build` (sem schema); o apply documental separado apontava diretamente para a migration de julho, executava `psql` e criava apenas evidência local, sem ledger Prisma. Call graph novo: `Production Schema PR827 → preview/aprovação+confirmação → pr827-schema-runner → SQL allowlisted → transação DDL+_prisma_migrations → catálogo exato → post-diff vazio`. Ledger aplicado com catálogo incompleto, catálogo sem ledger/parcial, predecessor ausente, checksum divergente, alvo incorreto e diff residual são falhas fechadas. Aplicado válido é idempotente. A migration continua expand: não remove objetos, não altera dados, não exige backfill, adiciona somente coluna nullable à tabela existente e é compatível com rollback da API. Nenhuma produção foi executada; a decisão permanece `SAFE_TO_DEPLOY=NO` até merge do runner e main pós-merge verde.


Data da análise: 2026-08-28. Este documento é somente um plano. Nenhum acesso à
produção, deploy, migration, Recovery, seed, backfill ou sincronização foi executado.

## Resultado executivo

```text
MAIN_SHA = 264310b80876249789c81afc3fdf6de2024c8d7f
PR_827_PRESENT = YES (merge ac088fe e commits 977c558, 9b63eda, 553afa8 e 584bf50 são ancestrais)
MIGRATION_CLASSIFICATION = EXPAND_COMPATIBLE, ADDITIVE, NULLABLE_ON_EXISTING_TABLE, NO_DESTRUCTIVE_REWRITE
OLD_API_COMPATIBLE_WITH_NEW_SCHEMA = YES
BACKUP_REQUIRED = YES, canonical, íntegro e fresh no preflight de schema/cutover
BUILD_WORKFLOW = GitHub Actions / Deploy Production / phase=build / SHA exato acima
SCHEMA_WORKFLOW = IMPLEMENTADO_NESTA_PR, NÃO EXECUTADO: Production Schema PR827 aplica somente 20260827190000 e registra ledger Prisma atomicamente
CUTOVER_WORKFLOW = GitHub Actions / Deploy Production / phase=cutover / SHA exato acima / environment production-cutover
SCHEDULER_PR_IMPACT = NOT_PROVEN; confirmar PR aberta e rebase antes da janela, sem executar ERP Production Recovery
SAFE_TO_DEPLOY = NO
READY_TO_RESOLVE_REAL_ORDER = NO até deploy e smoke aprovados
```

O `MAIN_SHA` é o HEAD integral disponível neste checkout e inclui também a PR #828,
posterior à #827. Antes de qualquer janela, o operador deve repetir `git fetch origin
main`, exigir que `git rev-parse origin/main` continue igual ao SHA aprovado e substituir
o SHA deste plano se a `main` avançar. O checkout entregue não possui remote configurado
nem credencial para consultar PRs abertas; por isso o estado de uma PR separada do
scheduler não pode ser promovido de `NOT_PROVEN` por inferência.

## Diagnóstico da migration

`20260827190000_add_erp_order_manual_resolution` somente:

1. cria dois enums;
2. adiciona `ErpOrderSync.supersedesErpOrderSyncId` sem `NOT NULL` e sem default;
3. cria uma tabela inicialmente vazia, seus índices e quatro FKs.

Não há `DROP`, alteração de tipo, `UPDATE`, backfill, seed, default sobre tabela
existente ou validação que reescreva as linhas de `ErpOrderSync`. A única coluna nova
na tabela existente é nullable. Logo, a API antiga ignora todos os objetos novos e
continua compatível durante a janela schema-expand → cutover. A criação dos índices/FKs
ainda deve ser tratada como DDL com locks e monitorada, embora não seja rewrite
destrutivo.

## Bloqueadores encontrados

1. `Deploy Production phase=build` executa preflight e constrói as imagens API/WEB;
   ele **não** aplica schema.
2. A autoridade documentada de schema é `scripts/production-schema-apply.sh`, mas o
   script está fixo em
   `20260731150000_safe_production_schema_transition/migration.sql`, assim como o gate
   de evidência do cutover. Executá-lo agora não aplicaria a migration da PR #827.
3. O apply atual usa `psql --single-transaction` e cria `applied.tsv`, mas não grava
   `20260827190000_add_erp_order_manual_resolution` em `_prisma_migrations`. O próprio
   repositório declara que o ledger histórico pode não ser confiável e proíbe
   `prisma migrate deploy` até baseline auditado.
4. Portanto, o requisito pós-deploy “migration presente no ledger do Prisma” não pode
   ser satisfeito pelo caminho oficial atual. Não se deve contornar isso com `prisma db
   push`, `prisma migrate reset`, SQL avulso ou inserção manual improvisada no ledger.

Antes da janela, uma PR operacional separada deve tornar o runner de schema capaz de
selecionar **somente** a migration `20260827190000`, validar seu checksum, aplicar em
transação, validar catálogo/diff e registrar de modo auditado e compatível com Prisma o
mesmo nome/checksum no ledger. Essa PR também deve atualizar o gate de schema do
cutover e ter os testes PostgreSQL 16 verdes. Se o baseline auditado do ledger ainda
não existir, o deploy permanece bloqueado; `applied.tsv` não deve ser chamado de ledger
Prisma.

## EXACT_EXECUTION_ORDER

Cada passo é um gate: em qualquer falha, parar sem avançar.

1. **Congelar a identidade.** Consultar a `main` remota e PRs abertas. Confirmar SHA de
   40 caracteres, worktree limpa, PR #827 ancestral e checks verdes. Identificar uma PR
   aberta cujo título/arquivos envolvam scheduler/INC-ERP-5050; registrar seu base SHA.
   Se baseada em main anterior, não fazer merge durante a janela: pedir rebase no novo
   `main`, repetir CI e tratar seu deploy em janela separada.
2. **Fechar o blocker de schema.** Mesclar e aprovar o runner descrito acima; atualizar
   `MAIN_SHA` para o novo merge, repetir a prova de ancestralidade da #827 e garantir que
   a mudança não habilite scheduler, Recovery ou sync.
3. **Provar local/CI.** Exigir todos os checks remotos do novo SHA, incluindo
   `npm run test:production-schema`, `npm run test:production-schema:postgres`, testes
   da resolução manual, build/typecheck e testes de deploy. Não usar fixtures como
   evidência produtiva.
4. **Build sem cutover.** Disparar manualmente **Deploy Production**, `phase=build`, no
   SHA congelado. Aprovar apenas se preflight finalizar `PASS`, as imagens
   `gest-o-api:<SHA>` e `gest-o-web:<SHA>` existirem e build-info da API corresponder ao
   SHA. Isso mantém os containers atuais atendendo e não prova schema.
5. **Backup canônico.** Preparar, pelo contrato protegido e aprovado de backup, um dump
   canônico novo com manifesto SHA-256, container PostgreSQL exato, health/network/
   volume/mount/identidade validados, promoção atômica e preflight cutover `PASS`.
   Não usar Recovery para isso e não expor paths, nomes protegidos ou credenciais.
6. **Schema preview.** No checkout/imagem pinados, executar o runner oficial corrigido
   em modo `validate` para **somente** `20260827190000`; preservar checksum e diff bruto.
   Confirmar DDL aditiva, ausência de DML/`DROP`/`incident_*`, alvo
   `salesforce_pro/postgres`, backup fresh e aprovação humana.
7. **Migration.** Executar uma única vez o apply oficial corrigido, com confirmação
   literal, SHA esperado e transação. Não iniciar API/WEB. Exigir: registro finalizado e
   não revertido no ledger Prisma, checksum correto, tabela/enums/coluna/índices/FKs
   exatos, `incident_*` preservado e post-diff gerenciado de zero bytes.
8. **Gate entre schema e cutover.** Manter a API/WEB antigas em execução. Fazer apenas
   leituras de catálogo/ledger e health; não resolver pedido, não chamar `POST /orders`,
   não rodar scheduler/Recovery/sync. Se a API antiga degradar, abortar o cutover e
   investigar; a migration aditiva pode permanecer.
9. **Cutover API/WEB conjunto.** Disparar **Deploy Production**, `phase=cutover`, no
   mesmo SHA. O environment `production-cutover` exige aprovação. O workflow deve
   revalidar backup fresh, SHA, imagem, post-diff/evidência e inventário de rollback;
   depois troca somente API e WEB e exige ambos healthy.
10. **Smoke read-only e RBAC.** Executar a lista abaixo. Não clicar a confirmação final
    e não criar nova tentativa. Manter `ERP_SYNC_SCHEDULER_ENABLED` no estado já aprovado;
    não usar esta janela para corrigir ou provar INC-ERP-5050.
11. **Encerrar ou reverter.** Somente após todos os gates registrar deploy aprovado.
    Mesmo com smoke verde, `READY_TO_RESOLVE_REAL_ORDER` continua `NO` até aprovação
    humana explícita posterior; a resolução real é outra operação auditada.

## ROLLBACK_ORDER

### Falha antes da migration

Parar. Não há runtime nem schema a reverter. Preservar logs, checksum e backup.

### Falha depois da migration e antes/durante o cutover

1. bloquear novas ações manuais e manter scheduler/Recovery/sync fora desta resposta;
2. executar o rollback persistido do **Deploy Production** para restaurar as imagens
   anteriores de API e WEB e validar health/portas/SHA;
3. **não** remover tabela, coluna, enums, índices/FKs e **não** apagar/reverter o ledger;
4. deixar a migration expand aplicada: a API antiga é compatível com os objetos extras;
5. validar API/WEB antigas, preservar backup/evidências e abrir incidente antes de nova
   tentativa.

Se a migration falhar, sua transação deve abortar integralmente e não pode receber
entrada de ledger como concluída. Divergência entre catálogo, ledger e evidência é
incidente de schema: não executar cutover, não “consertar” com `db push`/reset e não
restaurar o banco automaticamente. Restore é decisão de incidente separada e aprovada.

## POST_DEPLOY_SMOKE

O smoke não pode gerar nenhum `POST /orders`. Capturar horário inicial/final, SHA e
correlation IDs sanitizados para provar ausência de resolução automática.

1. Consultar `_prisma_migrations` e exigir uma única entrada finalizada, não revertida,
   para `20260827190000_add_erp_order_manual_resolution`, com checksum aprovado.
2. Consultar `pg_catalog`/`information_schema`: dois enums e seus únicos valores, tabela
   `ErpOrderManualResolution`, coluna nullable `supersedesErpOrderSyncId`, quatro índices
   e quatro FKs com ações `RESTRICT/CASCADE`.
3. Exigir `GET /health` e `GET /health/version` saudáveis e SHA exato; carregar WEB
   local e externamente e conferir assets da imagem nova.
4. Autenticar contas de teste separadas. Vendedor e gerente não podem ver a ação e uma
   chamada direta ao endpoint deve responder 403 sem criar timeline/resolução. Diretor
   pode ver a ação excepcional apenas numa tentativa ambígua elegível.
5. Na tentativa real, usar primeiro somente **Atualizar status** e preservar evidência
   de que o backend fez `GET /orderStatus` com a chave original. Resposta encontrada,
   processando, rejeitada ou erro continua bloqueando conforme o contrato.
6. Se o resultado for `unknown`, apenas abrir o modal de diretor e conferir os dados;
   **não** preencher/confirmar a ação no smoke. Comprovar contagem zero de novas
   `ErpOrderManualResolution` para a tentativa, tentativa original byte-semanticamente
   preservada e nenhum evento de resolução automática.
7. Comparar logs/auditoria e contadores antes/depois: nenhum `POST /orders`, nenhuma
   nova tentativa e nenhuma resolução aplicada automaticamente. O pedido real continua
   bloqueado até ação humana posterior.

## SCHEDULER_PR_IMPACT

O trabalho do scheduler é uma linha de mudança separada. A presença local dos merges
#825/#826 não prova se existe hoje uma nova PR aberta. A janela fica bloqueada enquanto
essa consulta remota não for feita. Se existir PR baseada em SHA anterior:

- registrar base/head e arquivos tocados;
- rebasear depois do novo `main` e repetir CI, com atenção a rotas ERP, Compose, env,
  preflight, deploy e documentação compartilhada;
- não incluí-la no SHA desta implantação e não executar **ERP Production Recovery**;
- não usar o smoke da #827 como prova do scheduler, nem o scheduler como mecanismo de
  reconciliação/resolução do pedido real.

## Decisão

```text
SAFE_TO_DEPLOY = NO
```

Motivos: ausência de runner oficial para a nova migration/ledger, gate de cutover ainda
fixo na migration anterior e estado remoto da PR do scheduler não comprovado. Depois de
remover os três bloqueadores e repetir todos os gates no novo SHA, a decisão pode ser
reavaliada; ela não muda automaticamente para `YES` por este plano.
