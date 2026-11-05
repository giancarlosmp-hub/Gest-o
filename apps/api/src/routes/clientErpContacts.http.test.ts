import assert from "node:assert/strict";
import { once } from "node:events";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";
import { buildClientErpContacts } from "../services/clientErpContacts.js";
import { signAccessToken } from "../utils/jwt.js";

// Telefones e e-mails do ERP no detalhe do cliente: lidos do cache do /partners, sem gravar em Contact.
// Dados fictícios; Prisma simulado.
type Row = Record<string, any>;

const BIRTH_DATE = "1990-01-01T00:00:00.000Z";

// 1) Montagem da lista: rótulos, formatos, nono dígito, duplicados, campos ignorados e data de nascimento fora.
const partner: Row = {
  PARCEIRO: "900001",
  TELEFONE: "(11) 3333-4444 / (11) 8888-7777",
  CELULAR: "11 9 8888-7777",
  FAX: "(11) 3333-0000",
  RAMAL: "21",
  CONTATO: "Contato Ficticio Um",
  TELEFONE_CONTATO1: "11977776666",
  CONTATO2: "",
  TELEFONE_CONTATO2: "(11) 3333-4444",
  CONTATO3: "Contato Ficticio Tres",
  TELEFONE_CONTATO3: "3333-5555",
  EMAIL: "principal@exemplo.invalid",
  EMAIL_CONTATO1: "um@exemplo.invalid; PRINCIPAL@exemplo.invalid",
  EMAIL_CONTATO2: "sem-arroba",
  EMAIL_CONTATO3: "",
  CONTATOS: [
    {
      PARCEIRO: "900001",
      CONTATO: "Contato Ficticio Lista",
      FUNCAO: "Compras",
      TELEFONE: "(21) 2222-3333",
      CELULAR: "(21) 6666-1234",
      EMAIL: "lista@exemplo.invalid",
      DATA_NASCIMENTO: BIRTH_DATE
    },
    { CONTATO: "Contato Ficticio Repetido", TELEFONE: "11988887777", DATA_NASCIMENTO: BIRTH_DATE },
    "linha-invalida"
  ]
};

const built = buildClientErpContacts(partner);
assert.deepEqual(built.erpPhones, [
  { label: "Principal", display: "(11) 3333-4444", kind: "landline", tel: "tel:+551133334444", whatsapp: "https://wa.me/551133334444" },
  { label: "Principal", display: "(11) 98888-7777", kind: "mobile", tel: "tel:+5511988887777", whatsapp: "https://wa.me/5511988887777" },
  { label: "Contato: Contato Ficticio Um", display: "(11) 97777-6666", kind: "mobile", tel: "tel:+5511977776666", whatsapp: "https://wa.me/5511977776666" },
  { label: "Contato: Contato Ficticio Tres", display: "3333-5555", kind: null, tel: null, whatsapp: null },
  { label: "Contato: Contato Ficticio Lista (Compras)", display: "(21) 2222-3333", kind: "landline", tel: "tel:+552122223333", whatsapp: "https://wa.me/552122223333" },
  { label: "Contato: Contato Ficticio Lista (Compras)", display: "(21) 96666-1234", kind: "mobile", tel: "tel:+5521966661234", whatsapp: "https://wa.me/5521966661234" }
], "CELULAR, contato 2 e o repetido da lista são duplicados; FAX e RAMAL ignorados; sem DDD fica só texto");
assert.deepEqual(built.erpEmails, [
  { label: "Principal", email: "principal@exemplo.invalid" },
  { label: "Contato: Contato Ficticio Um", email: "um@exemplo.invalid" },
  { label: "Contato: Contato Ficticio Lista (Compras)", email: "lista@exemplo.invalid" }
]);
assert.doesNotMatch(JSON.stringify(built), /1990|NASC|PARCEIRO|900001|3333-0000/);
assert.deepEqual(buildClientErpContacts(null), { erpPhones: [], erpEmails: [] });
assert.deepEqual(buildClientErpContacts({ TELEFONE: "", CELULAR: null, CONTATOS: "x" }), { erpPhones: [], erpEmails: [] });
assert.deepEqual(buildClientErpContacts({ TELEFONE_CONTATO1: "(41) 3333-4444" }).erpPhones[0]?.label, "Contato", "contato sem nome");

// 2) GET /clients/:id: mesma busca do PDF (código ERP, depois documento) e escopo do vendedor.
const users: Row[] = [
  { id: "director-a", role: "diretor", name: "Diretor Ficticio" },
  { id: "seller-a", role: "vendedor", name: "Vendedor Ficticio A" },
  { id: "seller-b", role: "vendedor", name: "Vendedor Ficticio B" }
];
const baseClient = {
  tenantId: "tenant-a", fantasyName: null, state: "SP", region: "Sudeste", city: "Cidade Ficticia", clientType: "PJ", segment: null,
  potentialHa: null, farmSizeHa: null, isArchived: false, archiveReason: null, lastPurchaseDate: null, lastPurchaseValue: null,
  erpUpdatedAt: null, financialProfile: null, partnerTitles: null, openTitlesTotal: 0, overdueTitlesTotal: 0, createdAt: new Date("2026-01-01T00:00:00.000Z")
};
const clients: Row[] = [
  { ...baseClient, id: "c-code", name: "Cliente Ficticio Codigo", code: "900001", cnpj: null, ownerSellerId: "seller-a" },
  { ...baseClient, id: "c-doc", name: "Cliente Ficticio Documento", code: null, cnpj: "00.000.000/0001-91", ownerSellerId: "seller-a" },
  { ...baseClient, id: "c-none", name: "Cliente Ficticio Sem ERP", code: "900099", cnpj: null, ownerSellerId: "seller-a" },
  { ...baseClient, id: "c-b", name: "Cliente Ficticio Vendedor B", code: "900002", cnpj: null, ownerSellerId: "seller-b" }
];
const partners: Row[] = [
  partner,
  { PARCEIRO: "900003", CNPJ: "00000000000191", TELEFONE: "(31) 3333-4444", DATA_NASCIMENTO: BIRTH_DATE },
  { PARCEIRO: "900002", TELEFONE: "(41) 3333-4444" }
];

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where ?? {}).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (key === "AND") return ([] as Row[]).concat(condition).every((part) => matches(row, part));
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part));
    if (key === "opportunities") return false;
    if (condition && typeof condition === "object" && "in" in condition) return condition.in.includes(row[key]);
    return row[key] === condition;
  });
const setModel = (model: string, methods: Record<string, unknown>) => {
  const target = (prisma as any)[model];
  for (const [key, value] of Object.entries(methods)) target[key] = value;
};
setModel("user", {
  findFirst: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, email: `${user.id}@test.invalid`, name: user.name, role: user.role, region: null, isActive: true } : null;
  },
  findUnique: async ({ where }: any) => {
    const user = users.find((row) => row.id === where?.id);
    return user ? { id: user.id, name: user.name, role: user.role, isActive: true } : null;
  }
});
setModel("tenantMembership", { findMany: async ({ where }: any) => (users.some((user) => user.id === where?.userId) ? [{ tenantId: "tenant-a" }] : []) });
setModel("client", { findFirst: async ({ where }: any) => clients.find((row) => matches(row, where)) ?? null });
setModel("opportunity", { count: async () => 0 });
setModel("activity", { count: async () => 0, aggregate: async () => ({ _max: { date: null, createdAt: null } }) });
setModel("erpOrderSync", { findMany: async () => [] });
let partnersCache: string | null = JSON.stringify(partners);
let appConfigReads = 0;
setModel("appConfig", {
  findUnique: async ({ where }: any) => {
    if (where.key !== "erp.ultrafv3.partners") return null;
    appConfigReads += 1;
    if (partnersCache === "throw") throw new Error("falha ficticia");
    return partnersCache === null ? null : { value: partnersCache };
  }
});

const originalInfo = console.info;
console.info = () => undefined;
const server = app.listen(0);
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");
const call = async (path: string, userId: string) => {
  const user = users.find((row) => row.id === userId)!;
  const token = signAccessToken({ id: user.id, email: `${user.id}@test.invalid`, role: user.role });
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
};

try {
  const byCode = await call("/clients/c-code", "seller-a");
  assert.equal(byCode.status, 200);
  assert.deepEqual(byCode.json.erpPhones, built.erpPhones, "achado pelo código ERP");
  assert.deepEqual(byCode.json.erpEmails, built.erpEmails);
  assert.doesNotMatch(JSON.stringify(byCode.json), /1990|DATA_NASCIMENTO|CONTATOS/, "data de nascimento e linha bruta do ERP nunca saem");

  const byDocument = await call("/clients/c-doc", "seller-a");
  assert.equal(byDocument.status, 200);
  assert.deepEqual(byDocument.json.erpPhones.map((phone: Row) => phone.display), ["(31) 3333-4444"], "achado pelo documento");
  assert.deepEqual(byDocument.json.erpEmails, []);

  const withoutPartner = await call("/clients/c-none", "seller-a");
  assert.equal(withoutPartner.status, 200);
  assert.deepEqual([withoutPartner.json.erpPhones, withoutPartner.json.erpEmails], [[], []], "parceiro fora do cache");

  // Escopo do vendedor: cliente de outro vendedor continua 404 e não lê o cache.
  const readsBefore = appConfigReads;
  const otherSeller = await call("/clients/c-b", "seller-a");
  assert.equal(otherSeller.status, 404);
  assert.equal(otherSeller.json.erpPhones, undefined);
  assert.equal(appConfigReads, readsBefore, "fora do escopo não lê o cache");
  assert.deepEqual((await call("/clients/c-b", "seller-b")).json.erpPhones.map((phone: Row) => phone.display), ["(41) 3333-4444"]);
  assert.deepEqual((await call("/clients/c-b", "director-a")).json.erpPhones.map((phone: Row) => phone.display), ["(41) 3333-4444"]);

  // Sem cache ou cache ilegível: o detalhe abre com listas vazias.
  partnersCache = null;
  assert.deepEqual((await call("/clients/c-code", "seller-a")).json.erpPhones, []);
  partnersCache = "{json-invalido";
  assert.deepEqual((await call("/clients/c-code", "seller-a")).json.erpPhones, []);
  partnersCache = "throw";
  const failed = await call("/clients/c-code", "seller-a");
  assert.equal(failed.status, 200, "falha na leitura do cache não derruba o detalhe");
  assert.deepEqual([failed.json.erpPhones, failed.json.erpEmails], [[], []]);

  console.log("client ERP contacts tests passed");
} finally {
  console.info = originalInfo;
  server.close();
  await prisma.$disconnect().catch(() => undefined);
}
