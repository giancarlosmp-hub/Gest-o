# Production Schema PR827 — lições consolidadas do rollout

## Evidência conclusiva do legado — run 33213116026 / job 98990686108

O diagnóstico read-only comprovou database, usuário administrativo, schema e `search_path` esperados em PostgreSQL 16.14, e distinguiu ausência global de `_prisma_migrations` de invisibilidade. Os catálogos de tenancy e PR827 estavam ausentes e nenhuma escrita ocorreu. A causa raiz foi impor um ledger Prisma e o predecessor de tenancy escolhido pela ordem dos diretórios, embora produção use bundles `applied.tsv` da transição SQL de julho.

O contrato corrigido trata `20260731150000_safe_production_schema_transition` como baseline real e valida `ErpOrderSync.id`, `Opportunity.id`, `User.id` e `Role`. O SQL PR827 não referencia Tenant nem `tenantId`. Preview dispensa imagem e não escreve. Apply mantém confirmação, SHA, backup, imagem, transação, publicação atômica, catálogo exato, diff vazio e idempotência.

Data de consolidação: 2026-08-28. Este registro não é autorização operacional.

| Falha observada | Causa | Correção | Regressão obrigatória |
|---|---|---|---|
| `production environment file absent` (run `33196976100`, job `98936493036`) | O workflow assumia o caminho canônico, mas a fonte real era a cópia legada protegida. | Usar o resolvedor existente, exigir exatamente uma fonte e entregar ao runner somente classe e referência validada. | `pr827-production-env-safety.sh`: cardinalidade, arquivo regular, owner/mode, sintaxe, `DATABASE_URL` única e hash imutável. |
| token literal `:'migration_name'` (run `33199668348`, job `98945662977`) | `psql -c` não fez a substituição esperada e enviou o token ao servidor. | SQL em stdin por heredoc literal e valor em `--set`, depois da allowlist. | `pr827-schema-runner-safety.mjs`: proíbe interpolação shell e `-c` no bloco parametrizado. |
| `_prisma_migrations` ausente (run `33204493337`, job `98961963978`) | O runner novo assumiu um ledger Prisma, contrariando o contrato histórico documentado: produção foi sincronizada por `prisma db push` e a transição SQL de julho gerou `applied.tsv`, não ledger. A mensagem isolada prova apenas que a relação não estava visível no `search_path`; ainda não prova ausência global nem exclui outro schema. | O preview passa a classificar conexão, schema, `search_path`, versão PostgreSQL, localização/visibilidade do ledger, catálogo predecessor e catálogo PR827, somente em transações read-only. Ledger ausente ou fora de `public` continua falha fechada; apply segue bloqueado. | Teste estático exige todas as sondagens sanitizadas, `BEGIN TRANSACTION READ ONLY`, ausência de DDL/DML no diagnóstico e falha antes da consulta ao ledger. |
| SQL diagnóstico inválido (run `33206303362`, job `98968114798`) | A revisão foi somente estática e aceitou `current_schemas(false)[1]`, sintaxe que o PostgreSQL 16 rejeita. | O acesso posicional agora é `(current_schemas(false))[1]`; os blocos reais foram extraídos para arquivos únicos, executados pelo runner e pelo harness. | `test:pr827-preview:postgres` executa conexão, ledger, predecessor e catálogo PR827 reais, cobre todos os estados e `search_path`, e prova que uma escrita em transação read-only é recusada. |

## Contrato legado proposto, não adotado automaticamente

Se a nova sondagem confirmar ledger globalmente ausente, classificar a história como
`LEGACY_NO_PRISMA_LEDGER`: exigir catálogo exato dos 11 roots da migration predecessor,
checksum versionado, evidência histórica `applied.tsv`/diff do SHA correspondente e revisão
humana auditada. Isso pode provar a precondição estrutural, mas **não** equivale a registro
Prisma e não autoriza o runner atual a inserir baseline. A eventual criação/adoção de ledger
é uma mudança operacional separada. Até essa decisão, preview termina em erro e apply não é
alcançável.

## PR827 final — histórico legado e incidente UltraFV3/Tailscale (31/08/2026)

O run `33383729453`/job `99461567959` falhou no estágio de metadata da raiz do histórico, antes de PostgreSQL e sem escrita: `SCHEMA_EVIDENCE_DIR_MODE` recebeu a classe produtiva `755_PROTECTED_BUNDLE_ROOT`, enquanto o runner permitia apenas `700_OWNER_PRIVATE` e `750_GROUP_TRAVERSE`. Isso não era `ERP_PRODUCTION_ENV_SOURCE=legacy_build_only`, `PR827_ENV_SOURCE=legacy_copy`, nem o modo `preview/apply`; era a permissão da raiz que contém os bundles protegidos. O contrato agora valida explicitamente o par `legacy_build_only:legacy_copy`, aceita somente 700/750/755 na raiz, mantém diretórios de bundle em 700 e `applied.tsv`/`migration.sha256` em 600, e registra apenas variável, classes, classe recebida e estágio. Valores desconhecidos falham sem fallback. Preview e apply suportam exclusivamente `applied.tsv` + `migration.sha256`; `_prisma_migrations` e `tenancy_expand_roots` não são exigidos. Preview não exige imagem e não escreve.

A causa operacional comprovada da indisponibilidade foi o peer Windows “servidor” offline no Tailscale; a VPS permaneceu conectada. Após reconectar o Windows e iniciar o UltraFV3Rest, as simulações passaram e um único novo pedido real foi confirmado como ERP **900113**. Isso não caracteriza defeito do Tailscale e não autoriza novo pedido para evidência. O pedido antigo `6f5edc8a-55a7-4502-a816-a8b94b8e67c2`, confirmado ausente por operador no UltraFV3, permanece imutável e bloqueado até o diretor registrar resolução append-only e o fluxo criar exatamente uma tentativa com `supersedesErpOrderSyncId`; nunca há resolução ou reenvio automático.

Antes de simulação/envio, `GET /salesmen` funciona como preflight read-only limitado a 10 s. Falha de timeout/conexão/autenticação bloqueia antes de qualquer `ErpOrderSync` e apresenta: “UltraFV3 indisponível. Verifique se o servidor, Tailscale e UltraFV3Rest estão conectados antes de tentar novamente.” Logs registram somente `correlationId`, classe `ERP_REACHABILITY`, classe de endpoint, duração e razão `timeout|connect|auth|5xx`. `scripts/diagnose-ultrafv3-reachability.sh` faz diagnóstico periódico GET-only, publica estado sanitizado para Saúde da Plataforma e retorna falha para o alertador; recuperação jamais chama `POST /orders`. No Windows, `scripts/windows/Ensure-UltraFV3Connectivity.ps1` configura o serviço Tailscale como Automatic, verifica conexão e inicia UltraFV3Rest apenas se parado, de forma idempotente e sem dados de rede no log. Instalação/execução remota não faz parte desta entrega.

Alternativas documentadas, não implementadas: manter Tailscale com autostart/watchdog é a recomendação atual; Cloudflare Tunnel autenticado e WireGuard site-to-site são alternativas futuras; IP público fixo/porta exposta não é recomendado sem reverse proxy, TLS, firewall, autenticação forte e allowlist.

## HISTORY_DIVERGENT do baseline — run 33427243014 (31/08/2026)

A inspeção read-only sanitizada do bundle e a reconstrução do produtor identificaram o primeiro
predicado incompatível: `BUNDLE_METADATA_INVALID`. O bundle único é evidência oficial do
`scripts/production-schema-apply.sh`: o produtor V1 criava o diretório com `mkdir -p` e os dois
arquivos por `tee`/redirecionamento sob o umask administrativo oficial, resultando nas classes
exatas `755_ROOT_OWNED_READ_ONLY` para o bundle e `644_ROOT_OWNED_READ_ONLY` para
`applied.tsv`/`migration.sha256`. O leitor novo aceitava exclusivamente o formato atômico V2
`700/600/600`. Portanto, ele rejeitava a metadata antes de comparar os checksums, embora nenhum
usuário não administrativo pudesse modificar a evidência.

O bundle encontrado tem cardinalidade um, diretório e arquivos regulares (nenhum symlink), owner
administrativo, uma linha e três campos TSV, timestamp UTC canônico, commit hexadecimal completo
existente, path allowlisted e migration presente nesse commit. O sidecar tem uma linha no formato
estrito `sha256sum`; seu SHA-256, o blob Git e o esperado versionado são
`66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506`. Os três coincidem.
Os demais artefatos do diretório são os arquivos de diagnóstico que o próprio produtor V1 publica;
não há arquivo inesperado capaz de ampliar a allowlist. O catálogo PostgreSQL não foi alcançado
nesse run, portanto seu estado para esta evidência é `NOT_EVALUATED`.

A correção versiona dois formatos, sem fallback: `PRODUCTION_SCHEMA_APPLY_V1` aceita somente o trio
root-owned `755/644/644`; `PR827_ATOMIC_V2` aceita somente `700/600/600`. Ambos continuam exigindo
regular file, ausência de symlink, cardinalidade, timestamp real, SHA de commit completo, commit
existente, diretório nomeado pelo commit, path exato, blob existente, sidecar estrito e igualdade
Git/sidecar/esperado. Falhas agora expõem somente a primeira categoria sanitizada. Nada no leitor
cria, completa ou altera evidência e preview permanece sem escrita.

Resultado: `ROOT_CAUSE_HISTORY_DIVERGENT=V1_METADATA_REJECTED_BY_V2_ONLY_READER`;
`HISTORY_DIVERGENCE_CATEGORY=BUNDLE_METADATA_INVALID`;
`HISTORICAL_PRODUCER=scripts/production-schema-apply.sh`;
`HISTORICAL_FORMAT_VERSION=PRODUCTION_SCHEMA_APPLY_V1`;
`CURRENT_READER_CONTRACT=VERSIONED_STRICT_V1_OR_V2`;
`BASELINE_BUNDLE_CARDINALITY=1`;
`BASELINE_BUNDLE_METADATA=REGULAR_NON_SYMLINK_ROOT_OWNED_755_V1`;
`APPLIED_TSV_LINE_COUNT=1`; `APPLIED_TSV_FIELD_COUNT=3`;
`TIMESTAMP_CLASS=UTC_CANONICAL`; `COMMIT_SHA_CLASS=HEX40`; `COMMIT_EXISTS=YES`;
`MIGRATION_PATH_CLASS=ALLOWLISTED`; `MIGRATION_EXISTS_AT_COMMIT=YES`;
`SIDECAR_STATE=REGULAR_NON_SYMLINK_ROOT_OWNED_644_SHA256SUM_V1`;
`GIT_BLOB_SHA256=66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506`;
`SIDECAR_SHA256_CLASS=HEX64`; `EXPECTED_SHA256=66efa6f797840a19731c15e264b8e5398f3e44179da8a35795c247b53baa5506`;
`CHECKSUM_GIT_MATCH=YES`; `CHECKSUM_SIDECAR_MATCH=YES`;
`CATALOG_BASELINE_STATE=NOT_EVALUATED`; `FIX_CLASS=READER_COMPATIBILITY`;
`PREVIEW_WRITES=NONE`; `MIGRATION_APPLIED=NO`; `PRODUCTION_MODIFIED=NO`; `ORDER_RESENT=NO`;
`RUN_EVIDENCE=33427243014`; `JOB_EVIDENCE=99603693137`.
`READY_TO_MERGE_HISTORY_FIX=NO` até checks remotos verdes;
`READY_TO_RERUN_SCHEMA_PREVIEW=NO` até merge e main verde; `READY_TO_APPLY_PR827=NO`.

## Exit 1 posterior ao preview aprovado — run 33441163558

O run/job `33441163558`/`99649450951` imprimiu todas as provas operacionais, inclusive
`PRIMARY_CHECKOUT_REFS_MODIFIED=NO`, e somente então terminou com status 1. Assim, o comando
posterior ao último marcador era exclusivamente o `EXIT trap cleanup`. O handler antigo iniciava
com o status do último comando, mas substituía esse status por 1 quando qualquer remoção falhava e
encerrava com `return "$rc"`; todos os stderr de Docker estavam redirecionados. A evidência antiga
prova `EXIT_TRAP_RETURNED_1_AFTER_OPERATION_PASS`, mas não permite inventar se a remoção que mudou
`rc` foi container ou network. A ausência dessa classificação era o defeito diagnóstico do cleanup.
Não foi comparação de refs, comando negativo esperado nem ausência de sucesso operacional: esses
pontos precederam seus marcadores PASS.

O harness agora registra criação individual de container, network, imagem e diretório temporário.
O `EXIT` captura o status original antes de qualquer cleanup; recursos não criados são
`NOT_CREATED`, recursos já ausentes são `ALREADY_ABSENT`, e recursos removidos precisam de uma
segunda inspeção que comprove ausência. Falha operacional preserva seu código original. Operação
aprovada com cleanup reprovado termina em 1 e informa a classe exata. Somente operação e cleanup
aprovados imprimem `PR827_PREVIEW_HARNESS_FINAL_RESULT=PASS` e terminam explicitamente em zero.
Signals INT/TERM entram no mesmo contrato com 130/143. Não há `|| true`, `|| :`, prune ou
`continue-on-error`.

A correção é exclusivamente do encerramento do harness PostgreSQL 16. Runner produtivo, parser,
baseline, checksums, migration, catálogo e produção não foram alterados. O resultado remoto pós-fix
permanece pendente até os checks da PR #839 executarem preview e apply PostgreSQL 16.

## Camada externa posterior ao marcador final — run 33442417298

O run/job `33442417298`/`99653533522` fechou definitivamente o cleanup: publicou
`HARNESS_OPERATION_RC=0`, `HARNESS_CLEANUP_FINAL_STATE=PASS`, `HARNESS_FINAL_RC=0` e
`PR827_PREVIEW_HARNESS_FINAL_RESULT=PASS`. A medição pai posterior comprovou
`DIRECT_HARNESS_PROCESS_RC=0`, mas `LEGACY_HISTORY_SUBPROCESS_RC=1`. A reprodução com usuário
não-root identificou o primeiro cenário exato: `LEGACY_FAILED_SCENARIO=V1_VALID`,
`LEGACY_FAILED_STAGE=VALIDATION`, esperado `RC_0_CLASS_NONE`, observado
`RC_1_CLASS_BUNDLE_METADATA_INVALID`.

A causa não era mais o `chown`, já removido: o harness criava fixtures pertencentes ao usuário do
runner, mas deixava `APPLIED_TSV_EXPECTED_OWNER` ausente. O validador corretamente aplicava seu
default produtivo `root:root`, rejeitando já o V1 válido no CI não-root. A correção exporta somente
no processo de teste a classe real da fixture. O cenário `OWNER_INCOMPATIBLE` substitui esse valor
em fronteira explícita, espera RC 1/`BUNDLE_METADATA_INVALID`, restaura o valor e é seguido por novo
V1 válido que prova ausência de vazamento.

Todos os cenários agora publicam nome, RC esperado/observado e resultado sanitizados. O processo pai
exige RC zero, exatamente um `LEGACY_HISTORY_HARNESS_FINAL_RESULT=PASS` e nenhuma ocorrência de
`LEGACY_SCENARIO_RESULT=FAIL`. O workflow continua medindo npm e o comando do step sem mascaramento.
O resultado remoto pós-fix ainda depende dos checks da PR #839; apply permanece bloqueado até o
step de preview ficar verde.
