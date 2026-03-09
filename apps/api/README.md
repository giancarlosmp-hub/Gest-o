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
