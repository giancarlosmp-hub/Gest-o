# Auditoria sanitizada UltraFV3 → Gest-o (04/09/2026)

## Escopo, cadeia de custódia e classificação

Esta auditoria do código é estática. Os pacotes confidenciais não foram abertos por esta tarefa; em
04/09/2026 foi recebido um **relatório estático sanitizado externo**, produzido em ambiente separado.
Somente suas classificações foram incorporadas. Nenhum ZIP, executável, VBS, log bruto, configuração,
segredo ou dado empresarial foi aberto, executado ou copiado aqui. Não houve acesso ao UltraFV3, banco, tablet ou
produção. O fetch remoto foi tentado e bloqueado pelo proxy (HTTP 403); o checkout disponível era o
merge da PR #853 (`58c7778`). O commit indicado `1820d8c` não existe no object database local e,
sem fetch, sua publicação ou substituição permanece **não comprovada**.

Classificações usadas abaixo: **código**, **banco informado**, **interface informada**, **inferido** e
**não comprovado**. Valores de clientes concretos foram deliberadamente omitidos.

## Call graph comprovado no código

```text
ERP → UltraFv3Rest → ultraFv3Client.request[WithCredentials]
→ fetchUltraFv3Rows/toArray → normalizadores pick*/buildPartnerMappedData
→ syncPartners/persistPartnerPayload → Prisma Client
→ crudRoutes (/clients/:id e relacionamentos) → ClientDetailsPage
```

O scheduler e as rotas administrativas chamam o mesmo serviço de sync. `/partners` é consultado
globalmente ou por credencial de vendedor; o modo por vendedor pagina, preserva a ordem e limita a
50 páginas. O parceiro é associado por código, documento ou fallback de identidade protegido. A
persistência cria/atualiza `Client`, move relações durante merge e **não chama `prisma.contact` para
uma linha normal de parceiro**. `Contact` só é movido quando clientes duplicados são fundidos.

`/financialProfiles?date=...` grava o objeto integral em `Client.financialProfile` e projeta data e
valor da última fatura. `/partnerTitles?date=...` agrupa por parceiro, grava o array integral e soma
saldo positivo; vencido significa data parseável anterior ao relógio do processo e saldo positivo.
Não há cálculo no sync de atraso médio, maior atraso, baixa, tolerância, renegociação ou cor.

## Matriz ERP → DTO/normalização → Prisma → API/tela

| Conceito | Entrada aceita pelo código | Persistência | Exposição/uso | Estado |
|---|---|---|---|---|
| código do parceiro | aliases de código | `Client.code` | cliente/busca | código |
| razão/fantasia | aliases de nome | `Client.name/fantasyName` | detalhe | código |
| documento | aliases CPF/CNPJ, validação 11/14 dígitos | `Client.cnpj*` | detalhe | código |
| cidade/UF/região | aliases explícitos | `Client.city/state/region` | detalhe/lista | código |
| endereço | rua/número/bairro/complemento concatenados | `Client.segment` | detalhe | código; modelagem legada inadequada |
| vendedor | aliases de código; fallback para vendedor ativo no sync global | `ownerSellerId` | lista/detalhe | código |
| telefone/e-mail do parceiro | nenhum alias mapeado | nenhum | ausência em `Contact` | descarte comprovado no código; presença no payload não comprovada |
| coleção de contatos | nenhum endpoint/schema/normalizador localizado | nenhum | `Client.contacts` | não instrumentado |
| perfil financeiro | objeto opaco de `/financialProfiles` | JSON + última compra/valor | detalhe/prioridades | parcial; sem DTO validado |
| títulos | objetos opacos de `/partnerTitles` | JSON + totais | detalhe/alerta | parcial; sem DTO validado |
| primeira compra/ticket médio | nenhum cálculo localizado no sync | nenhum campo dedicado | valores eventualmente lidos do JSON | não instrumentado |
| atraso médio/maior atraso | nenhum cálculo localizado | apenas JSON opaco | UI interpreta aliases quando presentes | origem/semântica não comprovadas |
| cheques devolvidos/risco | nenhum cálculo no sync | JSON opaco | UI interpreta aliases | contrato não comprovado |
| instante da fonte financeira | query usa data fixa; `AppConfig.updatedAt` só data recepção | sem timestamp por campo/snapshot no cliente | não exibido como frescor financeiro | não instrumentado |

Não existe DTO/Zod de resposta ERP para parceiros, perfis ou títulos: a borda aceita `unknown`,
`toArray` procura wrappers conhecidos e mapeadores fazem seleção tolerante por aliases. Payload
inesperado pode virar lista vazia e erro; objetos parcialmente válidos são processados campo a
campo. O cache `AppConfig` guarda respostas integrais, o que exige tratamento como dado empresarial
confidencial.

## Evidência estática sanitizada recebida externamente

**Comprovado pelo relatório, não analisado diretamente nesta tarefa:** `UltraFv3Rest` é um executável
console Windows PE32+ x86-64 com runtime Node.js incorporado; possui launcher VBS oculto e configuração
própria com chaves de servidor e banco. Somente nomes/caminhos de chaves foram observados externamente,
nunca valores. Nomes de variáveis AWS existem, mas sua finalidade não foi comprovada.

O ERP Gestao contém componentes Firebird e artefatos funcionais de parceiros, vendas, pedidos,
produtos, estoque e financeiro. Isso comprova a tecnologia do ERP e a existência dos módulos, não
tabelas, colunas, SQL, DTO, regra financeira ou acesso direto do conector ao mesmo Firebird. Os
`Schemas` inventariados são fiscais/documentos eletrônicos, não DDL relacional. A relação direta
`UltraFv3Rest → Firebird do Gestao` permanece **inferida, não comprovada**.

Tokens sanitizados comprovaram apenas os nomes `/auth/login`, `/partners`, `/products`, `/prices`,
`/priceVariations`, `/salesmen`, `/payment-methods`, `/receiving-conditions`, `/price-tables`,
`/operations`, `/branches` e as variantes camelCase relatadas. Eles não comprovam método, payload,
paginação, autenticação, resposta, schema, estabilidade ou significado das variantes. Em particular,
`/partnerTitles` e seu contrato não foram comprovados pelo relatório, embora o código Gest-o tente
chamá-los.

## Contatos: causa raiz comprovada e limite de implementação

**Comprovado no código:** `buildPartnerMappedData` descarta qualquer telefone/e-mail; o fluxo não
consulta endpoint de contatos e não cria `Contact`. **Banco informado:** `Contact` está vazio.
**Interface informada:** há telefone cadastral no parceiro e coleção de contatos vazia. A combinação
é compatível com telefone no objeto principal, mas não comprova o nome, tipo ou estabilidade do
campo no payload HTTP.

Não foi implementada importação: faltam uma amostra sanitizada do **schema** de `/partners`
(somente nomes/tipos/presença, sem valores), confirmação da coleção/rota de contatos, cardinalidade,
identificador estável e semântica de remoção. O model atual também não tem origem ou chave ERP; usar
`notes` como marcador seria frágil e sobrescrever/remover contato manual violaria a precedência.

Contrato proposto para futura decisão: telefone cadastral da empresa vira contato técnico do tipo
`company-primary`, origem `UltraFV3`, chave `(clientId, origin, normalizedPhone)`, nunca pessoa de
contato; atualização alcança apenas registro ERP; contato manual sempre prevalece e nunca é apagado;
campo ausente preserva o último valor e marca snapshot parcial, enquanto remoção explícita e
contratual desativa somente o registro ERP. Isso requer schema/ADR e testes antes de migration.

## Financeiro: conclusão temporal corrigida

O tablet depende de atualização manual e seu instante não foi fornecido. O instante da última sync
automática do CRM e o estado atual dos títulos no ERP também não foram fornecidos. Portanto as
fontes não são temporalmente comparáveis e a conclusão obrigatória é `INSUFFICIENT_EVIDENCE`.
Nenhuma correção financeira ou reparo foi implementado.

O código revela riscos de contrato, não um incidente atual: saldo ausente/inválido vira zero; clientes
sem linhas no lote não são limpos nem marcados como ausentes; datas usam `new Date(string)` sem
contrato de timezone; título é considerado aberto pelo saldo, sem status/baixa/renegociação; campos
de perfil permanecem JSON opaco. Para decidir entre `STALE_TABLET_SNAPSHOT`, `CRM_STALE_SNAPSHOT`,
`MAPPING_ERROR`, `CALCULATION_ERROR` e `CONSISTENT_CURRENT_STATE`, é necessária uma resposta atual,
sanitizada e read-only do ERP, com timestamps alinhados e dicionário de campos.

## Arquivamento, vendedor inativo e busca

Os agregados informados reconciliam a listagem: total menos arquivados é igual à lista normal. Os
clientes ativos vinculados a vendedor inativo devem continuar visíveis, mas carteira inativa pode
afetar filtros, autorização e sync por vendedor. Não redistribuir automaticamente: inventariar por
vendedor, obter decisão comercial, simular e aplicar somente por operação auditada.

A busca geral usa correspondência textual parcial em vários campos; assim, uma sequência numérica
pode retornar códigos/documentos que a contêm. Não houve mudança de UX. Proposta: filtro separado
“Código ERP exato”, mantendo busca livre, com testes de query, teclado, responsividade e vazio.

## Correção comprovada desta PR

O diagnóstico de normalização enviava amostra de payload e o sanitizador não ocultava telefone,
e-mail, nome nem endereço. Isso poderia expor PII se esses campos existissem. O sanitizador agora
remove aliases sensíveis em qualquer profundidade e os testes usam apenas valores sintéticos. Não
há mudança de banco, sync, regra de pedido ou UI.

## Evidência ainda necessária (um único envelope sanitizado)

Sem executar aqui: coletar por canal aprovado um JSON de **metadados**, não dados, contendo instante
UTC da resposta, nomes e tipos dos campos de um parceiro, nomes/tipos/cardinalidade da coleção de
contatos, e para títulos os nomes/tipos e enumerações de status/baixa/renegociação/bloqueio, timezone
e instante do snapshot. Juntar `AppConfig.updatedAt` e último `ErpSyncRun` automático bem-sucedido.
Não incluir valores, IDs, nomes, documentos, telefones, e-mails, endereços, URL ou credenciais.

## Pós-deploy e rollback

Após merge/checks/main verdes, deploy conjunto API/WEB pelo procedimento oficial; validar health,
SHA, autenticação, sync status **sem disparar sync**, e que logs sintéticos não contêm os marcadores
sensíveis. Não há migration nem saneamento automático. Rollback é reverter o commit e republicar a
API; banco e snapshots não devem ser restaurados.

## Relação com a PR #854

O relatório recebido classifica a PR #854 como aberta e verde e resume alterações de métricas,
`BTRIM`, `NOT EXISTS`, perfil versus títulos e estado não instrumentado. A tentativa de obter sua ref
para comparação foi bloqueada pelo proxy HTTP 403; não há objeto Git local da PR. Sem diff não é
seguro declarar independência, supersessão ou ordem de merge. Decisão: `PR_RELATIONSHIP_NOT_PROVEN`.
Antes de criar PR, obter a ref #854 em ambiente autenticado, comparar os ancestrais e preservar suas
mudanças por rebase/cherry-pick sem duplicar a documentação.

```text
SANITIZED_EXTERNAL_STATIC_REPORT_RECEIVED=YES
ATTACHMENTS_ANALYZED_BY_CODEX_TASK=NO
ATTACHMENTS_EXECUTED=NO
PR854_STATE=OPEN_GREEN_AS_REPORTED_NOT_INDEPENDENTLY_VERIFIED
PR854_RELATIONSHIP=PR_RELATIONSHIP_NOT_PROVEN
TABLET_LAST_MANUAL_SYNC=NOT_PROVIDED
CRM_LAST_AUTOMATIC_SYNC=NOT_PROVIDED
SOURCES_TEMPORALLY_COMPARABLE=NO
FINANCIAL_DIVERGENCE=INSUFFICIENT_EVIDENCE
CURRENT_ERP_TITLE_STATE=NOT_PROVEN
TABLET_STATE_CLASSIFICATION=STALE_OR_NOT_PROVEN_CURRENT
CRM_STATE_CLASSIFICATION=CURRENTNESS_DEPENDS_ON_LAST_SUCCESSFUL_AUTOMATIC_SYNC
FINANCIAL_CORRECTION_REQUIRED=NOT_PROVEN
FINANCIAL_UI_TRACEABILITY_REQUIRED=PROPOSED_NOT_IMPLEMENTED_CONTRACT_INCOMPLETE
```
