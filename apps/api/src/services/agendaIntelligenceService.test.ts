import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(
  new URL("./agendaIntelligenceService.ts", import.meta.url),
  "utf8",
);
const geoSource = readFileSync(
  new URL("./geoHeuristics.ts", import.meta.url),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../routes/crudRoutes.ts", import.meta.url),
  "utf8",
);
const webSource = readFileSync(
  new URL(
    "../../../web/src/components/agenda/AgendaIntelligencePanel.tsx",
    import.meta.url,
  ),
  "utf8",
);
const ultraSource = readFileSync(
  new URL("./ultraFv3SyncService.ts", import.meta.url),
  "utf8",
);

test("endpoint, permissões e escopo somente leitura", () => {
  assert.match(routeSource, /\/ai\/agenda-intelligence\/day/);
  assert.match(source, /viewerRole === "vendedor"/);
  assert.match(source, /role: "vendedor", isActive: true/);
  assert.doesNotMatch(
    source,
    /prisma\.[a-zA-Z]+\.(create|update|delete|createMany|updateMany|deleteMany)/,
  );
});

test("classifica fixos, concluídos e conflitos sem mover automaticamente", () => {
  assert.match(source, /fixedStartTime/);
  assert.match(source, /realizado|completed|cancelled|cancelado|em_andamento/);
  assert.match(source, /time_overlap/);
  assert.match(source, /over_capacity/);
  assert.match(source, /fixed_commitment|Compromisso fixo/);
});

test("agrupa cidade\/território, usa Haversine só com coordenadas válidas e não inventa km", () => {
  assert.match(source, /sellerTerritoryCity/);
  assert.match(source, /localeCompare\(b\.city/);
  assert.match(source, /calculateHaversineLineDistanceKm/);
  assert.match(geoSource, /hasValidCoordinates/);
  assert.match(source, /estimatedDistanceKm: distance/);
  assert.match(source, /return null/);
  assert.match(webSource, /Haversine é\s+linha reta/);
});

test("prioridade oficial, inserções, fallback IA, cache e date-only", () => {
  assert.match(source, /calculateCommercialPriority/);
  assert.doesNotMatch(source, /COMMERCIAL_PRIORITY_WEIGHTS\s*=/);
  assert.match(
    source,
    /planningIntelligenceService\.generateWeeklyCommercialPlan/,
  );
  assert.match(source, /maxSuggestedInsertions/);
  assert.match(source, /scheduled\.has/);
  assert.match(source, /parseAiJsonObject/);
  assert.match(source, /source: "deterministic"/);
  assert.match(source, /cacheTtlMs: 15 \* 60 \* 1000/);
  assert.match(source, /Date\.UTC\(year, month - 1, day, 3/);
  assert.doesNotMatch(
    source,
    /new Date\("YYYY-MM-DD"\)|toISOString\(\)\.slice\(0, 10\)/,
  );
});

test("frontend usa painel reutilizável com accordion/cards mobile e sem aplicar ordem", () => {
  assert.match(webSource, /export default function AgendaIntelligencePanel/);
  assert.match(webSource, /<details/);
  assert.match(webSource, /Ordem sugerida/);
  assert.match(webSource, /Atualizar análise/);
  assert.doesNotMatch(webSource, /Aplicar ordem|drag-and-drop/);
});

test("UltraFV3 permanece fora do fluxo", () => {
  assert.doesNotMatch(source, /UltraFV3|ultraFv3/i);
  assert.match(ultraSource, /ultraFv3/i);
});
