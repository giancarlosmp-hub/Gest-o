import { splitPhoneField } from "@salesforce-pro/shared";
import type { Client, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../config/prisma.js";
import { logApiEvent } from "../../utils/logger.js";
import { erpPartnerPhoneNumbers } from "../clientErpContacts.js";
import { createPdfPartnerLookup, getStoredErpPartnerRows } from "../erpOrderPdfService.js";
import { isWhatsAppMessagesEnabled } from "../whatsappConnection/config.js";
import { normalizeWhatsAppContactPhone } from "../whatsappConnection/phoneMatch.js";

// WhatsApp Fase B: índice telefone (55 + DDD + número) → cliente, montado a partir dos telefones do ERP
// (cache do /partners, mesma busca do cartão do cliente) e dos contatos do CRM. Nunca é a fonte do dado:
// é reconstruído por completo (diariamente e depois de cada sincronização de parceiros) e atualizado por
// cliente quando contatos, código ou documento mudam. Cliente arquivado fica no índice e é descartado na
// busca. Nada daqui vai para log além de contagens.

export type ClientPhoneSource = "erp" | "crm";
export type ClientPhoneIndexEntry = { phone: string; clientId: string; tenantId: string | null; source: ClientPhoneSource };

type IndexClient = Pick<Client, "id" | "code" | "cnpj" | "tenantId">;
type IndexContact = { clientId: string | null; phone: string | null };

/** Monta as linhas do índice (sem repetição por telefone, cliente e origem). Função pura. */
export function buildClientPhoneIndexEntries(input: {
  clients: IndexClient[];
  partners: Record<string, unknown>[];
  contacts: IndexContact[];
}): ClientPhoneIndexEntry[] {
  const entries = new Map<string, ClientPhoneIndexEntry>();
  const add = (phone: string, client: IndexClient, source: ClientPhoneSource) => {
    const key = `${phone}|${client.id}|${source}`;
    if (!entries.has(key)) entries.set(key, { phone, clientId: client.id, tenantId: client.tenantId ?? null, source });
  };
  const clientsById = new Map(input.clients.map((client) => [client.id, client]));
  const findPartner = createPdfPartnerLookup(input.partners);
  for (const client of input.clients) {
    for (const phone of erpPartnerPhoneNumbers(findPartner(client))) add(phone, client, "erp");
  }
  for (const contact of input.contacts) {
    const client = contact.clientId ? clientsById.get(contact.clientId) : undefined;
    if (!client) continue;
    for (const raw of splitPhoneField(contact.phone ?? "")) {
      const phone = normalizeWhatsAppContactPhone(raw);
      if (phone) add(phone, client, "crm");
    }
  }
  return [...entries.values()];
}

type IndexDb = Pick<PrismaClient, "client" | "contact" | "appConfig" | "clientPhoneIndex" | "$transaction">;

const CHUNK = 1_000;
const clientSelect = { id: true, code: true, cnpj: true, tenantId: true } as const;
// Duas reconstruções nunca rodam juntas (chave fixa do advisory lock da transação).
const REBUILD_LOCK_KEY = 726_100_501;

async function insertEntries(tx: Pick<PrismaClient, "clientPhoneIndex">, entries: ClientPhoneIndexEntry[]) {
  for (let start = 0; start < entries.length; start += CHUNK) {
    await tx.clientPhoneIndex.createMany({ data: entries.slice(start, start + CHUNK), skipDuplicates: true });
  }
}

/** Reconstrói o índice inteiro numa transação. Devolve só contagens. */
export async function rebuildClientPhoneIndex(db: IndexDb = defaultPrisma) {
  const [clients, partners, contacts] = await Promise.all([
    db.client.findMany({ select: clientSelect }),
    getStoredErpPartnerRows(db),
    db.contact.findMany({ where: { clientId: { not: null } }, select: { clientId: true, phone: true } })
  ]);
  const entries = buildClientPhoneIndexEntries({ clients, partners, contacts });
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REBUILD_LOCK_KEY})`;
      await tx.clientPhoneIndex.deleteMany({});
      await insertEntries(tx, entries);
    },
    { timeout: 60_000 }
  );
  return {
    clients: clients.length,
    erpEntries: entries.filter((entry) => entry.source === "erp").length,
    crmEntries: entries.filter((entry) => entry.source === "crm").length
  };
}

/** Recalcula as linhas de alguns clientes (contato criado, editado ou apagado; código ou documento trocado; mescla). */
export async function refreshClientPhoneIndexForClients(clientIds: string[], db: IndexDb = defaultPrisma) {
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!ids.length) return { clients: 0, entries: 0 };
  const [clients, partners, contacts] = await Promise.all([
    db.client.findMany({ where: { id: { in: ids } }, select: clientSelect }),
    getStoredErpPartnerRows(db),
    db.contact.findMany({ where: { clientId: { in: ids } }, select: { clientId: true, phone: true } })
  ]);
  const entries = buildClientPhoneIndexEntries({ clients, partners, contacts });
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REBUILD_LOCK_KEY})`;
    await tx.clientPhoneIndex.deleteMany({ where: { clientId: { in: ids } } });
    await insertEntries(tx, entries);
  });
  return { clients: clients.length, entries: entries.length };
}

export type ClientPhoneMatch =
  | { status: "linked"; clientId: string; tenantId: string | null }
  | { status: "ambiguous"; clientIds: string[] }
  | { status: "no_match" };

/** Clientes não arquivados com esse telefone: um só = vínculo; mais de um = ambíguo (vai para a fila). */
export async function findClientsByPhone(phone: string, db: Pick<PrismaClient, "clientPhoneIndex"> = defaultPrisma): Promise<ClientPhoneMatch> {
  const rows = await db.clientPhoneIndex.findMany({
    where: { phone, client: { isArchived: false } },
    select: { clientId: true, tenantId: true },
    take: 50
  });
  const ids = [...new Set(rows.map((row) => row.clientId))];
  if (ids.length === 0) return { status: "no_match" };
  if (ids.length > 1) return { status: "ambiguous", clientIds: ids.sort() };
  return { status: "linked", clientId: ids[0], tenantId: rows[0].tenantId ?? null };
}

/**
 * Gancho das rotas e serviços que mudam contatos ou a identificação do cliente: atualiza o índice em
 * segundo plano, só com a Fase B ligada. Falha não derruba a requisição (a reconstrução diária corrige).
 */
export function scheduleClientPhoneIndexRefresh(clientIds: Array<string | null | undefined>, reason: string) {
  if (!isWhatsAppMessagesEnabled()) return;
  const ids = clientIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (!ids.length) return;
  void refreshClientPhoneIndexForClients(ids).catch((error: unknown) => {
    logApiEvent("WARN", "[whatsapp] phone index refresh failed", { reason, clients: ids.length, error: error instanceof Error ? error.name : "unknown" });
  });
}

let rebuildRunning = false;
let rebuildPending = false;

/**
 * Gancho da sincronização de parceiros: reconstrução completa em segundo plano, só com a Fase B ligada.
 * Uma rodada de vários vendedores grava o cache várias vezes: pedidos durante uma reconstrução viram uma
 * só reconstrução a mais, no fim.
 */
export function scheduleClientPhoneIndexRebuild(reason: string) {
  if (!isWhatsAppMessagesEnabled()) return;
  if (rebuildRunning) {
    rebuildPending = true;
    return;
  }
  rebuildRunning = true;
  void rebuildClientPhoneIndex()
    .then((counts) => logApiEvent("INFO", "[whatsapp] phone index rebuilt", { reason, ...counts }))
    .catch((error: unknown) => {
      logApiEvent("WARN", "[whatsapp] phone index rebuild failed", { reason, error: error instanceof Error ? error.name : "unknown" });
    })
    .finally(() => {
      rebuildRunning = false;
      if (rebuildPending) {
        rebuildPending = false;
        scheduleClientPhoneIndexRebuild(reason);
      }
    });
}
