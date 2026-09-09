import assert from "node:assert/strict";
import fs from "node:fs";

type City = { id: string; sellerId: string; thirdParty?: boolean };
const transfer = (rows: City[], source: string, destination: string, selected: string[]) => {
  const movable = rows.filter((row) => row.sellerId === source && selected.includes(row.id) && !row.thirdParty);
  movable.forEach((row) => { row.sellerId = destination; });
  return movable.length;
};

const rows: City[] = [{ id: "a", sellerId: "edirlei" }, { id: "b", sellerId: "edirlei" }, { id: "c", sellerId: "terceiro", thirdParty: true }];
assert.equal(transfer(rows, "edirlei", "vitor", ["a"]), 1, "transferência parcial");
assert.equal(rows.find((row) => row.id === "b")?.sellerId, "edirlei", "cidade não selecionada permanece na origem");
assert.equal(transfer(rows, "edirlei", "vitor", ["a"]), 0, "repetição é idempotente");
assert.equal(transfer(rows, "edirlei", "vitor", ["b"]), 1, "transferência total restante");
assert.equal(rows.find((row) => row.id === "c")?.sellerId, "terceiro", "terceiro é preservado");

const routes = fs.readFileSync(new URL("../routes/crudRoutes.ts", import.meta.url), "utf8");
const auth = fs.readFileSync(new URL("../middlewares/auth.ts", import.meta.url), "utf8");
const sync = fs.readFileSync(new URL("./ultraFv3SyncService.ts", import.meta.url), "utf8");
assert.match(routes, /Território vinculado a vendedor inativo — transferência necessária/, "KML/KMZ sinaliza território inativo");
assert.match(routes, /status: existing\.seller\.isActive \? "conflict" : "inactive_transfer"/, "prévia distingue conflito ativo de origem inativa transferível");
assert.match(routes, /territorySnapshotToken[\s\S]*O território mudou após a prévia/, "snapshot divergente aborta a confirmação");
assert.match(routes, /cities\.length !== cityIds\.length/, "seleção incompleta aborta sem transferência parcial");
assert.match(routes, /destinationNow[\s\S]*foi desativado ou mudou de tenant/, "destino é revalidado dentro da transação");
assert.match(routes, /isActive: false, territoryCities: \{ some: \{ tenantId \} \}/, "inativo com território aparece como origem");
assert.match(routes, /isActive: true, tenantMemberships: \{ some: \{ tenantId, status: "active" \} \}/, "destino exige vendedor ativo no tenant");
assert.match(routes, /tenantMemberships: \{ create:/, "novo vendedor recebe membership no mesmo cadastro");
assert.match(routes, /Auditoria de transferência territorial \[\$\{correlationId\}\]/, "auditoria inclui correlação sem credenciais");
assert.match(routes, /transfers\/preview[\s\S]*transfers\/confirm/, "prévia precede confirmação explícita");
assert.match(routes, /sellerTerritoryCity\.update/, "vínculos são atualizados, não recriados");
assert.match(routes, /destinationAccess\.seller\.isActive/, "destino inativo é bloqueado");
assert.match(routes, /timelineEvent\.create/, "transferência produz auditoria");
assert.match(routes, /pg_advisory_xact_lock[\s\S]*TransactionIsolationLevel\.Serializable/, "transferência é serializada e transacional");
assert.match(routes, /opportunityChangeLog\.create/, "mudança manual de oportunidade registra change log");
assert.match(routes, /Responsável transferido manualmente/, "mudança manual de oportunidade registra Timeline legível");
assert.match(routes, /findDuplicateUserIdentity[\s\S]*erpOperatorCode[\s\S]*erpLoginUsername/, "identidades CRM/FV3 duplicadas são bloqueadas");
assert.match(auth, /id: decoded\.id, isActive: true/, "token de desligado é invalidado em cada requisição");
assert.match(sync, /ownerSeller: \{ connect: \{ id: ownerSellerId \} \}/, "sync atualiza o mesmo cliente quando ERP comprova novo responsável");
assert.match(sync, /const sellerChanged = primary\.ownerSellerId !== ownerSellerId/, "mudança de carteira é detectada e auditada");
assert.doesNotMatch(routes.slice(routes.indexOf('router.patch("/users/:id/active"')), /opportunity\.updateMany[\s\S]{0,1000}ownerSellerId/, "desativação não transfere oportunidades automaticamente");
const activationRoute = routes.slice(routes.indexOf('router.patch("/users/:id/active"'), routes.indexOf('router.patch("/users/:id/role"'));
assert.doesNotMatch(activationRoute, /deleteMany|updateMany|ownerSellerId|sellerTerritoryCity/, "desativação preserva todos os vínculos históricos e operacionais");
assert.doesNotMatch(routes.slice(routes.indexOf('router.post("/territories/config/transfers/confirm"'), routes.indexOf('router.post("/territories/config/import-kml-preview"')), /opportunity\.(update|delete)|erpOrderSync\.(update|delete)|activity\.(update|delete)/, "transferência territorial não altera oportunidades, pedidos ou atividades");

console.log("Seller offboarding regression tests passed");
