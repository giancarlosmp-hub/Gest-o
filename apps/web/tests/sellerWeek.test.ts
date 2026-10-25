import assert from "node:assert/strict";

// Aparelho em outro fuso: os períodos continuam em dias de Brasília. Dados fictícios.
process.env.TZ = "Asia/Tokyo";

const { buildSellerWeekMetrics, sellerWeekRanges } = await import("../src/lib/sellerWeek");

// Quarta: segunda a quarta desta semana contra segunda a quarta da semana passada.
assert.deepEqual(sellerWeekRanges("2026-11-04"), {
  current: { from: "2026-11-02", to: "2026-11-04" },
  previous: { from: "2026-10-26", to: "2026-10-28" },
});
// Segunda: compara só a segunda.
assert.deepEqual(sellerWeekRanges("2026-11-09"), {
  current: { from: "2026-11-09", to: "2026-11-09" },
  previous: { from: "2026-11-02", to: "2026-11-02" },
});
// Domingo: a semana inteira contra a semana passada inteira.
assert.deepEqual(sellerWeekRanges("2026-11-08"), {
  current: { from: "2026-11-02", to: "2026-11-08" },
  previous: { from: "2026-10-26", to: "2026-11-01" },
});
// Virada de mês: segunda 30/11 a quarta 02/12 contra 23/11 a 25/11.
assert.deepEqual(sellerWeekRanges("2026-12-02"), {
  current: { from: "2026-11-30", to: "2026-12-02" },
  previous: { from: "2026-11-23", to: "2026-11-25" },
});

// Os números da disciplina são os da rota (regra planejado × concluído), sem recálculo no front.
const current = {
  discipline: { planned: 7, executed: 3, notDone: 1, unresolved: 2, upcoming: 1, executionRate: 60, punctualRate: 66.6667 },
  visitsDone: 3,
  visitGoal: 25,
};
const previous = {
  discipline: { planned: 2, executed: 1, notDone: 1, unresolved: 0, upcoming: 0, executionRate: 100, punctualRate: 100 },
  visitsDone: 1,
  visitGoal: 25,
};
const metrics = buildSellerWeekMetrics(current, previous);
const byKey = Object.fromEntries(metrics.map((metric) => [metric.key, metric]));

assert.deepEqual(metrics.map((metric) => metric.key), ["completed", "executionRate", "notDone", "unresolved", "punctualRate", "visits"]);
assert.equal(byKey.completed.value, "3/7");
assert.equal(byKey.completed.detail, "1 ainda a fazer");
assert.equal(byKey.completed.comparison, "vs. mesmo período da semana passada: 1/2");
assert.equal(byKey.completed.tone, "better");
assert.equal(byKey.executionRate.value, "60,0%");
assert.equal(byKey.executionRate.comparison, "vs. mesmo período da semana passada: 100,0% (−40,0 p.p.)");
assert.equal(byKey.executionRate.tone, "worse");
// Não realizado igual; sem conclusão subiu, e mais sem conclusão é pior.
assert.equal(byKey.notDone.comparison, "vs. mesmo período da semana passada: 1 (igual)");
assert.equal(byKey.notDone.tone, "same");
assert.equal(byKey.unresolved.comparison, "vs. mesmo período da semana passada: 0 (+2)");
assert.equal(byKey.unresolved.tone, "worse");
assert.equal(byKey.punctualRate.value, "66,7%");
assert.equal(byKey.visits.value, "3");
assert.equal(byKey.visits.detail, "Meta semanal: 25");
assert.equal(byKey.visits.comparison, "vs. mesmo período da semana passada: 1 (+2)");
assert.equal(byKey.visits.tone, "better");

// Sem nada planejado na semana (vendedor sem linha na rota): zeros, sem quebrar.
const empty = buildSellerWeekMetrics({ discipline: null, visitsDone: 0, visitGoal: null }, { discipline: null, visitsDone: 0, visitGoal: null });
assert.deepEqual(empty.map((metric) => metric.value), ["0/0", "0,0%", "0", "0", "0,0%", "0"]);
assert(empty.every((metric) => metric.tone === "same"));

// Nada de posição, medalha ou colega no bloco.
const text = JSON.stringify(metrics);
assert.doesNotMatch(text, /Posição|🥇|🥈|🥉|#\d|ranking/i);

console.log("SELLER_WEEK=PASS ranges=PASS metrics=PASS empty=PASS no_ranking=PASS");
