import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import { createWhatsAppConversationsTestDb } from "../services/whatsappMessages/whatsappConversationsTestDb.js";
import { RECORDING_STATE_KEY } from "../services/whatsappMessages/whatsappRecordingState.js";

// WhatsApp Fase B2: resumo do cartão "Meu número" — gravação ligada/desligada desde quando e o contador da
// própria fila. Prisma em memória, só dados fictícios.
const { tables } = createWhatsAppConversationsTestDb(prisma);

const switchedOn = new Date("2026-11-10T12:00:00.000Z");
const connectedLater = new Date("2026-11-11T12:00:00.000Z");
tables.whatsAppConnection.push(
  { id: "conn-a", userId: "seller-a", status: "CONNECTED", connectedAt: connectedLater },
  { id: "conn-b", userId: "seller-b", status: "DISCONNECTED", connectedAt: null }
);
const queued = (id: string, owner: string, extra: Record<string, unknown> = {}) => ({
  id, provider: "evolution_whatsapp", clientId: null, numberOwnerUserId: owner, linkStatus: "unlinked", ...extra
});
tables.communicationConversation.push(
  queued("q-1", "seller-a"),
  queued("q-2", "seller-a", { linkStatus: "ambiguous" }),
  queued("q-linked", "seller-a", { clientId: "client-a", linkStatus: "linked" }),
  queued("q-meta", "seller-a", { provider: "META_WHATSAPP_CLOUD" }),
  queued("q-b", "seller-b")
);

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const summary = async (userId: string) => {
  const user = tables.user.find((row) => row.id === userId)!;
  const response = await fetch(`http://127.0.0.1:${address.port}/whatsapp/messages/summary`, {
    headers: { Authorization: `Bearer ${signAccessToken({ id: user.id, email: user.email, role: user.role })}` }
  });
  return { status: response.status, json: (await response.json()) as any };
};

try {
  env.communicationsEnabled = true;
  env.whatsappEvolutionEnabled = true;

  // Desligada (e ainda sem registro): sem data; o contador conta só a própria fila do Evolution.
  env.whatsappEvolutionMessagesEnabled = false;
  const off = await summary("seller-a");
  assert.equal(off.status, 200);
  assert.deepEqual(off.json, { recording: { enabled: false, since: null }, unlinkedCount: 2 });

  // Ligada desde o dia 10, número conectado no dia 11: "desde" = conexão.
  env.whatsappEvolutionMessagesEnabled = true;
  tables.appConfig.push({ id: "cfg-1", key: RECORDING_STATE_KEY, value: JSON.stringify({ enabled: true, since: switchedOn.toISOString() }) });
  assert.deepEqual((await summary("seller-a")).json, { recording: { enabled: true, since: connectedLater.toISOString() }, unlinkedCount: 2 });
  // Número desconectado: vale a data da ligação.
  assert.deepEqual((await summary("seller-b")).json, { recording: { enabled: true, since: switchedOn.toISOString() }, unlinkedCount: 1 });
  // Gerente sem fila.
  assert.deepEqual((await summary("manager-a")).json.unlinkedCount, 0);
} finally {
  server.close();
  await prisma.$disconnect().catch(() => undefined);
}

console.log("whatsappMessagesSummary.http.test.ts: ok");
