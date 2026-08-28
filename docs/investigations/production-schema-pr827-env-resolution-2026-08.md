# Production Schema PR827 — resolução protegida do ambiente

## Evidência e impacto

O preview do workflow **Production Schema PR827**, run **33196976100**, job
**98936493036**, chegou por SSH ao checkout de `main`, atualizou-o e iniciou o
runner allowlisted. Ele parou em `production environment file absent`, antes de
qualquer acesso ao schema. Nenhuma migration foi aplicada, nenhuma escrita foi
feita e produção não foi modificada.

## Causa raiz e call graph

O workflow chamava o runner sem `PRODUCTION_ENV_FILE`. O runner então aplicava
um default local que pressupunha somente a fonte canônica. Os fluxos produtivos
comprovados usam o contrato protegido que seleciona a fonte canônica ou a única
fonte de compatibilidade autorizada (`legacy_copy`). A evidência operacional
indica `legacy_copy`; por isso o default não representava a fonte produtiva real.

O call graph corrigido é `workflow → SSH → checkout main → resolvedor canônico
→ registro validado (classificação + referência opaca) → runner PR827 →
preflight de schema`.

O resolvedor seleciona exatamente uma das duas entradas autorizadas e falha se
ambas estiverem presentes. O runner não procura nem escolhe arquivos: recebe o
resultado explicitamente e repete as validações de arquivo regular não-symlink,
owner esperado e modo `600`. Depois valida sintaxe e a cardinalidade/presença de
`DATABASE_URL`, sem registrar valores. A referência protegida, owner numérico,
conteúdo e URL não são emitidos.

## Invariantes operacionais

- A fonte selecionada permanece imutável; o hash é conferido ao sair.
- Preview continua read-only e termina após ledger/catálogo/predecessor.
- Apply continua separado e exige `APPLY_PR827_SCHEMA`, SHA e imagem fixadas,
  backup aprovado, allowlist/checksum, predecessor, ledger e catálogo.
- Não há cópia, movimentação ou criação de env, busca no filesystem ou política
  de “primeiro arquivo encontrado”.
- Os marcadores públicos são `PR827_ENV_SOURCE=legacy_copy|canonical`,
  `PR827_ENV_METADATA=VALID`, `PR827_DATABASE_URL_CONTRACT=PASS`,
  `PR827_ENV_IMMUTABLE=PASS` e `PR827_SCHEMA_PREFLIGHT=PASS`.

Até a PR corretiva ter checks remotos verdes, ela não está pronta para merge.
Até a correção estar mesclada e `main` verde, o preview não deve ser reexecutado.
Esta correção não autoriza apply, migration, deploy, cutover, Recovery, seed,
backfill ou qualquer alteração na VPS.

## Follow-up: parametrização do ledger (run 33199668348)

O preview seguinte, run **33199668348**, job **98945662977**, comprovou os
gates `PR827_ENV_SOURCE=legacy_copy`, `PR827_ENV_METADATA=VALID`,
`PR827_DATABASE_URL_CONTRACT=PASS` e `PR827_ENV_IMMUTABLE=PASS`. Em seguida,
ele parou com erro de sintaxe próximo de `:` ao consultar o ledger: a chamada
usava `psql -c` com `migration_name=:'migration'`, modo no qual o marcador não
foi substituído pelo cliente e chegou literal ao PostgreSQL.

A consulta agora é fornecida pela entrada padrão em heredoc literal e o valor é
passado separadamente por `--set=migration_name=...`; assim o `psql` processa
`:'migration_name'` antes de enviar a instrução. A allowlist exata
`20260827190000_add_erp_order_manual_resolution` continua sendo verificada antes
da primeira consulta. Não há `eval` nem interpolação shell do valor no SQL.

O erro ocorreu antes de qualquer escrita. A migration permaneceu não aplicada e
a produção não foi modificada. Preview continua limitado a ledger, catálogo e
diff estrutural; apply continua bloqueado por confirmação literal, aprovação e
backup. `READY_TO_MERGE_PR827_PSQL_FIX=NO` até checks remotos verdes e
`READY_TO_RERUN_PREVIEW=NO` até merge e `main` verde.

## Follow-up: ledger ausente (run 33204493337)

O run `33204493337`, job `98961963978`, confirmou novamente `legacy_copy`, metadata,
contrato da URL e imutabilidade e parou em `relation "_prisma_migrations" does not
exist`, antes de escrita. O gate de identidade imediatamente anterior comprova a classe
`salesforce_pro/postgres`; não prova schema/search path nem ausência global da tabela.

A–H: A e H são rejeitadas pela identidade allowlisted e pelo servidor PostgreSQL que
respondeu; B, C, E, F e G permanecem não distinguíveis pela evidência antiga; D é
fortemente sustentada e é a incompatibilidade contratual comprovada pelos documentos e
scripts (`db push` + SQL manual/`applied.tsv`, sem ledger confiável). A nova sondagem
read-only produzirá as classes faltantes sem revelar nomes fora da allowlist. Ela também
prova o predecessor pelos 11 conjuntos coluna nullable/índice/FK e `Tenant`, e classifica
os objetos PR827 como ausentes, completos ou parciais/divergentes.

O contrato legado proposto não fabrica história: checksum versionado, catálogo exato e
evidência histórica auditada podem satisfazer uma precondição estrutural, mas não tornam
a migration “registrada no Prisma”. O runner continua falhando se o ledger não for
`public` e visível, e apply continua bloqueado. Veja as
[lições consolidadas](production-schema-pr827-lessons-learned.md).
