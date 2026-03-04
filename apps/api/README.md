# API

## Fixture seed (90 dias)

Use o fixture seed para popular a base com dados fictícios de clientes, oportunidades, atividades, agenda e roteiros.

### Rodar fixture

```bash
npm run seed:fixture -w @salesforce-pro/api
```

Esse comando define `SEED_FIXTURE=1` e executa o seed do Prisma. O seed padrão continua disponível via `npm run prisma:seed -w @salesforce-pro/api`.

Também é possível ativar o fixture com:

```bash
NODE_ENV=testfixture prisma db seed
```

### Limpar fixtures

O seed fixture é idempotente: antes de inserir novos dados, ele remove registros anteriores criados com prefixo `[fixture-90d]` (clientes, contatos, oportunidades, atividades, eventos e paradas).

Para limpar e recriar os fixtures, rode novamente:

```bash
npm run seed:fixture -w @salesforce-pro/api
```
