import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toPositiveInteger } from "../../config/env.js";
import { retentionCutoff, runWhatsAppMessagesMaintenance } from "./whatsappMessagesMaintenance.js";

// Limpeza das conversas gravadas (WhatsApp Fase B): fila vencida e retenção. Banco falso que registra os
// filtros; nenhuma linha real.

const calls: Array<{ model: string; where: any }> = [];
const db: any = {
  communicationConversation: { deleteMany: async ({ where }: any) => { calls.push({ model: "conversation", where }); return { count: 2 }; } },
  communicationMessage: { deleteMany: async ({ where }: any) => { calls.push({ model: "message", where }); return { count: 5 }; } }
};
const NOW = new Date("2026-11-07T15:00:00.000Z");

// 1) Contagens, nunca conteúdo.
assert.deepEqual(await runWhatsAppMessagesMaintenance(NOW, db, 24), {
  expiredUnlinkedConversations: 2,
  retentionMessages: 5,
  retentionConversations: 2,
  retentionMonths: 24
});

// 2) Fila vencida: só Evolution, sem cliente, não vinculada ou ambígua, com prazo vencido.
assert.deepEqual(calls[0], {
  model: "conversation",
  where: { provider: "evolution_whatsapp", clientId: null, linkStatus: { in: ["unlinked", "ambiguous"] }, unlinkedExpiresAt: { lte: NOW } }
});

// 3) Retenção de 24 meses: mensagens do Evolution mais antigas que o corte; a Meta não é tocada.
const cutoff = retentionCutoff(NOW, 24);
assert.equal(cutoff.toISOString(), "2024-11-07T15:00:00.000Z");
assert.deepEqual(calls[1], { model: "message", where: { provider: "evolution_whatsapp", providerTimestamp: { lt: cutoff } } });
assert.deepEqual(calls[2].where.provider, "evolution_whatsapp");
assert.deepEqual(calls[2].where.linkStatus, "linked");
assert.deepEqual(calls[2].where.messages, { none: {} }, "só conversa vinculada que ficou sem mensagem");
for (const call of calls) assert.equal(call.where.provider, "evolution_whatsapp");

// 4) Retenção inválida nunca vira "apagar tudo".
await assert.rejects(runWhatsAppMessagesMaintenance(NOW, db, 0), /whatsapp_retention_months_invalid/);
await assert.rejects(runWhatsAppMessagesMaintenance(NOW, db, Number.NaN), /whatsapp_retention_months_invalid/);
assert.equal(toPositiveInteger(undefined, 24), 24);
assert.equal(toPositiveInteger("", 24), 24, "vazio não vira 0");
assert.equal(toPositiveInteger("0", 24), 24);
assert.equal(toPositiveInteger("-3", 24), 24);
assert.equal(toPositiveInteger("12 meses", 24), 24);
assert.equal(toPositiveInteger("36", 24), 36);
assert.equal(toPositiveInteger("'18'", 24), 18);

// 5) O scheduler sobe no bootstrap de produção, depois do listen, como os outros.
const bootstrap = readFileSync(new URL("../../scripts/bootstrap.ts", import.meta.url), "utf8");
assert.match(bootstrap, /startWhatsAppMessagesScheduler\(\)/);
assert.ok(bootstrap.indexOf("app.listen") < bootstrap.lastIndexOf("startWhatsAppMessagesScheduler()"), "scheduler depois do listen");

console.log("whatsappMessagesMaintenance.test.ts: ok");
