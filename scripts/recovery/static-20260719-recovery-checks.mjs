import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const fail = (message) => {
  console.error(`static recovery check failed: ${message}`);
  process.exitCode = 1;
};

const sqlFiles = [
  "scripts/recovery/classify-20260719-productprice-orphans.sql",
  "scripts/recovery/diagnose-20260719-prisma-foreign-keys.sql",
  "scripts/recovery/report-20260719-generic-historical-clients.sql",
];

for (const file of sqlFiles) {
  const sql = read(file);
  const readOnlyBlocks = sql.split(/BEGIN\s+READ\s+ONLY\s*;/i).slice(1);
  for (const block of readOnlyBlocks) {
    const beforeEnd = block.split(/(?:COMMIT|ROLLBACK)\s*;/i)[0] ?? block;
    if (/CREATE\s+(?:TEMP|TEMPORARY)\s+TABLE/i.test(beforeEnd)) {
      fail(`${file} creates TEMP tables inside BEGIN READ ONLY`);
    }
  }
}

const productPriceApply = read("scripts/recovery/apply-20260719-productprice-recovery.sql");
if (/INSERT\s+INTO\s+public\."Product"|CREATE\s+TABLE[^;]+"Product"/is.test(productPriceApply)) {
  fail("ProductPrice recovery script must not create Product rows/tables");
}
for (const required of ["price <> 0", '"validFrom" IS NOT NULL', '"erpPriceId" IS NOT NULL AND "erpPriceId" <> \'1\'', "DELETE FROM public.\"ProductPrice\""]) {
  if (!productPriceApply.includes(required)) fail(`ProductPrice recovery script missing safety evidence: ${required}`);
}

const clientReport = read("scripts/recovery/report-20260719-generic-historical-clients.sql");
const forbiddenClientPatterns = [
  /incident_20260719_erp_partner_client_map\s+\w+[^;]+\.historical_client_id/is,
  /incident_20260718_client_map\s+\w+[^;]+\.old_client_id/is,
  /max\s*\(\s*jsonb/i,
  /INCIDENT_20260718_MISSING_PARENT_RESTORED%/,
];
for (const pattern of forbiddenClientPatterns){
  if (pattern.test(clientReport)) fail(`client report contains forbidden/obsolete pattern: ${pattern}`);
}
for (const required of [
  '"archiveReason" = \'INCIDENT_20260718_MISSING_PARENT_RESTORED\'',
  "name LIKE '[RECUPERADO]%'",
  'public."Contact"',
  "active_client_code_match_count = 1",
]) {
  if (!clientReport.includes(required)) fail(`client report missing required token: ${required}`);
}

const fkDiag = read("scripts/recovery/diagnose-20260719-prisma-foreign-keys.sql");
const expectedFkRows = [
  "('Activity.clientId','Activity','clientId','Client','id','SET NULL','CASCADE'",
  "('AgendaStop.clientId','AgendaStop','clientId','Client','id','SET NULL','CASCADE'",
  "('Opportunity.clientId','Opportunity','clientId','Client','id','RESTRICT','CASCADE'",
  "('OpportunityItem.productId','OpportunityItem','productId','Product','id','SET NULL','CASCADE'",
  "('ProductPrice.productId','ProductPrice','productId','Product','id','CASCADE','CASCADE'",
  "('TimelineEvent.clientId','TimelineEvent','clientId','Client','id','SET NULL','CASCADE'",
];
for (const row of expectedFkRows) {
  if (!fkDiag.includes(row)) fail(`FK diagnostic missing expected action row: ${row}`);
}

const schema = read("apps/api/prisma/schema.prisma");
for (const relation of [
  "client          Client?      @relation(fields: [clientId], references: [id])",
  "client           Client?     @relation(fields: [clientId], references: [id])",
  "client               Client                 @relation(fields: [clientId], references: [id])",
  "product             Product?                    @relation(fields: [productId], references: [id], onDelete: SetNull)",
  "product    Product   @relation(fields: [productId], references: [id], onDelete: Cascade)",
]) {
  if (!schema.includes(relation)) fail(`schema.prisma relation source changed or missing: ${relation}`);
}

for (const composeFile of ["docker-compose.yml", "docker-compose.preview.yml"]) {
  const current = read(composeFile);
  const baseline = execFileSync("git", ["show", `e21748a:${composeFile}`], { encoding: "utf8" });
  if (current !== baseline) fail(`${composeFile} differs from recovery base e21748a; Compose hardening must be a separate PR`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("static recovery checks passed");
