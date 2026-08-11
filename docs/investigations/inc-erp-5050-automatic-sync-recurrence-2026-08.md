# INC-ERP-5050 — recorrência da sincronização automática (11/08/2026)

## Limite da investigação

Este checkout gerenciado está na branch local `work`, sem remote configurado e sem canal SSH/VPS disponível. A produção **não foi acessada** por esta investigação. Portanto, SHA do runtime, containers, AppConfig, locks, logs, próxima janela e execução com `trigger=scheduler` permanecem não comprovados. As observações produtivas abaixo são exclusivamente as evidências sanitizadas fornecidas pelo operador em 10/08/2026; não são inferidas do Git.

## Classificação antes de alteração

| Item | Esperado | Observado em 10/08 (evidência fornecida) | Resultado | Evidência sanitizada |
|---|---|---|---|---|
| Gate do scheduler | `true` no container | desabilitado pelo ambiente | FAIL — A | painel: `scheduler_disabled` |
| Env externo | `/root/demetra-env/.env` presente | ausente | FAIL — B | presença técnica: AUSENTE |
| Credencial global | par completo ou modo alternativo válido | usuário/senha ausentes; vendedor de referência configurado | PENDENTE — C/D | valores não inspecionados |
| Configuração persistida | habilitada | botão oferece desativar | APARENTA PASS — exige leitura DB | UI, sem payload |
| Bootstrap | chama scheduler | backend inicializado | PASS no código; runtime não comprovado | `server.ts` chama o start |
| Próxima execução | preenchida | vazia | FAIL, consequência do gate | painel |
| Última automática | execução horária recente | 18/07/2026 18:00 | FAIL | painel |
| Instâncias/lock/conectividade | uma instância, lock íntegro, ERP acessível | não auditado | NOT PROVEN — G/H/I | acesso VPS indisponível |

**Causa comprovada pelas evidências fornecidas:** combinação **A + B**. O contrato de deploy também possuía uma divergência reprodutível: o deploy/cutover procurava `/root/demetra-env/production.env`, enquanto runtime, backup, restauração e runbook oficial usavam `/root/demetra-env/.env`. Essa inconsistência permitia que um arquivo correto e persistente não fosse carregado pelo mecanismo oficial.

## Correção versionada e prevenção

- caminho canônico único: `/root/demetra-env/.env`, fora de `/apps/gest-o`;
- preflight fail-closed antes do build, com owner/mode, variáveis, gates e render do Compose;
- scheduler sem default implícito no Compose de produção: deve ser declarado literalmente `true`;
- teste cobre arquivo ausente, scheduler falso, secret vazio, passagem válida e ausência de secrets na saída;
- backup/restauração permanecem protegidos, fora do Git e com mode `600`.

Nenhuma migration, schema Prisma, tenancy, ledger, backfill ou dado empresarial foi alterado.

## Procedimento operacional ainda pendente

Um operador com acesso autorizado e fonte segura deve restaurar o env (sem recriar credenciais), executar o preflight, validar o Compose sem exibir sua saída, recriar **somente** `api`, e então coletar a matriz read-only requerida. Se a fonte segura não existir, a operação deve parar antes de modificar o host. Não usar `down -v`, não remover volumes, não aplicar schema e não classificar uma execução manual como automática.

## Estado

```text
ERP_AUTOMATIC_SYNC = NOT_PROVEN
ERP_SYNC_ENV_PERSISTENCE = NOT_PROVEN
INC_ERP_5050 = INVESTIGATING
PRODUCTION_ACCESSED = NO
TENANCY_MODE_PRODUCTION = disabled (evidência fornecida; não reverificada)
TENANT_READ_PILOT_ENABLED_PRODUCTION = false (evidência fornecida; não reverificada)
READY_FOR_MULTI_TENANT_CUTOVER = NO
```

## Tentativa operacional de 11/08/2026

A execução solicitada após o merge da PR #797 foi interrompida no gate de acesso, antes de qualquer
alteração produtiva. O commit local `50970a5523512191625a90fc032ba502e8fd756b` contém o merge explícito
da PR #797, mas o checkout não possui remote, `/apps/gest-o` não existe neste ambiente, não há arquivos
em `/root/.ssh`, o GitHub CLI não está autenticado e a consulta read-only ao repositório público foi
bloqueada pelo proxy com HTTP 403. Não havia, portanto, um canal autorizado por meio do qual atualizar
a `main` produtiva, inventariar a VPS ou acessar a fonte protegida do ambiente.

Nenhum arquivo de ambiente foi procurado fora dos caminhos seguros documentados, nenhum segredo foi
impresso e nenhuma operação Docker, banco de dados, migration, backfill, seed, bootstrap ou cutover foi
executada. Em particular, a ausência local de `/root/demetra-env/.env` **não** é evidência sobre a VPS.

| Item | Esperado | Observado nesta tentativa | Resultado | Evidência sanitizada |
|---|---|---|---|---|
| PR #797 | merge em `main` | merge presente no histórico local | PASS local | SHA `50970a5523512191625a90fc032ba502e8fd756b` |
| SHA da API | `main` aprovada | VPS inacessível | NOT PROVEN | sem canal SSH |
| Env externo | arquivo regular | host produtivo inacessível | NOT PROVEN | caminho local não confundido com VPS |
| Owner/mode | `root:root`, `600` | host produtivo inacessível | NOT PROVEN | não coletado |
| Scheduler | `true` | runtime inacessível | NOT PROVEN | não coletado |
| Tenancy | `disabled` | runtime inacessível | NOT PROVEN | não coletado |
| Piloto tenant | `false` | runtime inacessível | NOT PROVEN | não coletado |
| Schema mode | `external` | runtime inacessível | NOT PROVEN | não coletado |
| Credenciais globais | par completo ou ambas ausentes | env protegido inacessível | PENDENTE | valores não inspecionados |
| Vendedor de referência | credencial válida | banco/ERP inacessíveis | NOT PROVEN | não coletado |
| AppConfig | scheduler habilitado | banco inacessível | NOT PROVEN | não coletado |
| Instâncias API | uma ou lock comprovado | Docker produtivo inacessível | NOT PROVEN | não coletado |
| Lock ERP | sem lock órfão | banco inacessível | NOT PROVEN | não coletado |
| Conectividade ERP | endpoint alcançável | VPS inacessível | NOT PROVEN | teste não executado |
| Próxima execução | calculada | runtime/banco inacessíveis | NOT PROVEN | não coletado |
| Última automática | recente e posterior ao cutover | runtime/banco inacessíveis | NOT PROVEN | não coletado |

O bloqueio ocorreu antes da Fase 1 produtiva. Por isso, não houve restauração, recriação de API nem
rollback; os checkpoints produtivos não podem ser promovidos a `PASS`. A causa técnica versionada
continua classificada como **A + B**, mas a restauração e a prova operacional continuam pendentes.

```text
ERP_PRODUCTION_ENV_PREFLIGHT=NOT_PROVEN
ERP_API_RECREATE=NOT_PROVEN
ERP_API_HEALTH=NOT_PROVEN
ERP_SCHEDULER_INITIALIZED=NOT_PROVEN
ERP_NEXT_RUN_AT=NOT_PROVEN
ERP_AUTOMATIC_TRIGGER=NOT_PROVEN
ERP_AUTOMATIC_SYNC=NOT_PROVEN
ERP_SYNC_LOCK=NOT_PROVEN
ERP_SYNC_ENV_PERSISTENCE=NOT_PROVEN

ERP_AUTOMATIC_SYNC = NOT_PROVEN
ERP_SYNC_ENV_PERSISTENCE = NOT_PROVEN
ERP_SCHEDULER_INITIALIZED = NOT_PROVEN
ERP_NEXT_RUN_AT = NOT_PROVEN
INC_ERP_5050 = INVESTIGATING
PRODUCTION_ACCESSED = NO
TENANCY_MODE_PRODUCTION = NOT_PROVEN
TENANT_READ_PILOT_ENABLED_PRODUCTION = NOT_PROVEN
READY_FOR_MULTI_TENANT_CUTOVER = NO
```
