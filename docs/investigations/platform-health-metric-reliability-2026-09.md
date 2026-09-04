# Auditoria das métricas da Saúde da Plataforma — 03/09/2026

## Escopo e evidência

Auditoria estática feita sobre o merge da PR #853 (`58c7778b`). Esse SHA é o `HEAD` recebido e, portanto, ancestral reflexivo do trabalho. O checkout não contém remoto `origin`; não foi possível buscar `main` nem consultar PRs remotas. Produção, ERP e dados empresariais não foram acessados ou modificados.

O modelo prova que telefone e e-mail de cliente existem somente em `Contact.phone` e `Contact.email`; `Client` não tem esses campos. `Contact.clientId` é opcional. Logo, a consulta por `NOT EXISTS`, correlacionada por cliente, é a fonte correta e não multiplica clientes com vários contatos. A correção comprovada é considerar `BTRIM(valor) = ''` ausente. O valor produtivo 5.607 não permite distinguir falta real de contatos não vinculados: é necessária a coleta agregada abaixo.

`Client.ownerSellerId` é obrigatório e referencia `User.id`; “sem vendedor” e “vendedor inexistente” são impossíveis sob o schema/constraints atuais, mas continuam `null` porque a Saúde não audita o catálogo real da constraint. `inactiveSeller` usa `ownerSeller.isActive=false`; `archived` usa `Client.isArchived=true`: são predicados independentes. A igualdade 1.298 não prova reutilização. A matriz agregada abaixo é necessária para determinar a sobreposição real.

Não existem tabelas `FinancialProfile` ou `PartnerTitle`: ambos são JSON opcionais em `Client`. A métrica legada `financialProfilesOrphaned` significa exatamente `financialProfile IS NOT NULL AND partnerTitles IS NULL`; não é orfandade relacional. O identificador do contrato 3.0 foi preservado, mas o texto executivo foi corrigido. `partnerTitlesInconsistent` conta JSON presente cujo tipo não é array/objeto; PostgreSQL garante JSON válido, não o formato de domínio interno.

A disponibilidade atual do UltraFV3 vem exclusivamente do arquivo sanitizado `/var/run/gest-o/ultrafv3-reachability.json`, produzido pelo diagnóstico GET-only. Execução automática bem-sucedida prova conectividade naquele instante, não disponibilidade atual. Ausência/arquivo inválido permanece `unknown`/Não instrumentado.

## Dicionário autoritativo

Todas as métricas são globais enquanto `TENANCY_MODE=disabled`. Datas são UTC. Campos sem fonte ficam `null`, nunca zero. Clientes ativos e arquivados entram nas métricas, salvo quando o nome/predicado disser o contrário.

| Nome executivo (chave) | Finalidade e definição formal | Fonte/predicado; janela | Null/vazio/arquivado; risco; teste |
|---|---|---|---|
| Total de clientes (`totalClients`) | Universo CRM | `COUNT(Client)`; atual | Inclui arquivados; baixo; teste PostgreSQL recomendado |
| Sem documento (`missingDocument`) | cadastro sem CPF/CNPJ | `cnpj IS NULL OR cnpj=''`; atual | Espaços ainda contam como documento: risco médio; diagnóstico abaixo |
| Documento inválido (`invalidDocument`) | comprimento normalizado diferente de 11/14 | documento não vazio e dígitos de `cnpjNormalized` fora de 11/14; atual | inclui arquivados; não valida dígitos verificadores; médio |
| Duplicados (`duplicates`) | excedentes por documento | soma `COUNT(*)-1` por `cnpjNormalized` não vazio; atual | inclui arquivados; médio (normalização) |
| Vendedor inativo (`inactiveSeller`) | clientes ligados a usuário inativo | relação `ownerSeller.isActive=false`; atual | inclui arquivados; baixo; teste de projeção e matriz SQL |
| Sem vendedor (`missingSeller`) | vínculo ausente | não instrumentado (`null`) | coluna obrigatória/FK no modelo; impossível comprovar constraint produtiva sem catálogo; baixo |
| Sem região/município/UF | ausência nos campos `region/city/state` | igualdade a `''`; atual | espaços não são ausência; médio |
| Sem carteira (`missingPortfolio`) | carteira comercial ausente | não instrumentado | não há campo autoritativo definido; impossível no modelo atual |
| Sem telefone (`missingPhone`) | cliente sem nenhum telefone não branco | `NOT EXISTS Contact(clientId=Client.id AND BTRIM(phone)<>'')`; atual | inclui arquivados; contato não vinculado não conta; baixo; teste SQL/estático |
| Sem e-mail (`missingEmail`) | cliente sem nenhum e-mail não branco | equivalente para `Contact.email`; atual | não valida formato; baixo; teste SQL/estático |
| Perfil financeiro sem títulos (`financialProfilesOrphaned`, legado) | JSON financeiro presente sem JSON de títulos | `financialProfile IS NOT NULL AND partnerTitles IS NULL`; atual | não é órfão/FK; risco semântico corrigido; teste de alerta |
| Estrutura de títulos inválida (`partnerTitlesInconsistent`) | tipo JSON externo ao envelope aceito | presente e `jsonb_typeof NOT IN ('array','object')`; atual | conteúdo interno não validado; médio |
| Clientes arquivados (`archived`) | população soft-deleted | `isArchived=true`; atual | definição direta; baixo; matriz SQL |
| Últimas execuções/taxas/duração/retries | operação ERP completa | somente pais `manual+syncAll` ou `scheduler+automatic`, últimos 7/30/90 dias, máx. 100 runs | etapas não entram nas taxas; ausência=`null`; testes de projeção |
| Parceiros recebidos/atualizados; clientes criados/atualizados | volumes persistidos | soma das chaves conhecidas em `metrics` dos pais na janela | chave ausente=`null`; aliases `updated` são ambíguos entre domínios: não instrumentado quando ausentes, risco alto |
| Pedidos sincronizados/com erro | volumes de pedido | aliases persistidos nos pais | escopo futuro de pedidos não é inferido; ausente=`null`; risco alto |
| Conflitos/fallback/correspondências de identidade | decisões de matching | chaves `documentErpConflicts`, `identity_fallback_no_document`, `code_exact`, `document_exact`, `rejected_document_conflict`, `create_no_safe_match` | só instrumentada quando a chave numérica existe; nomes executivos traduzidos; testes `metricFrom` |
| Alterações de `Client.code` | mutações auditadas hoje/tendência | `ClientCodeAudit`, meia-noite UTC/janela | zero coletado é zero real; baixo |
| Disponibilidade UltraFV3 | reachability GET-only atual | arquivo sanitizado; instante `checkedAt` | arquivo ausente/inválido=`unknown`; freshness ainda não imposta: risco médio |
| ERP conectado automaticamente | prova composta | scheduler inicializado+habilitado, pai automático `success`, lock não ativo | não equivale a reachability atual; testes de projeção |
| Scheduler/lock | capacidade automática/runtime | estado runtime e `ErpSyncLock`; atual | lock ausente=`free`, expirado é explícito; testes de projeção |
| Notificações | entrega externa | nenhum adapter registrado | `not_instrumented`; neutro |

## Inventário que permanece não instrumentado

`missingSeller`, `missingPortfolio` e qualquer chave ERP não numérica/ausente no JSON do pai. Em particular, volumes de parceiros, clientes, pedidos e estratégias de matching não podem ser derivados de `syncedCount`, de etapas ou do simples sucesso sem redefinir o domínio e arriscar dupla contagem. Eles permanecem `null`.

## Único diagnóstico produtivo read-only (para o operador, se necessário)

Não executar como parte desta PR. O bloco retorna apenas agregados, sem IDs ou PII:

```sql
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SELECT 'contact_quality' AS metric,
 COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "Contact" ct WHERE ct."clientId"=c.id AND BTRIM(ct.phone)<>'')) AS a,
 COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "Contact" ct WHERE ct."clientId"=c.id AND BTRIM(ct.email)<>'')) AS b,
 COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Contact" ct WHERE ct."clientId"=c.id)) AS c
FROM "Client" c;
SELECT 'seller_archive_matrix' AS metric,
 COUNT(*) FILTER (WHERE NOT c."isArchived" AND NOT u."isActive") AS active_client_inactive_seller,
 COUNT(*) FILTER (WHERE c."isArchived" AND u."isActive") AS archived_client_active_seller,
 COUNT(*) FILTER (WHERE c."isArchived" AND NOT u."isActive") AS archived_client_inactive_seller,
 COUNT(*) FILTER (WHERE c."ownerSellerId" IS NULL) AS missing_seller
FROM "Client" c LEFT JOIN "User" u ON u.id=c."ownerSellerId";
SELECT 'financial_json_states' AS metric,
 COUNT(*) FILTER (WHERE "financialProfile" IS NOT NULL AND "partnerTitles" IS NULL) AS profile_without_titles,
 COUNT(*) FILTER (WHERE "financialProfile" IS NULL AND "partnerTitles" IS NOT NULL) AS titles_without_profile,
 COUNT(*) FILTER (WHERE "financialProfile" IS NOT NULL AND "partnerTitles" IS NOT NULL) AS both_present
FROM "Client";
COMMIT;
```

## Veredito

Código: corrigir whitespace de contato e apresentação semântica/portuguesa. Dados: nenhuma reparação autorizada. Migration: nenhuma. Os números reais de contato, interseção vendedor/arquivo e estados JSON exigem o único diagnóstico acima antes de atribuir causalidade produtiva.
