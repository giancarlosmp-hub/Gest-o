# Adendo — bloqueio circular do run 31707019441 (13/08/2026)

O run real passou por SSH, atualização fast-forward e conferência do SHA, mas falhou no comando `MODE=build EXPECTED_SHA="$EXPECTED_SHA" bash scripts/deploy-production.sh`. A ausência já registrada do canônico é compatível com a guarda inicial anterior. Isso bloqueava a imagem exigida pelo ERP Production Recovery que, por sua vez, é a autoridade exclusiva para criar o canônico e mudar uma única ocorrência do gate para `true`. A correção mantém essa autoridade: build apenas pode ler o legado root:root/600 se o canônico estiver totalmente ausente, mantendo o scheduler `false`; canônico válido vence, canônico inválido bloqueia e cutover não aceita legado. Logs contêm somente o marcador da fonte, nunca conteúdo ou Compose renderizado. Nenhuma produção/restauração foi executada nesta PR; repetir o build após merge e manter Recovery e `INC_ERP_5050` pendentes.

# Correção semântica da observabilidade — 13/08/2026

A revisão da PR #799 remove dupla contagem: pais são somente `manual/syncAll` e
`scheduler/automatic`; demais scopes são etapas correlacionadas. Manual não satisfaz evidência
automática. O gate agora executa 20 fixtures comportamentais reais; seu PASS comprova o contrato
local, não scheduler/lock/execução em produção. Produção e recovery não foram acessados.

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
# Adendo — falha silenciosa anterior ao resolver no run 31713219051 (13/08/2026)

O SSH e o fast-forward `3c068fa..443be81` passaram e os 12 arquivos da PR #800 chegaram à VPS. O
status 1 ocorreu antes de `DEPLOY_CHECKOUT_SHA`, fonte do env, erro do resolver ou início do deploy.
A ordem do shell torna o antigo `test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"` o comando que
interrompeu o run; como ele não imprimia operandos, a condição subjacente não pode ser reconstruída
do log. A correção substitui esse ponto por checkpoints explícitos, validação de SHA completo,
worktree/script e diagnóstico sanitizado, além de marcar entrada e resolução no deploy. O resolver
da PR #800 e sua política permanecem semanticamente inalterados. Build, cutover, recriação e ERP
Production Recovery não ocorreram; `ERP_AUTOMATIC_SYNC` e persistência continuam `NOT_PROVEN`,
`INC_ERP_5050 = INVESTIGATING` e `READY_FOR_1_0B_2_O = NO`.
# Evidência adicional — bloqueio do build no run 31720219813

O job `94515047904`, SHA `a3f900b05cbbcc2ab9ee8bba306c4a2cea524d97`, confirmou os gates
Git/checkout/worktree/entrypoint, `MODE=build`, fonte `legacy_build_only` e scheduler desativado, mas
falhou em `TENANCY_MODE does not match the production policy`. Não construiu imagens, não recriou
containers, não executou cutover/Recovery e não modificou o env ou a produção; portanto não prova
sincronização automática nem persistência do env.

A correção limita-se a um overlay `mktemp` mode 600 durante build legado, com sete gates seguros,
cleanup e prova SHA-256 de imutabilidade da fonte. Canônico permanece autoritativo, cutover
canonical-only e Recovery inalterado. Após merge e checks verdes ainda será necessário repetir
somente o `phase=build`. `INC_ERP_5050=INVESTIGATING`, `ERP_AUTOMATIC_SYNC=NOT_PROVEN`,
`ERP_SYNC_ENV_PERSISTENCE=NOT_PROVEN` e `READY_FOR_1_0B_2_O=NO`.
