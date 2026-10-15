import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { brazilMonthKey, brazilTodayKey } from "../src/lib/brazilDate";

// 29/07 às 23:30 em Brasília já é 30/07 em UTC; o filtro precisa continuar em 29/07.
assert.equal(brazilTodayKey(new Date("2026-07-30T02:30:00.000Z")), "2026-07-29");
assert.equal(brazilTodayKey(new Date("2026-07-30T03:00:00.000Z")), "2026-07-30");
assert.equal(brazilMonthKey(new Date("2026-08-01T02:30:00.000Z")), "2026-07", "31/07 23:30 em Brasília ainda é julho");
assert.equal(brazilMonthKey(new Date("2026-08-01T03:00:00.000Z")), "2026-08");

// Mês padrão dos filtros não pode voltar a ser calculado em UTC.
const sources = [
  ...readdirSync(new URL("../src/pages/", import.meta.url)).filter((file) => file.endsWith(".tsx")).map((file) => `../src/pages/${file}`),
  "../src/lib/sellerMetrics.ts",
];
for (const source of sources) {
  assert.doesNotMatch(readFileSync(new URL(source, import.meta.url), "utf8"), /new Date\(\)\.toISOString\(\)\.slice\(0, 7\)/, `${source} deve usar brazilMonthKey()`);
}
for (const source of ["../src/pages/HomePage.tsx", "../src/pages/DashboardPage.tsx"]) {
  assert.doesNotMatch(readFileSync(new URL(source, import.meta.url), "utf8"), /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/, `${source} deve usar brazilTodayKey() nos filtros`);
}

console.log("brazilDate tests passed");
