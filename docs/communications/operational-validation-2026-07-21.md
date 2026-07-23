# Operational validation — secure omnichannel foundation

Date: 2026-07-21
Branch: work
Commit under validation: 8e30f043d0d13907bd3fd7f308597ecfada70f43

## Scope

This document records the operational validation pass for the secure omnichannel communications foundation. It intentionally does not add product functionality or alter runtime behavior.

## Audits performed

- Reviewed webhook middleware ordering: communications webhook routes are mounted before the global JSON parser.
- Reviewed HMAC verification: Meta provider validates `sha256=` header shape and size before `timingSafeEqual`.
- Reviewed webhook error path: raw body is redacted in the global Express error handler for communications webhook routes.
- Reviewed Prisma schema and migration for additive-only objects, explicit FKs, indexes, uniqueness and conditional runtime grants.
- Reviewed SaaS readiness: new communication tables carry optional indexed `tenantId` and `externalAccountId` for future tenant/account isolation.
- Reviewed LGPD controls: Timeline text is summary-only, media metadata is sanitized, raw body is not persisted, and retention guidance exists for webhook events.
- Reviewed operational restrictions: no Docker Compose, VPS, production DB, firewall, deploy or outbound provider calls were used.

## Commands executed

```bash
git diff --check
npm run build -w @salesforce-pro/shared
npm run typecheck -w @salesforce-pro/api
npm run smoke:communications -w @salesforce-pro/api
npm run smoke:communications:security -w @salesforce-pro/api
npm run smoke:archived-client-read -w @salesforce-pro/api
npm run smoke:ai -w @salesforce-pro/api
npm run smoke:date-only -w @salesforce-pro/api
npm run smoke:ultrafv3-order-flow -w @salesforce-pro/api
DATABASE_URL=postgresql://user:pass@localhost:5432/db npx prisma validate --schema apps/api/prisma/schema.prisma
rg '^(<<<<<<<|=======|>>>>>>>)' . --glob '!node_modules/**' --glob '!.git/**' || true
rg '\$queryRawUnsafe|\$executeRawUnsafe' apps/api/src/services/communications apps/api/src/routes/communication*.ts apps/api/src/scripts/communications*.ts apps/api/prisma/migrations/202607210001_secure_communications_foundation || true
rg 'fetch\(|axios|openai|Graph API|sendText|sendTemplate|download|transcri|\bAI\b|\bia\b' apps/api/src/services/communications apps/api/src/routes/communication*.ts || true
git diff --name-only | rg 'docker-compose' || true
which psql || true; which initdb || true; which postgres || true
which docker || true
apt-get update && apt-get install -y postgresql postgresql-client
find / -maxdepth 4 \( -name postgres -o -name psql -o -name initdb \) 2>/dev/null | head -50
```

## Results

- Build, typecheck, communications smoke, security smoke, archived-client smoke, AI smoke, date-only smoke and UltraFV3 order-flow smoke passed.
- Prisma schema validation passed with a dummy PostgreSQL URL.
- Static searches found no conflict markers, no unsafe raw SQL in the communications implementation, no outbound/AI calls in communications webhook/provider code, and no Docker Compose changes.
- PostgreSQL isolated migration execution was not completed because this environment does not provide `psql`, `postgres`, `initdb` or Docker.
- Attempting to install PostgreSQL with `apt-get` failed because the package repositories are blocked by a 403 proxy response.

## Required production blocker

The migration has **not** been executed against a real isolated PostgreSQL instance from this environment. Because the validation request requires real PostgreSQL execution, this remains a release blocker.

## CTO recommendation

Keep the PR as Draft until an environment with PostgreSQL or Docker can run:

```bash
createdb gesto_communications_validation
DATABASE_URL=postgresql://<migration-owner>@<host>:<port>/gesto_communications_validation npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
DATABASE_URL=postgresql://<migration-owner>@<host>:<port>/gesto_communications_validation npx prisma validate --schema apps/api/prisma/schema.prisma
DATABASE_URL=postgresql://<migration-owner>@<host>:<port>/gesto_communications_validation npm run prisma:generate -w @salesforce-pro/api
```

Then validate FKs, indexes, uniqueness, grants for `gesto_app`, duplicate webhook behavior, and rollback via feature flags.
