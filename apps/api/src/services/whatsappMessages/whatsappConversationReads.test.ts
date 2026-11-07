import assert from "node:assert/strict";
import { CommunicationDirection } from "@prisma/client";
import { brazilDayKey, brazilDayStart, groupDayCards, toMessageView, type DayScanRow } from "./whatsappConversationReads.js";

// WhatsApp Fase B2: dia de Brasília, agrupamento dos cartões e visão da mensagem. Só dados fictícios.

// Dia de Brasília: 02:59 UTC ainda é o dia anterior; 03:00 UTC já é o dia.
assert.equal(brazilDayKey(new Date("2026-11-05T02:59:59.000Z")), "2026-11-04");
assert.equal(brazilDayKey(new Date("2026-11-05T03:00:00.000Z")), "2026-11-05");
assert.equal(brazilDayStart("2026-11-05")?.toISOString(), "2026-11-05T03:00:00.000Z");
for (const invalid of ["2026-02-30", "2026-11-5", "ontem", "", null, 20261105]) assert.equal(brazilDayStart(invalid), null);

const row = (conversationId: string, iso: string, direction: CommunicationDirection = CommunicationDirection.INBOUND): DayScanRow => ({ conversationId, direction, providerTimestamp: new Date(iso) });
const rows = [
  row("conv-a", "2026-11-06T15:00:00.000Z", CommunicationDirection.OUTBOUND),
  row("conv-b", "2026-11-06T14:00:00.000Z"),
  row("conv-a", "2026-11-06T12:00:00.000Z"),
  // 01:00 UTC do dia 6 = 22:00 do dia 5 em Brasília.
  row("conv-a", "2026-11-06T01:00:00.000Z"),
  row("conv-a", "2026-11-04T18:00:00.000Z"),
  { conversationId: "conv-a", direction: CommunicationDirection.INBOUND, providerTimestamp: null }
];

// Um cartão por conversa e dia; dia mais recente primeiro e, no mesmo dia, a conversa mais recente primeiro.
const all = groupDayCards(rows, 20, false);
assert.deepEqual(all.items.map((card) => `${card.day} ${card.conversationId} ${card.total}/${card.inbound}/${card.outbound}`), [
  "2026-11-06 conv-a 2/1/1",
  "2026-11-06 conv-b 1/1/0",
  "2026-11-05 conv-a 1/1/0",
  "2026-11-04 conv-a 1/1/0"
]);
assert.equal(all.nextBefore, null);
assert.equal(all.items[0].firstAt.toISOString(), "2026-11-06T12:00:00.000Z");
assert.equal(all.items[0].lastAt.toISOString(), "2026-11-06T15:00:00.000Z");

// Paginação por dias: dois dias por página, a próxima começa antes do último dia devolvido.
const page = groupDayCards(rows, 2, false);
assert.deepEqual([...new Set(page.items.map((card) => card.day))], ["2026-11-06", "2026-11-05"]);
assert.equal(page.nextBefore, "2026-11-05");

// Varredura cortada: o dia mais antigo (possivelmente incompleto) fica para a próxima página.
const truncated = groupDayCards(rows.slice(0, 5), 20, true);
assert.deepEqual([...new Set(truncated.items.map((card) => card.day))], ["2026-11-06", "2026-11-05"]);
assert.equal(truncated.nextBefore, "2026-11-05");

// Varredura cortada com um único dia: devolve o dia e continua antes dele.
const single = groupDayCards(rows.slice(0, 3), 20, true);
assert.deepEqual(single.items.map((card) => card.day), ["2026-11-06", "2026-11-06"]);
assert.equal(single.nextBefore, "2026-11-06");

assert.deepEqual(groupDayCards([], 20, false), { items: [], nextBefore: null });

// Visão da mensagem: origem, editada e apagada vêm da direção e das marcas; nada de id externo.
const outbound = toMessageView({
  id: "msg-1",
  direction: CommunicationDirection.OUTBOUND,
  type: "TEXT",
  textContent: "Texto ficticio enviado",
  providerTimestamp: new Date("2026-11-06T15:00:00.000Z"),
  metadata: { origin: "app", editedAt: "2026-11-06T15:01:00.000Z", deletedInWhatsAppAt: "2026-11-06T15:02:00.000Z" }
});
assert.deepEqual(outbound, {
  id: "msg-1",
  direction: "outbound",
  type: "TEXT",
  text: "Texto ficticio enviado",
  at: new Date("2026-11-06T15:00:00.000Z"),
  origin: "app",
  edited: true,
  deletedInWhatsApp: true
});
const inbound = toMessageView({ id: "msg-2", direction: CommunicationDirection.INBOUND, type: "TEXT", textContent: null, providerTimestamp: null, metadata: null });
assert.equal(inbound.origin, "received");
assert.equal(inbound.text, "");
assert.equal(inbound.edited, false);
assert.equal(inbound.deletedInWhatsApp, false);

console.log("whatsappConversationReads.test.ts: ok");
