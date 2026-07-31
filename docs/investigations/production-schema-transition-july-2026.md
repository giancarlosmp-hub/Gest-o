# Transição segura do schema de produção — julho de 2026

**Estado:** bloqueador de cutover; implementação somente no repositório. Nenhum acesso à VPS, deploy,
Prisma contra produção ou sincronização UltraFV3 foi realizado nesta auditoria.

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
| oito FKs novas e `AgendaEvent_clientId_fkey` | sim; Agenda em `20260302170000` | integridade referencial | `NOT VALID`, aditiva, não examina/regrava linhas no apply | conferir `pg_constraint`; validar dados e depois `VALIDATE CONSTRAINT` em janela separada |

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

Pós-apply: conferir cinco tabelas, colunas nullable, enums/índices/FKs, `applied.tsv`, hash da
migration, logs e contagens imutáveis de `incident_*`; repetir o apply em snapshot descartável antes
da janela. Rollback da aplicação é troca de imagem e não reverte schema. Como tudo é nullable/novo,
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
