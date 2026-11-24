import { MarketingConsentStatus, type PrismaClient } from "@prisma/client";
import { normalizeBrazilPhone } from "@salesforce-pro/shared";

// Card "Boletins WhatsApp" da ficha do cliente: telefones do cliente com a situação atual e o histórico de
// aceite/descadastro, e as culturas do cliente (catálogo técnico CultureCatalog).

type ConsentReadDb = Pick<PrismaClient, "clientPhoneIndex" | "marketingConsentEvent">;

export type BulletinPhoneHistoryItem = {
  id: string;
  status: MarketingConsentStatus;
  source: string;
  note: string | null;
  createdAt: Date;
  recordedByName: string | null;
};

export type BulletinPhone = {
  /** Linha do ClientPhoneIndex (referência para registrar); null = telefone só no histórico, sem registro manual. */
  phoneRef: string | null;
  display: string;
  sources: string[];
  current: { status: MarketingConsentStatus; source: string; createdAt: Date } | null;
  canReceive: boolean;
  history: BulletinPhoneHistoryItem[];
};

const HISTORY_LIMIT = 200;

const displayOf = (phone: string) => {
  const parsed = normalizeBrazilPhone(phone);
  return parsed.valid ? parsed.display : phone;
};

/**
 * Telefones do índice do cliente (ERP antes dos contatos do CRM) e os do histórico ligado ao cliente.
 * O histórico de cada telefone é o do tenant inteiro (o aceite é do telefone, não do cliente).
 */
export async function readClientBulletinPhones(db: ConsentReadDb, input: { tenantId: string; clientId: string }): Promise<BulletinPhone[]> {
  const indexRows = await db.clientPhoneIndex.findMany({
    where: { clientId: input.clientId },
    orderBy: [{ source: "desc" }, { id: "asc" }],
    select: { id: true, phone: true, source: true },
  });
  const linkedRows = await db.marketingConsentEvent.findMany({
    where: { tenantId: input.tenantId, clientId: input.clientId },
    select: { phone: true },
    distinct: ["phone"],
    take: HISTORY_LIMIT,
  });

  const byPhone = new Map<string, { phoneRef: string | null; sources: Set<string> }>();
  for (const row of indexRows) {
    const entry = byPhone.get(row.phone);
    if (entry) entry.sources.add(row.source);
    else byPhone.set(row.phone, { phoneRef: row.id, sources: new Set([row.source]) });
  }
  for (const row of linkedRows) if (!byPhone.has(row.phone)) byPhone.set(row.phone, { phoneRef: null, sources: new Set() });
  if (!byPhone.size) return [];

  const events = await db.marketingConsentEvent.findMany({
    where: { tenantId: input.tenantId, phone: { in: [...byPhone.keys()] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, phone: true, status: true, source: true, note: true, createdAt: true, recordedBy: { select: { name: true } } },
    take: HISTORY_LIMIT * byPhone.size,
  });
  const historyByPhone = new Map<string, BulletinPhoneHistoryItem[]>();
  for (const event of events) {
    const list = historyByPhone.get(event.phone) ?? [];
    if (list.length < HISTORY_LIMIT) {
      list.push({ id: event.id, status: event.status, source: event.source, note: event.note, createdAt: event.createdAt, recordedByName: event.recordedBy?.name ?? null });
    }
    historyByPhone.set(event.phone, list);
  }

  return [...byPhone.entries()].map(([phone, entry]) => {
    const history = historyByPhone.get(phone) ?? [];
    const latest = history[0] ?? null;
    return {
      phoneRef: entry.phoneRef,
      display: displayOf(phone),
      sources: [...entry.sources].sort().reverse(),
      current: latest ? { status: latest.status, source: latest.source, createdAt: latest.createdAt } : null,
      canReceive: latest?.status === MarketingConsentStatus.ACEITE,
      history,
    };
  });
}

type CulturesDb = Pick<PrismaClient, "clientCulture" | "cultureCatalog">;

export type ClientCulturesView = {
  selected: Array<{ id: string; label: string; isActive: boolean }>;
  options: Array<{ id: string; label: string; category: string }>;
};

export async function readClientCultures(db: CulturesDb, clientId: string): Promise<ClientCulturesView> {
  const [links, options] = await Promise.all([
    db.clientCulture.findMany({
      where: { clientId },
      select: { culture: { select: { id: true, label: true, isActive: true } } },
    }),
    db.cultureCatalog.findMany({
      where: { isActive: true },
      orderBy: [{ label: "asc" }],
      select: { id: true, label: true, category: true },
    }),
  ]);
  const selected = links.map((link) => link.culture).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  return { selected, options };
}

export type ReplaceClientCulturesResult = { ok: true } | { ok: false; reason: "unknown_culture" | "inactive_culture" };

/**
 * Troca as culturas do cliente pela lista enviada. Só culturas ativas do catálogo podem entrar; uma cultura
 * desativada que o cliente já tinha pode continuar.
 */
export async function replaceClientCultures(
  db: CulturesDb & { $transaction: PrismaClient["$transaction"] },
  input: { clientId: string; cultureIds: string[] }
): Promise<ReplaceClientCulturesResult> {
  const wanted = [...new Set(input.cultureIds)];
  const [catalog, current] = await Promise.all([
    wanted.length ? db.cultureCatalog.findMany({ where: { id: { in: wanted } }, select: { id: true, isActive: true } }) : Promise.resolve([]),
    db.clientCulture.findMany({ where: { clientId: input.clientId }, select: { cultureId: true } }),
  ]);
  if (catalog.length !== wanted.length) return { ok: false, reason: "unknown_culture" };
  const currentIds = new Set(current.map((row) => row.cultureId));
  if (catalog.some((row) => !row.isActive && !currentIds.has(row.id))) return { ok: false, reason: "inactive_culture" };

  const toAdd = wanted.filter((id) => !currentIds.has(id));
  const toRemove = [...currentIds].filter((id) => !wanted.includes(id));
  await db.$transaction([
    db.clientCulture.deleteMany({ where: { clientId: input.clientId, cultureId: { in: toRemove } } }),
    db.clientCulture.createMany({ data: toAdd.map((cultureId) => ({ clientId: input.clientId, cultureId })), skipDuplicates: true }),
  ]);
  return { ok: true };
}
