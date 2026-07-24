import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const sync = readFileSync(
  new URL("../services/ultraFv3SyncService.ts", import.meta.url),
  "utf8",
);
const routes = readFileSync(
  new URL("../routes/crudRoutes.ts", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL(
    "../../../../apps/web/src/components/settings/ErpIntegrationPanel.tsx",
    import.meta.url,
  ),
  "utf8",
);
const clientSelect = readFileSync(
  new URL(
    "../../../../apps/web/src/components/clients/ClientSearchSelect.tsx",
    import.meta.url,
  ),
  "utf8",
);
const investigate = readFileSync(
  new URL("./erpInvestigatePartner.ts", import.meta.url),
  "utf8",
);
const investigationService = readFileSync(
  new URL("../services/erpPartnerInvestigationService.ts", import.meta.url),
  "utf8",
);

assert.match(
  sync,
  /status: "failed" as "success" \| "partial" \| "failed"/,
  "all-sellers deve expor status success/partial/failed",
);
assert.match(
  sync,
  /emptyCount/,
  "all-sellers deve contabilizar vendedor com zero legítimo",
);
assert.match(
  sync,
  /reasonCode: skipped \? "LOCKED" : empty \? "EMPTY_SUCCESS" : "SUCCESS"/,
  "zero legítimo deve usar EMPTY_SUCCESS",
);
assert.match(
  sync,
  /reasonCode: \/auth\|login\|credencial/,
  "erros por vendedor devem ter reasonCode sanitizado",
);
assert.match(
  sync,
  /fetchUltraFv3PartnerRowsForSeller/,
  "sync por vendedor deve usar coletor com diagnóstico de paginação",
);
assert.match(
  sync,
  /repeatedPageDetected/,
  "paginação deve detectar página repetida",
);
assert.match(sync, /maxPages = 50/, "paginação deve limitar loops infinitos");
assert.match(
  sync,
  /pickUltraFv3PartnerCode/,
  "normalização de ERP Code deve ser reutilizável pelo modo investigação",
);
assert.match(
  sync,
  /ownerSeller: \{ connect: \{ id: ownerSellerId \} \}/,
  "troca de vendedor deve atualizar owner sem criar duplicado",
);
assert.match(
  sync,
  /same_erp_code_conflicting_document/,
  "ambiguidade não deve fazer merge automático",
);
assert.match(
  routes,
  /result\.status === "failed" \? 502 : result\.status === "partial" \? 207 : 200/,
  "HTTP deve distinguir falha total, parcial e sucesso",
);
assert.match(
  panel,
  /Sincronização parcial: \$\{processedCount\} clientes processados; \$\{errorCount \+ skippedCount\} vendedores com falha; \$\{emptyCount\} sem registros\./,
  "UI deve exibir toast parcial operacional",
);
assert.match(
  panel,
  /Sincronização concluída: \$\{processedCount\} clientes processados\./,
  "UI deve exibir sucesso total padronizado",
);
assert.match(
  panel,
  /Nenhum vendedor foi processado com sucesso/,
  "UI deve exibir falha total apenas quando status failed",
);
assert.match(
  clientSelect,
  /client\.code/,
  "busca da UI deve incluir código ERP",
);
assert.match(
  clientSelect,
  /client\.fantasyName/,
  "busca da UI deve incluir fantasia",
);
assert.match(
  routes,
  /\{ code: \{ contains: search, mode: "insensitive" \} \}/,
  "GET /clients deve pesquisar ERP Code",
);
assert.match(
  investigate,
  /investigateErpPartnerReadOnly/,
  "CLI deve chamar o mesmo serviço read-only usado pelo HTTP",
);
assert.match(
  investigationService,
  /READ_ONLY_SANITIZED/,
  "investigação 5050 deve ser read-only sanitizada",
);
assert.match(
  investigationService,
  /WOULD_CHANGE_OWNER/,
  "investigação deve simular troca de owner sem persistir",
);
assert.match(
  investigationService,
  /NOT_RETURNED_BY_ERP/,
  "investigação deve reportar quando ERP não retorna 5050",
);
assert.doesNotMatch(
  investigationService,
  /prisma\.(?:client|user|erpSyncRun|appConfig)\.(?:update|delete|create|upsert)/,
  "investigação não pode alterar dados",
);

assert.match(
  routes,
  /router\.get\("\/erp\/investigate\/:erpCode", authorize\("diretor", "gerente"\), runErpPartnerInvestigationHttp\)/,
  "endpoint GET /erp/investigate/:erpCode deve existir protegido",
);
assert.match(
  routes,
  /router\.post\("\/erp\/investigate", authorize\("diretor", "gerente"\), runErpPartnerInvestigationHttp\)/,
  "endpoint POST /erp/investigate deve existir protegido",
);
assert.match(
  routes,
  /env\.nodeEnv !== "production" \|\| process\.env\.FEATURE_ERP_INVESTIGATION === "true"/,
  "endpoint HTTP deve desaparecer em produção sem feature flag",
);
assert.match(
  routes,
  /investigateErpPartnerReadOnly\(\{ erpCode \}\)/,
  "endpoint HTTP deve chamar o mesmo serviço do CLI",
);

console.log("PR 18A.3 UltraFV3 partner sync smoke passed");
