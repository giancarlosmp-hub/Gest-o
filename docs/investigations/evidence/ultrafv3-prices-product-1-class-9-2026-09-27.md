# Relato técnico sanitizado — `GET /prices`, produto 1/classificação 9

## Objetivo

Solicitar ao responsável pelo integrador UltraFV3 a proveniência e o contrato comercial de duas
linhas divergentes devolvidas pelo mesmo GET, sem concluir antecipadamente que a API ou a tela está
incorreta.

## Requisição observada

- Operações: `POST /auth/login`, seguido de `GET /prices`.
- GET sem query string e sem body; endpoint base configurado no runtime produtivo (host não incluído
  neste relato até validação do destinatário).
- Horário do GET: `2026-09-27T13:40:41Z`.
- HTTP: `200`; total extraído: `501` linhas.
- Identidade sanitizada do token: vendedor `6611`, operador `43`, filial `1`.
- Nenhuma senha, documento de login, token, chave, URL completa ou resposta de autenticação é
  incluída.

## Linhas comerciais projetadas

Produto `CODPRODUTO=1`, classificação `CODPRODUTO_CLAS=9`:

```json
{"CODPRODUTO":1,"CODPRODUTO_CLAS":9,"CODFILIAL":null,"PRECO":128}
{"CODPRODUTO":1,"CODPRODUTO_CLAS":9,"CODFILIAL":1,"PRECO":252.08}
```

`CODFILIAL` está explicitamente nulo na primeira linha. Nenhum dos aliases de tabela pesquisados
(`TABELA`, `CODTABELA`, `COD_TABELA`, `TABELA_PRECO`, `priceTableCode`, `tabela`) está presente nas
duas projeções. Campos fora da allowlist não foram coletados.

## Comparação visual separada

Na tela comercial/pedido do ERP, usando vendedor `7081` e filial `1`, o operador confirmou:

- Tabela 1: R$ 128,00;
- Tabela 2: R$ 160,00.

As identidades de vendedor divergem (`6611` na integração, `7081` na tela). Portanto, os resultados
não são ainda comparáveis como se viessem do mesmo contexto.

## Perguntas ao responsável pelo UltraFV3

1. Quais tabelas/views, joins e campos originam cada linha do `GET /prices`?
2. Quais filtros de empresa, vendedor, operador, filial, cliente, grupo, unidade, vigência e tabela
   de preços são derivados do token ou aplicados implicitamente?
3. O que significa `CODFILIAL=null`: ausência de escopo, todas as filiais, preço geral, fallback ou
   outra regra? Solicita-se referência contratual, não inferência.
4. Qual é o identificador de tabela de cada linha quando nenhum campo de tabela é devolvido?
5. Qual regra de precedência deve ser usada quando há uma linha sem filial e outra da filial 1 para
   o mesmo produto/classificação?
6. De qual registro/regra/vigência resulta R$ 252,08 para vendedor 6611, operador 43 e filial 1?
7. O endpoint aceita parâmetros explícitos de empresa, vendedor, filial ou tabela? Em caso positivo,
   quais são os nomes, tipos e defaults?
8. O contexto vendedor 7081/filial 1 deveria produzir resposta diferente? Comparação direta somente
   será feita se existir credencial autorizada, sem trocar a credencial configurada da sincronização.

## Evidência solicitada na resposta

Resposta sanitizada com nome lógico da fonte (tabela/view), campos de join/filtro, regra de vigência,
precedência, significado de nulos e contrato de tabela. Não enviar credenciais, tokens, documentos,
dados pessoais nem dump integral. O incidente no CRM permanece aberto e nenhum saneamento depende
deste relato sem validação posterior.

## Complemento: log histórico e limite temporal

O GET atual confirmou apenas valores/filiais. Separadamente, o log histórico de 03/09 associa `PRECOS_ID=2776` e datas de 2026 ao valor 128, e `PRECOS_ID=2166` e datas de 2022 ao valor 252,08. Esses metadados não são atribuídos à resposta atual sem nova projeção. `cache_updated_at` e `ProductPrice.updatedAt` medem coleta/persistência, não vigência comercial.

A análise estática externa recebida indica que a versão examinada de `/prices` chama `WS_PRECOS(date)` sem tabela/vendedor/filial. A igualdade desse executável com o processo ativo permanece não comprovada. O pedido ao mantenedor deve incluir, de forma sanitizada, as duas linhas, as identidades distintas 6611/7081 e solicitar contrato de filial nula, tabela, vigência e origem interna de 252,08.

## Screenshot do arquivo das 18:00:55

O operador apresentou screenshot de
`C:\Ultra\UltraFV3\logs\request\2026-09-27-18-00-55-prices-GET.json`. Para 1/9, a imagem mostra
128 com `PRECOS_ID=2878`, filial nula, vigência/alteração em 24/09; e 252,08 com
`PRECOS_ID=2166`, filial 1, vigência/alteração em 26/08/2022. É evidência visual, não inspeção do JSON
completo, e não há correlação demonstrada com o GET direto das 13:40. O ID 2878 não substitui o ID
2776 do arquivo histórico anterior: são observações de artefatos distintos. A fixture sanitizada será
criada somente após receber e conferir envelope/campos do JSON.
