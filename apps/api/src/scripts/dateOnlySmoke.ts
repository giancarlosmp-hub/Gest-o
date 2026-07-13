import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const formatters = readFileSync(resolve(repoRoot, "web/src/lib/formatters.ts"), "utf8");
const opportunitiesPage = readFileSync(resolve(repoRoot, "web/src/pages/OpportunitiesPage.tsx"), "utf8");
const crudRoutes = readFileSync(resolve(repoRoot, "api/src/routes/crudRoutes.ts"), "utf8");

assert.match(formatters, /dateOnly[\s\S]*\$\{dateOnly\[3\]\}\/\$\{dateOnly\[2\]\}\/\$\{dateOnly\[1\]\}/, "formatDateBR deve formatar date-only/ISO pelo componente YYYY-MM-DD sem deslocar timezone");
assert.match(opportunitiesPage, /function toDateInput[\s\S]*dateOnly[\s\S]*return dateOnly\[1\]/, "input date deve reaproveitar YYYY-MM-DD sem new Date ingênuo");
assert.match(opportunitiesPage, /function toDayStart[\s\S]*new Date\(Number\(dateOnly\[1\]\), Number\(dateOnly\[2\]\) - 1, Number\(dateOnly\[3\]\)\)/, "comparações de dia devem parsear date-only como data local");
assert.match(opportunitiesPage, /Data de entrada — de/, "Filtro inicial deve identificar Data de entrada — de");
assert.match(opportunitiesPage, /Data de entrada — até/, "Filtro final deve identificar Data de entrada — até");
assert.match(crudRoutes, /whereFilters\.push\(\{ proposalDate: params\.dateRangeWhere \}\)/, "Filtros dateFrom/dateTo devem continuar aplicados ao campo proposalDate/Data de entrada");

console.log("Date-only opportunity smoke passed");
