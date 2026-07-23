# Go Live Checklist — Omnichannel Communications Foundation

Date executed: 2026-07-23
Checklist file date: 2026-07-21 (requested path)
Commit under review: d80da83284eae4ba8007a62e2752258ac23ce823
Decision: **MANTER EM DRAFT**

## Executive decision

The PR is **not ready for merge**. The architecture freeze is complete, but the Production Gate remains blocked because the migration has not been applied and validated in a real isolated PostgreSQL database. Preview and CI status could not be confirmed from this managed checkout because no Git remote/PR URL/check metadata is available in the environment.

No production system, VPS, firewall, Docker Compose, deploy, merge, ERP, UltraFV3, PDF, pricing, stock, recovery-data, or manual WhatsApp assistant flow was accessed or changed during this go-live review.

## Checklist

| Item | Result | Evidence / reason |
|---|---:|---|
| Preview opens normally | NOT VALIDATED | No Preview URL/check metadata available in this checkout. |
| Login works | NOT VALIDATED | Requires Preview or local full app with DB. |
| Dashboard works | NOT VALIDATED | Requires Preview or local full app with DB. |
| Clients work | NOT VALIDATED | Requires Preview or local full app with DB. |
| Opportunities work | NOT VALIDATED | Requires Preview or local full app with DB. |
| Orders work | PARTIAL | `smoke:ultrafv3-order-flow` passed with mock flow. |
| Agenda works | NOT VALIDATED | No Preview/manual browser validation available. |
| No functional regression | PARTIAL | Build/typecheck/smokes passed; Preview/manual checks pending. |
| Console without critical errors | NOT VALIDATED | No Preview browser session available. |
| Network without 500/502/503 | NOT VALIDATED | No Preview browser/network session available. |
| Build approved | PASS | `npm run build -w @salesforce-pro/shared` passed. |
| Typecheck approved | PASS | `npm run typecheck -w @salesforce-pro/api` passed. |
| Smokes approved | PASS | Communications, security, archived-client-read, AI, date-only and UltraFV3 order-flow smokes passed. |
| CI approved | NOT VALIDATED | No remote/PR/check metadata available in this checkout. |
| Migration applied in Preview | NOT VALIDATED | Preview/DB access unavailable. |
| Tables created | NOT VALIDATED | Real PostgreSQL migration execution unavailable. |
| Feature flags preserve current behavior | PARTIAL | Defaults are false and smokes pass; full Preview validation pending. |
| No interference with manual WhatsApp assistant | PASS STATIC | No files for the manual assistant were changed in this go-live step. |
| No interference with ERP | PASS STATIC | No ERP/UltraFV3 code changed in this go-live step; ERP smoke passed. |
| No interference with orders | PARTIAL | Order-flow smoke passed; Preview/manual order validation pending. |
| No interference with PDFs | PASS STATIC | No PDF files/code changed in this go-live step. |
| No interference with pricing | PASS STATIC | No pricing files/code changed in this go-live step. |
| No interference with stock | PASS STATIC | No stock files/code changed in this go-live step. |
| No interference with production | PASS | Production was not accessed and no deploy was performed. |

## Checks executed

```bash
git status --short
git rev-parse HEAD
git remote -v
command -v gh || true
npm run build -w @salesforce-pro/shared
npm run typecheck -w @salesforce-pro/api
npm run smoke:communications -w @salesforce-pro/api
npm run smoke:communications:security -w @salesforce-pro/api
DATABASE_URL=postgresql://user:pass@localhost:5432/db npx prisma validate --schema apps/api/prisma/schema.prisma
git diff --check
npm run smoke:archived-client-read -w @salesforce-pro/api
npm run smoke:ai -w @salesforce-pro/api
npm run smoke:date-only -w @salesforce-pro/api
npm run smoke:ultrafv3-order-flow -w @salesforce-pro/api
rg '^(<<<<<<<|=======|>>>>>>>)' . --glob '!node_modules/**' --glob '!.git/**' || true
rg '\$queryRawUnsafe|\$executeRawUnsafe' apps/api/src/services/communications apps/api/src/routes/communication*.ts apps/api/src/scripts/communications*.ts apps/api/prisma/migrations/202607210001_secure_communications_foundation || true
rg 'fetch\(|axios|openai|Graph API|sendText|sendTemplate|download|transcri|\bAI\b|\bia\b' apps/api/src/services/communications apps/api/src/routes/communication*.ts || true
git diff --name-only | rg 'docker-compose' || true
```

## Results

- Local build, typecheck and available smoke checks passed.
- Prisma schema validation passed with a dummy PostgreSQL URL.
- Static searches found no conflict markers, no unsafe SQL in the communications implementation, no outbound/AI calls in communications code, and no Docker Compose changes.
- CI status was not validated because the managed checkout has no remote/check metadata and no PR URL was available.
- Preview status was not validated because no Preview URL was available.
- Migration execution remains unvalidated in real PostgreSQL.

## Production Gate

Status: **BLOCKED**

Required before merge:

1. Execute migration in isolated PostgreSQL using `prisma migrate deploy`.
2. Confirm the new tables exist.
3. Validate FKs, unique constraints, indexes and conditional grants for `gesto_app`.
4. Run DB-backed webhook/idempotency tests.
5. Validate Preview opens and core CRM flows manually: login, dashboard, clients, opportunities, orders and agenda.
6. Confirm CI checks pass in GitHub.

## Architecture Freeze

Status: **COMPLETED / APPROVED FOR FREEZE**

The architecture freeze approved the domain foundation after account-scoped uniqueness and provider tenant-authority concerns were addressed. This does not override the blocked Production Gate.

## Known limitations

- No real PostgreSQL migration execution in this environment.
- No Preview URL available for browser/manual validation.
- No GitHub CI/check status available from this checkout.
- No full manual regression run was possible.

## Accepted technical debt

- `tenantId` remains nullable until `CommunicationIntegrationAccount` and `CommunicationTenantResolver` are introduced.
- Matching remains phone-based until normalized identity work lands.
- Outbox/workers are deferred until before Inbox/outbound/AI scale-up.
- Metadata JSON governance must be tightened before broad provider expansion.

## Planned next PR — 18A.1

- Add `CommunicationIntegrationAccount`.
- Add `CommunicationTenantResolver`.
- Add normalized contact/communication identity matching.
- Add DB-backed tests for migration, grants, idempotency, concurrency and status ordering.

## Final recommendation

**MANTER EM DRAFT.**

The PR is not approved for merge because mandatory Production Gate items are not complete. The code may remain as a Draft candidate for the next validation environment, but merge should wait for real PostgreSQL migration validation, Preview/manual checks and CI confirmation.
