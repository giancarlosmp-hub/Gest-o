#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const [input, output, mode = "post"] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: schema-diff-filter.mjs INPUT OUTPUT [pre|post]");
const incidentTables = [
  "incident_20260718_client_enrichment_audit", "incident_20260718_client_map",
  "incident_20260718_june_client_source", "incident_20260718_recovery_audit",
  "incident_20260719_erp_code_enrichment_audit", "incident_20260719_erp_partner_client_map",
  "incident_20260719_orphan_productprice_audit", "incident_20260719_product_snapshot_map"
];
let sql = readFileSync(input, "utf8");
for (const table of incidentTables) {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allowed = new RegExp(`(?:--\\s*DropTable\\s*\\n)?DROP TABLE \\"${escaped}\\";\\s*`, "g");
  sql = sql.replace(allowed, "");
}
if (/incident_\d+/i.test(sql)) throw new Error("unsupported operation involving incident_* in Prisma diff");
writeFileSync(output, sql);

const meaningful = sql.replace(/^\s*--.*$/gm, "").trim();
if (mode === "post") {
  if (meaningful) throw new Error("managed post-apply Prisma diff is not empty");
  process.exit(0);
}
const enums = "(?:Communication(?:ChannelType|ProviderType|Direction|MessageType|MessageStatus|ConversationStatus|WebhookStatus)|TenantStatus|TenantMembershipStatus|TenantRole)";
const tables = "(?:ClientCodeAudit|CommunicationIntegrationAccount|CommunicationConversation|CommunicationMessage|CommunicationWebhookEvent|Tenant|TenantMembership)";
const indexes = [
  "Tenant_slug_key", "TenantMembership_tenantId_userId_key", "TenantMembership_userId_status_idx", "TenantMembership_tenantId_status_idx",
  "ClientCodeAudit_clientId_createdAt_idx", "ClientCodeAudit_requestId_idx", "ClientCodeAudit_origin_createdAt_idx",
  "Contact_phoneHash_idx", "Contact_ownerSellerId_phoneHash_idx",
  "CommunicationIntegrationAccount_provider_channel_externalAc_idx", "CommunicationIntegrationAccount_tenantId_enabled_idx", "CommunicationIntegrationAccount_tenantId_provider_channel_e_key",
  "CommunicationConversation_integrationAccountId_idx", "CommunicationConversation_tenantId_contactPhoneHash_idx", "CommunicationConversation_tenantId_idx", "CommunicationConversation_clientId_idx", "CommunicationConversation_assignedSellerId_idx", "CommunicationConversation_contactNormalized_idx", "CommunicationConversation_status_idx", "CommunicationConversation_lastMessageAt_idx", "CommunicationConversation_provider_externalAccountId_extern_key",
  "CommunicationMessage_integrationAccountId_idx", "CommunicationMessage_tenantId_contactPhoneHash_idx", "CommunicationMessage_conversationId_idx", "CommunicationMessage_tenantId_idx", "CommunicationMessage_providerTimestamp_idx", "CommunicationMessage_status_idx", "CommunicationMessage_provider_externalAccountId_externalMes_key",
  "CommunicationWebhookEvent_integrationAccountId_idx", "CommunicationWebhookEvent_tenantId_idx", "CommunicationWebhookEvent_status_createdAt_idx", "CommunicationWebhookEvent_payloadHash_idx", "CommunicationWebhookEvent_provider_externalAccountId_extern_key"
];
const constraints = ["TenantMembership_tenantId_fkey", "TenantMembership_userId_fkey", "ClientCodeAudit_clientId_fkey", "AgendaEvent_clientId_fkey", "CommunicationConversation_integrationAccountId_fkey", "CommunicationConversation_clientId_fkey", "CommunicationConversation_assignedSellerId_fkey", "CommunicationMessage_conversationId_fkey", "CommunicationMessage_integrationAccountId_fkey", "CommunicationWebhookEvent_integrationAccountId_fkey"];
const approvedContactColumns = new Map([
  ["phoneHash", "VARCHAR(64)"],
  ["phoneNormalized", "VARCHAR(32)"]
]);
function isApprovedContactAddition(statement) {
  const match = statement.match(/^ALTER\s+TABLE\s+"Contact"\s+([\s\S]+)$/);
  if (!match) return false;

  const clauses = match[1].split(",").map((clause) => clause.trim());
  if (clauses.length === 0 || clauses.length > approvedContactColumns.size) return false;

  const addedColumns = new Set();
  for (const clause of clauses) {
    const addition = clause.match(/^ADD\s+COLUMN\s+"(phoneHash|phoneNormalized)"\s+(VARCHAR\s*\(\s*\d+\s*\))$/);
    if (!addition) return false;

    const [, column, rawType] = addition;
    const normalizedType = rawType.replace(/\s+/g, "");
    if (approvedContactColumns.get(column) !== normalizedType || addedColumns.has(column)) return false;
    addedColumns.add(column);
  }
  return true;
}
const statements = meaningful.split(/;\s*/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
for (const statement of statements) {
  const allowed = new RegExp(`^CREATE TYPE "${enums}" AS ENUM`, "s").test(statement)
    || new RegExp(`^CREATE TABLE "${tables}" \\(`, "s").test(statement)
    || isApprovedContactAddition(statement)
    || indexes.some((name) => new RegExp(`^CREATE (?:UNIQUE )?INDEX "${name}" `).test(statement))
    || constraints.some((name) => new RegExp(`^ALTER TABLE ".+" ADD CONSTRAINT "${name}" FOREIGN KEY`).test(statement));
  if (!allowed) throw new Error(`unapproved or partially-compatible pre-apply drift: ${statement.slice(0, 180)}`);
}
