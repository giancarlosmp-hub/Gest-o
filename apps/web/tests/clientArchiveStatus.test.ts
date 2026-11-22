import assert from "node:assert/strict";
import fs from "node:fs";
import {
  canArchiveClient,
  canManageArchivedClients,
  canReactivateClient,
  CLIENT_ARCHIVE_CONFIRM_MESSAGE,
  clientArchiveBadgeLabel,
  clientArchiveNotice,
  clientReactivateActionLabel,
  clientReactivateConfirmMessage,
  isManualArchivedClient,
  isPortfolioCleanupArchivedClient,
} from "../src/lib/clientArchiveStatus.js";

// Dados fictícios: filtro "Mostrar arquivados", selo, "Arquivar" e "Reativar cliente"/"Desarquivar".
const cleanup = { isArchived: true, archiveReason: "PORTFOLIO_CLEANUP:2026-10-01T12:00:00.000Z" };
const merged = { isArchived: true, archiveReason: "MERGED_INTO:cliente-principal" };
const legacy = { isArchived: true, archiveReason: "legacy_duplicate_cleanup" };
const manualMerge = { isArchived: true, archiveReason: "manual_duplicate_merge" };
const active = { isArchived: false, archiveReason: null };
const manual = { isArchived: true, archiveReason: "MANUAL:2026-11-20T12:00:00.000Z" };

assert.equal(canManageArchivedClients("gerente"), true);
assert.equal(canManageArchivedClients("diretor"), true);
assert.equal(canManageArchivedClients("vendedor"), false);
assert.equal(canManageArchivedClients(undefined), false);

assert.equal(clientArchiveBadgeLabel(cleanup), "Arquivado (limpeza da carteira)");
assert.equal(clientArchiveBadgeLabel(manual), "Arquivado manualmente");
assert.equal(isManualArchivedClient(manual), true);
assert.equal(isManualArchivedClient(manualMerge), false, "fusão manual antiga não é arquivo manual");
assert.equal(isManualArchivedClient({ isArchived: false, archiveReason: "MANUAL:2026-11-20T12:00:00.000Z" }), false, "desarquivado não conta");
assert.match(clientArchiveNotice(manual), /arquivado manualmente/);
assert.match(clientArchiveNotice(merged), /use o cliente principal/);
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
assert.equal(canReactivateClient("diretor", manual), true);
assert.equal(canReactivateClient("vendedor", manual), false);
assert.equal(clientReactivateActionLabel(manual), "Desarquivar");
assert.equal(clientReactivateActionLabel(cleanup), "Reativar cliente");
assert.match(clientReactivateConfirmMessage(manual), /^Desarquivar este cliente\?/);
assert.match(clientReactivateConfirmMessage(cleanup), /^Reativar este cliente\?/);

// "Arquivar": gerente e diretor, só cadastro ativo.
assert.equal(canArchiveClient("gerente", active), true);
assert.equal(canArchiveClient("diretor", active), true);
assert.equal(canArchiveClient("vendedor", active), false, "vendedor não arquiva");
for (const archived of [cleanup, manual, merged]) assert.equal(canArchiveClient("gerente", archived), false, "arquivado não arquiva de novo");
assert.match(CLIENT_ARCHIVE_CONFIRM_MESSAGE, /sem apagar o histórico/);

// A lista só mostra o filtro e só envia includeArchived quando o papel permite.
const list = fs.readFileSync(new URL("../src/pages/CrudSimplePage.tsx", import.meta.url), "utf8");
assert.match(list, /const canShowArchived = isClientsPage && canManageArchivedClients\(user\?\.role\);/);
assert.match(list, /\{canShowArchived \? \(\s*<label[\s\S]*?Mostrar arquivados\s*<\/label>\s*\) : null\}/);
assert.match(list, /includeArchived: canShowArchived && showArchived/);
assert.equal(list.match(/Mostrar arquivados/g)?.length, 1, "um único filtro, dentro do bloco condicionado");
// Menu "…" (mobile e desktop): "Arquivar" e "Desarquivar" só na lista de clientes e pelo papel, com confirmação.
assert.equal(list.match(/\{isClientsPage && canArchiveClient\(user\?\.role, it\) \? \(/g)?.length, 2, "Arquivar nos dois menus");
assert.equal(list.match(/\{isClientsPage && canReactivateClient\(user\?\.role, it\) \? \(/g)?.length, 2, "Desarquivar nos dois menus");
assert.match(list, /const onArchiveClient = async[\s\S]*?window\.confirm\(CLIENT_ARCHIVE_CONFIRM_MESSAGE\)[\s\S]*?api\.post\(`\/clients\/\$\{item\.id\}\/archive`\)/);
assert.match(list, /const onReactivateClient = async[\s\S]*?window\.confirm\(clientReactivateConfirmMessage\(item\)\)[\s\S]*?api\.post\(`\/clients\/\$\{item\.id\}\/reactivate`\)/);

// O detalhe só mostra o botão quando canReactivateClient permite.
const details = fs.readFileSync(new URL("../src/pages/ClientDetailsPage.tsx", import.meta.url), "utf8");
assert.match(details, /const showReactivateButton = canReactivateClient\(user\?\.role, client\);/);
assert.match(details, /\{showReactivateButton \? \(\s*<button[\s\S]*?\{reactivating \?[\s\S]*?reactivateLabel\}[\s\S]*?<\/button>\s*\) : null\}/);
assert.match(details, /window\.confirm\(clientReactivateConfirmMessage\(client\)\)/, "reativação pede confirmação");
// Ficha: "Arquivar" só quando canArchiveClient permite, com confirmação.
assert.match(details, /const showArchiveButton = canArchiveClient\(user\?\.role, client\);/);
assert.match(details, /\{showArchiveButton \? \(\s*<button[\s\S]*?Arquivar[\s\S]*?<\/button>\s*\) : null\}/);
assert.match(details, /window\.confirm\(CLIENT_ARCHIVE_CONFIRM_MESSAGE\)[\s\S]*?api\.post\(`\/clients\/\$\{id\}\/archive`\)/);

console.log("CLIENT_ARCHIVE_STATUS=PASS");
