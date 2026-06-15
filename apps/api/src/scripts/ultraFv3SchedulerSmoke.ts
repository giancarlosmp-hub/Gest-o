import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const repoRoot = resolve(import.meta.dirname, "../../..");
const scheduler = readFileSync(resolve(repoRoot, "api/src/jobs/erpSyncScheduler.ts"), "utf8");
const routes = readFileSync(resolve(repoRoot, "api/src/routes/crudRoutes.ts"), "utf8");
const panel = readFileSync(resolve(repoRoot, "web/src/components/settings/ErpIntegrationPanel.tsx"), "utf8");

assert.match(scheduler, /America\/Sao_Paulo/, "Scheduler deve usar timezone America/Sao_Paulo");
assert.match(scheduler, /AUTOMATIC_SYNC_START_HOUR = 7/, "Janela deve iniciar às 07:00 America/Sao_Paulo");
assert.match(scheduler, /AUTOMATIC_SYNC_END_HOUR = 19/, "Janela deve encerrar às 19:00 America/Sao_Paulo");
assert.match(scheduler, /hour >= AUTOMATIC_SYNC_START_HOUR && hour < AUTOMATIC_SYNC_END_HOUR/, "Cálculo de janela deve incluir 07:00 e excluir 19:00");

assert.match(scheduler, /\[ultrafv3 scheduler\] initialized/, "Scheduler deve registrar inicialização no boot");
assert.match(scheduler, /\[ultrafv3 scheduler\] tick/, "Scheduler deve registrar tick");
assert.match(scheduler, /\[ultrafv3 scheduler\] skipped/, "Scheduler deve registrar skip");
assert.match(scheduler, /\[ultrafv3 scheduler\] run started/, "Scheduler deve registrar início de execução");
assert.match(scheduler, /\[ultrafv3 scheduler\] run finished/, "Scheduler deve registrar fim de execução");
assert.match(scheduler, /trigger:\s*ErpSyncTrigger\.scheduler/, "Execução real deve persistir ErpSyncRun com trigger scheduler");
assert.match(scheduler, /authMode:\s*"seller_reference"/, "Scheduler deve aceitar modo por vendedor sem credencial global");
assert.match(scheduler, /saveAutomaticSyncPersistedConfig\(\{ enabled: false \}\)/, "Ausência de AppConfig deve criar default seguro enabled=false");
assert.match(routes, /\/erp\/ultrafv3\/scheduler\/status/, "Backend deve expor status real do scheduler");
assert.match(panel, /lastRealSchedulerSuccessRecent/, "UI deve diferenciar sucesso scheduler real recente de histórico antigo");
assert.doesNotMatch(panel, /Executada com sucesso[\s\S]*Próxima execução prevista[\s\S]*statusLabel \|\|/, "UI não deve inferir sucesso visual sem estado real do backend");

console.log("UltraFV3 scheduler smoke passed");
