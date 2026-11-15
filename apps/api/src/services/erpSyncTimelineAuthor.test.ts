import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ERP_SYNC_TIMELINE_AUTHOR_LABEL,
  ERP_SYNC_TIMELINE_PATTERNS,
  isErpSyncTimelineEvent,
  timelineEventAuthorLabel,
} from "@salesforce-pro/shared";
import { SYSTEM_TIMELINE_PATTERNS } from "../scripts/simulateClientPortfolioCleanup.js";

// Contrato do autor "Sistema (sincronização ERP)" na linha do tempo. Dados fictícios.
const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const sync = source("./ultraFv3SyncService.ts");
const legacy = source("../scripts/erpFixLegacyDuplicates.ts");
const cleanupArchive = source("./portfolioCleanupArchive.ts");

// Cada texto gravado pela sincronização/saneamento do ERP existe no código e é reconhecido.
const erpSamples: [string, string, string][] = [
  [sync, "Cliente atualizado via UltraFV3. Vendedor alterado de ${", "Cliente atualizado via UltraFV3. Vendedor alterado de Vendedor Ficticio A para Vendedor Ficticio B. Oportunidades, atividades, autores e datas históricas foram preservados."],
  [sync, "fundido ao cliente principal via sincronização UltraFV3.", "Cadastro duplicado Cliente Ficticio (C-1) fundido ao cliente principal via sincronização UltraFV3. Histórico e relacionamentos preservados no cadastro principal."],
  [sync, "Duplicado arquivado automaticamente via UltraFV3: ${", "Duplicado arquivado automaticamente via UltraFV3: Cliente Ficticio. Motivo: cadastro fundido ao cliente principal."],
  [sync, '"Tenant comprovado e adotado por sincronização UltraFV3 autenticada.', "Tenant comprovado e adotado por sincronização UltraFV3 autenticada. Históricos, autoria e datas foram preservados."],
  [sync, '"Cliente reativado automaticamente pela sincronização UltraFV3 ', "Cliente reativado automaticamente pela sincronização UltraFV3 por corresponder ao cadastro principal do ERP."],
  [cleanupArchive, 'PORTFOLIO_CLEANUP_REACTIVATION_DESCRIPTION = "Cliente reativado automaticamente por nova compra no ERP";', "Cliente reativado automaticamente por nova compra no ERP"],
  [cleanupArchive, 'PORTFOLIO_CLEANUP_PARTNER_REACTIVATION_DESCRIPTION = "Cliente reativado automaticamente: o ERP voltou a indicar cliente da carteira";', "Cliente reativado automaticamente: o ERP voltou a indicar cliente da carteira"],
  [legacy, '"Duplicado legado arquivado automaticamente pelo saneamento UltraFV3.', "Duplicado legado arquivado automaticamente pelo saneamento UltraFV3."],
  [legacy, "Duplicado legado arquivado automaticamente pelo saneamento UltraFV3: ${", "Duplicado legado arquivado automaticamente pelo saneamento UltraFV3: Cliente Ficticio."],
  [legacy, "fundido ao cliente principal pelo saneamento UltraFV3.", "Cadastro legado duplicado Cliente Ficticio (C-2) fundido ao cliente principal pelo saneamento UltraFV3. Histórico, oportunidades, atividades e timeline foram preservados no cliente principal."],
];
for (const [file, fragment, sample] of erpSamples) {
  assert.ok(file.includes(fragment), `texto de evento do ERP mudou: ${fragment}`);
  assert.ok(isErpSyncTimelineEvent(sample), `não reconheceu evento do ERP: ${sample}`);
}
// Todo padrão casa com algum texto real (nenhum padrão sobrando).
for (const pattern of ERP_SYNC_TIMELINE_PATTERNS) {
  assert.ok(erpSamples.some(([, , sample]) => pattern.test(sample)), `padrão sem texto correspondente: ${pattern.source}`);
}

// A cópia autocontida do script de limpeza da carteira contém todos os padrões do ERP.
const scriptPatterns = new Set(SYSTEM_TIMELINE_PATTERNS.map((pattern) => pattern.source));
for (const pattern of ERP_SYNC_TIMELINE_PATTERNS) {
  assert.ok(scriptPatterns.has(pattern.source), `simulateClientPortfolioCleanup não tem o padrão: ${pattern.source}`);
}

// Usuários e outros sistemas continuam com o próprio autor.
for (const other of [
  "Comentario ficticio do vendedor",
  "Atividade criada: visita",
  "Cliente atualizado via UltraFV3 manualmente",
  "Nova mensagem recebida pelo WhatsApp oficial.",
  "Cliente arquivado pela limpeza da carteira (regra a)",
  "Observação: Cliente atualizado via UltraFV3. Vendedor alterado de A para B.",
]) {
  assert.equal(isErpSyncTimelineEvent(other), false, `evento tratado como sincronização do ERP: ${other}`);
}
assert.equal(isErpSyncTimelineEvent(null), false);
assert.equal(isErpSyncTimelineEvent(undefined), false);

assert.equal(ERP_SYNC_TIMELINE_AUTHOR_LABEL, "Sistema (sincronização ERP)");
assert.equal(timelineEventAuthorLabel({ description: erpSamples[0][2], ownerSeller: { name: "Vendedor Ficticio B" } }, "Sistema"), "Sistema (sincronização ERP)");
assert.equal(timelineEventAuthorLabel({ description: "Comentario ficticio", ownerSeller: { name: "Vendedor Ficticio B" } }, "Sistema"), "Vendedor Ficticio B");
assert.equal(timelineEventAuthorLabel({ description: "Comentario ficticio", ownerSeller: null }, "Usuário"), "Usuário");

console.log("ERP_SYNC_TIMELINE_AUTHOR=PASS texts_in_code=PASS script_copy=PASS humans_untouched=PASS");
