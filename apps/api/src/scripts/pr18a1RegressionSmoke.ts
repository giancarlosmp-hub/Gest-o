import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const crud = readFileSync(new URL("../routes/crudRoutes.ts", import.meta.url), "utf8");
const agenda = readFileSync(new URL("../services/agendaIntelligenceService.ts", import.meta.url), "utf8");
const planning = readFileSync(new URL("../services/planningIntelligenceService.ts", import.meta.url), "utf8");
const scheduler = readFileSync(new URL("../jobs/erpSyncScheduler.ts", import.meta.url), "utf8");
const sync = readFileSync(new URL("../services/ultraFv3SyncService.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
const env = readFileSync(new URL("../config/env.ts", import.meta.url), "utf8");

const coolingIndex = crud.indexOf('router.get("/clients/alerts/cooling"');
const clientByIdIndex = crud.indexOf('router.get("/clients/:id"');
assert(coolingIndex >= 0, "cooling alerts route must exist");
assert(clientByIdIndex > coolingIndex, "cooling route must be registered before /clients/:id");
assert.match(crud, /isArchived:\s*false/, "client list/cooling must exclude archived clients");
assert.match(agenda, /firstSeller/, "agenda intelligence must allow director/manager without sellerId via safe active-seller default");
assert.match(planning, /português do Brasil/, "weekly planning AI prompt must force Brazilian Portuguese");
assert.match(scheduler, /authMode: "seller_reference"/, "scheduler diagnostics must support seller credential fallback");
assert.match(scheduler, /nextAutomaticRunAt = calculateNextAutomaticRunAt\(finishedAt\)/, "scheduler must recalculate next run after failure/success");
assert.match(sync, /syncPartnersForAllConfiguredSellers/, "all-sellers partner sync must exist");
assert.match(sync, /sellerChangedCount/, "seller change diagnostics must be preserved");
assert.match(sync, /LEGACY_ARCHIVED_DUPLICATE_PREFIX/, "legacy archived duplicate prefix must be preserved");
assert.match(sync, /NOT: legacyArchivedDuplicateNameWhere/, "legacy archived duplicates must not block matching");
assert.match(app, /\["\/health\/version", "\/api\/health\/version"\]/, "version endpoint must be exposed with and without /api prefix");
assert.match(app, /commit: env\.appCommit\.length > 12/, "version endpoint must expose a short build-provided commit without secrets");
assert.match(env, /process\.env\.APP_COMMIT/, "build commit must come from deployment environment variables");
console.log("PR 18A.1 regression smoke passed");
