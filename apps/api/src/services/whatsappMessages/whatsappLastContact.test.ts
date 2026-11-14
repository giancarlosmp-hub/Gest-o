import assert from "node:assert/strict";
import { advanceClientOpenOpportunitiesLastContact, brazilDayKeyOf, lastContactToRecord } from "./whatsappLastContact.js";

// WhatsApp como contato: quando a mensagem enviada grava o último contato das oportunidades abertas do cliente.
// Só dados fictícios.

// Dia de Brasília (UTC-3): 02:59Z ainda é o dia anterior.
assert.equal(brazilDayKeyOf(new Date("2026-11-14T02:59:00.000Z")), "2026-11-13");
assert.equal(brazilDayKeyOf(new Date("2026-11-14T03:00:00.000Z")), "2026-11-14");

const morning = new Date("2026-11-14T12:00:00.000Z"); // 09:00 de Brasília
const afternoon = new Date("2026-11-14T18:00:00.000Z"); // 15:00 de Brasília
const lateNight = new Date("2026-11-15T02:30:00.000Z"); // 23:30 de Brasília, ainda 14/11
const nextDay = new Date("2026-11-15T12:00:00.000Z");

// Primeira enviada da conversa: grava.
assert.equal(lastContactToRecord({ clientId: "client-1", previousLastOutboundAt: null, outboundAt: morning, linkedNow: false }), morning);
// Outra enviada no mesmo dia de Brasília (inclusive 23:30, que em UTC já é o dia seguinte): não grava de novo.
assert.equal(lastContactToRecord({ clientId: "client-1", previousLastOutboundAt: morning, outboundAt: afternoon, linkedNow: false }), null);
assert.equal(lastContactToRecord({ clientId: "client-1", previousLastOutboundAt: morning, outboundAt: lateNight, linkedNow: false }), null);
// Primeira enviada do dia seguinte: grava.
assert.equal(lastContactToRecord({ clientId: "client-1", previousLastOutboundAt: afternoon, outboundAt: nextDay, linkedNow: false }), nextDay);
// Mensagem antiga entregue fora de ordem: não grava.
assert.equal(lastContactToRecord({ clientId: "client-1", previousLastOutboundAt: nextDay, outboundAt: morning, linkedNow: false }), null);
// Recebida (sem outboundAt): nunca conta.
assert.equal(lastContactToRecord({ clientId: "client-1", previousLastOutboundAt: morning, outboundAt: null, linkedNow: false }), null);
// Conversa sem cliente: nada.
assert.equal(lastContactToRecord({ clientId: null, previousLastOutboundAt: null, outboundAt: morning, linkedNow: false }), null);
assert.equal(lastContactToRecord({ clientId: null, previousLastOutboundAt: morning, outboundAt: null, linkedNow: true }), null);

// Vínculo agora: vale a última enviada da conversa, mesmo no mesmo dia.
assert.equal(lastContactToRecord({ clientId: "client-1", previousLastOutboundAt: morning, outboundAt: null, linkedNow: true }), morning);
assert.equal(lastContactToRecord({ clientId: "client-1", previousLastOutboundAt: morning, outboundAt: afternoon, linkedNow: true }), afternoon);
assert.equal(lastContactToRecord({ clientId: "client-1", previousLastOutboundAt: afternoon, outboundAt: morning, linkedNow: true }), afternoon);
// Vínculo de conversa só com recebidas: nada.
assert.equal(lastContactToRecord({ clientId: "client-1", previousLastOutboundAt: null, outboundAt: null, linkedNow: true }), null);

// Gravação: só oportunidades abertas do cliente, nunca para trás. Banco em memória mínimo.
type Opp = { id: string; clientId: string; stage: string; lastContactAt: Date | null };
const opportunities: Opp[] = [
  { id: "opp-open-empty", clientId: "client-1", stage: "proposta", lastContactAt: null },
  { id: "opp-open-older", clientId: "client-1", stage: "negociacao", lastContactAt: new Date("2026-11-01T12:00:00.000Z") },
  { id: "opp-open-newer", clientId: "client-1", stage: "prospeccao", lastContactAt: nextDay },
  { id: "opp-won", clientId: "client-1", stage: "ganho", lastContactAt: null },
  { id: "opp-lost", clientId: "client-1", stage: "perdido", lastContactAt: null },
  { id: "opp-other-client", clientId: "client-2", stage: "proposta", lastContactAt: null }
];
let lastWhere: any = null;
const db = {
  opportunity: {
    updateMany: async ({ where, data }: any) => {
      lastWhere = where;
      const hit = opportunities.filter(
        (row) =>
          row.clientId === where.clientId &&
          !where.stage.notIn.includes(row.stage) &&
          where.OR.some((cond: any) => (cond.lastContactAt === null ? row.lastContactAt === null : row.lastContactAt !== null && row.lastContactAt < cond.lastContactAt.lt))
      );
      for (const row of hit) row.lastContactAt = data.lastContactAt;
      return { count: hit.length };
    }
  }
} as any;

assert.equal(await advanceClientOpenOpportunitiesLastContact(db, "client-1", morning), 2);
assert.deepEqual(lastWhere.stage, { notIn: ["ganho", "perdido"] });
const byId = Object.fromEntries(opportunities.map((row) => [row.id, row.lastContactAt]));
assert.equal(byId["opp-open-empty"], morning);
assert.equal(byId["opp-open-older"], morning);
assert.equal(byId["opp-open-newer"], nextDay);
assert.equal(byId["opp-won"], null);
assert.equal(byId["opp-lost"], null);
assert.equal(byId["opp-other-client"], null);
// Data inválida ou cliente vazio: não chama o banco.
lastWhere = null;
assert.equal(await advanceClientOpenOpportunitiesLastContact(db, "client-1", new Date("x")), 0);
assert.equal(await advanceClientOpenOpportunitiesLastContact(db, "", morning), 0);
assert.equal(lastWhere, null);

console.log("whatsappLastContact.test.ts: ok");
