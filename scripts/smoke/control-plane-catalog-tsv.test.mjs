#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCatalogRows } from "../control-plane-catalog-validate.mjs";
import { validateForeignKeys } from "../control-plane-foreign-key.mjs";

const catalogSql = readFileSync("scripts/control-plane-catalog.sql", "utf8");
assert.match(catalogSql, /e\.enumlabel::text AS detail/);
assert.doesNotMatch(catalogSql, /e\.enumlabel\s+AS detail/);
assert.match(catalogSql, /format\([\s\S]*?con\.convalidated::text[\s\S]*?\)::text/);
assert.doesNotMatch(catalogSql, /::name\b|CAST\s*\([^)]*\s+AS\s+name\)|(?:varchar|character varying|char)\s*\(\s*63\s*\)|\b(?:substring|left|right)\s*\(/i);
assert.match(catalogSql, /SELECT pg_typeof\(detail\)::text FROM catalog LIMIT 1/);
const fkFormat = catalogSql.match(new RegExp("format\\(\\n\\s*'source_schema=%s;source=%s;source_columns=%s;target_schema=%s;target=%s;target_columns=%s;delete=%s;update=%s;validated=%s',[\\s\\S]*?\\n\\s*\\)"))?.[0] ?? "";
const detailFormatLiteral = fkFormat.match(/'([^']+)'/)?.[1] ?? "";
assert.equal((detailFormatLiteral.match(/%s/g) || []).length, 9);
for (const token of ["src_ns.nspname", "src.relname", "src_cols.columns", "dst_ns.nspname", "dst.relname", "dst_cols.columns", "con.confdeltype", "con.confupdtype", "con.convalidated::text"]) assert.ok(fkFormat.includes(token), token);
assert.doesNotMatch(fkFormat, /source_columns=%s'\s*,\s*src_cols\.columns\s*\)/);

const tenantDetail = "source_schema=public;source=TenantMembership;source_columns=tenantId;target_schema=public;target=Tenant;target_columns=id;delete=RESTRICT;update=CASCADE;validated=true";
const userDetail = "source_schema=public;source=TenantMembership;source_columns=userId;target_schema=public;target=User;target_columns=id;delete=RESTRICT;update=CASCADE;validated=true";
const longDetail = `${tenantDetail};diagnostic=${"x".repeat(80)}`;
const line = (name, detail) => `fk\t${name}\t0\t${detail}`;
const parseFks = content => parseCatalogRows(content).filter(row => row.kind === "fk");
const rejects = fn => {
  const original = console.error;
  console.error = () => {};
  try { assert.throws(fn, /CATALOG_/); } finally { console.error = original; }
};

assert.ok(longDetail.length > 200);
let rows = parseFks(`${line("TenantMembership_tenantId_fkey", longDetail)}\n${line("TenantMembership_userId_fkey", userDetail)}\n`);
validateForeignKeys(rows);
assert.equal(rows[0].detail.includes("source_columns=tenantId"), true);
assert.equal(rows[1].detail.includes("source_columns=userId"), true);
assert.equal(rows[0].detail.includes("target=Tenant"), true);
assert.equal(rows[1].detail.includes("target=User"), true);
assert.equal(rows[0].detail.includes("delete=RESTRICT"), true);
assert.equal(rows[0].detail.includes("update=CASCADE"), true);
assert.equal(rows[0].detail.endsWith("x".repeat(80)), true);
assert.equal(line("TenantMembership_tenantId_fkey", tenantDetail).split("\t").length, 4);
assert.equal(tenantDetail.endsWith("validated=true"), true);
assert.equal(userDetail.endsWith("validated=true"), true);

for (const truncated of [
  line("TenantMembership_tenantId_fkey", "source_schema=public;source=TenantMembership;source_columns=ten"),
  line("TenantMembership_userId_fkey", "source_schema=public;source=TenantMembership;source_columns=use")
]) rejects(() => validateForeignKeys(parseFks(`${truncated}\n${line("TenantMembership_userId_fkey", userDetail)}\n`)));

rejects(() => parseCatalogRows("fk\tTenantMembership_tenantId_fkey\t0\n"));
rejects(() => parseCatalogRows(`${line("TenantMembership_tenantId_fkey", `${tenantDetail}\textra=true`)}\n`));
rejects(() => validateForeignKeys(parseFks(`${line("TenantMembership_tenantId_fkey", "source_schema=public;source=TenantMembership;source_columns=tenantId")}\n${line("TenantMembership_userId_fkey", userDetail)}\n`)));
rejects(() => parseCatalogRows("fk        TenantMembership_tenantId_fkey        0        source_schema=public\n"));
validateForeignKeys(parseFks(`${line("TenantMembership_tenantId_fkey", tenantDetail)}\n${line("TenantMembership_userId_fkey", userDetail)}\n`));

console.log("control-plane catalog TSV transport tests passed");
