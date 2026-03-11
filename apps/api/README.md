## Test Fixture Seed

Populates 90 days of fake data for UI validation.

```bash
# Run fixture seed (requires sellers from default seed)
cd apps/api
npm run seed:fixture

# Remove all fixture data
# All fixture records have names/titles starting with "[fixture]"
# Run seed:fixture again to reset
```

## Bootstrap da API
- `npm run docker:start` espera o Postgres e roda `prisma db push`.
- O seed padrão (`prisma/seed.js`) **não** roda automaticamente, salvo quando `SEED_ON_BOOTSTRAP=true`.
- Para seed manual: `npm run prisma:seed`.
- Com `ENABLE_SMOKE_BOOTSTRAP=true`, o bootstrap garante seed idempotente para compose-smoke: Diretor, Gerente, 4 Vendedores, cliente smoke e meta mensal para o Vendedor 1.
- Com `ADMIN_BOOTSTRAP_ENABLED=true`, a API garante no startup um usuário administrativo idempotente via variáveis `ADMIN_BOOTSTRAP_NAME`, `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`, `ADMIN_BOOTSTRAP_ROLE` e `ADMIN_BOOTSTRAP_REGION`.

