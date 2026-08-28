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
