#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const filter = resolve(root, "scripts/schema-diff-filter.mjs");
const migration = "20260911190000_product_price_authority";
const observed = `-- AlterTable
ALTER TABLE "ProductPrice" ADD COLUMN "availabilityState" TEXT NOT NULL DEFAULT 'available', ADD COLUMN "source" TEXT NOT NULL DEFAULT 'legacy';

-- CreateIndex
CREATE INDEX "ProductPrice_source_availabilityState_idx" ON "ProductPrice"("source", "availabilityState");
`;

function run(name, sql, accepted, id = migration) {
  const dir = mkdtempSync(join(tmpdir(), "product-price-diff-"));
  const input = join(dir, "input.sql");
  const output = join(dir, "output.sql");
  writeFileSync(input, sql);
  const result = spawnSync(process.execPath, [filter, input, output, "pre", id], { cwd: root, encoding: "utf8" });
  rmSync(dir, { recursive: true });
  assert.equal(result.status === 0, accepted, `${name}: ${result.stdout}${result.stderr}`);
}

run("exact grouped run #30 diff", observed, true);
run("separate and reordered columns", `
  ALTER TABLE public."ProductPrice" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'legacy';
  CREATE INDEX "ProductPrice_source_availabilityState_idx" ON public."ProductPrice" ( "source" , "availabilityState" );
  ALTER TABLE "ProductPrice" ADD COLUMN "availabilityState" TEXT NOT NULL DEFAULT 'available';`, true);
run("empty idempotent diff", "-- This is an empty migration.\n", true);
run("one column only", `ALTER TABLE "ProductPrice" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'legacy';`, false);
run("wrong type", observed.replace("TEXT NOT NULL DEFAULT 'legacy'", "VARCHAR(20) NOT NULL DEFAULT 'legacy'"), false);
run("wrong default", observed.replace("DEFAULT 'available'", "DEFAULT 'unavailable'"), false);
run("nullable", observed.replace("TEXT NOT NULL DEFAULT 'legacy'", "TEXT DEFAULT 'legacy'"), false);
run("extra column", observed.replace(";\n\n-- CreateIndex", `, ADD COLUMN "extra" TEXT;\n\n-- CreateIndex`), false);
run("extra index", `${observed}\nCREATE INDEX "extra_idx" ON "ProductPrice"("source");`, false);
run("wrong index order", observed.replace('("source", "availabilityState")', '("availabilityState", "source")'), false);
run("destructive operation", `${observed}\nALTER TABLE "ProductPrice" DROP COLUMN "price";`, false);
run("different migration authorization", observed, false, "20260904120000_orders_operational_view");

const registryResult = spawnSync(process.execPath, [resolve(root, "scripts/production-schema-migrations.mjs"), migration], { cwd: root, encoding: "utf8" });
assert.equal(registryResult.status, 0, registryResult.stderr);
const registry = JSON.parse(registryResult.stdout);
assert.equal(registry.actualSha256, registry.sha256, "registered immutable checksum must match migration bytes");
assert.equal(readFileSync(resolve(root, registry.path), "utf8").trim().endsWith('ON "ProductPrice"("source", "availabilityState");'), true);
console.log("PRODUCT_PRICE_AUTHORITY_DIFF_FILTER=PASS");
