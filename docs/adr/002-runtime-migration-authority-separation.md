# ADR 002 — Separação de autoridade runtime e migration

- **Status:** Aceita para implementação; execução em produção pendente
- **Data:** 01/08/2026

## Contexto

A aplicação conecta com uma role sem `CREATE` no schema `public`. No apply controlado do SHA
`6041ddac24a6be0bb85a63498656b4d183ccd5d7`, essa role chegou à transação e foi recusada no primeiro
`CREATE TYPE`. A recusa preservou integralmente o banco e confirmou que conceder DDL permanente à
API seria uma violação do menor privilégio.

## Decisão

`DATABASE_URL` (e sua variante libpq sanitizada) representa exclusivamente a autoridade runtime e é
usada em Prisma diff, consultas read-only e health checks. A autoridade de migration existe apenas
no apply controlado: após repetir todos os gates de identidade e integridade, o SQL versionado entra
por stdin em `docker exec --user postgres` no container PostgreSQL exato e roda em uma única
transação. Consultas administrativas ficam limitadas à identidade da sessão e ao catálogo necessário
às pós-condições.

Não serão concedidos `CREATE` ao runtime, alterados owners, copiada ou impressa a senha de `postgres`,
publicadas portas, iniciados bancos alternativos ou operado Docker Compose sobre o banco.

## Consequências

A aplicação comprometida não ganha autoridade DDL. O deploy exige acesso operacional ao container e
gates mais rigorosos; qualquer falha bloqueia o cutover e impede `applied.tsv`. O procedimento mantém
evidências, valida cinco tabelas, sete enums, duas colunas, diff Prisma vazio e oito `incident_*`
idênticas. A decisão não afirma que o schema já foi aplicado em produção.
