import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const files = [
  "src/routes/communicationWebhookRoutes.ts",
  "src/services/communications/communicationIntegrationService.ts",
  "src/services/communications/metaWhatsAppCloudProvider.ts",
];
const content = files.map((f) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8")).join("\n");
assert.match(content, /express\.raw\(\{ type: "application\/json", limit: "256kb" \}\)/);
assert.match(content, /timingSafeEqual/);
assert.doesNotMatch(content, /fetch\(|axios|openai|sendText\(|sendTemplate\(|Graph API/i);
assert.doesNotMatch(content, /console\.log\([^)]*(rawBody|payload|token|signature|textContent)/i);
const migration = readFileSync(new URL("../../prisma/migrations/202607210001_secure_communications_foundation/migration.sql", import.meta.url), "utf8");
assert.doesNotMatch(migration.replace(/GRANT[^;]+;/g, "").replace(/ON DELETE (SET NULL|CASCADE|RESTRICT|NO ACTION)/gi, ""), /\b(DROP|TRUNCATE|DELETE)\b/i);
assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CommunicationConversation", "CommunicationMessage", "CommunicationWebhookEvent" TO gesto_app/);
console.log("communicationsSecuritySmoke ok");
