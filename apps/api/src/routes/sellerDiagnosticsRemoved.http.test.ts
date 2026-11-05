import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";

// Dados fictícios: a rota temporária de diagnóstico ERP por vendedor foi removida. Diretor e gerente
// recebem 404, com ou sem parâmetros, e a rota não consulta banco nem ERP.
const users: Record<string, "diretor" | "gerente"> = { "director-x": "diretor", "manager-x": "gerente" };
const touched: string[] = [];

const prismaAny = prisma as any;
prismaAny.user.findFirst = async ({ where }: any) => {
  const role = users[where?.id];
  return role ? { id: where.id, email: `${where.id}@test.invalid`, role, region: null, isActive: true, tenantMemberships: [{ tenantId: "tenant-x", role, status: "active" }] } : null;
};
prismaAny.user.findMany = async () => {
  touched.push("user.findMany");
  return [];
};
prismaAny.tenantMembership.findMany = async () => [{ tenantId: "tenant-x" }];
prismaAny.appConfig.findUnique = async () => {
  touched.push("appConfig.findUnique");
  return null;
};

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const status = async (userId: string, path: string) =>
  (await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${signAccessToken({ id: userId, email: `${userId}@test.invalid`, role: users[userId] })}` },
  })).status;

try {
  for (const userId of Object.keys(users)) {
    assert.equal(await status(userId, "/api/erp/ultrafv3/seller-diagnostics"), 404, `${userId} sem parâmetros`);
    assert.equal(
      await status(userId, "/api/erp/ultrafv3/seller-diagnostics?sellerCode=9001&operatorCode=901&search=Vendedor%20Ficticio"),
      404,
      `${userId} com parâmetros fictícios`,
    );
  }
  assert.deepEqual(touched, [], "a rota removida não pode consultar usuários nem caches do ERP");

  console.log("seller diagnostics route removed: HTTP regression passed");
} finally {
  server.close();
  await prismaAny.$disconnect?.();
}
