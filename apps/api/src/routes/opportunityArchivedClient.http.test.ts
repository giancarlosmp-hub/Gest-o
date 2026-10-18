import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import { buildPortfolioCleanupArchiveReason } from "../services/portfolioCleanupArchive.js";

// Dados fictícios: cliente arquivado não recebe oportunidade nova (POST /opportunities responde 409).
type Row = Record<string, any>;

const users: Record<string, "vendedor" | "gerente" | "diretor"> = { "seller-a": "vendedor", "director-a": "diretor" };
const clients: Row[] = [
  { id: "client-ativo", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false, archiveReason: null },
  { id: "client-limpeza", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: true, archiveReason: buildPortfolioCleanupArchiveReason(new Date("2026-10-18T12:00:00.000Z")) },
  { id: "client-fundido", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: true, archiveReason: "MERGED_INTO:client-ativo" },
];
const createdOpportunities: Row[] = [];
const createdEvents: Row[] = [];

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row);
setModel("user", {
  findFirst: async ({ where }: any) => (users[where?.id] ? { id: where.id, email: `${where.id}@test.invalid`, role: users[where.id], region: null, isActive: true } : null),
  findUnique: async ({ where }: any) => (users[where?.id] ? { id: where.id, name: where.id, role: users[where.id], isActive: true } : null),
  findMany: async () => Object.entries(users).map(([id, role]) => ({ id, name: id, email: `${id}@test.invalid`, role, isActive: true })),
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users[where?.userId] ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", {
  findUnique: async ({ where, select }: any) => {
    const row = clients.find((client) => client.id === where.id);
    return row ? pick(row, select) : null;
  },
  findFirst: async ({ where, select }: any) => {
    const row = clients.find((client) => client.id === where?.id);
    return row ? pick(row, select) : null;
  },
});
setModel("opportunity", {
  create: async ({ data }: any) => {
    const created = { id: `opp-${createdOpportunities.length + 1}`, ...data };
    createdOpportunities.push(created);
    return created;
  },
});
setModel("timelineEvent", { create: async ({ data }: any) => { createdEvents.push(data); return data; } });
(prisma as any).$transaction = async (input: any) => (typeof input === "function" ? input(prisma) : Promise.all(input));

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const post = async (userId: string, body: unknown) => {
  const response = await fetch(`${baseUrl}/opportunities`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signAccessToken({ id: userId, email: `${userId}@test.invalid`, role: users[userId] })}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
};
const opportunity = (clientId: string) => ({
  title: "Oportunidade Ficticia", value: 100, stage: "prospeccao", clientId,
  proposalDate: "2026-10-18", followUpDate: "2026-10-25", expectedCloseDate: "2026-11-30",
});

try {
  for (const userId of ["seller-a", "director-a"]) {
    const archived = await post(userId, opportunity("client-limpeza"));
    assert.equal(archived.status, 409, `${userId}: arquivado pela limpeza`);
    assert.equal(archived.json?.message, "Cliente arquivado na limpeza da carteira. Peça ao gerente para reativar o cadastro.");

    const merged = await post(userId, opportunity("client-fundido"));
    assert.equal(merged.status, 409, `${userId}: arquivado por outro motivo`);
    assert.equal(merged.json?.message, "Cliente arquivado. Peça ao gerente para reativar o cadastro.");
  }
  assert.equal(createdOpportunities.length, 0, "nenhuma oportunidade criada para cliente arquivado");
  assert.equal(createdEvents.length, 0, "nenhum evento de timeline");

  const active = await post("seller-a", opportunity("client-ativo"));
  assert.equal(active.status, 201, "cliente ativo segue como hoje");
  assert.equal(createdOpportunities.length, 1);
  assert.equal(createdOpportunities[0].clientId, "client-ativo");
} finally {
  server.close();
  await (prisma as any).$disconnect?.();
}

console.log("OPPORTUNITY_ARCHIVED_CLIENT=PASS portfolio_cleanup_409=PASS other_archive_409=PASS active_client_201=PASS");
