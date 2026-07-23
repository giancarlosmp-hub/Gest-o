# Architecture Freeze — Omnichannel Communications Foundation

Date: 2026-07-21
Status: Architecture approved for freeze; Production Gate remains blocked until PostgreSQL migration validation.

## 1. Context

The current PR adds a generic Communication foundation for inbound Meta WhatsApp Cloud webhooks only. It intentionally excludes Inbox UI, outbound sending, AI inference, automations, media download and production deployment.

## 2. Current architecture

```text
Public webhook
→ communicationWebhookRoutes (transport, raw body, Content-Type, HTTP response)
→ MetaWhatsAppCloudProvider (Meta-specific HMAC/challenge/payload normalization)
→ CommunicationIntegrationService (flags, idempotency, transaction, conversation/message/status persistence, conservative matching, Timeline summary)
→ PostgreSQL via Prisma models CommunicationConversation, CommunicationMessage, CommunicationWebhookEvent
```

## 3. Approved decisions

- Keep the domain named `Communication`, not WhatsApp-specific.
- Keep provider-specific payload and HMAC logic inside provider implementations.
- Keep routes thin and free of CRM business rules.
- Persist sanitized communication records rather than raw webhook payloads.
- Keep feature flags off by default and use flags for operational rollback.
- Keep Timeline as a controlled side effect with summary-only text.
- Include `externalAccountId` in conversation, message and webhook event uniqueness to avoid collisions across multiple accounts of the same provider.
- Keep `tenantId` optional in this PR only because there is no tenant registry yet; future tenant-aware queries must not infer tenant from external payload values.

## 4. Rejected decisions

- Do not derive authoritative tenant ownership inside `MetaWhatsAppCloudProvider`.
- Do not introduce Inbox, outbound, AI, automations, media download or workers in this freeze.
- Do not store tokens, signatures, raw body, full payloads, temporary media URLs or credentials in communication records.
- Do not depend on the manual WhatsApp assistant flow.

## 5. Accepted trade-offs

- `tenantId` remains nullable until a tenant registry and CommunicationIntegrationAccount exist.
- Matching by current `Contact.phone` is acceptable for the first disabled-by-default foundation, but it is not the final SaaS-scale matching model.
- Timeline is synchronous in this PR to preserve simple transactional behavior; it should move behind Outbox/workers before high-volume tenants.
- Metadata JSON is allowed only for sanitized provider-neutral facts; future PRs must formalize stricter schemas before broad provider expansion.

## 6. Blockers

- Production Gate blocker: migration has not been executed in a real isolated PostgreSQL instance.

## 7. Required before merge

- Execute `prisma migrate deploy` against isolated PostgreSQL.
- Validate FKs, unique constraints, indexes and conditional grants for `gesto_app`.
- Execute real webhook persistence/idempotency tests against that isolated database.
- Keep this PR Draft until the Production Gate is complete.

## 8. Next PR — 18A.1

- Add `CommunicationIntegrationAccount` to map tenant/channel/provider/externalAccountId and hold non-secret configuration state.
- Add `CommunicationTenantResolver` so webhook processing resolves tenant from trusted configured integration accounts, not from arbitrary payload fields.
- Add normalized contact identity fields or a `CommunicationIdentity` foundation for tenant-aware matching.
- Add DB-backed tests for duplicate webhook, concurrent conversation creation, status ordering, orphan checks and grants.

## 9. Next PR — 18B

- Introduce Transactional Outbox and workers before Inbox/outbound/AI scale-up.
- Move matching, Timeline enrichment, metrics and future automations out of the synchronous webhook request path.

## 10. Future

- Inbox/Communication Center UX.
- Outbound official messages and template governance.
- AI artifacts/insights with model/prompt version audit.
- Retention and anonymization jobs per tenant.
- Tenant-aware repository or Prisma extension for future internal query APIs.

## 11. Freeze rules for next PRs

- Never trust `tenantId` from external webhook payloads.
- Resolve tenant from a configured internal account registry keyed by provider/channel/externalAccountId.
- Every future query that returns communications data must be tenant-aware.
- Every future provider must output canonical DTOs and keep provider payload details out of routes.
- No AI, outbound, media download or automation may run inside webhook acknowledgement flow.
- No raw body, provider payload, token, signature, phone number, full name or message text in logs.
- Any new communication table must include tenant strategy, retention strategy and access-control strategy.

## 12. Mandatory freeze answers

1. Large refactor in 6 months? No, if PR 18A.1 adds IntegrationAccount/TenantResolver before real SaaS tenants.
2. Difficulty supporting 1,000 tenants? Partially: nullable tenant is acceptable now but must be resolved before tenant-facing APIs.
3. Collision risk between tenants/accounts? Reduced by unique constraints including `externalAccountId`; tenant collisions remain blocked by the required TenantResolver roadmap.
4. Is nullable tenantId safe now? Accepted trade-off only while integration is disabled-by-default and no tenant-facing Inbox exists.
5. Do unique constraints include tenant/account correctly? They include provider plus externalAccountId plus external key; tenant uniqueness requires IntegrationAccount mapping in 18A.1.
6. Is provider doing tenant resolution incorrectly? It must not; provider only extracts externalAccountId.
7. CommunicationTenantResolver before merge? No; NEXT PR — 18A.1 before first tenant/customer enablement.
8. CommunicationIntegrationAccount before merge? No; NEXT PR — 18A.1 before first tenant/customer enablement.
9. CommunicationIdentity before merge? No; NEXT PR — 18A.1 or shortly after, before Inbox scale.
10. phoneNormalized/phoneHash before merge? No; NEXT PR — 18A.1 for safer matching.
11. Outbox before merge? No; NEXT PR — 18B before Inbox/outbound/AI scale.
12. Worker before Inbox? Yes, NEXT PR — 18B.
13. Worker before outbound? Yes, NEXT PR — 18B.
14. Worker before IA? Yes, NEXT PR — 18B.
15. Does CommunicationIntegrationService have too many responsibilities? Accepted for this first inbound foundation; split before outbound/AI.
16. Cross-tenant leak risk? No tenant-facing read APIs were added; future reads must be tenant-aware.
17. Can future queries be tenant-aware? Yes, tenantId/indexes are present, but repository discipline is required.
18. Multiple accounts per tenant? Partially supported by externalAccountId; full support requires IntegrationAccount.
19. Multiple providers without central model changes? Yes for current channel/provider/message enums; new provider types may add enum values/migrations.
20. Reprocessing safe? Partially; event/message idempotency exists, but retry states should improve with Outbox.
21. Is metadata governed enough? Accepted trade-off; must be schema-governed before broad provider expansion.
22. Is unreadCount concurrency safe? Uses atomic increment only after a new message insert; DB validation still required.
23. Should Timeline remain synchronous? Accepted for now; move to worker before high volume.
24. Absence causing destructive migration after Inbox? No known destructive migration if 18A.1 happens before tenant-facing Inbox.
25. Correct now vs PR 18A.1? Correct now: account-scoped uniqueness and no provider tenant authority. PR 18A.1: IntegrationAccount, TenantResolver, identity matching and DB-backed concurrency tests.

## 13. Findings classification

| Finding | Classification | Risk | Cost now | Cost later | Decision |
|---|---|---:|---:|---:|---|
| Migration not validated in real PostgreSQL | BLOCKER | High | Medium | High | Keep Draft until Production Gate passes |
| Unique constraints lacked external account dimension | REQUIRED BEFORE MERGE | High | Low | High | Fixed in current PR migration/schema |
| Provider-derived tenant authority would be unsafe | REQUIRED BEFORE MERGE | High | Low | High | Provider extracts externalAccountId only; authoritative resolver deferred |
| Missing IntegrationAccount aggregate | NEXT PR — 18A.1 | Medium | Medium | High | Add before first real tenant enablement |
| Missing TenantResolver | NEXT PR — 18A.1 | Medium | Medium | High | Add with IntegrationAccount |
| Phone matching lacks normalized indexed identity | NEXT PR — 18A.1 | Medium | Medium | High | Add phoneHash/identity before Inbox scale |
| No Outbox/workers | NEXT PR — 18B | Medium | Medium | High | Add before Inbox/outbound/AI scale |
| Metadata JSON governance is light | ACCEPTED TRADE-OFF | Medium | Low | Medium | Formalize schemas before more providers |
| Timeline synchronous | ACCEPTED TRADE-OFF | Low | Low | Medium | Move to worker before high volume |
| No tenant-aware repository layer | FUTURE | Medium | High | High | Required before broad internal communications APIs |

## 14. Final architecture decision

Architecture is approved for freeze because the domain remains provider-agnostic, account-scoped uniqueness is now modeled, no tenant-facing read surface was added, idempotent persistence is preserved, and the path to IntegrationAccount, TenantResolver, Identity, Outbox and Workers is explicit.

This is not production approval. Production Gate remains blocked until real PostgreSQL migration validation succeeds.
