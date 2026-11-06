import assert from "node:assert/strict";
import { once } from "node:events";
import { Prisma } from "@prisma/client";

// Dados fictícios. Erro async não tratado em rota real chega ao handler final em milissegundos (nunca 408);
// o timeout continua valendo só para requisição realmente lenta.
const TIMEOUT_MS = 2000;
process.env.API_REQUEST_TIMEOUT_MS = String(TIMEOUT_MS);

const { app } = await import("../app.js");
const { prisma } = await import("../config/prisma.js");
const { signAccessToken } = await import("../utils/jwt.js");

const errorLogs: unknown[] = [];
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  errorLogs.push(args[0]);
};

const SLOW_MS = TIMEOUT_MS + 500;
let slowFinished: Promise<void> = Promise.resolve();
const known = (code: string) => new Prisma.PrismaClientKnownRequestError(`detalhe interno ${code} tabela_ficticia`, { code, clientVersion: "test" });

const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
setModel("user", {
  findFirst: async ({ where }: any) => (where?.id === "seller-a" ? { id: "seller-a", email: "seller-a@test.invalid", role: "vendedor", region: null } : null),
});
setModel("tenantMembership", { findMany: async () => [{ tenantId: "tenant-a" }] });
setModel("client", {
  findFirst: async ({ where }: any) => {
    switch (where?.id) {
      case "client-falha-generica": throw new Error("detalhe interno fictício da consulta");
      case "client-p2002": throw known("P2002");
      case "client-p2003": throw known("P2003");
      case "client-p2025": throw known("P2025");
      case "client-validacao": throw new Prisma.PrismaClientValidationError("Argument `campoFicticio` is missing.", { clientVersion: "test" });
      case "client-lento": {
        let release!: () => void;
        slowFinished = new Promise((resolve) => { release = resolve; });
        await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
        setTimeout(release, 50);
        return null;
      }
      default: return { id: where?.id };
    }
  },
});
setModel("contact", { findMany: async () => [] });

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const authorization = `Bearer ${signAccessToken({ id: "seller-a", email: "seller-a@test.invalid", role: "vendedor" })}`;

const getContacts = async (clientId: string) => {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/clients/${clientId}/contacts`, { headers: { Authorization: authorization } });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, text, requestId: response.headers.get("x-request-id"), elapsedMs: Date.now() - startedAt };
};

const assertNoInternalDetail = (text: string) => {
  assert.doesNotMatch(text, /detalhe interno|tabela_ficticia|campoFicticio|P20\d\d|stack|at .*\.ts/i, `resposta sem detalhe interno: ${text}`);
};

try {
  assert.equal((await getContacts("client-ok")).status, 200, "rota de controle responde normalmente");

  // Erro genérico: 500 em menos de 1 s, não 408, com requestId e sem detalhe interno.
  const generic = await getContacts("client-falha-generica");
  assert.equal(generic.status, 500);
  assert.ok(generic.elapsedMs < 1000, `500 rápido (${generic.elapsedMs} ms)`);
  assert.ok(generic.requestId, "header x-request-id presente");
  assert.deepEqual(generic.json, { message: `Erro interno. Informe o código ${generic.requestId} ao suporte.`, requestId: generic.requestId });
  assertNoInternalDetail(generic.text);
  const genericLog = errorLogs.find((entry: any) => entry?.meta?.requestId === generic.requestId) as any;
  assert.ok(genericLog, "erro completo registrado no log do servidor");
  assert.match(String(genericLog.meta.stack), /detalhe interno fictício da consulta/);

  const conflicts = [await getContacts("client-p2002"), await getContacts("client-p2003")];
  for (const conflict of conflicts) {
    assert.equal(conflict.status, 409);
    assert.ok(conflict.elapsedMs < 1000);
    assertNoInternalDetail(conflict.text);
  }
  assert.deepEqual(conflicts.map((conflict) => conflict.json.message), ["Já existe um registro com esses dados.", "Operação bloqueada: há registros vinculados."]);

  const notFound = await getContacts("client-p2025");
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFound.json, { message: "Registro não encontrado." });

  const prismaValidation = await getContacts("client-validacao");
  assert.equal(prismaValidation.status, 500, "PrismaClientValidationError fica 500 genérico");
  assertNoInternalDetail(prismaValidation.text);

  // JSON malformado (body-parser): 400, não 500.
  const malformed = await fetch(`${baseUrl}/clients`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: "{campo-ficticio",
  });
  const malformedText = await malformed.text();
  assert.equal(malformed.status, 400);
  assert.deepEqual(JSON.parse(malformedText), { message: "Requisição inválida." });
  assertNoInternalDetail(malformedText);

  // Requisição realmente lenta: o timeout continua respondendo 408.
  const slow = await getContacts("client-lento");
  assert.equal(slow.status, 408);
  assert.deepEqual(slow.json, { message: "Request timeout" });
  assert.ok(slow.elapsedMs >= TIMEOUT_MS - 100, `408 só depois do timeout (${slow.elapsedMs} ms)`);

  // O handler lento termina depois do 408 e tenta responder de novo: o erro vai só para o log.
  await slowFinished;
  const lateLog = errorLogs.find((entry: any) => entry?.meta?.requestId === slow.requestId && entry?.meta?.responseAlreadySent === true);
  assert.ok(lateLog, "erro depois da resposta registrado no log com responseAlreadySent");
} finally {
  console.error = originalConsoleError;
  server.close();
  await (prisma as any).$disconnect?.();
}

console.log("ASYNC_ROUTE_ERRORS=PASS generic_500_fast=PASS prisma_409_404=PASS body_parser_400=PASS slow_408=PASS late_error_logged=PASS");
