import { EventType, MarketingConsentSource, MarketingConsentStatus, type Prisma } from "@prisma/client";
import { MARKETING_CONSENT_SOURCE_LABELS, normalizeBrazilPhone } from "@salesforce-pro/shared";

// Campanhas WhatsApp Fase 1: aceite e descadastro dos boletins de marketing.
// - Histórico só de inclusão por telefone (55 + DDD + número) e tenant: nunca é apagado nem editado.
// - A situação atual é o registro mais recente do telefone; canReceiveMarketing é a ÚNICA regra que a
//   Fase 2 (envio) pode usar para decidir se o telefone recebe campanha.
// - Nada aqui grava log: o telefone nunca sai do banco por este módulo.

/** Payload do botão de resposta rápida dos modelos de marketing que descadastra. */
export const OPT_OUT_BUTTON_PAYLOAD = "OPT_OUT_MARKETING";

/** Frase do link wa.me de aceite (texto já preenchido para o cliente enviar). */
export const OPT_IN_PHRASE = "Quero receber os boletins da Demetra";

const stripAccents = (value: string) => value.normalize("NFD").replace(/\p{M}+/gu, "");

/**
 * Aceite: ignora acentos, maiúsculas e espaços; pontuação só nas pontas. Espaços repetidos no meio viram um.
 * "  quero receber os boletins da demetra!! " → "quero receber os boletins da demetra".
 */
export function normalizeOptInText(text: string): string {
  return stripAccents(text)
    .toLowerCase()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .replace(/\s+/g, " ");
}

/**
 * Descadastro: ignora acentos, maiúsculas, espaços, pontuação e emojis em qualquer posição (tudo que não é
 * letra nem número vira espaço). "Não quero receber 🙏" → "nao quero receber"; "PARAR!!!" → "parar".
 */
export function normalizeOptOutText(text: string): string {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const OPT_IN_NORMALIZED = normalizeOptInText(OPT_IN_PHRASE);
const OPT_OUT_WORDS = new Set(
  ["parar", "sair", "cancelar", "descadastrar", "remover", "stop", "não quero receber", "não quero mais receber"].map(normalizeOptOutText)
);

export type InboundConsentDecision = { status: MarketingConsentStatus; source: MarketingConsentSource } | null;

/** Mensagem recebida no número oficial → aceite, descadastro ou nada. A mensagem tem de ser só a frase/palavra. */
export function classifyInboundConsent(input: { text?: string | null; buttonPayload?: string | null }): InboundConsentDecision {
  if (typeof input.buttonPayload === "string" && input.buttonPayload.trim() === OPT_OUT_BUTTON_PAYLOAD) {
    return { status: MarketingConsentStatus.DESCADASTRO, source: MarketingConsentSource.WHATSAPP_BOTAO };
  }
  if (typeof input.text !== "string" || !input.text.trim()) return null;
  if (normalizeOptInText(input.text) === OPT_IN_NORMALIZED) {
    return { status: MarketingConsentStatus.ACEITE, source: MarketingConsentSource.WHATSAPP_LINK };
  }
  if (OPT_OUT_WORDS.has(normalizeOptOutText(input.text))) {
    return { status: MarketingConsentStatus.DESCADASTRO, source: MarketingConsentSource.WHATSAPP_PALAVRA };
  }
  return null;
}

/** Telefone brasileiro em 55 + DDD + número (celular com o nono dígito), ou null. */
export function normalizeConsentPhone(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const phone = normalizeBrazilPhone(value);
  return phone.valid ? phone.e164 : null;
}

type ConsentEventRow = { status: MarketingConsentStatus; source: MarketingConsentSource; createdAt: Date };
type LatestDb = {
  marketingConsentEvent: {
    findFirst(args: Prisma.MarketingConsentEventFindFirstArgs): Promise<ConsentEventRow | null>;
  };
};

/** Mais recente primeiro; o id desempata registros no mesmo milissegundo. */
const LATEST_FIRST: Prisma.MarketingConsentEventOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];

/** Situação atual do telefone no tenant: o registro mais recente, ou null se nunca houve registro. */
export async function currentMarketingConsent(db: LatestDb, tenantId: string, phone: string): Promise<ConsentEventRow | null> {
  const normalized = normalizeConsentPhone(phone);
  if (!tenantId || !normalized) return null;
  return db.marketingConsentEvent.findFirst({
    where: { tenantId, phone: normalized },
    orderBy: LATEST_FIRST,
    select: { status: true, source: true, createdAt: true },
  });
}

/** Pode receber marketing? Sim só quando o registro mais recente do telefone no tenant é ACEITE. */
export async function canReceiveMarketing(db: LatestDb, tenantId: string, phone: string): Promise<boolean> {
  const latest = await currentMarketingConsent(db, tenantId, phone);
  return latest?.status === MarketingConsentStatus.ACEITE;
}

const STATUS_TEXT: Record<MarketingConsentStatus, string> = {
  ACEITE: "Aceite dos boletins WhatsApp",
  DESCADASTRO: "Descadastro dos boletins WhatsApp",
};

/** Texto da linha do tempo: sem telefone e sem a observação. */
export function consentTimelineDescription(status: MarketingConsentStatus, source: MarketingConsentSource, recordedByName?: string | null) {
  const origin = MARKETING_CONSENT_SOURCE_LABELS[source];
  return recordedByName
    ? `${STATUS_TEXT[status]} registrado por ${recordedByName} (${origin}).`
    : `${STATUS_TEXT[status]} recebido pelo WhatsApp oficial (${origin}).`;
}

type RecordDb = {
  marketingConsentEvent: { create(args: Prisma.MarketingConsentEventCreateArgs): Promise<{ id: string }> };
  client: { findFirst(args: Prisma.ClientFindFirstArgs): Promise<{ id: string; ownerSellerId: string } | null> };
  timelineEvent: { create(args: Prisma.TimelineEventCreateArgs): Promise<unknown> };
};

export type RecordMarketingConsentInput = {
  tenantId: string;
  phone: string;
  clientId: string | null;
  status: MarketingConsentStatus;
  source: MarketingConsentSource;
  note?: string | null;
  recordedBy?: { id: string; name: string } | null;
};

/**
 * Grava um registro novo (nunca altera os anteriores). Com cliente do mesmo tenant, também grava o evento
 * "comentario" na linha do tempo do cliente, em nome do vendedor dono da carteira.
 */
export async function recordMarketingConsent(db: RecordDb, input: RecordMarketingConsentInput): Promise<{ id: string; phone: string; clientId: string | null }> {
  const phone = normalizeConsentPhone(input.phone);
  if (!input.tenantId || !phone) throw Object.assign(new Error("Telefone inválido para o aceite de boletins."), { status: 400 });
  const client = input.clientId
    ? await db.client.findFirst({ where: { id: input.clientId, tenantId: input.tenantId }, select: { id: true, ownerSellerId: true } })
    : null;
  const created = await db.marketingConsentEvent.create({
    data: {
      tenantId: input.tenantId,
      phone,
      clientId: client?.id ?? null,
      status: input.status,
      source: input.source,
      note: input.note ? input.note.slice(0, 280) : null,
      recordedById: input.recordedBy?.id ?? null,
    },
    select: { id: true },
  });
  if (client) {
    await db.timelineEvent.create({
      data: {
        type: EventType.comentario,
        description: consentTimelineDescription(input.status, input.source, input.recordedBy?.name ?? null),
        clientId: client.id,
        ownerSellerId: client.ownerSellerId,
      },
    });
  }
  return { id: created.id, phone, clientId: client?.id ?? null };
}

type InboundDb = RecordDb & {
  clientPhoneIndex: { findMany(args: Prisma.ClientPhoneIndexFindManyArgs): Promise<Array<{ clientId: string }>> };
};

/**
 * Webhook de entrada do número oficial (Cloud API): só processa, nunca responde. O cliente vem do
 * ClientPhoneIndex do mesmo tenant (cliente não arquivado); nenhum ou mais de um cliente → grava sem cliente.
 */
export async function processInboundMarketingConsent(
  db: InboundDb,
  input: { tenantId: string | null | undefined; phone: string | null | undefined; text?: string | null; buttonPayload?: string | null }
): Promise<"accepted" | "opted_out" | "ignored"> {
  const decision = classifyInboundConsent(input);
  if (!decision) return "ignored";
  const phone = normalizeConsentPhone(input.phone);
  if (!input.tenantId || !phone) return "ignored";
  const rows = await db.clientPhoneIndex.findMany({
    where: { phone, client: { tenantId: input.tenantId, isArchived: false } },
    select: { clientId: true },
    take: 50,
  });
  const clientIds = [...new Set(rows.map((row) => row.clientId))];
  await recordMarketingConsent(db, {
    tenantId: input.tenantId,
    phone,
    clientId: clientIds.length === 1 ? clientIds[0] : null,
    status: decision.status,
    source: decision.source,
  });
  return decision.status === MarketingConsentStatus.ACEITE ? "accepted" : "opted_out";
}
