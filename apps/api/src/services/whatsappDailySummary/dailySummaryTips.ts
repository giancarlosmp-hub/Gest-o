import { WHATSAPP_DAILY_SUMMARY_MAX_ITEMS_PER_SECTION } from "@salesforce-pro/shared";
import { parseAiJsonObject } from "../ai/aiResponseParser.js";
import { DAILY_SUMMARY_SECTION_ORDER, plainText, type DailySummaryData, type DailySummarySectionKey } from "./dailySummaryFormat.js";

// Resumo diário: bloco "Dicas do gerente comercial" escrito pela IA. Funções puras (sem banco, sem rede, sem log).
// Privacidade: o modelo gratuito registra os dados. A IA nunca recebe nome, documento, telefone, cidade nem região
// do cliente: só um código por oportunidade (C1, C2…), etapa, dias, valor, cultura/produto, data da última compra
// (reativação) e a UF. O CRM troca os códigos pelos nomes depois de conferir a resposta.
// Conferência: qualquer falha (formato, código desconhecido, texto longo, termo proibido, cultura fora dos dados)
// descarta todas as dicas.

export const MAX_TIP_CODES = 12;
export const MAX_TIPS = 3;
export const MAX_AI_TIP_LENGTH = 250;
const DAY_MS = 86_400_000;
const OPEN_STAGES = new Set(["prospeccao", "negociacao", "proposta"]);
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

const SECTION_LABELS: Record<DailySummarySectionKey, string> = {
  reactivations: "reativacao",
  newOpportunities: "lancada_24h",
  overdueFollowUps: "follow_up_vencido",
  todayFollowUps: "follow_up_hoje"
};

export const DAILY_SUMMARY_TIPS_SYSTEM_PROMPT = [
  "Você é Claude, gerente comercial experiente do agronegócio: sementes de inverno e verão, revendas e produtores do PR, SC e MS.",
  "Escreva no máximo 3 dicas curtas (até 250 caracteres cada), práticas e acionáveis para o vendedor aplicar HOJE: o que priorizar, como abordar conforme a etapa, argumento de fechamento e atenção ao calendário agrícola do mês.",
  "Cite clientes somente pelos códigos recebidos (C1, C2...). Nunca invente código.",
  "Use apenas os dados recebidos. É proibido citar preço, valor em reais, percentual, desconto, promoção, brinde, prazo, parcelamento ou condição de pagamento.",
  "Não cite cultura nem produto que não esteja nos dados recebidos.",
  "Tom profissional e motivador, em português do Brasil. Sem assinatura, sem emojis e sem markdown.",
  "Responda somente JSON válido no formato {\"dicas\": [\"...\", \"...\"]}."
].join("\n");

export type DailySummaryTipEntry = {
  codigo: string;
  secao: string;
  etapa: string;
  valor?: number;
  diasFollowUpVencido?: number;
  diasSemContato?: number;
  diasNaEtapa?: number;
  cultura?: string;
  produtos?: string[];
  ultimaCompra?: string;
  uf?: string;
};

export type DailySummaryTipsPayload = { hoje: string; mes: string; ufs: string[]; oportunidades: DailySummaryTipEntry[] };

export type DailySummaryTipsInput = {
  payload: DailySummaryTipsPayload;
  /** Código → nome do cliente (fica no CRM, nunca vai para a IA). */
  names: Map<string, string>;
  /** Culturas que aparecem nos dados (normalizadas); a resposta não pode citar outras. */
  cultures: Set<string>;
};

/** Sem acento e em minúsculas, para comparar termos. */
const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Culturas e forrageiras do setor. A resposta só pode citar as que aparecem nos dados.
const CULTURE_TERMS = [
  "soja", "milho", "milheto", "trigo", "aveia", "azevem", "cevada", "centeio", "triticale", "sorgo", "feijao", "canola",
  "girassol", "algodao", "arroz", "braquiaria", "brachiaria", "panicum", "capim", "nabo", "ervilhaca", "crotalaria",
  "estilosantes", "tifton", "mombaca"
];
const CULTURE_PATTERN = new RegExp(`\\b(${CULTURE_TERMS.join("|")})s?\\b`, "g");
const culturesIn = (text: string) => new Set([...normalize(text).matchAll(CULTURE_PATTERN)].map((match) => match[1]));

const wholeDays = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
// Data gravada só como dia (00:00 UTC, como o follow-up e as datas do ERP) vale como está; outro horário vira o
// dia de Brasília.
const purchaseDayKey = (instant: Date) =>
  (instant.getTime() % DAY_MS === 0 ? instant : new Date(instant.getTime() - 3 * 3_600_000)).toISOString().slice(0, 10);

/** Dados anonimizados para a IA, ou null quando não há oportunidade a citar. */
export function buildDailySummaryTipsInput(data: DailySummaryData, now: Date): DailySummaryTipsInput | null {
  const todayStart = new Date(`${data.dayKey}T00:00:00.000Z`);
  const names = new Map<string, string>();
  const seen = new Set<string>();
  const entries: DailySummaryTipEntry[] = [];
  const cultureText: string[] = [];

  for (const key of DAILY_SUMMARY_SECTION_ORDER) {
    const section = data.sections[key];
    if (!section) continue;
    for (const item of section.items.slice(0, WHATSAPP_DAILY_SUMMARY_MAX_ITEMS_PER_SECTION)) {
      const facts = item.tipFacts;
      if (!facts || seen.has(facts.opportunityId) || entries.length >= MAX_TIP_CODES) continue;
      seen.add(facts.opportunityId);
      const codigo = `C${entries.length + 1}`;
      names.set(codigo, plainText(item.clientName) || "Cliente sem nome");

      const entry: DailySummaryTipEntry = { codigo, secao: SECTION_LABELS[key], etapa: item.stage };
      if (facts.value > 0) entry.valor = Math.round(facts.value);
      if (item.followUpDate && OPEN_STAGES.has(item.stage) && item.followUpDate.getTime() < todayStart.getTime()) {
        entry.diasFollowUpVencido = Math.max(1, wholeDays(item.followUpDate, todayStart));
      }
      if (facts.lastContactAt) entry.diasSemContato = wholeDays(facts.lastContactAt, now);
      entry.diasNaEtapa = wholeDays(facts.stageSince, now);
      const crop = plainText(facts.crop, 40);
      if (crop) entry.cultura = crop;
      const products = [...new Set(facts.products.map((product) => plainText(product, 60)).filter(Boolean))].slice(0, 3);
      if (products.length) entry.produtos = products;
      if (key === "reactivations" && facts.lastPurchaseDate) entry.ultimaCompra = purchaseDayKey(facts.lastPurchaseDate);
      const uf = plainText(item.state, 10).toUpperCase();
      if (/^[A-Z]{2}$/.test(uf)) entry.uf = uf;
      cultureText.push(crop, ...products);
      entries.push(entry);
    }
  }
  if (!entries.length) return null;

  const month = Number(data.dayKey.slice(5, 7));
  return {
    payload: {
      hoje: data.dayKey,
      mes: MONTHS[month - 1] ?? "",
      ufs: [...new Set(entries.flatMap((entry) => (entry.uf ? [entry.uf] : [])))].sort(),
      oportunidades: entries
    },
    names,
    cultures: culturesIn(cultureText.join(" "))
  };
}

export const dailySummaryTipsUserMessage = (input: DailySummaryTipsInput) => JSON.stringify(input.payload);

export type DailySummaryTipsDiscardReason =
  | "invalid_format"
  | "empty"
  | "too_many"
  | "too_long"
  | "unknown_code"
  | "forbidden_term"
  | "culture_not_in_data";

export type DailySummaryTipsValidation = { ok: true; tips: string[] } | { ok: false; reason: DailySummaryTipsDiscardReason };

const CODE_PATTERN = /\b[Cc](\d{1,3})\b/g;
// Preço, valor em reais, percentual, desconto, promoção, prazo e condição de pagamento (texto sem acento).
const FORBIDDEN_PATTERN =
  /r\$|%|\breais\b|\bprec[oa]s?\b|\bdesconto|\babatimento|\bpromoc|\bbrinde|\bbonifica|\bparcel|\bprazo|\bcondic(ao|oes) de pagamento|\bjuros|\bcashback|\bfrete gratis/;

/**
 * Confere a resposta da IA e devolve as dicas com os códigos trocados pelos nomes. Qualquer falha descarta tudo.
 */
export function validateDailySummaryTips(content: string, input: DailySummaryTipsInput): DailySummaryTipsValidation {
  const json = parseAiJsonObject(content);
  const parsed = json?.parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "invalid_format" };
  const keys = Object.keys(parsed);
  const list = (parsed as Record<string, unknown>).dicas;
  if (keys.length !== 1 || keys[0] !== "dicas" || !Array.isArray(list) || list.some((tip) => typeof tip !== "string")) {
    return { ok: false, reason: "invalid_format" };
  }
  const tips = (list as string[]).map((tip) => tip.replace(/\s+/g, " ").trim());
  if (!tips.length || tips.some((tip) => !tip)) return { ok: false, reason: "empty" };
  if (tips.length > MAX_TIPS) return { ok: false, reason: "too_many" };
  if (tips.some((tip) => tip.length > MAX_AI_TIP_LENGTH)) return { ok: false, reason: "too_long" };
  for (const tip of tips) {
    for (const match of tip.matchAll(CODE_PATTERN)) {
      if (!input.names.has(`C${Number(match[1])}`) || match[1].startsWith("0")) return { ok: false, reason: "unknown_code" };
    }
    const normalized = normalize(tip);
    if (FORBIDDEN_PATTERN.test(normalized)) return { ok: false, reason: "forbidden_term" };
    for (const culture of culturesIn(normalized)) {
      if (!input.cultures.has(culture)) return { ok: false, reason: "culture_not_in_data" };
    }
  }
  return { ok: true, tips: tips.map((tip) => tip.replace(CODE_PATTERN, (_code, digits: string) => input.names.get(`C${Number(digits)}`)!)) };
}
