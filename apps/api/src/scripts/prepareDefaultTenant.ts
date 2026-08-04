import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_TENANT } from "../tenancy/defaultTenant.js";
import { prepareDefaultTenant } from "../tenancy/defaultTenantPreparation.js";
import { readTenancyMode } from "../tenancy/tenancyMode.js";

const apply = process.argv.includes("--apply");
if (process.argv.some(arg => !["--apply", "--dry-run"].includes(arg))) throw new Error("usage: prepareDefaultTenant [--dry-run|--apply]");
readTenancyMode();
const root = resolve(import.meta.dirname, "../../../..");
const sha = process.env.APP_COMMIT;
if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("PINNED_APP_COMMIT_REQUIRED");
if (!existsSync(resolve(root, "apps/api/prisma/migrations/20260802120000_tenancy_control_plane/migration.sql"))) throw new Error("CONTROL_PLANE_MIGRATION_MISSING");
if (apply) {
  if (process.env.CONFIRM !== "PREPARE_DEFAULT_TENANT") throw new Error("APPLY_CONFIRMATION_REQUIRED");
  if (!process.env.EXPECTED_SHA || process.env.EXPECTED_SHA !== sha) throw new Error("EXPECTED_SHA_MISMATCH");
  if (process.env.TENANCY_MODE !== "default-only") throw new Error("DEFAULT_ONLY_REQUIRED");
}
if (DEFAULT_TENANT.id !== "tenant-default-v1") throw new Error("DEFAULT_TENANT_IDENTITY_DIVERGED");
const prisma = new PrismaClient();
try {
  const result = await prepareDefaultTenant(prisma, { apply, evidenceDir: resolve(process.env.EVIDENCE_DIR || "tenancy-evidence") });
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", result }));
} finally {
  await prisma.$disconnect();
}
