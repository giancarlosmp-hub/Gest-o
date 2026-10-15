import assert from "node:assert/strict";
import { brazilDayRange, calendarDayRange, type DayRange } from "./dateRange.js";

const inRange = (value: string, range: DayRange | null) => {
  assert.ok(range);
  const time = new Date(value).getTime();
  return (!range.gte || time >= range.gte.getTime())
    && (!range.lt || time < range.lt.getTime())
    && (!range.lte || time <= range.lte.getTime());
};

// Oportunidades: proposalDate de 29/07 é gravado como meia-noite UTC.
const proposal = "2026-07-29T00:00:00.000Z";
assert.equal(inRange(proposal, calendarDayRange("2026-07-29", "2026-07-29")), true, "29/07 até 29/07 encontra a entrada de 29/07");
assert.equal(inRange(proposal, calendarDayRange("2026-07-28", "2026-07-29")), true);
assert.equal(inRange(proposal, calendarDayRange("2026-07-28", "2026-07-28")), false, "28/07 até 28/07 não traz a de 29/07");
assert.equal(inRange(proposal, calendarDayRange("2026-07-30", "2026-07-30")), false);

// Pedidos: createdAt é instante; 29/07 em Brasília vai de 03:00Z de 29/07 a 02:59:59.999Z de 30/07.
for (const createdAt of ["2026-07-29T03:00:00.000Z", "2026-07-29T15:00:00.000Z", "2026-07-30T02:59:59.999Z"]) {
  assert.equal(inRange(createdAt, brazilDayRange("2026-07-29", "2026-07-29")), true, `29/07 até 29/07 traz ${createdAt}`);
  assert.equal(inRange(createdAt, brazilDayRange("2026-07-27", "2026-07-29")), true, `27/07 até 29/07 traz ${createdAt}`);
}
assert.equal(inRange("2026-07-29T02:59:59.999Z", brazilDayRange("2026-07-29", "2026-07-29")), false, "28/07 23:59 em Brasília fica fora");
assert.equal(inRange("2026-07-30T03:00:00.000Z", brazilDayRange("2026-07-29", "2026-07-29")), false, "30/07 00:00 em Brasília fica fora");

// Limites abertos e entradas inválidas.
assert.deepEqual(brazilDayRange("2026-07-29"), { gte: new Date("2026-07-29T03:00:00.000Z") });
assert.deepEqual(brazilDayRange(undefined, "2026-07-29"), { lt: new Date("2026-07-30T03:00:00.000Z") });
assert.deepEqual(calendarDayRange("2026-12-31", "2026-12-31"), { gte: new Date("2026-12-31T00:00:00.000Z"), lt: new Date("2027-01-01T00:00:00.000Z") });
assert.equal(brazilDayRange("2026-02-30"), null);
assert.equal(calendarDayRange(undefined, "não-é-data"), null);
assert.deepEqual(brazilDayRange(undefined, undefined), {});

console.log("dateRange tests passed");
