import assert from "node:assert/strict";
import { env } from "../../config/env.js";
import { createPdfPartnerLookup, findPdfPartner } from "../erpOrderPdfService.js";
import { erpPartnerPhoneNumbers } from "../clientErpContacts.js";
import {
  buildClientPhoneIndexEntries,
  findClientsByPhone,
  rebuildClientPhoneIndex,
  refreshClientPhoneIndexForClients,
  scheduleClientPhoneIndexRefresh
} from "./clientPhoneIndex.js";

// Índice telefone → cliente da Fase B do WhatsApp. Banco em memória; parceiros, clientes, documentos e
// telefones fictícios.

type Row = Record<string, any>;
const partners = [
  { CODPARCEIRO: "100", NOME: "Parceiro Ficticio A", CNPJ: "11.111.111/0001-11", TELEFONE: "(11) 3000-0001", CELULAR: "(11) 90000-0001 / (11) 90000-0002" },
  { CODPARCEIRO: "200", NOME: "Parceiro Ficticio B", CNPJ: "22.222.222/0001-22", CELULAR: "11 90000-0003", CONTATOS: [{ CONTATO: "Contato Ficticio", CELULAR: "(11) 90000-0001" }] },
  { CODPARCEIRO: "300", NOME: "Parceiro Ficticio C", CNPJ: "33.333.333/0001-33", TELEFONE: "sem telefone", CELULAR: "(00) 1234-5678" },
  { CODPARCEIRO: "400", NOME: "Parceiro Ficticio D", CNPJ: "44.444.444/0001-44", CELULAR: "(21) 8000-0004" }
];
const clients: Row[] = [
  { id: "client-a", code: "100", cnpj: null, tenantId: "tenant-a", isArchived: false },
  { id: "client-b", code: null, cnpj: "22222222000122", tenantId: "tenant-a", isArchived: false },
  { id: "client-c", code: "300", cnpj: null, tenantId: "tenant-a", isArchived: false },
  { id: "client-d", code: "400", cnpj: null, tenantId: "tenant-a", isArchived: true },
  { id: "client-e", code: "999", cnpj: null, tenantId: "tenant-a", isArchived: false }
];
const contacts: Row[] = [
  { clientId: "client-e", phone: "(11) 90000-0005" },
  { clientId: "client-e", phone: "(11) 90000-0005 ou (11) 3000-0009" },
  { clientId: "client-a", phone: "(11) 90000-0002" },
  { clientId: null, phone: "(11) 90000-0006" },
  { clientId: "client-inexistente", phone: "(11) 90000-0007" }
];

// 1) Mesma busca do cartão do cliente (código; sem código, documento), agora com mapa.
const lookup = createPdfPartnerLookup(partners);
for (const client of [...clients, { id: "x", code: "000200", cnpj: "33333333000133" }, { id: "y", code: "", cnpj: "" }]) {
  assert.equal(lookup(client as any), findPdfPartner(partners, client as any), `mesmo parceiro para ${client.id}`);
}
assert.deepEqual(erpPartnerPhoneNumbers(partners[0]), ["551130000001", "5511900000001", "5511900000002"]);
assert.deepEqual(erpPartnerPhoneNumbers(partners[2]), [], "texto e DDD inválido ficam fora");
assert.deepEqual(erpPartnerPhoneNumbers(null), []);

// 2) Linhas do índice: ERP e CRM, sem repetição, cliente desconhecido fora.
const entries = buildClientPhoneIndexEntries({ clients: clients as any, partners, contacts: contacts as any });
const keys = entries.map((entry) => `${entry.phone}|${entry.clientId}|${entry.source}`).sort();
assert.deepEqual(keys, [
  "551130000001|client-a|erp",
  "551130000009|client-e|crm",
  "5511900000001|client-a|erp",
  "5511900000001|client-b|erp",
  "5511900000002|client-a|crm",
  "5511900000002|client-a|erp",
  "5511900000003|client-b|erp",
  "5511900000005|client-e|crm",
  "5521980000004|client-d|erp"
]);
assert.ok(entries.every((entry) => entry.tenantId === "tenant-a"));

// Banco em memória.
const indexRows: Row[] = [];
const locks: number[] = [];
const appConfigValue = JSON.stringify(partners);
const db: any = {
  client: { findMany: async ({ where }: any = {}) => clients.filter((row) => !where?.id?.in || where.id.in.includes(row.id)).map(({ id, code, cnpj, tenantId }) => ({ id, code, cnpj, tenantId })) },
  contact: { findMany: async ({ where }: any) => contacts.filter((row) => row.clientId !== null && (!where.clientId?.in || where.clientId.in.includes(row.clientId))) },
  appConfig: { findUnique: async ({ where }: any) => (where.key === "erp.ultrafv3.partners" ? { value: appConfigValue } : null) },
  clientPhoneIndex: {
    findMany: async ({ where, take }: any) =>
      indexRows
        .filter((row) => row.phone === where.phone && clients.find((client) => client.id === row.clientId)?.isArchived === where.client.isArchived)
        .slice(0, take)
        .map(({ clientId, tenantId }) => ({ clientId, tenantId })),
    deleteMany: async ({ where }: any) => {
      const keep = indexRows.filter((row) => where?.clientId?.in && !where.clientId.in.includes(row.clientId));
      const count = indexRows.length - keep.length;
      indexRows.splice(0, indexRows.length, ...keep);
      return { count };
    },
    createMany: async ({ data, skipDuplicates }: any) => {
      assert.equal(skipDuplicates, true);
      indexRows.push(...data);
      return { count: data.length };
    }
  },
  $executeRaw: async (_strings: TemplateStringsArray, key: number) => {
    locks.push(key);
    return 1;
  },
  $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(db)
};

// 3) Reconstrução completa: troca tudo, sob o mesmo lock, e devolve só contagens.
indexRows.push({ phone: "5599999999999", clientId: "client-velho", tenantId: null, source: "erp" });
const counts = await rebuildClientPhoneIndex(db);
assert.deepEqual(counts, { clients: 5, erpEntries: 6, crmEntries: 3 });
assert.equal(indexRows.length, 9);
assert.equal(indexRows.some((row) => row.clientId === "client-velho"), false, "linha antiga some");
assert.equal(locks.length, 1);

// 4) Busca: um cliente = vínculo; dois = ambíguo; arquivado não conta; nenhum = sem cliente.
assert.deepEqual(await findClientsByPhone("5511900000003", db), { status: "linked", clientId: "client-b", tenantId: "tenant-a" });
assert.deepEqual(await findClientsByPhone("5511900000001", db), { status: "ambiguous", clientIds: ["client-a", "client-b"] });
assert.deepEqual(await findClientsByPhone("5521980000004", db), { status: "no_match" }, "só cliente arquivado");
assert.deepEqual(await findClientsByPhone("5511900000099", db), { status: "no_match" });

// 5) Atualização por cliente (contato mudou): só as linhas desse cliente.
contacts.push({ clientId: "client-c", phone: "(11) 90000-0008" });
assert.deepEqual(await refreshClientPhoneIndexForClients(["client-c", "client-c", ""], db), { clients: 1, entries: 1 });
assert.deepEqual(await findClientsByPhone("5511900000008", db), { status: "linked", clientId: "client-c", tenantId: "tenant-a" });
assert.equal(indexRows.length, 10, "os outros clientes ficaram como estavam");
assert.deepEqual(await refreshClientPhoneIndexForClients([], db), { clients: 0, entries: 0 });

// 6) Gancho em segundo plano: nada acontece com a Fase B desligada.
env.communicationsEnabled = false;
scheduleClientPhoneIndexRefresh(["client-a"], "teste");

console.log("clientPhoneIndex.test.ts: ok");
