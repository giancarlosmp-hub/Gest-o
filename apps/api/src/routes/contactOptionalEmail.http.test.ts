import assert from "node:assert/strict";
import { once } from "node:events";
import { clientContactSchema, contactSchema, isValidOptionalContactEmail } from "@salesforce-pro/shared";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import { createWhatsAppConversationsTestDb } from "../services/whatsappMessages/whatsappConversationsTestDb.js";

// E-mail do contato opcional (WhatsApp Fase B2: o vínculo de uma conversa cria contato sem e-mail): ausente
// ou vazio é aceito e gravado vazio; se informado, continua validado como e-mail. Só dados fictícios.

// 1) Schemas compartilhados.
const base = { name: "Contato Ficticio", phone: "(11) 90000-0401" };
assert.equal(clientContactSchema.safeParse(base).success, true);
assert.equal(clientContactSchema.safeParse({ ...base, email: "" }).success, true);
assert.equal(clientContactSchema.safeParse({ ...base, email: "  " }).success, true);
assert.equal(clientContactSchema.safeParse({ ...base, email: "contato@test.invalid" }).success, true);
assert.equal(clientContactSchema.safeParse({ ...base, email: "não é email" }).success, false);
assert.equal(contactSchema.safeParse({ ...base, clientId: "client-a" }).success, true);
assert.equal(contactSchema.safeParse({ ...base, clientId: "client-a", email: "x@" }).success, false);
assert.equal(clientContactSchema.partial().safeParse({ email: "" }).success, true);
assert.equal(isValidOptionalContactEmail(""), true);
assert.equal(isValidOptionalContactEmail(null), true);
assert.equal(isValidOptionalContactEmail(" contato@test.invalid "), true);
assert.equal(isValidOptionalContactEmail("contato@"), false);

// 2) Rotas.
const { tables } = createWhatsAppConversationsTestDb(prisma);
tables.client.push({ id: "client-a", tenantId: "tenant-a", ownerSellerId: "seller-a", isArchived: false });

const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const call = async (method: string, path: string, body: unknown) => {
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${signAccessToken({ id: "seller-a", email: "seller-a@test.invalid", role: "vendedor" })}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};

try {
  const withoutEmail = await call("POST", "/clients/client-a/contacts", base);
  assert.equal(withoutEmail.status, 201);
  assert.equal(withoutEmail.json.email, "");
  const emptyEmail = await call("POST", "/clients/client-a/contacts", { ...base, email: "" });
  assert.equal(emptyEmail.status, 201);
  assert.equal(emptyEmail.json.email, "");
  const withEmail = await call("POST", "/clients/client-a/contacts", { ...base, email: "contato@test.invalid" });
  assert.equal(withEmail.json.email, "contato@test.invalid");
  assert.equal((await call("POST", "/clients/client-a/contacts", { ...base, email: "não é email" })).status, 400);

  // Editar um contato sem e-mail mantendo o e-mail vazio (o caso do contato criado pelo vínculo).
  const edited = await call("PUT", `/clients/client-a/contacts/${withoutEmail.json.id}`, { ...base, name: "Contato Ficticio Editado", email: "" });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.name, "Contato Ficticio Editado");
  assert.equal(edited.json.email, "");
  assert.equal((await call("PUT", `/clients/client-a/contacts/${withoutEmail.json.id}`, { email: "x@" })).status, 400);

  // Rota genérica /contacts.
  const generic = await call("POST", "/contacts", { ...base, clientId: "client-a" });
  assert.equal(generic.status, 201);
  assert.equal(generic.json.email, "");
} finally {
  server.close();
  await prisma.$disconnect().catch(() => undefined);
}

console.log("contactOptionalEmail.http.test.ts: ok");
