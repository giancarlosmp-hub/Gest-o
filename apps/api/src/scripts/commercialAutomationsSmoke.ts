import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
const service = readFileSync(resolve(repoRoot, "api/src/services/commercialAutomationsService.ts"), "utf8");
const routes = readFileSync(resolve(repoRoot, "api/src/routes/crudRoutes.ts"), "utf8");
const scheduler = readFileSync(resolve(repoRoot, "api/src/jobs/commercialAutomationsScheduler.ts"), "utf8");
const server = readFileSync(resolve(repoRoot, "api/src/server.ts"), "utf8");

assert.match(service, /WORKFLOW_INACTIVE_CLIENT_ORIGIN = "workflow_cliente_sem_compra"/, "Origem do workflow deve ser registrada");
assert.match(service, /lastPurchaseDate[\s\S]*financialProfile[\s\S]*DATA_ULTFATURA/, "Deve usar Client.lastPurchaseDate com fallback DATA_ULTFATURA");
assert.match(service, /if \(client\.isArchived\)/, "Cliente arquivado deve ser ignorado");
assert.match(service, /if \(!client\.ownerSellerId\)/, "Cliente sem vendedor deve ser ignorado");
assert.match(service, /findFirst\([\s\S]*stage: \{ in: \[\.\.\.OPEN_OPPORTUNITY_STAGES\] \}[\s\S]*contains: WORKFLOW_INACTIVE_CLIENT_ORIGIN/, "Não deve duplicar oportunidade aberta do workflow");
assert.match(service, /Reativação comercial — cliente sem compra há \$\{workflow\.daysWithoutPurchase\} dias/, "Título deve conter dias configurados");
assert.match(service, /resolveOpportunityValue\(client\)/, "Valor inicial deve vir de última compra/ticket médio ou 0");
assert.match(service, /workflow\.createActivity[\s\S]*tx\.activity\.create/, "Activity deve ser criada quando habilitada");
assert.match(service, /workflow\.createTimelineEvent[\s\S]*tx\.timelineEvent\.create/, "TimelineEvent deve ser criado quando habilitado");
assert.match(service, /daysWithoutPurchase < workflow\.daysWithoutPurchase/, "Configuração 30/60/90 deve alterar elegibilidade");
assert.match(routes, /post\("\/commercial-automations\/run"[\s\S]*runCommercialAutomations\("manual"\)/, "Rota manual POST deve executar workflow");
assert.match(routes, /get\("\/commercial-automations\/history"[\s\S]*getCommercialAutomationsStatus/, "Rota de histórico/status deve existir");
assert.match(scheduler, /commercial automations scheduler/, "Scheduler comercial separado deve existir");
assert.match(server, /startCommercialAutomationsScheduler/, "Servidor deve iniciar scheduler comercial separado");

console.log("Commercial automations smoke passed");
