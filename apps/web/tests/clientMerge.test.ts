import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ClientMergeComparison from "../src/components/clients/ClientMergeComparison";
import {
  buildMergePayload,
  formatMergeDate,
  MERGE_KEEP_WARNING,
  mergeComparisonRows,
  mergeConfirmMessage,
  mergeMatchLabel,
  type MergeClientSummary
} from "../src/lib/clientMerge";

// Dados fictícios: "Mesclar duplicado" na tela do cliente.
const counts = { opportunities: 2, timelineEvents: 5, activities: 1, contacts: 1, agendaEvents: 1, agendaStops: 2, communicationConversations: 0 };
const current: MergeClientSummary = {
  id: "atual", code: "83001", name: "Fazenda Ficticia", document: null, city: "Cidade Ficticia", state: "PR",
  lastPurchaseDate: "2026-08-15T15:00:00.000Z", createdAt: "2025-01-02T12:00:00.000Z", ownerSellerName: "Vendedor Ficticio", counts,
};
const candidate: MergeClientSummary = {
  id: "outro", code: null, name: "Fazenda Ficticia Nova", document: "303.404.505-60", city: "Cidade Ficticia", state: "PR",
  lastPurchaseDate: null, createdAt: "2026-09-01T12:00:00.000Z", ownerSellerName: null,
  counts: { ...counts, opportunities: 0, timelineEvents: 0, agendaStops: 0 }, matchReasons: ["documento", "nome e cidade"],
};

// Linhas lado a lado: código, documento, cidade, última compra e contagens.
const rows = Object.fromEntries(mergeComparisonRows(current));
assert.equal(rows["Código"], "83001");
assert.equal(rows["Documento"], "—");
assert.equal(rows["Cidade/UF"], "Cidade Ficticia/PR");
assert.equal(rows["Última compra"], "15/08/2026");
assert.equal(rows["Oportunidades"], "2");
assert.equal(rows["Linha do tempo"], "5");
assert.equal(rows["Agenda"], "3", "compromissos + paradas");
const candidateRows = Object.fromEntries(mergeComparisonRows(candidate));
assert.equal(candidateRows["Código"], "sem código");
assert.equal(candidateRows["Documento"], "303.404.505-60");
assert.equal(candidateRows["Última compra"], "—");
assert.equal(formatMergeDate("2026-01-01T02:00:00.000Z"), "31/12/2025", "data no fuso de Brasília");
assert.equal(mergeMatchLabel(candidate.matchReasons), "Mesmo documento · Mesmo nome e cidade/UF");
assert.equal(mergeMatchLabel(["busca"]), "Encontrado na busca");

// Payload: o escolhido fica; o outro é o duplicado. Sem escolha válida, não monta.
assert.deepEqual(buildMergePayload("atual", "outro", "atual"), { primaryClientId: "atual", duplicateClientIds: ["outro"] });
assert.deepEqual(buildMergePayload("atual", "outro", "outro", "  Cadastro repetido  "), { primaryClientId: "outro", duplicateClientIds: ["atual"], reason: "Cadastro repetido" });
assert.throws(() => buildMergePayload("atual", "outro", "terceiro"));
const confirmText = mergeConfirmMessage(current, candidate);
assert.match(confirmText, /Mesclar "Fazenda Ficticia Nova" \(código sem código\) em "Fazenda Ficticia" \(código 83001\)/);
assert.match(confirmText, /não pode ser reativado/);

// Render real da comparação (react-dom/server).
const html = renderToStaticMarkup(createElement(ClientMergeComparison, { current, candidate, keepId: "atual", onKeepChange: () => {} }));
assert.ok(html.includes(MERGE_KEEP_WARNING), "aviso de qual cadastro fica");
assert.equal(MERGE_KEEP_WARNING, "Fica o cadastro cujo código continua no ERP.");
assert.equal((html.match(/type="radio"/g) || []).length, 2, "uma escolha por cadastro");
assert.match(html, /checked="" value="atual"/, "o escolhido vem marcado");
assert.equal((html.match(/Fica este cadastro/g) || []).length, 1, "só o escolhido marcado");
for (const text of ["83001", "sem código", "303.404.505-60", "Cidade Ficticia/PR", "15/08/2026", "Oportunidades", "Linha do tempo", "Contatos", "Conversas"]) {
  assert.ok(html.includes(text), `mostra ${text}`);
}
const noChoice = renderToStaticMarkup(createElement(ClientMergeComparison, { current, candidate, keepId: null, onKeepChange: () => {} }));
assert.doesNotMatch(noChoice, /checked=""/, "sem escolha pré-marcada");

// Página do cliente: botão só para gerente/diretor em cadastro ativo; diálogo com sugestões e busca.
const page = readFileSync(new URL("../src/pages/ClientDetailsPage.tsx", import.meta.url), "utf8");
assert.match(page, /const showMergeButton = canManageArchivedClients\(user\?\.role\) && !client\.isArchived;/);
assert.match(page, /\{showMergeButton \? \(/);
assert.match(page, /<ClientMergeDuplicateDialog clientId=\{id\}/);
const dialog = readFileSync(new URL("../src/components/clients/ClientMergeDuplicateDialog.tsx", import.meta.url), "utf8");
assert.match(dialog, /api\.get<CandidatesResponse>\(`\/clients\/\$\{clientId\}\/merge-candidates`/, "sugestões e busca vêm da API");
assert.match(dialog, /api\.post\("\/clients\/diagnostics\/merge-duplicates", buildMergePayload\(/);
assert.match(dialog, /disabled=\{!selected \|\| !keepId \|\| merging\}/, "só mescla com candidato e escolha de qual fica");
assert.match(dialog, /window\.confirm\(mergeConfirmMessage\(/);

console.log("CLIENT_MERGE_WEB=PASS rows=PASS payload=PASS render=PASS page=PASS");
