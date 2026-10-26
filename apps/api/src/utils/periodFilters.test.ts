import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { brazilDayKeyOf, monthDayBounds, shiftDayKey } from "./dateRange.js";
import { closedOpportunityPeriodWhere, opportunityPeriodWhere } from "./periodFilters.js";

// Avaliador mínimo do subconjunto de where do Prisma usado pelos filtros de período.
type Row = Record<string, Date | null>;
const matches = (row: Row, where: any): boolean => Object.entries(where).every(([key, condition]: [string, any]) => {
  if (key === "OR") return condition.some((branch: any) => matches(row, branch));
  const value = row[key] ?? null;
  if (condition === null) return value === null;
  if (value === null) return false;
  const time = value.getTime();
  return (!condition.gte || time >= condition.gte.getTime())
    && (!condition.lt || time < condition.lt.getTime())
    && (!condition.lte || time <= condition.lte.getTime());
});
const at = (iso: string) => new Date(iso);

// Oportunidades: "Data de entrada" de 29/07 é gravada como meia-noite UTC.
const entry29 = { proposalDate: at("2026-07-29T00:00:00.000Z") };
assert.equal(matches(entry29, opportunityPeriodWhere("open", "2026-07-29", "2026-07-29")), true, "29/07 até 29/07 traz a entrada de 29/07");
assert.equal(matches(entry29, opportunityPeriodWhere("open", "2026-07-28", "2026-07-29")), true);
assert.equal(matches(entry29, opportunityPeriodWhere("open", "2026-07-28", "2026-07-28")), false);
assert.equal(matches(entry29, opportunityPeriodWhere("open", "2026-07-30", "2026-07-30")), false);

// Encerradas: closedAt é instante (dia de Brasília); sem closedAt vale a previsão (dia de calendário).
const closed2330 = { closedAt: at("2026-07-30T02:30:00.000Z"), expectedCloseDate: at("2026-08-15T00:00:00.000Z") }; // 29/07 23:30 BRT
const closed2200Day28 = { closedAt: at("2026-07-29T01:00:00.000Z"), expectedCloseDate: at("2026-07-29T00:00:00.000Z") }; // 28/07 22:00 BRT
const expected29 = { closedAt: null, expectedCloseDate: at("2026-07-29T00:00:00.000Z") };
assert.equal(matches(closed2330, opportunityPeriodWhere("closed", "2026-07-29", "2026-07-29")), true, "fechada às 23:30 de 29/07 entra em 29/07");
assert.equal(matches(closed2200Day28, opportunityPeriodWhere("closed", "2026-07-29", "2026-07-29")), false, "fechada às 22:00 de 28/07 não entra em 29/07");
assert.equal(matches(expected29, opportunityPeriodWhere("closed", "2026-07-29", "2026-07-29")), true, "sem closedAt, previsão de 29/07 entra em 29/07");

// Mês (dashboard e relatórios mensais): julho em dias de Brasília.
const july = monthDayBounds("2026-07")!;
assert.deepEqual(july, { from: "2026-07-01", to: "2026-07-31" });
const julyWon = closedOpportunityPeriodWhere(july.from, july.to);
assert.equal(matches({ closedAt: at("2026-08-01T02:30:00.000Z") }, julyWon), true, "31/07 23:30 BRT é julho");
assert.equal(matches({ closedAt: at("2026-07-01T02:00:00.000Z") }, julyWon), false, "30/06 23:00 BRT é junho");
assert.equal(matches({ closedAt: null, expectedCloseDate: at("2026-07-01T00:00:00.000Z") }, julyWon), true, "previsão de 01/07 é julho");
assert.equal(matches({ closedAt: null, expectedCloseDate: at("2026-08-01T00:00:00.000Z") }, julyWon), false, "previsão de 01/08 não é julho");

// Utilitários de dia/mês.
assert.equal(brazilDayKeyOf(at("2026-07-30T02:59:59.999Z")), "2026-07-29");
assert.equal(brazilDayKeyOf(at("2026-07-30T03:00:00.000Z")), "2026-07-30");
assert.equal(shiftDayKey("2026-07-31", 1), "2026-08-01");
assert.equal(shiftDayKey("2026-03-01", -89), "2025-12-02");
assert.deepEqual(monthDayBounds("2028-02"), { from: "2028-02-01", to: "2028-02-29" });
assert.equal(monthDayBounds("2026-13"), null);
assert.equal(monthDayBounds("2026-7"), null);

// As rotas precisam usar esses filtros; voltar ao recorte antigo deve quebrar este teste.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const orderRoutes = read("../routes/orderRoutes.ts");
assert.match(orderRoutes, /where\.createdAt = brazilDayRange\(q\.from, q\.to\)!/, "Pedidos filtram createdAt por dia de Brasília");
assert.doesNotMatch(orderRoutes, /(from|to): z\.coerce\.date\(\)/, "Pedidos não podem converter a data para meia-noite UTC");

const healthRoutes = read("../routes/platformHealthRoutes.ts");
assert.match(healthRoutes, /createdAt: brazilDayRange\(q\.from, q\.to\)!/, "Auditoria da Saúde filtra por dia de Brasília");
assert.doesNotMatch(healthRoutes, /(from|to): z\.coerce\.date\(\)/);

const crudRoutes = read("../routes/crudRoutes.ts");
assert.match(crudRoutes, /whereFilters\.push\(opportunityPeriodWhere\(params\.status, params\.period\.from, params\.period\.to\)\)/, "Oportunidades e Relatórios usam o filtro de período");
assert.doesNotMatch(crudRoutes, /buildWonOpportunityDateRangeFilter/, "ganhos não podem voltar ao recorte único de start/end");
assert.ok((crudRoutes.match(/closedOpportunityPeriodWhere\(/g) || []).length >= 5, "score mensal, score comercial, consistência e destaques semanais usam o recorte de ganhos");
assert.match(crudRoutes, /createdAt: brazilDayRange\(period\.from, period\.to\)!/, "contagem mensal de atividades usa dias de Brasília");
assert.match(crudRoutes, /\{ sentAt: monthInstantRange \}/, "cobertura de territórios usa dias de Brasília");
assert.match(crudRoutes, /loadAgendaDisciplineBySeller\(monthInstantRange,/, "score comercial usa dias de Brasília para a agenda");

const dashboardRoutes = read("../routes/dashboardRoutes.ts");
assert.doesNotMatch(dashboardRoutes, /buildWonDateRangeFilter|getMonthRange\(/, "dashboard não pode voltar ao recorte único de start/end");
assert.doesNotMatch(dashboardRoutes, /toISOString\(\)\.slice\(0, 7\)/, "mês padrão do dashboard é o de Brasília");
assert.doesNotMatch(dashboardRoutes, /expectedCloseDate\)\.getDate\(\)/, "série diária agrupa pelo mesmo dia usado no filtro");
assert.ok((dashboardRoutes.match(/closedOpportunityPeriodWhere\(/g) || []).length >= 4);
assert.match(read("../services/clientAbcCurve.ts"), /closedOpportunityPeriodWhere\(/, "curva ABC do dashboard usa o recorte de ganhos");

console.log("periodFilters tests passed");
