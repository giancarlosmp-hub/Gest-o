# Documento Mestre — decisões operacionais e arquiteturais

Este documento é a fonte normativa das decisões que afetam procedimentos de produção. O procedimento
executável da Etapa 1 permanece no [runbook da auditoria ERP 5050](production-erp-5050-runbook.md).

A engenharia reversa consolidada do ciclo de vida de clientes, troca de carteira, arquivamento, histórico de commits/PRs e riscos está em [Investigação ERP 5050 — Fluxo completo ERP → CRM](investigations/investigacao-erp-5050-fluxo-completo.md).

## ADR — Backup administrativo local do PostgreSQL recuperado

**Status:** aceita — substitui o comportamento anterior baseado em variáveis de credenciais do
container.

### Contexto

A recuperação do banco eliminou a disponibilidade das variáveis `POSTGRES_USER` e
`POSTGRES_PASSWORD` no ambiente do container. O usuário administrativo local `postgres` continua
disponível com autenticação peer, enquanto a aplicação usa suas próprias configurações de conexão.

### Decisão

Os backups administrativos utilizados pelos procedimentos de produção passam a executar
exclusivamente `docker exec -u postgres`, com `psql -U postgres` para validar a conexão local antes
do backup e `pg_dump -U postgres` para produzir o dump, utilizando autenticação local peer.

Essas rotinas nunca devem depender de `POSTGRES_USER`, `POSTGRES_PASSWORD` ou `DATABASE_URL`. O nome
do banco deve ser resolvido por `DB_NAME` informado pelo operador, depois por `POSTGRES_DB` do
container e, por fim, pelo fallback `salesforce_pro`.

Esta ADR substitui oficialmente o comportamento anterior da Etapa 1 que tentava obter usuário e
senha do ambiente do container. A implementação e as instruções operacionais estão no
[runbook da Etapa 1](production-erp-5050-runbook.md#bc-evidências-protegidas-e-backup-lógico).

### Justificativa

- elimina dependência de credenciais;
- reduz o risco operacional;
- é compatível com bancos recuperados e autenticação peer;
- não interfere no usuário da aplicação;
- torna o runbook reproduzível.

### Consequências

Toda rotina administrativa futura deverá utilizar este padrão. Novos scripts não deverão utilizar
`POSTGRES_USER` nem `POSTGRES_PASSWORD` para backups administrativos locais. A execução depende da
presença do usuário local `postgres`, do acesso peer e das ferramentas PostgreSQL no container; uma
falha na validação deve abortar antes da criação do dump.
