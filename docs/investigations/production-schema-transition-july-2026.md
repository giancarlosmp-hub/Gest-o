# Transição segura do schema de produção — julho de 2026

**Estado:** bloqueador de cutover; implementação somente no repositório. Nenhum acesso à VPS, deploy,
Prisma contra produção ou sincronização UltraFV3 foi realizado nesta auditoria.

## Diagnóstico da reutilização de evidência (01/08/2026)

O diagnóstico read-only posterior na VPS confirmou a integridade de `applied.tsv`, do checksum da
migration autorizada e do `post-apply-diff.sql` vazio. A migration atual e a árvore
`apps/api/prisma` permanecem equivalentes às do commit evidenciado. A reutilização falhou apenas
porque a allowlist operacional estava incompleta diante dos arquivos de deploy, rollback e
documentação alterados entre os commits. A correção mantém uma lista fechada de oito arquivos e
continua rejeitando código, Prisma, migrations e configuração de runtime; caminhos bloqueadores
passam a ser exibidos antes da falha. Produção e containers antigos foram preservados, nenhum
cutover ou deploy ocorreu, e o cutover e o incidente continuam pendentes no estágio 🔵 PR.

## Evidência e causa raiz

O preview read-only informado para o banco recuperado compara o catálogo real com
`schema.prisma`. O catálogo contém oito tabelas `incident_*` que não estão no datamodel; `prisma db
push` interpreta qualquer tabela pública ausente do modelo como drift a reconciliar e, por isso,
gerou `DROP TABLE`. O bootstrap chamava `npm run prisma:migrate`, que na realidade era o alias de
`prisma db push`. Além disso, os objetos novos já constavam no Prisma e nas migrations de 21, 23 e
31/07, mas não no snapshot recuperado (e a FK de Agenda estava divergente). O problema não é uma
solicitação funcional para excluir auditoria: é a combinação de objetos manuais fora da propriedade
do Prisma, banco recuperado anterior às mudanças e bootstrap reconciliador.

O checkout é isolado: não há remote `origin`. O `HEAD` local `a2daeb5` contém os merges #753,
#754 e #755, mas atualização remota e publicação de PR não podem ser comprovadas aqui.

## Inventário auditado

| Objeto | Prisma / migration anterior | Função | Natureza e risco | Dependência / validação |
|---|---|---|---|---|
| 7 enums `Communication*` | sim / `202607210001` | contrato omnichannel | criação aditiva; falha se nome incompatível já existir | conferir `pg_type` e valores |
| `Contact.phoneNormalized` (varchar 32), `phoneHash` (varchar 64) | sim / `202607230001` | busca/identidade telefônica sem expor valor | nullable e aditiva; sem backfill neste cutover | conferir `information_schema.columns`; null é permitido |
| `ClientCodeAudit` | sim / `20260731120000` | trilha de alterações de `Client.code` | tabela aditiva; não altera clientes | tabela, 3 índices e FK para `Client` |
| `CommunicationIntegrationAccount` | sim / `202607230001` | identidade/configuração da conta do provider | aditiva; unique pode falhar com duplicatas | diagnóstico por tenant/provider/channel/external id |
| `CommunicationConversation` | sim / `202607210001` + `230001` | conversas inbound | aditiva | unique provider/account/conversation; FKs Client, User e account |
| `CommunicationMessage` | sim / mesmas | mensagens/deduplicação | aditiva | unique provider/account/message; FKs conversation/account |
| `CommunicationWebhookEvent` | sim / mesmas | inbox idempotente de webhooks | aditiva | unique provider/account/event; FK account |
| índices não únicos Communication/Contact/Audit | sim / mesmas | consulta operacional | aditivos, podem consumir I/O/lock curto | conferir `pg_indexes`; aplicar em janela |
| quatro índices únicos Communication | sim / mesmas | idempotência | risco de falha, não perda | cada `CREATE UNIQUE` é precedido por `GROUP BY ... HAVING count(*) > 1` que falha fechado |
| oito FKs novas e `AgendaEvent_clientId_fkey` | sim; Agenda em `20260302170000` | integridade referencial | validada e aditiva; órfãos abortam a transação | conferir definição e estado validado em `pg_constraint` |

Todos os objetos estão no datamodel e têm migration versionada, mas o preview fornecido comprova que
faltavam no banco recuperado. Eles são necessários às comunicações, à auditoria de código e à
integridade da agenda. A migration controlada não recria objeto existente e pode ser repetida. Os
índices ainda podem bloquear brevemente escrita durante sua construção; a primeira janela deve
monitorar locks e ter timeout operacional. `CREATE INDEX CONCURRENTLY` não foi usado porque a
execução é transacional e as tabelas Communication/Audit são ausentes ou novas.

Não há backfill de telefone. Futuro backfill deve ser uma operação própria: normalização E.164
(dígitos e código de país definidos pelo produto), hash HMAC-SHA-256 com segredo versionado (não
SHA simples), lotes observáveis e validação antes de qualquer `NOT NULL`/unique. Valores desconhecidos
continuam `NULL`; este cutover não lê nem modifica `Contact.phone`.

## Tabelas do incidente

Preservar integralmente:

- `incident_20260718_client_enrichment_audit`, `incident_20260718_client_map`,
  `incident_20260718_june_client_source`, `incident_20260718_recovery_audit`;
- `incident_20260719_erp_code_enrichment_audit`, `incident_20260719_erp_partner_client_map`,
  `incident_20260719_orphan_productprice_audit`, `incident_20260719_product_snapshot_map`.

Nenhuma consta de `schema.prisma` ou migration Prisma. A busca no repositório encontra criação/leitura
persistente de `incident_20260719_orphan_productprice_audit` no script e runbook de recuperação, e
checks estáticos que citam os mapas de cliente/parceiro. As demais só são evidenciadas pelo preview e
pelo registro operacional fornecido; sem acessar produção não é possível afirmar contagem, FKs ou
referências externas. O apply registra nome e contagem de todas as `incident_*` antes de encerrar,
sem escrever nelas. Elas podem permanecer no schema `public` fora do Prisma porque produção não
executa mais `db push`. Exportação, retenção permanente ou mudança para schema `archive` exigem
inventário de dependências, dump+SHA e decisão futura; **não fazem parte desta migration**.

## Decisão (A–D)

| Opção | Segurança/rastreabilidade | Idempotência/drift | Decisão |
|---|---|---|---|
| A — manter `db push` | baixa; diff amplo e não registrado pode apagar incidentes | reconcilia drift de forma destrutiva | rejeitada |
| B — `migrate deploy` | alta no estado normal | o banco recuperado pode não ter histórico `_prisma_migrations`; migrations históricas contêm DDL destrutiva | alvo futuro, bloqueada até baseline auditado |
| C — SQL operacional versionado | alta para esta transição; allowlist exata e evidência | migration com gates, repetível; dívida de baseline permanece | **escolhida para o primeiro cutover** |
| D — mover incidentes a schema arquivo | potencialmente boa, porém altera nomes/dependências | requer exportação, retenção e auditoria próprias | adiada |

A migration `20260731150000_safe_production_schema_transition` contém exclusivamente DDL aditiva e
idempotente. `production-schema-apply.sh` a aplica diretamente com `psql --single-transaction`; isso
é deliberadamente **não** `migrate deploy`, pois executar toda a cadeia sem baseline poderia repetir
migrations antigas (inclusive migrations históricas com DROP). A adoção permanente de Prisma
Migrate depende de inventariar `_prisma_migrations`, criar baseline verificável e ensaiar snapshot.

## Regra anterior e nova

Antes, o bootstrap de produção fazia `db push`, seed conforme flags e depois abria API/scheduler.
Agora, produção nunca altera schema no bootstrap; falha de conexão/saúde ainda impede a abertura, e
o scheduler só é solicitado após bootstrap e `listen`. Desenvolvimento mantém `db push`. O deploy
exige evidência `schema/<SHA>/applied.tsv` antes do cutover e rollback de container nunca executa SQL.
Não existe fallback automático.

Fluxo: `preflight → build → preview/validação → aprovação humana → schema apply → pós-validação →
cutover`. Preview bloqueia `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, drop com `CASCADE`, remoção de
enum e alterações de tipo, imprime SQL e resume aditivas/destrutivas/bloqueadas/não gerenciadas.

## Validação, rollback e riscos residuais

Pós-apply: o diff Prisma pinado confirma integralmente colunas, tipos, nullability, defaults, sete enums/valores, PKs, índices, uniques e FKs. O SQL bruto é preservado; somente os oito `DROP TABLE incident_*` conhecidos são separados, e `post-apply-diff.sql` deve ficar vazio antes de `applied.tsv`. Nomes e contagens de `incident_*` também devem permanecer byte a byte iguais. Repetir o apply em snapshot descartável antes da janela. Rollback da aplicação é troca de imagem e não reverte schema. Como tudo é nullable/novo,
o schema pode permanecer; qualquer rollback de schema ou restore requer decisão separada e ensaio.
Riscos: histórico Prisma ainda sem baseline, locks de índices, enum preexistente incompatível, dados
órfãos antes de validar FKs e impossibilidade local de provar conteúdo/dependências do banco real.
O cutover e o incidente 5050×4484 permanecem bloqueados/em homologação.

## Comandos futuros (somente após revisão, na VPS)

```bash
cd /apps/gest-o
git fetch origin --prune
git switch main
git pull --ff-only origin main
EXPECTED_SHA=$(git rev-parse HEAD) MODE=build bash scripts/deploy-production.sh
set -a; source /root/demetra-env/production.env; set +a
APP_COMMIT="$EXPECTED_SHA" MODE=validate bash scripts/production-schema-preview.sh
CONFIRM=PRODUCTION_SCHEMA_APPLY EXPECTED_SHA="$EXPECTED_SHA" bash scripts/production-schema-apply.sh
# revisar /var/log/gest-o/schema/$EXPECTED_SHA; não executar cutover nesta etapa
# em janela posterior e aprovação separada:
CONFIRM=PRODUCTION_CUTOVER EXPECTED_SHA="$EXPECTED_SHA" MODE=cutover bash scripts/deploy-production.sh
```

## Revisão de equivalência da PR #756

A primeira versão divergia do datamodel: usava oito nomes manuais longos para índices/uniques em vez
dos nomes truncados gerados pelo Prisma; e atribuía `DEFAULT CURRENT_TIMESTAMP` a `updatedAt` nas
quatro tabelas Communication, embora `@updatedAt` gere `TIMESTAMP(3) NOT NULL` sem default de banco.
As FKs também eram criadas `NOT VALID`, estado substituído por constraints validadas. A migration
agora reproduz os nomes e definições obtidos por `prisma migrate diff --from-empty`.

Antes da transação, o apply gera um diff do catálogo real com o datamodel usando a imagem pinada.
Somente os oito `DROP TABLE incident_*` exatos são retirados da visão gerenciada. O restante aceita
apenas a allowlist desta transição; tabela parcialmente existente com coluna, tipo, nullability,
default, enum ou constraint divergente produz DDL fora da allowlist e aborta antes do `psql`.

Depois da transação, o mesmo comando/imagem gera `post-apply-diff.raw.sql`; o filtro preserva o raw,
remove exclusivamente os oito drops históricos e grava `post-apply-diff.sql`. Qualquer DDL gerenciada
restante falha, de modo que essa pós-condição Prisma valida o contrato completo. `applied.tsv` é a
última escrita. O teste `production-schema-postgres.sh` cria um PostgreSQL 16 descartável, deriva o
schema base do próprio Prisma, simula o snapshot recuperado com oito tabelas e dados, aplica duas
vezes, compara contagens e testa rejeição de tabela parcial. No ambiente sem Docker, ele retorna 77 e
não constitui validação end-to-end; deve rodar no CI antes da janela.

## Autoridade de schema independente de `NODE_ENV` — correção dos checks da PR #756

Os checks Docker Compose CI e Preview Deploy usam `NODE_ENV=production`, embora criem PostgreSQL
novo e descartável. Condicionar a autorização de schema a `NODE_ENV` fez o bootstrap pular o `db
push`; por isso `User`, `Opportunity`, `AppConfig`, `KnowledgeDocument` e demais tabelas não existiam,
e login, seed e scheduler falharam. `NODE_ENV` descreve o comportamento da aplicação, não a
autoridade sobre o banco.

`DATABASE_SCHEMA_MODE` agora é obrigatório e aceita somente:

- `external`: produção real. O bootstrap não altera schema, não garante a sequence e não executa
  admin bootstrap, smoke seed, seed comum ou preview seed. A única autoridade é
  `production-schema-apply.sh`, com pós-diff vazio e `applied.tsv` antes do cutover;
- `ephemeral-push`: Docker Compose CI, Preview Deploy e Compose genérico com volume descartável.
  Autoriza explicitamente `prisma db push`, setup da sequence e os bootstraps/seeds habilitados pelas
  flags existentes.

Ausência ou valor desconhecido aborta o bootstrap; não há fallback por `NODE_ENV`, `CI`, flags de
seed ou interpolação no Compose de produção. A política é literal nos três arquivos Compose e também
visível nos workflows. O incidente permanece em homologação e a entrega em 🔵 PR até Docker Compose
CI, Preview Deploy e os demais checks reais ficarem verdes.

## Falha operacional posterior à PR #757: Prisma ausente no host

O build da PR #757 concluiu com sucesso e a imagem `gest-o-api:<APP_COMMIT>` contém o Prisma 5.22.0
pinado. Já o ensaio PostgreSQL descartável encerrou antes da primeira migration: seu script ainda
invocava `./node_modules/.bin/prisma` no checkout da VPS, onde dependências Node não são instaladas
por decisão da topologia de deploy. Portanto, a falha não indica drift ou erro na migration. Nenhum
schema foi aplicado, o banco de produção não foi acessado ou alterado, não houve cutover e os
containers anteriores continuaram atendendo.

O ensaio passa a exigir `APP_COMMIT` ou `EXPECTED_SHA`, validar a existência local da imagem (sem
pull) e exigir que `org.opencontainers.image.revision` seja exatamente o SHA testado. Cada comando
`prisma migrate diff` roda em container efêmero dessa imagem. O PostgreSQL 16 também é
efêmero e se comunica apenas por uma rede Docker recém-criada, sem porta no host; sua URL aponta
exclusivamente para o container e database `gesto_test`. Entradas herdadas que indiquem o hostname
de produção, `salesforce_pro`, loopback ou `gest-o_default` são rejeitadas, e o trap remove banco,
rede e arquivos temporários. O cutover segue bloqueado e esta correção permanece no estágio 🔵 PR.

## Incompatibilidade Prisma `DATABASE_URL` × libpq/`psql`

Em 01/08/2026, o apply controlado chegou a ser iniciado na VPS. O preflight confirmou a identidade
esperada do banco e do runtime, a existência e o SHA256 do backup e os demais gates operacionais. O
preview, a allowlist e a validação da migration aditiva também passaram. A execução parou então com
o erro exato:

```text
psql: error: invalid URI query parameter: "schema"
```

A falha ocorreu na primeira chamada de inventário `incident_*` feita pelo `psql`, antes do comando
posterior que abre `--single-transaction` e lê `/migration.sql`. O erro é de parsing da URI pelo
cliente, antes de uma conexão ou de qualquer instrução SQL: portanto, o arquivo da migration não
foi entregue ao servidor. Não houve migration aplicada, tabela criada ou alterada, mudança nas
`incident_*` nem cutover.

A causa raiz foi o uso direto da `DATABASE_URL` do Prisma como URI de conexão do libpq/`psql`.
Embora usuário, senha, host, porta e database sejam compatíveis, `schema` configura o connector do
Prisma e não é um parâmetro de conexão reconhecido pelo libpq. A correção cria uma URI exclusiva
para `psql` e remove os parâmetros próprios do Prisma `schema`, `connection_limit`, `pool_timeout`,
`pgbouncer`, `statement_cache_size` e `socket_timeout`. Protocolo, usuário, senha, host, porta,
database e parâmetros PostgreSQL/libpq, como `sslmode`, são preservados.

Foram auditados todos os scripts shell que invocam `psql`. `production-schema-apply.sh` passa a usar
a URI sanitizada nas contagens anteriores e posteriores, na transação da migration e na validação
das tabelas obrigatórias. O modo `libpq` de `production/run-erp-5050-forensic.sh`, único outro fluxo
que podia anexar `DATABASE_URL` ao comando, usa o mesmo conversor. `production-schema-preview.sh`
usa a URL somente com Prisma; `production-preflight.sh` decompõe host, porta e database para
`pg_isready`; e `smoke/production-schema-postgres.sh` e os demais chamadores de `psql` usam flags de
conexão separadas, portanto não encaminham a URI Prisma.

O smoke automatizado agora exercita uma URL com `?schema=public`, confirma a remoção dos parâmetros
Prisma e a preservação de credenciais, destino e `sslmode`. Ele também percorre os scripts
operacionais e falha se `$DATABASE_URL` voltar a ser enviada diretamente ao `psql`; o harness do
coletor forense continua validando seu fluxo isolado. A mudança é exclusivamente de compatibilidade
da conexão: não altera a migration, sua transação, a allowlist, os gates do deploy ou o cutover.

Operacionalmente, o apply permanece pendente e deve ser reiniciado integralmente, não retomado do
ponto da falha. Depois do merge e de todos os checks verdes, deve-se atualizar a `main` na VPS e
repetir `production-schema-apply.sh` desde o início. Até essa execução controlada terminar e suas
evidências serem revisadas, o banco permanece inalterado e o cutover continua bloqueado.

## Falha segura de autoridade DDL em 01/08/2026

A nova tentativa partiu da `main` no SHA `6041ddac24a6be0bb85a63498656b4d183ccd5d7` e validou
backup/SHA256, preflight, imagens pinadas, allowlist, migration e o inventário inicial das oito
`incident_*`. Dentro de `--single-transaction`, o primeiro `CREATE TYPE` recebeu `permission denied
for schema public`. Como foi o primeiro DDL e a unidade transacional abortou, nada persistiu:
nenhuma migration foi concluída e nenhum cutover ocorreu.

A causa raiz é a mistura anterior entre conexão runtime e autoridade de migration. A role da
`DATABASE_URL` deliberadamente não possui `CREATE`; ampliar seus privilégios, transferir ownership
ou conceder acesso permanente contrariaria o isolamento esperado. A decisão passa a ser permanente:

- a URL sanitizada da aplicação continua sendo usada por Prisma diff, inventário read-only e health;
- imediatamente antes do DDL, todos os gates mutáveis são repetidos e o processo confirma que o
  container exato está running, com volume/destino/database esperados, e que a sessão local retorna
  `salesforce_pro`/`postgres`;
- somente a migration transacional enviada por stdin e consultas de catálogo indispensáveis usam
  `docker exec --user postgres`; não se lê senha, não se publica porta e não se modifica o banco ou
  seu container;
- `applied.tsv` continua sendo criado apenas após incidentes idênticos, cinco tabelas, sete enums,
  duas colunas de telefone e diff Prisma gerenciado vazio.

O teste descartável agora cria uma role runtime sem `CREATE`, demonstra sua recusa, demonstra o apply
administrativo, rollback integral em falha intermediária, idempotência, equivalência Prisma e
preservação byte a byte do inventário `incident_*`. Esta mudança permanece 🔵 PR; não comprova
produção atualizada, schema aplicado nem encerramento do incidente.

## Imagem histórica ausente no primeiro cutover (01/08/2026)

O schema foi aplicado e validado. No SHA operacional
`c178a69efc79cf78862b697229c7192b607fbcc6`, o deploy também revalidou com sucesso a evidência de
schema de `0f1391fee481254dc1896a18ec261ef168e5bbe3`. Em seguida, a preparação do rollback falhou em
`docker image inspect`/tag porque o image ID `sha256:0ce92e...` do
`gest-o-api-recovery-20260718` não estava mais no catálogo, embora o container permanecesse running.

A falha ocorreu antes de `docker stop`; API/WEB antigas, PostgreSQL, volume e schema permaneceram
intactos. O cutover continua pendente e o incidente aberto. A correção em 🔵 PR registra, por role,
rollback por imagem ou pelo ID imutável de um container histórico externo ao projeto
`gest-o-production`. Evidências completas e protegidas, validações de porta/rede/restart/DB e o
rollback instalado são obrigatórios antes da primeira parada; containers do próprio projeto sem
imagem falham fechado para impedir restauração ambígua após reutilização de nome.
