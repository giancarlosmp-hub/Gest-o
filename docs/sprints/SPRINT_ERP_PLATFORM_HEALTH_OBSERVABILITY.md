# Sprint Brief — estabilização ERP e Saúde da Plataforma

**Objetivo:** reconciliar telemetria manual/automática, banco, API e UX antes da 1.0B.2-O.

**Escopo:** contrato v2 fail-closed, agregação bounded de `ErpSyncRun`, estado scheduler/lock,
qualidade e auditoria reais, UX loading/empty/error/retry e gate automatizado com 20 cenários.

**Fora do escopo:** produção, recovery, sync, deploy, secrets, migrations, backfill, tenancy, ledger
e qualquer ativação tenant-aware.

**Aceite:** manual não vira automática; erro não vira zero; vazio é explícito; RBAC e correlação são
preservados; documentação e rollback estão consolidados. Checks remotos e prova automática produtiva
permanecem obrigatórios antes de qualquer recomendação de merge.

**Rollback:** revert único do commit e publicação normal de API/WEB, sem ação de banco.

**Estado:** desenvolvimento local; produção não acessada; 1.0B.2-O pausada.
