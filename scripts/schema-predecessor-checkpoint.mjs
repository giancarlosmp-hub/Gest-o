#!/usr/bin/env node
import { readFileSync } from "node:fs";

const input = process.argv[2];
if (!input) throw new Error("usage: schema-predecessor-checkpoint.mjs MANAGED_DIFF.sql");
const meaningful = readFileSync(input, "utf8").replace(/^\s*--.*$/gm, "").trim();
const enumNames = new Set(["TenantStatus", "TenantMembershipStatus", "TenantRole"]);
const tableNames = new Set(["Tenant", "TenantMembership"]);
const indexNames = new Set(["Tenant_slug_key", "TenantMembership_tenantId_userId_key", "TenantMembership_userId_status_idx", "TenantMembership_tenantId_status_idx"]);
const foreignKeys = new Set(["TenantMembership_tenantId_fkey", "TenantMembership_userId_fkey"]);
const statements = meaningful.split(/;\s*/).map(statement => statement.trim()).filter(Boolean);

for (const statement of statements) {
  const enumMatch = statement.match(/^CREATE TYPE "([^"]+)" AS ENUM\b/s);
  const tableMatch = statement.match(/^CREATE TABLE "([^"]+)"\s*\(/s);
  const indexMatch = statement.match(/^CREATE (?:UNIQUE )?INDEX "([^"]+)" ON\b/s);
  const fkMatch = statement.match(/^ALTER TABLE "TenantMembership" ADD CONSTRAINT "([^"]+)" FOREIGN KEY\b/s);
  if (enumMatch && enumNames.has(enumMatch[1])) continue;
  if (tableMatch && tableNames.has(tableMatch[1])) continue;
  if (indexMatch && indexNames.has(indexMatch[1])) continue;
  if (fkMatch && foreignKeys.has(fkMatch[1])) continue;
  throw new Error(`AFTER_PREDECESSOR_UNEXPECTED_DDL:${statement.slice(0, 240)}`);
}
