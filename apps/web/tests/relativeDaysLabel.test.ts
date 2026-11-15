import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// "hoje"/"ontem"/"há N dias" (packages/shared relativeDays.ts) pelo calendário de Brasília, e as telas que
// mostravam "há N dia(s)" usando a mesma função. Só datas fictícias.
const { brazilCalendarDaysBetween, relativeDaysLabel, relativeDaysSinceLabel } = await import("@salesforce-pro/shared");

assert.equal(relativeDaysLabel(0), "hoje");
assert.equal(relativeDaysLabel(1), "ontem");
assert.equal(relativeDaysLabel(2), "há 2 dias");
assert.equal(relativeDaysLabel(31), "há 31 dias");
assert.equal(relativeDaysLabel(-3), "hoje", "data futura conta como hoje");
assert.equal(relativeDaysLabel(Number.NaN), "hoje");

// Calendário de Brasília (UTC-3), não blocos de 24 h.
const now = new Date("2026-11-15T13:00:00.000Z"); // 10h de 15/11 em Brasília
assert.equal(relativeDaysSinceLabel(new Date("2026-11-15T03:00:00.000Z"), now), "hoje", "meia-noite de 15/11 em Brasília");
assert.equal(relativeDaysSinceLabel(new Date("2026-11-15T02:59:59.999Z"), now), "ontem", "23h59 de 14/11 em Brasília");
assert.equal(relativeDaysSinceLabel(new Date("2026-11-14T21:00:00.000Z"), now), "ontem", "18h de ontem: menos de 24 h, mas é ontem");
assert.equal(relativeDaysSinceLabel(new Date("2026-11-13T23:00:00.000Z"), now), "há 2 dias", "20h de 13/11");
assert.equal(relativeDaysSinceLabel(new Date("2026-11-16T12:00:00.000Z"), now), "hoje", "futuro");
assert.equal(brazilCalendarDaysBetween(new Date("2026-11-15T02:00:00.000Z"), new Date("2026-11-15T04:00:00.000Z")), 1, "virada do dia em Brasília");
assert.equal(brazilCalendarDaysBetween(new Date("2026-11-14T04:00:00.000Z"), new Date("2026-11-15T02:00:00.000Z")), 0, "mesmo dia em Brasília");

// As telas usam a função compartilhada e não montam mais "há N dia(s)".
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const home = read("../src/pages/HomePage.tsx");
const opportunity = read("../src/pages/OpportunityDetailsPage.tsx");
const clients = read("../src/pages/CrudSimplePage.tsx");
assert.ok(home.includes("${getPipelinePriorityLabel(topPipelinePriority.priorityType)} ${relativeDaysLabel(topPipelinePriority.daysLate)}."));
assert.ok(home.includes("` · ${relativeDaysLabel(item.daysLate)}`"));
assert.ok(opportunity.includes("Atenção: oportunidade atrasada {relativeDaysLabel(item.daysOverdue)}."));
assert.ok(clients.includes("título mais antigo vencido {relativeDaysLabel(oldestOverdueDays)}"));
for (const source of [home, opportunity, clients]) {
  assert.doesNotMatch(source, /há \$?\{[^}]*\} dia/, "nenhum \"há N dia(s)\" montado na tela");
}

console.log("relativeDaysLabel.test.ts: ok");
