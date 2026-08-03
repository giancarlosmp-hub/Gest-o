#!/usr/bin/env node
import { readFileSync } from "node:fs";

const input = process.argv[2];
if (!input) throw new Error("usage: schema-predecessor-checkpoint.mjs MANAGED_DIFF.sql");

function tokenize(sql) {
  const out = [];
  for (let i = 0; i < sql.length;) {
    if (/\s/.test(sql[i])) { i += 1; continue; }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (sql[i] === '"' || sql[i] === "'") {
      const quote = sql[i];
      let value = quote; i += 1;
      let closed = false;
      while (i < sql.length) {
        value += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { value += sql[i + 1]; i += 2; continue; }
          i += 1; closed = true; break;
        }
        i += 1;
      }
      if (!closed) throw new Error("AFTER_PREDECESSOR_UNTERMINATED_STRING");
      out.push(value); continue;
    }
    if ("(),;".includes(sql[i])) { out.push(sql[i]); i += 1; continue; }
    const start = i;
    while (i < sql.length && !/\s/.test(sql[i]) && !"(),;'\"".includes(sql[i]) && !(sql[i] === "-" && sql[i + 1] === "-")) i += 1;
    if (start === i) throw new Error(`AFTER_PREDECESSOR_UNRECOGNIZED_CHARACTER:${sql[i]}`);
    out.push(sql.slice(start, i));
  }
  return out;
}

function statements(sql) {
  const result = []; let current = []; let depth = 0;
  for (const token of tokenize(sql)) {
    if (token === "(") depth += 1;
    if (token === ")") { depth -= 1; if (depth < 0) throw new Error("AFTER_PREDECESSOR_UNBALANCED_SQL"); }
    if (token === ";" && depth === 0) {
      if (!current.length) throw new Error("AFTER_PREDECESSOR_EMPTY_STATEMENT");
      result.push(current.join(" ")); current = []; continue;
    }
    current.push(token);
  }
  if (depth !== 0) throw new Error("AFTER_PREDECESSOR_UNBALANCED_SQL");
  if (current.length) throw new Error("AFTER_PREDECESSOR_PARTIAL_STATEMENT");
  return result;
}

const expectedSql = `
CREATE TYPE "TenantStatus" AS ENUM ('active', 'suspended', 'archived');
CREATE TYPE "TenantMembershipStatus" AS ENUM ('invited', 'active', 'revoked');
CREATE TYPE "TenantRole" AS ENUM ('diretor', 'gerente', 'vendedor');
CREATE TABLE "Tenant" (
 "id" TEXT NOT NULL, "slug" TEXT NOT NULL, "legalName" TEXT NOT NULL,
 "displayName" TEXT NOT NULL, "status" "TenantStatus" NOT NULL DEFAULT 'active',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 "suspendedAt" TIMESTAMP(3), CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "TenantMembership" (
 "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "userId" TEXT NOT NULL,
 "role" "TenantRole" NOT NULL, "status" "TenantMembershipStatus" NOT NULL,
 "version" INTEGER NOT NULL, "invitedAt" TIMESTAMP(3), "acceptedAt" TIMESTAMP(3),
 "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "TenantMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE INDEX "TenantMembership_userId_status_idx" ON "TenantMembership"("userId", "status");
CREATE INDEX "TenantMembership_tenantId_status_idx" ON "TenantMembership"("tenantId", "status");
CREATE UNIQUE INDEX "TenantMembership_tenantId_userId_key" ON "TenantMembership"("tenantId", "userId");
ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
`;

const actual = statements(readFileSync(input, "utf8"));
const expected = statements(expectedSql);
if (actual.length !== expected.length) throw new Error(`AFTER_PREDECESSOR_STATEMENT_COUNT:${actual.length}:EXPECTED:${expected.length}`);
for (let index = 0; index < expected.length; index += 1) {
  if (actual[index] !== expected[index]) {
    throw new Error(`AFTER_PREDECESSOR_STATEMENT_${index + 1}_MISMATCH\nEXPECTED: ${expected[index]}\nACTUAL: ${actual[index]}`);
  }
}
