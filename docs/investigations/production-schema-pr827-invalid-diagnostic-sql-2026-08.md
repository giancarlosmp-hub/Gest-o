# PR827 — SQL diagnóstico inválido no preview

Em 28 de agosto de 2026, o run `33206303362` (job `98968114798`) terminou antes de qualquer escrita: `current_schemas(false)[1]` não é acesso de array válido no PostgreSQL 16. A forma corrigida é `(current_schemas(false))[1]`.

A causa sistêmica foi permitir que SQL operacional fosse aprovado apenas por inspeção estática. Os diagnósticos de conexão, catálogo predecessor, catálogo PR827 e ledger agora vivem em arquivos SQL únicos consumidos tanto pelo runner quanto pelo harness `scripts/smoke/pr827-preview-postgres.sh`. O harness cria PostgreSQL 16 descartável, cobre ledger ausente/public/outro schema, estados COMPLETE/PARTIAL/ABSENT dos catálogos, ordens de `search_path`, checksum do ledger e rejeição real de escrita em transação read-only.

O apply permanece desabilitado. Nenhuma migration, baseline ou `_prisma_migrations` foi criada em produção. A correção não autoriza preview produtivo, deploy, backup, Recovery ou cutover; merge e `main` verdes são precondições para um novo preview.

## Correção do teste negativo no check remoto

O run `33207583135` (job `98972472779`) comprovou todos os estados e a rejeição read-only, mas encerrou antes do marcador final. O harness agora captura explicitamente o exit code não zero esperado, aceita somente o SQLSTATE `25006` emitido com `VERBOSITY verbose`, falha preservando o exit code para qualquer erro diferente e exige `PR827_PREVIEW_POSTGRES_RESULT=PASS`. Os `DROP SCHEMA ... CASCADE` pertencem exclusivamente ao banco `salesforce_pro` do container descartável conectado a uma rede Docker interna; nenhum endpoint produtivo é recebido ou acessado.
