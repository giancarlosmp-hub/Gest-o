import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = await readFile(resolve(process.cwd(), "src/services/ultraFv3SyncService.ts"), "utf8");
const orderSource = await readFile(resolve(process.cwd(), "src/services/erpOrderService.ts"), "utf8");

assert.match(source, /tenantId: authority\.tenantId/, "new ERP clients inherit only proved authority");
assert.match(source, /tenant: \{ connect: \{ id: authority\.tenantId \} \}/, "updates preserve/adopt the proved tenant");
assert.match(source, /tenantId: \{ not: tenantId \}/, "legacy adoption checks other tenants");
assert.match(source, /allowLegacyAdoption: Boolean\(options\?\.authenticatedTenantId/, "only authenticated synchronization repairs null tenancy");
assert.match(source, /seller\.tenantMemberships\.length !== 1/, "global synchronization rejects absent or ambiguous memberships");
assert.doesNotMatch(source, /payload[^\n]*tenantId|tenantId[^\n]*payload/, "ERP payload cannot select tenant authority");
assert.doesNotMatch(source, /fallbackSeller\.id/, "global synchronization never infers tenant through a fallback seller");
assert.match(source, /AND: \[tenantScope/, "identity matching and deduplication are tenant-scoped");
assert.match(source, /operation: "tenant_adoption"/, "legacy adoption is auditable and idempotent");
assert.match(source, /Históricos, autoria e datas foram preservados/, "seller succession does not rewrite history");
assert.match(orderSource, /Tenant do cliente não comprovado; criação do pedido ERP bloqueada\./, "real order gate remains fail closed");
assert.match(orderSource, /Tenant do cliente não comprovado; teste de protocolo bloqueado\./, "simulation uses the same tenant proof");

console.log("UltraFV3 partner tenant-safety contract passed");
