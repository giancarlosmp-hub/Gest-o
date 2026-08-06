#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync("scripts/control-plane-catalog.sql", "utf8");

const deleteCase = sql.match(/CASE con\.confdeltype[\s\S]*?END/)?.[0] ?? "";
const updateCase = sql.match(/CASE con\.confupdtype[\s\S]*?END/)?.[0] ?? "";

for (const [code, label] of [["a", "NO ACTION"], ["r", "RESTRICT"], ["c", "CASCADE"], ["n", "SET NULL"], ["d", "SET DEFAULT"]]) {
  assert.match(deleteCase, new RegExp(`WHEN '${code}'::"char" THEN '${label}'::text`));
  assert.match(updateCase, new RegExp(`WHEN '${code}'::"char" THEN '${label}'::text`));
}

assert.match(deleteCase, /format\('UNKNOWN:%s', con\.confdeltype::text\)/);
assert.match(updateCase, /format\('UNKNOWN:%s', con\.confupdtype::text\)/);
assert.doesNotMatch(sql, /'UNKNOWN:'\s*\|\|\s*con\.confdeltype(?!::text)/);
assert.doesNotMatch(sql, /'UNKNOWN:'\s*\|\|\s*con\.confupdtype(?!::text)/);
assert.doesNotMatch(sql, /'UNKNOWN:'\s*\|\|\s*con\.conf(?:del|upd)type\b/);

console.log("control-plane referential action SQL tests passed");
