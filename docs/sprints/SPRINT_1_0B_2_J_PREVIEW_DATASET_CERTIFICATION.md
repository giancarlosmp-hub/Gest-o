# Sprint 1.0B.2-J — certificação do dataset preview

## Escopo e inventário

O Preview Deploy cria um projeto Compose e banco PostgreSQL por PR (`gesto-pr-<PR>` e `salesforce_pro_preview_pr_<PR>`), com volume nomeado por PR. O bootstrap da API usa `DATABASE_SCHEMA_MODE=ephemeral-push`; depois cria o administrador sintético e executa `seedPreview.ts`. O seed contém três vendedores sintéticos (`vendedor`), um administrador (`diretor`) recebido pelo canal seguro e Clients fictícios preservando `ownerSellerId`. Não existe dado produtivo nem acesso à VPS fora do workflow.

Em rerun, o diretório é recriado, mas o volume da mesma PR pode ser reutilizado. Por isso o seed remove/recria somente fixtures marcadas, reconcilia por chaves estáveis e falha diante de tenant ou membership incompatível. PRs usam projetos, bancos, portas e volumes distintos. Ao fechar a PR, o cleanup executa `down -v`; uma falha operacional de cleanup pode deixar volume órfão, mas ele permanece isolado pelo número da PR.

Ordem certificada: banco isolado → `prisma db push` no bootstrap → API inicialmente disabled → admin → seed → validador → recriação somente da API com piloto → health/login → GET `/clients` concorrente → MATCH. Os únicos segredos do smoke são credenciais sintéticas transmitidas como variáveis protegidas; senha, token, resposta e `DATABASE_URL` não são impressos.

## Contrato sintético fail-closed

O ID determinístico sintético é `tenant-default-v1`, documentado apenas no seed/configuração preview. Deve existir exatamente um Tenant ativo. Todo usuário ativo autenticável tem exatamente uma membership ativa, não revogada e no tenant default; nenhuma membership/tenant divergente é reparada silenciosamente. Todo Client certificado possui o mesmo `tenantId`, e seu `ownerSellerId` aponta para usuário com membership coerente. Filtros funcionais e RBAC permanecem no `where` legado; o validador compara contagens de vendedor com e sem o predicado tenant.

O seed é reaplicável: Tenant, User e TenantMembership são reconciliados; fixtures marcadas são recriadas sem alterar cardinalidade. O harness PostgreSQL 16 materializa `public`, aplica seed, valida, reaplica, compara cardinalidades e executa queries negativas de NULL/divergência/ownership. O comando oficial é `npm run test:tenant-read-pilot-preview-seed`.

## Ativação, checkpoints e prova

O preview nasce com `DEPLOYMENT_ENV=preview`, `TENANCY_MODE=disabled`, `TENANT_READ_PILOT_ENABLED=false` e o ID configurado. Somente após `TENANT_READ_PREVIEW_SEED=PASS` e `TENANT_READ_PREVIEW_DATASET=PASS`, o workflow troca para `default-only`/`true` e recria a API. Quatro requests concorrentes autenticados chamam o endpoint real sem registrar token/payload. O gate usa `TENANT_READ_SHADOW_EVENT=<JSON>` serializado explicitamente, exige exatamente um `MATCH` para cada um dos quatro request IDs do run, HTTP 200/exit 0 em cada processo, nenhum `MISMATCH` após o timestamp da prova, e publica `TENANT_READ_PREVIEW_SHADOW=MATCH`. A resposta continua exclusivamente legada.

A prova local/CI certifica o dataset e o mecanismo. O valor MATCH do Preview Deploy real será produzido pelo workflow desta PR; não se declara execução remota antecipadamente neste documento.

## Abort, rollback, riscos e limites

Qualquer incompatibilidade aborta antes da ativação. Em MISMATCH, o workflow restaura `TENANT_READ_PILOT_ENABLED=false` e `TENANCY_MODE=disabled`, recria somente a API preview e falha. Rollback manual usa os mesmos valores, reinicia somente preview, chama GET `/clients` e confirma resposta legada e ausência do evento shadow. Não apagar/corrigir dados automaticamente durante diagnóstico.

Produção permanece literalmente disabled/false. Não houve acesso produtivo, migration, backfill, RLS, mutation tenant-aware, alteração JWT ou cutover. Risco residual: indisponibilidade do executor/VPS pode impedir a prova remota; isso é falha do gate, nunca autorização para bypass. Próxima subfase: observar estabilidade do shadow sintético por período definido, sem autorizar runtime tenant-aware.

## Declarações

`READY_FOR_1_0B_2_J_REVIEW = YES`  
`READY_FOR_TENANT_READ_PILOT_PREVIEW = YES`  
`TENANT_READ_PREVIEW_SHADOW = NOT_PROVEN` (o gate exige MATCH; execução real ocorre após a publicação da PR)  
`READY_FOR_ACTIVITY_DUAL_PARENT_MIGRATION = NO`  
`READY_FOR_TENANT_AWARE_RUNTIME = NO`  
`READY_FOR_BACKFILL_PRODUCTION = NO`  
`READY_FOR_MULTI_TENANT_CUTOVER = NO`  
`TENANCY_MODE_PRODUCTION = disabled`  
`TENANT_READ_PILOT_ENABLED_PRODUCTION = false`  
`PRODUCTION_ACCESSED = NO`


## Correção da prova da PR #792
A prova não depende mais de `util.inspect`/renderização de objetos do logger. As quatro chamadas têm PID, status HTTP e exit code capturados separadamente; todas são aguardadas. Qualquer falha após ativação aciona trap de rollback para `disabled/false`, recria apenas a API preview e limita o diagnóstico a requestId, status, exit code, contagens e marcadores técnicos. Até os dois checks do novo head ficarem verdes, `READY_TO_MERGE_PR_792 = NO` e `TENANT_READ_PREVIEW_SHADOW = NOT_PROVEN`.

## Correção observável do segundo Preview Deploy
O run `31294252007` chegou a seed/dataset PASS e API saudável, mas o pipeline fail-fast de login/token encerrou antes de qualquer diagnóstico ou rollback normal. O workflow agora captura separadamente exit code, HTTP e arquivo de resposta do login, guarda a extração do token em condicional explícita e nunca imprime resposta/token. `fail_shadow_proof` identifica `login`, `token_extraction` ou `requests_or_events`, produz somente metadados técnicos e chama `rollback_preview_pilot` diretamente; o trap EXIT é apenas proteção emergencial. A etapa tornou falhas observáveis; a correlação autoritativa foi corrigida na seção seguinte. Até evidência verde do novo head: `READY_TO_MERGE_PR_792 = NO` e `TENANT_READ_PREVIEW_SHADOW = NOT_PROVEN`.

## Correlação autoritativa da API
O run `31312582680` provou quatro HTTP 200/exit 0, porém zero eventos porque o workflow procurava o `X-Request-Id` enviado pelo cliente. Por desenho, `requestContextMiddleware` ignora esse valor, gera `req-<8 hex>` internamente e o devolve em `x-request-id`. A prova agora não envia identidade de correlação: salva headers de cada resposta, exige exatamente um ID interno válido e quatro IDs distintos, e limita eventos/MATCH/MISMATCH exclusivamente a esse conjunto retornado. Header ausente, duplicado ou inválido falha em `response_request_id` e executa rollback. O middleware permanece sem confiança em header, query ou body.
