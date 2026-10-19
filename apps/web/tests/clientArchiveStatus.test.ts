import assert from "node:assert/strict";
import fs from "node:fs";
import {
  canManageArchivedClients,
  canReactivateClient,
  clientArchiveBadgeLabel,
  isPortfolioCleanupArchivedClient,
} from "../src/lib/clientArchiveStatus.js";

// Dados fictícios: filtro "Mostrar arquivados", selo e botão "Reativar cliente".
const cleanup = { isArchived: true, archiveReason: "PORTFOLIO_CLEANUP:2026-10-01T12:00:00.000Z" };
const merged = { isArchived: true, archiveReason: "MERGED_INTO:cliente-principal" };
const legacy = { isArchived: true, archiveReason: "legacy_duplicate_cleanup" };
const manualMerge = { isArchived: true, archiveReason: "manual_duplicate_merge" };
const active = { isArchived: false, archiveReason: null };

assert.equal(canManageArchivedClients("gerente"), true);
assert.equal(canManageArchivedClients("diretor"), true);
assert.equal(canManageArchivedClients("vendedor"), false);
assert.equal(canManageArchivedClients(undefined), false);

assert.equal(clientArchiveBadgeLabel(cleanup), "Arquivado (limpeza da carteira)");
for (const duplicate of [merged, legacy, manualMerge]) assert.equal(clientArchiveBadgeLabel(duplicate), "Duplicado arquivado");
assert.equal(clientArchiveBadgeLabel(active), null);
assert.equal(clientArchiveBadgeLabel({ isArchived: false, archiveReason: "PORTFOLIO_CLEANUP:2026-10-01T12:00:00.000Z" }), null, "reativado não tem selo");

assert.equal(isPortfolioCleanupArchivedClient(cleanup), true);
assert.equal(canReactivateClient("gerente", cleanup), true);
assert.equal(canReactivateClient("diretor", cleanup), true);
assert.equal(canReactivateClient("vendedor", cleanup), false, "vendedor não vê o botão");
for (const duplicate of [merged, legacy, manualMerge, active]) {
  assert.equal(canReactivateClient("gerente", duplicate), false, "duplicado ou ativo não tem botão");
}

// A lista só mostra o filtro e só envia includeArchived quando o papel permite.
const list = fs.readFileSync(new URL("../src/pages/CrudSimplePage.tsx", import.meta.url), "utf8");
assert.match(list, /const canShowArchived = isClientsPage && canManageArchivedClients\(user\?\.role\);/);
assert.match(list, /\{canShowArchived \? \(\s*<label[\s\S]*?Mostrar arquivados\s*<\/label>\s*\) : null\}/);
assert.match(list, /includeArchived: canShowArchived && showArchived/);
assert.equal(list.match(/Mostrar arquivados/g)?.length, 1, "um único filtro, dentro do bloco condicionado");

// O detalhe só mostra o botão quando canReactivateClient permite.
const details = fs.readFileSync(new URL("../src/pages/ClientDetailsPage.tsx", import.meta.url), "utf8");
assert.match(details, /const showReactivateButton = canReactivateClient\(user\?\.role, client\);/);
assert.match(details, /\{showReactivateButton \? \(\s*<button[\s\S]*?Reativar cliente[\s\S]*?<\/button>\s*\) : null\}/);
assert.match(details, /window\.confirm\(/, "reativação pede confirmação");

console.log("CLIENT_ARCHIVE_STATUS=PASS");
