# Sprint 1.0B.2-K — observação de estabilidade do shadow no preview

## Objetivo e limite da evidência

Esta Sprint acrescenta uma prova **sintética, repetida, rápida e limitada** ao Preview Deploy certificado. Ela observa somente o shadow read-only de `GET /clients`; a resposta HTTP continua sendo produzida pelo caminho legado. A prova não é soak test, não mede estabilidade temporal produtiva e não autoriza produção, mutation, backfill, migration, RLS ou cutover.

A janela executa 10 ciclos sequenciais, com quatro chamadas reais concorrentes por ciclo (40 amostras). Cada chamada tem timeout de 15 segundos e deve terminar com curl exit 0, HTTP 200, exatamente um `x-request-id` interno no formato `req-` + oito hexadecimais, ID distinto no run, exatamente um evento correlato e resultado MATCH. O aceite exige 40/40 HTTP 200, 40 MATCH, zero MISMATCH e zero ID ausente, inválido ou duplicado. Retentativas de logs são limitadas a cinco consultas separadas por um segundo; não há espera longa nem workflow bloqueado por horas.

## Lifecycle real do preview e idempotência

O evento de PR cria o diretório e projeto Compose `gesto-pr-<PR>`, banco e volume nomeados pela PR. Um synchronize/rerun remove e clona novamente o diretório e recria containers, mas `down --remove-orphans` preserva o volume. A API nasce em `disabled/false`; schema/bootstrap, admin sintético, seed e certificação precedem a ativação. O seed reconcilia chaves estáveis, recria fixtures marcadas e falha fechado em incompatibilidade; o harness predecessor reaplica seed/certificação e compara cardinalidades. Nenhuma correção automática é admitida durante a prova. O fechamento da PR usa cleanup separado com `down -v`; falha de teardown pode deixar volume órfão isolado pelo número da PR.

Rerun da mesma PR é parte do contrato: seed e certificação devem continuar determinísticos, cardinalidades não podem crescer indevidamente e a nova observação usa novo `runId`, timestamps e somente os 40 IDs retornados naquela execução. Eventos antigos, mesmo presentes no volume/log driver, não contam. A API é recriada para ativação e, no rollback, somente a API é recriada; banco e web não são reinicializados.

## Correlação, logs e resumo sanitizado

O cliente não envia `X-Request-Id`. A API gera a identidade interna e a devolve em `x-request-id`; somente esse valor é autoridade. A captura de logs usa `--since` e `--until` da janela e filtra o conjunto exato dos IDs retornados. Cada evento deve ser único. Isso elimina contagem de eventos antigos sem confiar apenas na precisão de timestamp.

O workflow emite `TENANT_READ_PREVIEW_STABILITY=<JSON>` com somente runId técnico, ciclos e requests planejados/concluídos, totais HTTP 200/MATCH/MISMATCH, IDs ausentes/duplicados, duração e PASS/FAIL. JWT, Authorization, credenciais, login, payload, nomes de clientes, connection string e dados empresariais não integram evidência. Logs disponíveis são os logs Compose da API; atraso de entrega, rotação/retenção do driver, rate limit, timeout, indisponibilidade do runner/VPS ou teardown incompleto fazem o gate falhar ou permanecem riscos explícitos — nunca justificam bypass.

## Fail-closed e rollback

Falha registra apenas estágio, ciclo/índice técnico, HTTP, exit code, request ID e contagens sanitizadas. Em seguida restaura literalmente `TENANCY_MODE=disabled` e `TENANT_READ_PILOT_ENABLED=false`, força a recriação somente da API preview, emite `TENANT_READ_PREVIEW_ROLLBACK=PASS` e falha o Preview Deploy. Falha do próprio rollback também é explícita. Não se apaga, altera ou “corrige” dado para mascarar incompatibilidade.

## Gates e decisão

O comando oficial `npm run test:tenant-read-pilot-preview-stability` reúne o teste HTTP, gates do piloto/preview e o contrato estático sem depender de números de linha. No Docker Compose CI, `Prove tenant read pilot preview stability contract` fica após dataset preview e antes dos smokes gerais, sem escape permissivo.

O Preview Deploy mantém seed, dataset, login, token, IDs e shadow do predecessor e só publica PASS com os checkpoints 10 ciclos, 40 requests, 40 MATCH e zero MISMATCH. Antes do Docker Compose CI e Preview Deploy reais verdes, a prova permanece `NOT_PROVEN` e a PR deve permanecer Draft/não pronta para review.

## Limitações estatísticas e decisão posterior

Quarenta amostras sintéticas numa janela curta detectam regressões repetíveis sob concorrência pequena, mas não estimam disponibilidade, caudas de latência, sazonalidade, capacidade, rate limit sustentado, retenção de logs nem comportamento produtivo. Não há autorização produtiva. A próxima decisão somente pode ocorrer depois de checks reais verdes e revisão humana das evidências; mesmo assim, mutation, backfill e cutover exigem gates próprios.

## Declarações

`READY_FOR_1_0B_2_K_REVIEW = NO` até checks reais verdes  
`TENANT_READ_PREVIEW_STABILITY = NOT_PROVEN` até o Preview Deploy real  
`READY_FOR_TENANT_AWARE_RUNTIME = NO`  
`READY_FOR_BACKFILL_PRODUCTION = NO`  
`READY_FOR_MULTI_TENANT_CUTOVER = NO`  
`TENANCY_MODE_PRODUCTION = disabled`  
`TENANT_READ_PILOT_ENABLED_PRODUCTION = false`  
`PRODUCTION_ACCESSED = NO`
