# Preparação do control plane default-only

> **Estado reconciliado:** a PR #773 foi encerrada sem merge e a PR #774 está **🟡 Merge** no SHA
> `57cb0b6`. O procedimento canônico está no [Brief OP-EXEC](../sprints/SPRINT_1_0B_1_OP_EXEC_CONTROL_PLANE_CERTIFICATION.md).
> Esta entrega permanece **🔵 PR**; nenhuma execução real é autorizada. O apply DML continua
> bloqueado até existir credencial temporária aprovada e evidência da janela.

## Contrato

A migration `20260802120000_tenancy_control_plane` cria somente enums, `Tenant`,
`TenantMembership`, índices, checks e FKs. Ela não contém backfill. A identidade versionada é
`tenant-default-v1` / `default-v1`, com nomes institucionais sem PII; não deriva do host, ERP, banco
ou request.

O runner `prepareDefaultTenant.ts` cria ou valida exatamente esse tenant e cria uma membership
determinística por `User`. Diretor, gerente e vendedor preservam sua role. Usuários inativos também
recebem membership `active`: `User.isActive` continua sendo o bloqueio global de autenticação e não
é reinterpretado como lifecycle empresarial. `acceptedAt` é definido, `invitedAt`/`revokedAt` são
nulos e `version=1`.

## Dry-run, apply e evidências

Dry-run é o padrão e apenas lê/gera o plano. Apply requer `TENANCY_MODE=default-only`,
`CONFIRM=PREPARE_DEFAULT_TENANT`, `EXPECTED_SHA` igual ao HEAD e checkout limpo. O diretório de
evidência é definido por `EVIDENCE_DIR`; contém `metadata.tsv`, `users-before.tsv`,
`tenants-before.tsv`, `dry-run-plan.tsv` e, após apply, `apply-result.tsv`, `tenants-after.tsv`,
`memberships-after.tsv`, `reconciliation.tsv` e `result.tsv`. Não contém nome, e-mail, credencial,
token nem IDs individuais; somente contagens e hash agregado.

Este documento deliberadamente não fornece comando definitivo de produção. Banco/host, imagem,
SHA, backup, preview e autoridade de schema devem ser aprovados pelo fluxo oficial antes de qualquer
execução. O runner não pertence ao bootstrap, seed, Compose ou deploy.

## Falhas esperadas e reconciliação

Role desconhecida, identidade default incompatível, segundo tenant, membership divergente,
duplicidade, órfão, lifecycle incoerente ou versão não positiva falham fechados. Nenhuma divergência
é apagada ou aproximada. A reconciliação compara contagens, cobertura e hash após a transação; só
então emite PASS.

## Rollback e limites

Rollback de código mantém `TENANCY_MODE=disabled`. Objetos aditivos e dados permanecem, sem DROP ou
revogação automática; divergência exige plano aprovado. CRM, ERP, Communications, JWT, handlers,
caches e jobs continuam single-tenant. A Sprint 1.0B.2 poderá iniciar apenas após apply/preparação
operacionais comprovados e tratar tenantização dos models e data access.
