import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const service = readFileSync(new URL("../services/communications/communicationIntegrationService.ts", import.meta.url), "utf8");
const resolver = readFileSync(new URL("../services/communications/communicationTenantResolver.ts", import.meta.url), "utf8");
const phone = readFileSync(new URL("../services/communications/phoneNormalization.ts", import.meta.url), "utf8");

assert.match(schema, /model CommunicationIntegrationAccount/, "integration account model must exist");
assert.match(schema, /@@unique\(\[tenantId, provider, channel, externalAccountId\]\)/, "integration account must be unique per tenant/provider/channel/external account");
const accountModel = schema.slice(schema.indexOf("model CommunicationIntegrationAccount"), schema.indexOf("model CommunicationConversation"));
assert.doesNotMatch(accountModel, /accessToken|appSecret|password/i, "integration account schema must not store secrets");
assert.match(resolver, /externalAccountId/, "tenant resolver must resolve from external account id");
assert.doesNotMatch(resolver, /defaultTenant|tenantId.*payload/i, "tenant resolver must not fall back to tenant from payload/default");
assert.match(service, /tenantResolver\.resolve/, "webhook processing must use tenant resolver");
assert.match(service, /unknown_account/, "unknown accounts must be controlled");
assert.match(service, /disabled_account/, "disabled accounts must be controlled");
assert.match(phone, /hashPhoneForTenant/, "tenant-aware deterministic phone hash must exist");
assert.match(service, /phoneHash/, "matching must use phoneHash rather than contains");
assert.doesNotMatch(service, /phone:\s*\{\s*contains/, "communications matching must not use textual contains as primary strategy");
console.log("PR 18A.1 communications smoke passed");
