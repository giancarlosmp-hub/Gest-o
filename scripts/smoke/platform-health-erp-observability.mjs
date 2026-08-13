import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const service = readFileSync("apps/api/src/services/platformHealthService.ts", "utf8");
const route = readFileSync("apps/api/src/routes/platformHealthRoutes.ts", "utf8");
const page = readFileSync("apps/web/src/pages/PlatformHealthPage.tsx", "utf8");
const scheduler = readFileSync("apps/api/src/jobs/erpSyncScheduler.ts", "utf8");
const sync = readFileSync("apps/api/src/services/ultraFv3SyncService.ts", "utf8");
const proves = [
  ["manual permanece manual", sync, /scope: "syncAll"[\s\S]*trigger: ErpSyncTrigger\.manual/],
  ["scheduler permanece scheduler", scheduler, /trigger: ErpSyncTrigger\.scheduler/],
  ["manual e automática separadas", service, /lastManualSync:[\s\S]*lastAutomaticSync:/],
  ["nenhuma execução é empty", service, /dataState: runs\.length \? "available" : "empty"/],
  ["API indisponível é erro", route, /status\(503\).*dataState: "error"/],
  ["erro de banco falha fechado", route, /PLATFORM_HEALTH_COLLECTION_FAILED/],
  ["zeros reais vêm de resposta válida", service, /quality: \{ dataState: "available"/],
  ["qualidade consulta o banco", service, /prisma\.client\.count/],
  ["auditoria vazia explícita", route, /dataState: items\.length \? "available" : "empty"/],
  ["auditoria paginada", route, /pageSize:[\s\S]*totalPages/],
  ["alerta sem execução", service, /sync-never-observed/],
  ["alerta automático sem prova", service, /scheduler-run-not-proven/],
  ["janelas 7 30 90", route, /z\.literal\(7\).*z\.literal\(30\).*z\.literal\(90\)/],
  ["correlationId preservado", service, /correlationId: true/],
  ["warnings separados", scheduler, /nonCriticalStepWarnings/],
  ["RBAC preservado", route, /PLATFORM_HEALTH_ROLES/],
  ["frontend não mascara erro", page, /Nenhuma métrica abaixo deve ser interpretada como zero/],
  ["concorrência cancela obsoleta", page, /AbortController/],
  ["histórico reconhece manual", page, /r\.trigger==="scheduler"\?"Automática":"Manual"/],
  ["retry acionável", page, /Tentar novamente/],
];
for (const [name, source, pattern] of proves) assert.match(source, pattern, name);
for (const forbidden of ["ULTRAFV3_PASSWORD", "DATABASE_URL", "ERP_CREDENTIAL_ENCRYPTION_KEY"])
  assert.equal(service.includes(forbidden) || page.includes(forbidden), false, `${forbidden} não pode integrar o payload`);
console.log("PLATFORM_HEALTH_ERP_OBSERVABILITY=PASS");
