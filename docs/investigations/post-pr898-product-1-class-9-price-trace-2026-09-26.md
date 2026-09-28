# Rastreamento pós-PR #898 — produto `1 / 9` (26/09/2026)

## Evidência nova e significado dos identificadores

O operador comprovou que API e WEB em execução usam o merge `281e2059bcba417cc1e01f2bd58c6abe35fdb42f`
da PR #898 e que os containers antecedem o sintoma. Portanto, esta rodada não repete a prova de
imagem. No seletor da Nova oportunidade, o texto é construído como
`erpProductCode / erpProductClassCode — name`; assim, `Marandu 1 / 9` significa código ERP do
produto `1` e código ERP da classificação `9`. Não é filial, unidade ou tabela.

Ainda não há leitura da VPS nem resposta atual do ERP nesta investigação. Os valores R$ 252,08 e
R$ 160,00 são somente valores observados na interface; nenhum foi assumido como correto.

## Divergências comprovadas no código atual

* `Product` possui chave única global no par `(erpProductCode, erpProductClassCode)`; embora
  possua `tenantId`, a chave única, o upsert do catálogo e a busca da Nova oportunidade são globais.
* `ProductPrice` pode guardar várias linhas para o mesmo produto/tabela, diferenciadas por filial,
  fonte e estado. A busca da Nova oportunidade não recebe filial. Sem `branchCode`, o cálculo aceita
  linhas de **todas** as filiais e escolhe uma observação por atualização. Portanto, uma resposta de
  R$ 252,08 prova apenas qual linha materializada venceu, não qual filial deveria ser comercialmente
  aplicada.
* “Atualizar estoque” executa `/products` e `/prices` com o tenant autenticado. `/products` faz upsert
  sem tenant, mas `/prices` procura somente produtos cujo `Product.tenantId` seja o tenant.
  Produto não atribuído/legado com `tenantId = NULL` pode, assim, atualizar estoque e não processar nenhum
  preço, ainda que a rota responda sucesso. Isso é uma hipótese diretamente testável nos campos
  `matchedProducts`, `missingProduct` e no `tenantId`; não é ainda causa produtiva confirmada.
* Uma resposta nua em array é considerada snapshot completo. Resposta envelopada só é completa
  quando não anuncia próxima página e a quantidade lida alcança `total`; somente então ocorre sweep
  de ausências. Essa regra não busca páginas adicionais: ela apenas impede o sweep quando os
  metadados denunciam parcialidade.

O endpoint administrativo de diagnóstico agora aceita `classCodes=9` e expõe `tenantId`, fonte,
estado de disponibilidade, filial, timestamps, filiais concorrentes e timestamps dos caches. Isso
permite separar dado antigo de seleção incorreta sem executar sincronização.

## Bloco curto para o operador (somente leitura)

Executar na raiz do checkout produtivo. O bloco usa o nome do container PostgreSQL já configurado,
não imprime URL/senha/ambiente, não chama ERP e não altera dados:

```bash
set -euo pipefail
: "${PRODUCTION_DB_CONTAINER_EXPECTED:?defina o container PostgreSQL produtivo já validado}"
docker exec --user postgres -i "$PRODUCTION_DB_CONTAINER_EXPECTED" \
  psql -X -U postgres -d salesforce_pro -v ON_ERROR_STOP=1 \
  --set=product_code='1' --set=class_code='9' <<'SQL'
SELECT p.id, p."tenantId", p."erpProductCode", p."erpProductClassCode", p.name,
       p.unit, p."groupName", p."stockQuantity", p."defaultPrice", p."minPrice",
       p."isActive", p."isSuspended", p."createdAt", p."updatedAt"
FROM "Product" p
WHERE coalesce(nullif(ltrim(p."erpProductCode", '0'), ''), '0') = :'product_code'
  AND coalesce(nullif(ltrim(p."erpProductClassCode", '0'), ''), '0') = :'class_code';

SELECT pp."productId", pp."erpPriceId", pp."branchCode", pp.price, pp.source,
       pp."availabilityState", pp."validFrom", pp."createdAt", pp."updatedAt"
FROM "ProductPrice" pp
JOIN "Product" p ON p.id = pp."productId"
WHERE coalesce(nullif(ltrim(p."erpProductCode", '0'), ''), '0') = :'product_code'
  AND coalesce(nullif(ltrim(p."erpProductClassCode", '0'), ''), '0') = :'class_code'
ORDER BY pp."erpPriceId" NULLS FIRST, pp."branchCode" NULLS FIRST, pp."updatedAt" DESC;

SELECT key, "updatedAt", jsonb_typeof(value::jsonb) AS shape,
       left(md5(value), 12) AS content_fingerprint
FROM "AppConfig"
WHERE key IN ('erp.ultrafv3.products','erp.ultrafv3.prices',
              'erp.ultrafv3.priceTables','erp.ultrafv3.priceVariations')
ORDER BY key;

SELECT scope, trigger, status, "authMode", "tenantId", "startedAt", "finishedAt",
       "syncedCount", metrics, errors, "errorMessage", "correlationId"
FROM "ErpSyncRun"
WHERE scope IN ('products','prices','priceTables','priceVariations','syncAll')
ORDER BY "startedAt" DESC LIMIT 30;
SQL
```

Depois, com uma sessão de diretor/gerente já autenticada no navegador, consultar sem disparar sync:
`GET /api/erp/ultrafv3/price-diagnostics?codes=1&classCodes=9&priceTableCode=1` e repetir somente
`priceTableCode=2`. Salvar a resposta sanitizada, preservando `correlationId`, mas não compartilhar
cookie/token. A comparação precisa registrar: linha `/prices` (ausente, zero explícito ou positiva),
filial, fonte/estado persistidos, regra do grupo, preço efetivo da API e valor exibido no mesmo ciclo
da interface.

## Decisão e pendências

Não há saneamento nem correção comercial autorizada nesta etapa. Antes de alterar seleção por filial
ou escopo de tenant, é necessário obter as leituras acima e confirmar a filial/contexto esperado do
pedido. Também é necessário inspecionar no navegador a resposta efetiva de `/products/search` ao
alternar as tabelas 1 e 2, com cache desabilitado, para separar API de estado do frontend. A PR #898
pode impedir algumas novas ressurreições de tombstones, mas não reescreve automaticamente toda
materialização antiga; isso deve ser tratado separadamente, com backup e plano de saneamento.

## Evidência consolidada e causa demonstrada (27/09/2026)

O operador confirmou no ERP, para `1 / 9` (Marandu VITALSEED 10KG), filial 1: Tabela 1
R$ 128,00 e Tabela 2 R$ 160,00, sendo a segunda derivada por acréscimo ERP de 25% aplicável a
TODAS as filiais. Esses números são fixture da regressão, não constantes de negócio.

No PostgreSQL há um único `Product` com `tenantId=NULL` (isso prova ausência de atribuição, não que seja compartilhado por contrato) e quatro materializações relevantes:
`prices/null/null=128`, `prices/null/1=252,08`, `products/1/null=128` e
`calculated_from_variation/2/null=160`. A execução do serviço foi reproduzida em teste: `null` era
normalizado como Tabela 1 e, sem filial pedida, linhas de qualquer filial participavam; a observação
autoritativa mais recente de R$ 252,08 vencia. Assim, a cadeia comprovada de **seleção** é persistência ambígua
(`erpPriceId=NULL`) → equivalência implícita com Tabela 1 → ausência de limite de filial → seleção
por autoridade/recência → API → interface. Ainda não foi apresentado o registro original do cache
`/prices`; portanto a origem ERP de R$ 252,08 e os aliases exatos usados no normalizador permanecem
lacuna. `source=prices` prova somente qual sincronizador persistiu a linha, não o que a API ERP enviou.

Há uma segunda causa comprovada nas atualizações manuais: runs com `received=501`,
`missingProduct=501` e `matchedProducts=0` foram registrados como sucesso porque `syncedCount`
contava linhas recebidas. O catálogo é global por chave e o refresh atualizava `/products` global,
mas restringia `/prices` ao tenant, excluindo o mesmo produto global. A sync completa global que
processou 181 preços explica a diferença entre pontos de entrada. O ciclo automático pós-deploy
ainda não foi observado.

Grupo 24 no cache de variações e agrupamento 11 mostrado no ERP permanecem entidades potencialmente
distintas. A correção não os iguala nem inventa mapeamento: continua aplicando somente regra cuja
chave de grupo venha do payload de produto e cujo percentual/tabela venham do ERP.

## Correção implementada e propriedades

1. Linha sem código de tabela permanece armazenada para auditoria, mas não participa de uma tabela
   explícita até existir contrato ERP que prove equivalência. Não é chamada de Tabela 1/fallback.
2. Sem filial comercial, somente uma linha igualmente sem filial é comparável. Isso **não** declara
   que `NULL` significa TODAS. Com filial explícita, exige correspondência exata e falha fechada se
   não existir; nenhuma filial ou fallback é inferido por preço, ordem ou timestamp.
3. A reconciliação derivada usa base sem filial explicitamente marcada Tabela 1 quando existente e
   não usa uma observação de filial como base sem filial.
4. O refresh autenticado permanece estritamente no tenant. `tenantId=NULL` não é promovido a
   compartilhado: a unicidade global do par código/classificação e o upsert global mostram tensão
   arquitetural, mas não provam intenção de compartilhamento. A resolução exige código e classe
   exatos e candidato único após o filtro; testes com tenant A, tenant B e NULL falham fechados em
   colisão, embora o schema atual impeça persistir a colisão exata. A decisão arquitetural fica pendente.
5. A revisão dos contadores do SHA produtivo mostrou que `matchedProducts` contava apenas preço
   positivo: o incremento ocorria depois do ramo `if (!price)`, enquanto zero também incrementava
   `invalidPrice` antes de ser persistido como tombstone. Logo, 181 + 320 = 501 não prova
   correspondência parcial. A correção separa produto encontrado, positivo, zero explícito,
   inválido, ausente, persistido e rejeitado; não exige `matchedProducts === received`.

As regressões usam 128/252,08/160 apenas como expectativas do caso, cobrem seleção com/sem filial,
falha fechada, produto ausente/preço inválido nos três pontos de entrada, alteração de regra, tombstone/restauração e snapshot
parcial. Os fluxos manual, automático e Atualizar estoque convergem em `syncPrices`, portanto recebem
a mesma validação; os call graphs existentes continuam protegidos pelos smokes.

### Semântica dos contadores e atomicidade

* `received`: elementos recebidos do endpoint;
* `productFoundRows`: linhas cujo produto foi encontrado após tenant+código+classificação;
* `matchedProducts`/`positivePriceRows`: linhas com preço positivo;
* `explicitZeroRows`: zeros processados como invalidação no contexto tabela/filial recebido;
* `invalidPrice`: valor ausente, não numérico ou negativo; zero não entra mais aqui;
* `missingProduct`: linha identificável sem produto correspondente;
* `persistedPriceRows`: linhas positivas ou zero para as quais houve create/update autoritativo;
* `rejectedRows`: linha malformada, preço inválido ou produto ausente;
* `updatedPrices`/`createdPrices`: materializações positivas atualizadas/criadas, preservadas
  separadamente para compatibilidade operacional.

Não há transação envolvendo cache, todos os upserts, validação final e `ErpSyncRun`. Se a validação
lançar erro depois de algumas gravações, o run fica `error`, o frontend recebe erro e a reconciliação
derivada não começa, porém cache e `ProductPrice` já gravados permanecem. O sweep de ausência é
bloqueado quando nem todas as linhas encontraram produto ou houve rejeição, limitando o efeito
parcial, mas isso **não é atomicidade**.

## Reconstrução controlada — proposta, não autorizada

A sync corrigida converge as fontes `products`, `prices` e `calculated_from_variation` sem excluir
`Product`, trocar IDs ou tocar preços já copiados em oportunidades/pedidos. A linha histórica
`prices/null/1=252,08` pode permanecer auditável sem ser selecionada. Portanto a primeira opção
pós-deploy é **não sanear**, executar sync completa controlada e validar contagens/seleção.

Se ainda houver materialização selecionável inválida, preparar operação separada: backup validado e
restaurável; lock de todos os pontos de sync; dry-run por IDs exatos exibindo contagens antes/depois;
alterar somente `ProductPrice` comprovadamente obsoleto (preferir `availabilityState=absent`, nunca
`DELETE`); executar a mesma mutação primeiro em clone PostgreSQL isolado; provar que referências e
preços históricos não mudaram; obter aprovação; aplicar transação com timeout; rodar sync de
reposição; validar Tabelas 1/2 e rollback pelo backup. Nenhum SQL mutativo foi preparado ou executado
nesta tarefa porque a correção torna a linha ambígua inelegível e ainda falta validação real.

## Pendências operacionais

Após merge/deploy: validar busca Tabelas 1/2; executar Atualizar estoque e conferir `received`,
`matchedProducts`, `updatedPrices`/`createdPrices`; executar sync completa; observar ao menos um ciclo
automático posterior ao deploy; confirmar filial comercial recebida quando houver contexto de pedido;
e investigar separadamente a semântica grupo 24 versus agrupamento 11. Incidente permanece aberto.

## Coleta pendente da origem de R$ 252,08 (somente leitura)

Executar uma única vez na VPS; a transação read-only, `statement_timeout` e projeção allowlisted
impedem mutação e não imprimem payload completo:

```bash
docker exec --user postgres -i gest-o-db-clean-v2-20260717 \
  psql -X -U postgres -d salesforce_pro -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
WITH cache AS (
  SELECT "updatedAt", value::jsonb AS doc
  FROM "AppConfig" WHERE key = 'erp.ultrafv3.prices'
), rows AS (
  SELECT cache."updatedAt", item
  FROM cache
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(doc) = 'array' THEN doc
      WHEN jsonb_typeof(doc->'items') = 'array' THEN doc->'items'
      WHEN jsonb_typeof(doc->'data') = 'array' THEN doc->'data'
      WHEN jsonb_typeof(doc->'rows') = 'array' THEN doc->'rows'
      WHEN jsonb_typeof(doc->'results') = 'array' THEN doc->'results'
      WHEN jsonb_typeof(doc->'content') = 'array' THEN doc->'content'
      ELSE '[]'::jsonb
    END
  ) AS expanded(item)
)
SELECT "updatedAt" AS cache_updated_at,
       coalesce(item->>'CODPRODUTO',item->>'COD_PRODUTO',item->>'productCode',item->>'erpProductCode',item->>'produto') AS product_code,
       coalesce(item->>'CODPRODUTO_CLAS',item->>'COD_PRODUTO_CLAS',item->>'productClassCode',item->>'erpProductClassCode',item->>'classificacao') AS class_code,
       coalesce(item->>'TABELA',item->>'CODTABELA',item->>'COD_TABELA',item->>'TABELA_PRECO',item->>'priceTableCode',item->>'tabela') AS table_code,
       coalesce(item->>'CODFILIAL',item->>'COD_FILIAL',item->>'branchCode',item->>'filial') AS branch_code,
       coalesce(item->>'PRECO',item->>'PRECO_LISTA',item->>'VALOR',item->>'price',item->>'preco',item->>'valor') AS price,
       coalesce(item->>'CODGRUPO',item->>'COD_GRUPO',item->>'groupCode',item->>'codigoGrupo',item->>'grupo') AS group_code
FROM rows
WHERE coalesce(nullif(ltrim(coalesce(item->>'CODPRODUTO',item->>'COD_PRODUTO',item->>'productCode',item->>'erpProductCode',item->>'produto'), '0'), ''), '0') = '1'
  AND coalesce(nullif(ltrim(coalesce(item->>'CODPRODUTO_CLAS',item->>'COD_PRODUTO_CLAS',item->>'productClassCode',item->>'erpProductClassCode',item->>'classificacao'), '0'), ''), '0') = '9'
ORDER BY table_code NULLS FIRST, branch_code NULLS FIRST, price;
ROLLBACK;
SQL
```

O resultado deve ser comparado diretamente aos aliases de
`upsertProductPricesFromRows`: produto/classificação, tabela, filial e preço. Se R$ 252,08 não estiver
no cache, o cache não prova a origem; será necessária leitura GET direta de `/prices` com as mesmas
credenciais/runtime e projeção allowlisted, sem chamar função de sync nem persistir resposta.

O caminho de código já comprovado é: `syncPrices` grava `result.rows` no cache sem transformação;
`upsertProductPricesFromRows` lê produto por `CODPRODUTO|COD_PRODUTO|productCode|erpProductCode|produto`,
classe por `CODPRODUTO_CLAS|COD_PRODUTO_CLAS|productClassCode|erpProductClassCode|classificacao`, tabela
por `TABELA|CODTABELA|COD_TABELA|TABELA_PRECO|priceTableCode|tabela`, filial por
`CODFILIAL|COD_FILIAL|branchCode|filial` e valor por `PRECO|PRECO_LISTA|VALOR|price|preco|valor`;
campos ausentes viram `NULL` no upsert de `ProductPrice`. A consulta pendente identifica qual alias e
valor estavam efetivamente presentes; sem sua saída, não se atribui R$ 252,08 ao ERP remoto.

O problema da atualização autenticada para `Product.tenantId=NULL` continua pendente: `NULL` não é
tratado como compartilhado sem contrato arquitetural. Descartar linhas sem tabela na seleção evita a
precedência indevida observada, mas não comprova a origem de R$ 252,08 nem corrige necessariamente a
normalização; os testes locais não substituem a consulta acima ao payload real.

## Resultado da coleta do cache e proveniência (27/09/2026)

A consulta foi executada com sucesso. Em `cache_updated_at=2026-09-27 13:00:54.765`, o cache contém
duas linhas para produto 1/classificação 9: tabela ausente, filial ausente, preço 128; e tabela
ausente, filial 1, preço 252,08. Isso comprova que 252,08 estava no cache recente, não apenas em
`ProductPrice`. Não comprova que o endpoint/identidade correspondam à tela ERP consultada.

O caminho de gravação foi inspecionado:

1. `syncPrices` resolve credencial de referência: usa credencial global quando configurada; caso
   contrário escolhe o primeiro vendedor ativo com credencial, ordenado por nome (`seller_reference`).
2. Faz GET de `/prices`, sem query string, por `fetchUltraFv3RowsWithAlias`; neste uso não há alias.
3. O cliente autentica, faz GET com Bearer e apenas converte o corpo JSON textual com `JSON.parse`.
4. `toArray` remove somente o envelope (`data`, `items`, `rows`, `result`, `results` ou `content`) e
   devolve os objetos de linha sem renomear campos, calcular preço ou combinar registros.
5. O `AppConfig.upsert` substitui o valor de `erp.ultrafv3.prices` por
   `JSON.stringify(result.rows)`. Não mescla com cache anterior.
6. Consultas posteriores `/prices?tabela=<código>` são agregadas apenas a `allPriceRows` para o
   upsert; não entram nesse cache.

Portanto, as duas linhas vieram do array extraído da resposta JSON do GET base `/prices` daquela
execução. O cache não preserva envelope, headers, status, bytes originais nem token/claims; tampouco
prova equivalência com a consulta visual do ERP. A origem remota semântica permanece condicionada à
identidade autenticada e aos filtros implícitos do endpoint.

### Coleta complementar dos nomes originais (somente leitura)

O primeiro SQL usou `coalesce` somente para localizar/projetar aliases. Para revelar campos
concorrentes sem imprimir o payload completo, executar:

```bash
docker exec --user postgres -i gest-o-db-clean-v2-20260717 \
  psql -X -U postgres -d salesforce_pro -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
WITH cache AS (
  SELECT "updatedAt", value::jsonb AS doc
  FROM "AppConfig" WHERE key = 'erp.ultrafv3.prices'
), rows AS (
  SELECT cache."updatedAt", item
  FROM cache
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(doc) = 'array' THEN doc
      WHEN jsonb_typeof(doc->'items') = 'array' THEN doc->'items'
      WHEN jsonb_typeof(doc->'data') = 'array' THEN doc->'data'
      WHEN jsonb_typeof(doc->'rows') = 'array' THEN doc->'rows'
      WHEN jsonb_typeof(doc->'results') = 'array' THEN doc->'results'
      WHEN jsonb_typeof(doc->'content') = 'array' THEN doc->'content'
      ELSE '[]'::jsonb
    END
  ) AS expanded(item)
)
SELECT "updatedAt" AS cache_updated_at,
       left(md5(item::text), 12) AS row_fingerprint,
       jsonb_strip_nulls(jsonb_build_object(
         'CODPRODUTO',item->'CODPRODUTO','COD_PRODUTO',item->'COD_PRODUTO',
         'productCode',item->'productCode','erpProductCode',item->'erpProductCode','produto',item->'produto',
         'CODPRODUTO_CLAS',item->'CODPRODUTO_CLAS','COD_PRODUTO_CLAS',item->'COD_PRODUTO_CLAS',
         'productClassCode',item->'productClassCode','erpProductClassCode',item->'erpProductClassCode',
         'classificacao',item->'classificacao')) AS identity_fields,
       jsonb_strip_nulls(jsonb_build_object(
         'TABELA',item->'TABELA','CODTABELA',item->'CODTABELA','COD_TABELA',item->'COD_TABELA',
         'TABELA_PRECO',item->'TABELA_PRECO','priceTableCode',item->'priceTableCode','tabela',item->'tabela',
         'CODFILIAL',item->'CODFILIAL','COD_FILIAL',item->'COD_FILIAL',
         'branchCode',item->'branchCode','filial',item->'filial')) AS context_fields,
       jsonb_strip_nulls(jsonb_build_object(
         'PRECO',item->'PRECO','PRECO_LISTA',item->'PRECO_LISTA','VALOR',item->'VALOR',
         'price',item->'price','preco',item->'preco','valor',item->'valor')) AS price_fields,
       jsonb_strip_nulls(jsonb_build_object(
         'CODGRUPO',item->'CODGRUPO','COD_GRUPO',item->'COD_GRUPO',
         'groupCode',item->'groupCode','codigoGrupo',item->'codigoGrupo','grupo',item->'grupo')) AS group_fields
FROM rows
WHERE (coalesce(nullif(ltrim(item->>'CODPRODUTO','0'),''),'0')='1'
    OR coalesce(nullif(ltrim(item->>'COD_PRODUTO','0'),''),'0')='1'
    OR coalesce(nullif(ltrim(item->>'productCode','0'),''),'0')='1'
    OR coalesce(nullif(ltrim(item->>'erpProductCode','0'),''),'0')='1'
    OR coalesce(nullif(ltrim(item->>'produto','0'),''),'0')='1')
  AND (coalesce(nullif(ltrim(item->>'CODPRODUTO_CLAS','0'),''),'0')='9'
    OR coalesce(nullif(ltrim(item->>'COD_PRODUTO_CLAS','0'),''),'0')='9'
    OR coalesce(nullif(ltrim(item->>'productClassCode','0'),''),'0')='9'
    OR coalesce(nullif(ltrim(item->>'erpProductClassCode','0'),''),'0')='9'
    OR coalesce(nullif(ltrim(item->>'classificacao','0'),''),'0')='9')
ORDER BY row_fingerprint;

SELECT scope, "authMode", "sellerId", "startedAt", "finishedAt",
       "syncedCount", "correlationId", metrics
FROM "ErpSyncRun"
WHERE scope='prices' AND "startedAt" <= timestamp '2026-09-27 13:00:54.765'
ORDER BY "startedAt" DESC LIMIT 3;
ROLLBACK;
SQL
```

Esse bloco não mostra nome/login, senha, token ou payload integral. A leitura HTTP direta não é
necessária para provar que as linhas estavam na resposta JSON extraída pelo sincronizador. Ela será
necessária se os campos/identidade acima não explicarem a divergência com a tela ERP. Antes disso,
deve-se criar um probe GET-only que reutilize exatamente `resolveReferenceCredentials`, desabilite
logs de corpo/token, projete campos allowlisted em memória e não invoque `syncPrices`, Prisma,
`AppConfig` ou `ProductPrice`. O cliente atual autentica (POST `/auth/login`), mantém token apenas em
cache de memória e faz GET, mas seu caminho de login de vendedor registra `ultraResponse`; por isso
não é seguro improvisar o probe em produção sem redaction específica e revisão prévia.

## Campos originais e identidade confirmados

A coleta complementar retornou exatamente as projeções:

```json
{"CODPRODUTO":1,"CODPRODUTO_CLAS":9,"CODFILIAL":1,"PRECO":252.08}
{"CODPRODUTO":1,"CODPRODUTO_CLAS":9,"PRECO":128}
```

Campos fora da allowlist não foram observados; dentro dela, a primeira linha possui filial 1 e a
segunda não possui campo de filial. Nenhuma possui campo de tabela na projeção. A execução que cobre
o timestamp do cache foi `seller_reference`, `sellerId=cmmqokl8d0003qu9f6bngo667`, correlação
`5840e359-b182-4297-ad1c-cc470ef44f8c`, iniciada `13:00:54.578` e finalizada `13:00:59.049` UTC.
As duas execuções anteriores listadas usaram o mesmo sellerId. Isso prova estabilidade da identidade
de referência observada, não equivalência dela com o usuário/contexto da tela ERP.

### Probe direto revisado, sem persistência

O bloco abaixo roda **dentro do container API atual**, usa apenas um `SELECT` Prisma pelo sellerId
exato, descriptografa a credencial apenas em memória, executa explicitamente `POST /auth/login` e
depois `GET /prices`, sem importar serviços de sync/logger, sem chamar `syncPrices` e sem escrever em
Prisma/cache/preços. A saída contém somente contexto sanitizado e aliases allowlisted, distinguindo
campo ausente (`present:false`) de nulo (`present:true,state:"null"`). O POST de login é efeito remoto
de autenticação e, portanto, o procedimento não é chamado de GET-only.

```bash
docker exec -i gest-o-api node --input-type=module <<'NODE'
import { PrismaClient } from '@prisma/client';
import { createDecipheriv, createHash } from 'node:crypto';

const SELLER_ID = 'cmmqokl8d0003qu9f6bngo667';
const TIMEOUT_MS = 30000;
const prisma = new PrismaClient();
const abort = () => AbortSignal.timeout(TIMEOUT_MS);
const fail = (stage, status = null) => {
  process.stdout.write(`${JSON.stringify({ ok: false, stage, status })}\n`);
  process.exitCode = 1;
};
const formatDocument = (value) => {
  const raw = String(value ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (/[.\-/]/.test(raw)) return raw;
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (digits.length === 14) return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return raw;
};
const decrypt = (cipherText, secret) => {
  const [version, iv, tag, encrypted] = String(cipherText).split(':');
  if (version !== 'v1' || !iv || !tag || !encrypted || !secret) throw new Error('credential_contract');
  const key = createHash('sha256').update(secret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
};
const toRows = (value) => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['data','items','rows','result','results','content']) {
    if (Array.isArray(value[key])) return value[key];
    if (value[key] && typeof value[key] === 'object') {
      const nested = toRows(value[key]);
      if (nested.length) return nested;
    }
  }
  return [];
};
const aliases = {
  identity: ['CODPRODUTO','COD_PRODUTO','productCode','erpProductCode','produto','CODPRODUTO_CLAS','COD_PRODUTO_CLAS','productClassCode','erpProductClassCode','classificacao'],
  context: ['TABELA','CODTABELA','COD_TABELA','TABELA_PRECO','priceTableCode','tabela','CODFILIAL','COD_FILIAL','branchCode','filial'],
  price: ['PRECO','PRECO_LISTA','VALOR','price','preco','valor'],
  group: ['CODGRUPO','COD_GRUPO','groupCode','codigoGrupo','grupo'],
  company: ['CODEMPRESA','COD_EMPRESA','empresa','companyCode'],
  seller: ['CODVENDEDOR','COD_VENDEDOR','vendedor','sellerCode'],
};
const field = (row, key) => Object.prototype.hasOwnProperty.call(row, key)
  ? { present: true, state: row[key] === null ? 'null' : 'value', value: row[key] }
  : { present: false };
const project = (row, keys) => Object.fromEntries(keys.map((key) => [key, field(row, key)]));
const normalize = (value) => String(value ?? '').trim().replace(/^0+(?=\d)/, '');
const anyEquals = (row, keys, expected) => keys.some((key) =>
  Object.prototype.hasOwnProperty.call(row, key) && normalize(row[key]) === expected);
const tokenContext = (token) => {
  try {
    const encoded = token.split('.')[1];
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const take = (...keys) => keys.map((key) => payload[key]).find((value) => value !== undefined) ?? null;
    return { salesman: take('salesman','vendedor'), operator: take('operator','operador'), branch: take('branch','filial'), partner: take('partner','parceiro'), exp: take('exp') };
  } catch { return { parseable: false }; }
};

try {
  const seller = await prisma.user.findUnique({
    where: { id: SELLER_ID },
    select: { id: true, erpCode: true, isActive: true, erpLoginUsername: true, erpLoginPasswordEncrypted: true },
  });
  if (!seller?.isActive || !seller.erpLoginUsername || !seller.erpLoginPasswordEncrypted) throw new Error('seller_contract');
  const base = new URL(String(process.env.ULTRAFV3_BASE_URL || ''));
  const password = decrypt(seller.erpLoginPasswordEncrypted, process.env.ERP_CREDENTIAL_ENCRYPTION_KEY);
  const loginStartedAt = new Date().toISOString();
  const login = await fetch(`${base.origin}${base.pathname.replace(/\/$/, '')}/auth/login`, {
    method: 'POST', signal: abort(), headers: { 'Content-Type':'application/json', Accept:'application/json' },
    body: JSON.stringify({ document: formatDocument(seller.erpLoginUsername), password, appVersion: '1.15.13' }),
  });
  const loginBody = await login.json().catch(() => null);
  const token = loginBody?.token || loginBody?.accessToken || loginBody?.access_token;
  if (!login.ok || !token) { fail('POST /auth/login', login.status); }
  else {
    const requestStartedAt = new Date().toISOString();
    const response = await fetch(`${base.origin}${base.pathname.replace(/\/$/, '')}/prices`, {
      method: 'GET', signal: abort(), headers: { 'Content-Type':'application/json', Accept:'application/json', Authorization:`Bearer ${token}` },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) fail('GET /prices', response.status);
    else {
      const rows = toRows(body).filter((row) => row && typeof row === 'object'
        && anyEquals(row, ['CODPRODUTO','COD_PRODUTO','productCode','erpProductCode','produto'], '1')
        && anyEquals(row, ['CODPRODUTO_CLAS','COD_PRODUTO_CLAS','productClassCode','erpProductClassCode','classificacao'], '9'));
      process.stdout.write(`${JSON.stringify({
        ok: true,
        operations: ['local SELECT User by id','POST /auth/login','GET /prices'],
        target: { protocol: base.protocol, host: base.host, basePath: base.pathname, endpoint: '/prices' },
        auth: { mode: 'seller_reference', sellerId: seller.id, erpCode: seller.erpCode, tokenContext: tokenContext(token) },
        timing: { loginStartedAt, requestStartedAt, finishedAt: new Date().toISOString() },
        response: { status: response.status, topLevel: Array.isArray(body) ? 'array' : typeof body, extractedRows: toRows(body).length },
        matches: rows.map((row) => Object.fromEntries(Object.entries(aliases).map(([group, keys]) => [group, project(row, keys)]))),
      }, null, 2)}\n`);
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : 'probe_failed');
} finally {
  await prisma.$disconnect();
}
NODE
```

O comando não imprime login/documento, senha, chave, token, nome do vendedor, resposta de login ou
campos fora da allowlist. Não redirecionar stderr/stdout para logs públicos sem revisar a saída.

## Resultado do probe direto e revisão da correção (27/09/2026)

O probe foi executado sem sincronização. Às `2026-09-27T13:40:41Z`, `GET /prices` respondeu HTTP 200
com 501 linhas. Para 1/9 retornou `CODFILIAL=null, PRECO=128` e
`CODFILIAL=1, PRECO=252.08`; nenhum alias de tabela pesquisado estava presente. O token sanitizado
indicou vendedor 6611, operador 43 e filial 1. A tela/pedido ERP usada como referência estava em
vendedor 7081 e filial 1, mostrando Tabela 1=128 e Tabela 2=160. Assim, está comprovado que 252,08
vem da resposta direta da API nessa identidade; sua origem interna e equivalência com a tela não.

O repositório contém apenas o cliente/proxy consumidor de `/prices`, normalização, cache e
persistência. Não contém implementação do endpoint externo, SQL, views ou joins que calculam sua
resposta. O único route handler local é um proxy para o mesmo caminho. Foi criado um
[relato técnico sanitizado](evidence/ultrafv3-prices-product-1-class-9-2026-09-27.md) solicitando ao
responsável as fontes, filtros, vigência, precedência, significado de `CODFILIAL=null` e contrato de
tabela.

### Bloqueio pré-merge

A correção proposta exige `erpPriceId` explícito na seleção. O payload real provou que **ambas** as
linhas do GET base não carregam nenhum alias de tabela. Portanto, elas seriam descartadas pela busca:
isso impede 252,08 de vencer no caso observado, mas também descarta a linha 128 e qualquer zero
explícito sem tabela. O caso permanece visível graças à materialização `/products` explicitamente
marcada como Tabela 1 e à derivada da Tabela 2, mas isso não demonstra um contrato geral nem preserva
necessariamente a autoridade de `/prices` para outros produtos.

Consequentemente, `READY_TO_MERGE_PRICE_FIX=NO`. Não se deve resolver escolhendo o menor preço,
atribuindo tabela 1 a `NULL`, tratando filial nula como TODAS ou fixando 128/160. Antes de alterar a
seleção/normalização, é necessário obter o contrato do integrador ou comparar, com autorização, a
mesma chamada sob vendedor 7081. Essa comparação não pode trocar a credencial persistida nem alterar
a configuração do scheduler; deve usar probe isolado equivalente, nova autenticação em memória e
saída allowlisted.

A falha de seleção do CRM está comprovada historicamente (mistura de contextos e precedência). A
falha da resposta/contrato de integração continua investigativa: duas linhas conflitantes foram
devolvidas, mas a diferença de identidade e os filtros internos não são conhecidos. A pendência
`tenantId=NULL` do Atualizar estoque continua independente.

## 27/09 — vigência histórica, mapa dos executáveis e revisão da proposta

### Fatos comprovados

- GET direto atual: 501 linhas; produto 1/classificação 9 com `(CODFILIAL=null, PRECO=128)` e `(CODFILIAL=1, PRECO=252.08)`; nenhum alias pesquisado de tabela. Identidade: vendedor 6611, operador 43, filial 1.
- Tela ERP: vendedor 7081, filial 1, Tabela 1=128 e Tabela 2=160. A equivalência de identidades/contextos não foi comprovada.
- Somente no log histórico de 03/09: 128 tem `PRECOS_ID=2776`, `DATA_VIGENCIA=2026-06-09`, `DTAALTER=2026-06-09...`; 252,08 tem `PRECOS_ID=2166`, vigência/alteração de 2022. Não se transplantam esses campos para o GET atual.

### Evidência externa recebida (não reinspecionada neste checkout)

O pacote UltraFV3 analisado estaticamente (hash informado `94799c...bca3`) contém controlador que chama `WS_PRECOS(date)` e não encaminha tabela, vendedor ou filial; o binário em execução ainda não foi comparado. O Gestao.exe contém uma consulta `PRECOS_CLASSIF_MAIS_ATUAL` que ordena vigência antes da filial e referência a `PRECO_VENDA`. Isso orienta a coleta, mas não constitui contrato definitivo da tela.

### Perda demonstrada no CRM e alteração preparada

O normalizador anterior não preservava `PRECOS_ID`, `DATA_VIGENCIA` e `DTAALTER`; o upsert atualizava `updatedAt`, confundindo reobservação com novidade comercial. A migration aditiva e o normalizador preparados separam `erpSourcePriceId`, `validFrom`, `sourceChangedAt` e `observedAt`. `PRECOS_ID` é usado apenas no escopo do produto/contexto, não como chave global. Vigências futuras não participam da seleção. A tabela ausente continua um bloqueio: descartar as linhas não explica nem corrige o contrato.

### Fluxos e atomicidade

Completa, automática e Atualizar estoque convergem em `syncProducts`/`syncPrices`. No botão, produtos incluem estoque e devem continuar antes dos preços. São gravações incrementais sem transação abrangendo chamada remota e duas etapas; uma falha posterior pode deixar gravações anteriores. A mensagem preparada explicita parcialidade.

### Premissas retiradas / lacunas

Não se assume filial nula = TODAS, tabela ausente = Tabela 1, filial exata antes da vigência, menor preço, tenancy nula compartilhada, nem `updatedAt` como data ERP. Seguem pendentes semântica Firebird, vínculo grupo 24/agrupamento 11, equivalência dos vendedores e atualização autenticada de `tenantId=NULL`. Portanto `READY_TO_MERGE_PRICE_FIX=NO`.

### Próxima coleta mínima

Usar primeiro o SQL somente de metadados em `evidence/firebird-price-metadata-read-only.sql`; ele não executa procedures. Para produzir o comando Windows exato ainda são indispensáveis: caminho real confirmado do `isql.exe`, alias/host autorizado e identificador do banco correto (sem enviar senha). Depois dos metadados, formular uma segunda leitura mínima do vínculo em `AGRUPAMENTOS` com os nomes reais das colunas.

## Consolidação no checkout recuperado

O SHA informado `1f50c9e...` não existe no objeto Git deste checkout (`NOT_VERIFIED`); o trabalho foi
recuperado no commit squash `9b7973e...`. O arquivo novo não foi recriado: sua presença foi confirmada
na árvore em `docs/investigations/evidence/firebird-price-metadata-read-only.sql`. Não há remote
configurado, portanto main posterior, PR publicada e incidentes remotos são `NOT_VERIFIED`.

A correção de tenancy foi alinhada ao modo vigente: `disabled` mantém o catálogo global/null nos três
fluxos; `default-only` mantém filtro exato e não adota nulos. A política comercial segue bloqueada:
metadados de origem são preservados, mas falta provar tabela/filial/grupo e equivalência de identidade
antes de permitir seleção das linhas sem tabela. O harness PostgreSQL do caminho real `db push` foi
versionado; execução local está bloqueada pela ausência de Docker e cliente PostgreSQL.

## Screenshot do log de preços das 18:00:55 (27/09/2026)

Evidência visual fornecida pelo operador, não inspeção do JSON completo:
`C:\Ultra\UltraFV3\logs\request\2026-09-27-18-00-55-prices-GET.json` mostra, para produto 1/classe 9,
`PRECOS_ID=2878`, preço 128, filial nula, vigência `2026-09-24` e alteração
`2026-09-24T19:49:04.975Z`; e `PRECOS_ID=2166`, preço 252,08, filial 1, vigência `2022-08-26` e
alteração `2022-08-26T16:59:58.214Z`. Isso difere do arquivo histórico anterior, no qual o preço 128
estava em `PRECOS_ID=2776` com vigência de junho. Não há correlação demonstrada entre o arquivo das
18:00:55 e o probe direto das 13:40. Quando o JSON chegar, deve-se verificar envelope e campos
originais e produzir somente uma fixture sanitizada; IDs/datas/valores não viram constantes da regra.

Os pacotes `FirebirdSql.Data.FirebirdClient(1).zip` e `(2).zip` já foram comparados externamente e os
arquivos internos têm hashes correspondentes iguais. Eles contêm driver, configuração e logs, não as
definições das procedures comerciais. Não repetir pesquisa na pasta do driver: o próximo passo é a
leitura dos metadados Firebird pelo script já versionado.

## Falha de schema da PR #899 e sequência corrigida (28/09/2026)

O job `orders-migration-postgres` chegou a `final_schema_diff` com a expansão
`20260911190000_product_price_authority` aplicada, mas sem
`20260927160000_product_price_source_observation`. Por isso o Prisma retornou `EXIT_2` e listou
`erpSourcePriceId`, `observedAt`, `sourceChangedAt` e o índice como drift. A comparação estava correta;
a sequência de preparação do banco estava incompleta.

O harness agora aplica, tanto em `fresh_sequence` quanto em `upgrade_from_previous`: Orders →
autoridade de preço → proveniência/observação → `migrate diff --exit-code`. O teste de segurança exige
textualmente as duas expansões antes do diff final. O harness dedicado de `prisma db push` passou a
ser um job CI independente, sem dependência do job de Orders; retorno 77 continua não sendo sucesso.
Neste checkout sem Docker foram validados sintaxe, testes estáticos e workflow, não a execução
PostgreSQL. O resultado real de banco deve ser registrado apenas quando o CI terminar verde.
