# Pedido UltraFV3 ambíguo após timeout — investigação e reconciliação segura

## Escopo e evidência

Investigação exclusivamente estática/local da tentativa identificada por `pedidoIdImportacao=6f5edc8a-55a7-4502-a816-a8b94b8e67c2` e `correlationId=93690e4d-ac13-4288-b4c9-0212efe2dfad`. Produção/VPS e workflows não foram acessados. Portanto, não é possível afirmar localmente se o UltraFV3 recebeu ou criou esse pedido específico.

## Call graph comprovado

1. Modal **Gerar pedido ERP** chama `POST /opportunities/:id/erp/orders`.
2. A rota valida oportunidade/itens/parâmetros e chama `createErpOrderFromOpportunity`.
3. O serviço obtém `NUM_PEDIDO` por `GET /salesmen`, cria `PEDIDO_ID_IMPORTACAO` UUID e, sob advisory lock por oportunidade, persiste `ErpOrderSync(pending)` **antes** da chamada externa.
4. Envia uma única vez `POST /orders`, autenticado pela credencial do vendedor, com `PEDIDO_ID_IMPORTACAO` no corpo e como correlation id. O client aborta em 30 s. Não há retry automático de POST; somente leituras e renovação de autenticação podem repetir.
5. Resposta válida marca `sent`; timeout/rede/erro marca a mesma tentativa `error`, preservando chave, payload sanitizado e diagnóstico. Como o abort local não desfaz processamento remoto, o primeiro ponto de confirmação perdido é entre o aceite remoto possível e a chegada da resposta ao client.
6. O bloqueio transacional impede novo envio quando existe pedido `sent` ou tentativa `pending/error` com falha ambígua.
7. Antes desta correção, **Atualizar status** chamava `POST /opportunities/:id/erp/orders/status`, mas selecionava somente registros `sent`; logo a tentativa `error` por timeout nunca era consultada. Para enviados, priorizava `erpOrderNumber` (preenchido com o `NUM_PEDIDO` reservado) e só usava `pedidoIdImportacao` como fallback.

## Causa raiz e risco

A causa comprovada no CRM é uma lacuna de reconciliação: o status excluía justamente tentativas ambíguas e consultava primeiro o identificador secundário. O timeout de 30 s comprova apenas ausência de resposta no prazo, não entrega, aceite, rejeição nem criação. Assim, A/B/C/D não podem ser distinguidos sem resposta autoritativa do UltraFV3; E é confirmada no filtro/ordem da consulta; não há evidência local bastante para F sobre a tentativa concreta.

Duplicidade seria possível se a oportunidade fosse liberada com base apenas em timeout/resultado vazio. O lock existente é preservado e a reconciliação permanece fail-closed.

## Correção

- A consulta inclui `sent`, `pending` e `error`, usando primeiro `PEDIDO_ID_IMPORTACAO`, depois `NUM_PEDIDO`/número ERP, sem qualquer `POST /orders`.
- Só uma resposta que contenha exatamente a chave de importação ou o número esperado pode confirmar, indicar processamento ou provar rejeição. Vazio ou resposta sem vínculo permanece `unknown` e bloqueado.
- Confirmação atualiza a tentativa existente para `sent`, número/status e `sentAt`; processamento mantém `pending`; rejeição vinculada preserva evidência; toda consulta grava auditoria sanitizada em `lastStatusPayload` com ordem das chaves, correlation id e instante.
- A interface distingue confirmado, processando, rejeitado, desconhecido e reconciliado sem reenvio.

## Runbook local/operacional

1. Usar apenas **Atualizar status**; não reenviar, apagar, editar ou sincronizar manualmente.
2. Conferir o resultado de reconciliação e preservar ambas as chaves no chamado.
3. `confirmed`: validar o número vinculado à tentativa existente; nenhum novo pedido.
4. `processing`: aguardar e consultar novamente; bloqueio permanece.
5. `rejected`: somente a rejeição explicitamente vinculada à chave é evidência para o fluxo controlado de nova tentativa.
6. `unknown`: revisar no ERP com dupla confirmação. Ausência/timeout não libera envio.

O contrato observado de `/orderStatus?pedido=...` não documenta garantia formal de busca por chave nem semântica autoritativa de “não encontrado”. Por isso o fluxo considera encontro exato autoritativo, mas nunca converte resultado vazio em prova de não criação.

## Evidência operacional posterior e resolução manual

Em 27/08/2026, foi fornecida evidência operacional de que um diretor pesquisou diretamente no UltraFV3 a tentativa `6f5edc8a-55a7-4502-a816-a8b94b8e67c2`, usando os atributos comerciais e o identificador de importação, e não encontrou o pedido. Isso é uma decisão humana autorizada (`manual_verified_not_found`), **não** uma garantia autoritativa da API UltraFV3. Nenhum nome de cliente, credencial, token ou payload foi registrado.

Quando a reconciliação automática continuar inconclusiva, somente um usuário autenticado com role `diretor` pode usar **Confirmar conferência no ERP e liberar nova tentativa**. A operação exige duas confirmações, o sufixo de oito caracteres do identificador, a frase exata `CONFIRMEI QUE O PEDIDO NÃO EXISTE NO ERP`, o `correlationId` já presente na timeline e uma justificativa sanitizada. O projeto não possui mecanismo de reautenticação recente; por isso não foi criado um requisito fictício além da autenticação e autorização existentes.

A resolução é uma linha imutável separada e não altera nem apaga a tentativa original. Sob o advisory lock, o backend executa uma nova consulta `GET /orderStatus` pela chave original e só aceita a decisão se a resposta fresca continuar `unknown`. A resolução é criada na mesma transação da timeline, tem unicidade por tentativa e preserva ator, role comprovada, instante, categoria, estado terminal projetado `manually_resolved_not_found`, justificativa, identificadores originais e evidência temporal da consulta fresca. Esse estado representa decisão humana e nunca é exibido como `rejected`.

Procedimento operacional:

1. Tentar primeiro **Atualizar status** e confirmar que o resultado segue desconhecido.
2. Um diretor confere diretamente no UltraFV3 e abre a ação excepcional.
3. Ler o alerta de risco de duplicidade, marcar as duas confirmações, informar o sufixo, motivo e frase exata.
4. Ao confirmar, o backend — não o navegador — repete imediatamente a consulta. Resultado encontrado, processando, rejeitado ou consulta com erro bloqueiam a resolução; somente uma resposta válida ainda `unknown` cria o evento append-only.
5. Depois da resolução, o vendedor pode iniciar uma tentativa controlada. O fluxo adquire novamente o lock, faz outro preflight e cria uma nova tentativa vinculada, sem alterar a anterior.

O contrato disponível não prova que `PEDIDO_ID_IMPORTACAO` seja uma chave idempotente real no UltraFV3. Portanto, a tentativa controlada usa uma nova chave e aponta `supersedesErpOrderSyncId` para a tentativa original. Imediatamente antes de criar a nova tentativa e liberar o único `POST /orders`, o backend repete `GET /orderStatus` pela chave original sob o mesmo lock:

- se houver confirmação/processamento vinculado, registra a interrupção na timeline e não executa o POST;
- se continuar vazio, inconclusivo ou indisponível, a decisão manual permite exatamente uma nova tentativa;
- cliques concorrentes encontram a nova tentativa `pending` e são bloqueados antes do POST;
- a reconciliação automática ignora a tentativa manualmente resolvida, preservando sua imutabilidade, mas continua preferencial para todas as tentativas não resolvidas.
