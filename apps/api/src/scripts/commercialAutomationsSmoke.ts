import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
const service = readFileSync(resolve(repoRoot, "api/src/services/commercialAutomationsService.ts"), "utf8");
const routes = readFileSync(resolve(repoRoot, "api/src/routes/crudRoutes.ts"), "utf8");
const scheduler = readFileSync(resolve(repoRoot, "api/src/jobs/commercialAutomationsScheduler.ts"), "utf8");
const server = readFileSync(resolve(repoRoot, "api/src/server.ts"), "utf8");

assert.match(service, /WORKFLOW_INACTIVE_CLIENT_ORIGIN = "workflow_cliente_sem_compra"/, "Origem do workflow deve ser registrada");
assert.match(service, /listPortfolioSegment\("semComprar"[\s\S]*entry\.status === "inativoRecente"/, "Elegibilidade deve ser inativo recente pela regra oficial da carteira");
assert.match(service, /ownerSeller\?\.isActive/, "Vendedor inativo deve ficar fora");
assert.match(service, /stage: \{ in: \[\.\.\.OPEN_OPPORTUNITY_STAGES\] \}/, "Cliente com oportunidade aberta deve ficar fora");
assert.match(service, /RECENT_AUTOMATION_DAYS = 90/, "Não deve recriar oportunidade da automação em 90 dias");
assert.match(service, /used >= dailyLimitPerSeller/, "Teto diário por vendedor deve ser respeitado");
assert.match(service, /title: `Reativação – \$\{client\.name\}`/, "Título deve ser Reativação – <cliente>");
assert.match(service, /value: 0,/, "Valor inicial deve ser 0");
assert.match(service, /workflow\.createActivity[\s\S]*tx\.activity\.create/, "Activity deve ser criada quando habilitada");
assert.match(service, /workflow\.createTimelineEvent[\s\S]*tx\.timelineEvent\.create/, "TimelineEvent deve ser criado quando habilitado");
assert.match(routes, /post\("\/commercial-automations\/run"[\s\S]*runCommercialAutomations\("manual"\)/, "Rota manual POST deve executar workflow");
assert.match(routes, /get\("\/commercial-automations\/history"[\s\S]*loadCommercialAutomationsHistory/, "Rota de histórico persistente deve existir");
assert.match(routes, /get\("\/commercial-automations\/simulation"[\s\S]*simulateCommercialAutomations/, "Rota de simulação deve existir");
assert.match(scheduler, /commercial automations scheduler/, "Scheduler comercial separado deve existir");
assert.match(server, /startCommercialAutomationsScheduler/, "Servidor deve iniciar scheduler comercial separado");

console.log("Commercial automations smoke passed");
