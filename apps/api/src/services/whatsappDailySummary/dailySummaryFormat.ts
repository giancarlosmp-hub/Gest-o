import { WHATSAPP_DAILY_SUMMARY_MAX_ITEMS_PER_SECTION, type WhatsAppDailySummarySections } from "@salesforce-pro/shared";

// WhatsApp Fase D: texto do resumo diário de um vendedor. Função pura (sem banco, sem rede, sem log): recebe
// as seções já lidas e devolve o texto, ou null quando não há nada a enviar.

export type DailySummarySectionKey = keyof WhatsAppDailySummarySections;

export type DailySummaryItem = {
  clientName: string;
  city: string | null;
  state: string | null;
  stage: string;
  followUpDate: Date | null;
  /** Criada nas últimas 24 h (destacada nas reativações). */
  isNew: boolean;
  /** Só com as dicas ligadas: dados para a IA (o texto do resumo não usa). */
  tipFacts?: DailySummaryTipFacts;
};

/** Dados de uma oportunidade para as dicas do gerente comercial. Nada aqui vai para a IA sem anonimizar. */
export type DailySummaryTipFacts = {
  opportunityId: string;
  value: number;
  lastContactAt: Date | null;
  /** Última troca de etapa registrada (OpportunityChangeLog) ou, sem ela, a criação: aproximado. */
  stageSince: Date;
  crop: string | null;
  /** Produto ofertado e nomes dos itens da oportunidade. */
  products: string[];
  lastPurchaseDate: Date | null;
};

export type DailySummarySection = { total: number; newCount: number; items: DailySummaryItem[] };

export type DailySummaryData = {
  sellerName: string;
  /** Dia de Brasília (AAAA-MM-DD). */
  dayKey: string;
  /** Só as seções ligadas na configuração, na ordem de exibição. */
  sections: Partial<Record<DailySummarySectionKey, DailySummarySection>>;
};

export type DailySummaryFormatOptions = {
  /** Endereço do CRM (FRONTEND_URL); sem ele, a mensagem sai sem link. */
  crmUrl: string | null;
  /**
   * Bloco opcional "Dicas do gerente comercial" (gerado pela IA e já conferido), com a assinatura posta pelo CRM.
   * Só complementa: um resumo sem itens continua sem envio, mesmo com dicas.
   */
  managerTips?: readonly string[] | null;
};

export const DAILY_SUMMARY_SECTION_ORDER: readonly DailySummarySectionKey[] = ["reactivations", "newOpportunities", "overdueFollowUps", "todayFollowUps"];

const STAGE_LABELS: Record<string, string> = {
  prospeccao: "Prospecção",
  negociacao: "Negociação",
  proposta: "Proposta",
  ganho: "Ganho",
  perdido: "Perdido"
};

const MAX_NAME_LENGTH = 60;
const MAX_TIPS = 3;
const MAX_TIP_LENGTH = 320;
const MANAGER_TIPS_SIGNATURE = "— Claude, gerente comercial";

/** Texto de cadastro numa linha só, sem marcação do WhatsApp (* _ ~ `) e com tamanho limitado. */
export function plainText(value: string | null | undefined, maxLength = MAX_NAME_LENGTH): string {
  const text = (value ?? "").replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

const dayMonth = (date: Date) => `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

const firstName = (name: string) => plainText(name).split(" ")[0] || "";

const place = (item: DailySummaryItem) => {
  const city = plainText(item.city, 40);
  const state = plainText(item.state, 10).slice(0, 2).toUpperCase();
  return city && state ? `${city}/${state}` : city || state;
};

const itemLine = (item: DailySummaryItem, highlightNew: boolean) => {
  const parts = [plainText(item.clientName) || "Cliente sem nome", place(item), STAGE_LABELS[item.stage] ?? plainText(item.stage, 20)];
  if (item.followUpDate) parts.push(`follow-up ${dayMonth(item.followUpDate)}`);
  return `• ${highlightNew && item.isNew ? "NOVA – " : ""}${parts.filter(Boolean).join(" – ")}`;
};

const plural = (count: number, singular: string, pluralForm: string) => (count === 1 ? singular : pluralForm);

const sectionTitle = (key: DailySummarySectionKey, section: DailySummarySection) => {
  switch (key) {
    case "reactivations":
      return section.newCount > 0
        ? `*Reativações abertas* (${section.total}, ${section.newCount} ${plural(section.newCount, "nova", "novas")} nas últimas 24 h)`
        : `*Reativações abertas* (${section.total})`;
    case "newOpportunities":
      return `*Oportunidades lançadas nas últimas 24 h* (${section.total})`;
    case "overdueFollowUps":
      return `*Follow-ups vencidos* (${section.total})`;
    case "todayFollowUps":
      return `*Follow-ups de hoje* (${section.total})`;
  }
};

const crmBase = (crmUrl: string | null) => {
  const base = (crmUrl ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/\S+$/i.test(base) ? base : null;
};

/** Texto do resumo, ou null se nenhuma seção ligada tem itens (vendedor sem nada: não envia). */
export function formatDailySummary(data: DailySummaryData, options: DailySummaryFormatOptions): string | null {
  const blocks: string[] = [];
  for (const key of DAILY_SUMMARY_SECTION_ORDER) {
    const section = data.sections[key];
    if (!section || section.total <= 0) continue;
    const items = section.items.slice(0, WHATSAPP_DAILY_SUMMARY_MAX_ITEMS_PER_SECTION);
    const lines = [sectionTitle(key, section), ...items.map((item) => itemLine(item, key === "reactivations"))];
    const rest = section.total - items.length;
    if (rest > 0) lines.push(`+${rest} no CRM`);
    blocks.push(lines.join("\n"));
  }
  if (blocks.length === 0) return null;

  const tips = (options.managerTips ?? []).map((tip) => plainText(tip, MAX_TIP_LENGTH)).filter(Boolean).slice(0, MAX_TIPS);
  if (tips.length) blocks.push(["*Dicas do gerente comercial*", ...tips.map((tip) => `• ${tip}`), MANAGER_TIPS_SIGNATURE].join("\n"));

  const base = crmBase(options.crmUrl);
  if (base) {
    const links = [`Ver no CRM: ${base}/oportunidades`];
    if ((data.sections.overdueFollowUps?.total ?? 0) > 0) links.push(`Vencidos: ${base}/oportunidades?overdue=true`);
    blocks.push(links.join("\n"));
  }

  const name = firstName(data.sellerName);
  const [, month, day] = data.dayKey.split("-");
  const header = `Bom dia${name ? `, ${name}` : ""}! Resumo da sua carteira – ${day}/${month}`;
  return [header, ...blocks].join("\n\n");
}
