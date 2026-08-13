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

## Cronologia do canal de recuperação

- **PR #797:** prevenção versionada e contrato fail-closed do env; não é prova da VPS.
- **ERP Production Recovery:** novo canal manual, aprovado e auditável para copiar a fonte legado
  autorizada quando necessário, habilitar o gate, recriar somente a API e coletar a prova automática.
- **Execução produtiva:** ainda pendente. O workflow só pode ser disparado depois do merge desta PR e
  da preparação da imagem do mesmo SHA; o incidente permanece `INVESTIGATING` até uma execução real
  e bem-sucedida com `trigger=scheduler` e persistência do ambiente comprovada.
- **Revisão pré-merge da PR #798:** remove a dependência incorreta de `API_IMAGE`, `WEB_IMAGE` e
  `APP_*` transitórios no env e separa as credenciais de validação no canal protegido do GitHub. O
  workflow permanece não executado e produção não foi acessada por essa correção.

```text
ERP_AUTOMATIC_SYNC = NOT_PROVEN
ERP_SYNC_ENV_PERSISTENCE = NOT_PROVEN
ERP_SCHEDULER_INITIALIZED = NOT_PROVEN
ERP_NEXT_RUN_AT = NOT_PROVEN
INC_ERP_5050 = INVESTIGATING
PRODUCTION_ACCESSED = NO
READY_TO_MERGE_RECOVERY_PR = NO
```

## Reconciliação de observabilidade — 12/08/2026

A evidência fornecida de sync completa é classificada exclusivamente como `manual`. A investigação
local comprovou mascaramento de erro/ausência no frontend e lacunas de contrato da Saúde; a correção
v2 e a matriz de fontes estão em `docs/platform-health-erp-observability.md`. Isso não executou nem
comprovou scheduler/recovery/produção. `INC_ERP_5050` permanece `INVESTIGATING`.
