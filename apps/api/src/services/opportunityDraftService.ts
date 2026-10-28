import { z } from "zod";
import type { Prisma, Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";
import { brazilTodayKey, shiftDayKey } from "../utils/dateRange.js";
import { aiService } from "./ai/aiService.js";
import { timeAiStage } from "./ai/aiTimeBudget.js";
import { parseAiJsonObject } from "./ai/aiResponseParser.js";
import { calculateOpportunityPriceForTable, isOpportunityProductSelectable } from "./opportunityPriceService.js";
import { isSynchronizedProduct, loadOpportunityPriceRules } from "./opportunityPriceRules.js";
import {
  defaultFollowUpDate,
  foldText,
  meaningfulWords,
  parseDraftText,
  parseObservationDate,
  type DraftPriceTable,
  type DraftStage,
  type ObservationDate,
  type SpokenItem,
  type SpokenPrice
} from "./opportunityDraftParser.js";

// Rascunho de oportunidade a partir da frase ditada (fase 1: só interpreta, não grava). Regras fixas primeiro; a IA só
// entra quando elas não acham cliente ou produto/valor, ou quando a observação cita uma data que elas não entendem.
// A IA recebe só a frase (até 300 caracteres), nenhum dado do banco, e a resposta passa pelo Zod.

export const DRAFT_STAGE_PROBABILITY: Record<DraftStage, number> = { prospeccao: 20, negociacao: 50, proposta: 70 };
const STAGE_LABELS: Record<string, string> = { prospeccao: "Prospecção", negociacao: "Negociação", proposta: "Proposta", ganho: "Ganho", perdido: "Perdido" };
const PRICE_TABLE_LABELS: Record<DraftPriceTable, string> = { "1": "Tabela 1", "2": "Tabela 2" };
const MAX_CANDIDATES = 5;
const AI_TEXT_LIMIT = 300;
const WEEKDAY_LABELS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

const requestSchema = z.object({ text: z.string().trim().min(3).max(1000) }).strict();

const aiDraftSchema = z.object({
  clientName: z.string().trim().min(1).max(120).nullable().optional(),
  city: z.string().trim().min(1).max(80).nullable().optional(),
  stage: z.enum(["prospeccao", "negociacao", "proposta", "ganho", "perdido"]).nullable().optional(),
  priceTable: z.enum(["1", "2"]).nullable().optional(),
  products: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    kg: z.number().positive().max(1000).nullable().optional(),
    sacks: z.number().positive().max(1_000_000).nullable().optional(),
    price: z.number().positive().max(1_000_000).nullable().optional()
  })).max(10).nullable().optional(),
  value: z.number().positive().max(1_000_000_000).nullable().optional(),
  followUpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
});
type AiDraft = z.infer<typeof aiDraftSchema>;

export type OpportunityDraftViewer = { id: string; role: Role | string };
export type OpportunityDraftScope = { tenantId: string; clientScope: Prisma.ClientWhereInput };
export type DraftWarning = { code: string; field: string; message: string };
type SuggestedOwner = { id: string; name: string } | null;
export type DraftClientCandidate = { id: string; name: string; fantasyName: string | null; city: string | null; state: string | null; score: number; suggestedOwner: SuggestedOwner; ownerPending: boolean };
export type DraftProductCandidate = {
  productId: string;
  name: string;
  className: string | null;
  brand: string | null;
  unit: string | null;
  weightKg: number | null;
  tablePrice: number;
  unitPrice: number;
  total: number | null;
  priceDiffPercent: number | null;
  score: number;
};
export type DraftItem = { spokenName: string; kg: number | null; quantity: number | null; price: SpokenPrice; candidates: DraftProductCandidate[] };
export type OpportunityDraft = {
  client: { spokenName: string | null; spokenCity: string | null; candidates: DraftClientCandidate[] };
  owner: { mode: "self"; sellerId: string } | { mode: "client_owner" };
  title: string;
  stage: { value: DraftStage; label: string };
  probability: number;
  priceTable: { code: DraftPriceTable; label: string };
  items: DraftItem[];
  value: { amount: number | null; source: "items" | "spoken" | null };
  proposalDate: string;
  followUp: { date: string; source: "default" | "observation"; suggestedByAi: boolean };
  expectedCloseDate: string;
  notes: string | null;
  warnings: DraftWarning[];
  pendingFields: string[];
  aiFields: string[];
  source: "ai" | "deterministic";
};

const formatMoney = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const formatDayKey = (dayKey: string) => dayKey.split("-").reverse().join("/");
const titleCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const unique = <T>(values: T[]) => [...new Set(values)];

// Palavra falada contra palavra do cadastro: igual vale 2; parecida (prefixo ou até 1–2 letras trocadas, como
// "braquiaria" x "brachiaria") vale 1.
const editDistance = (left: string, right: string) => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
};
const wordScore = (spoken: string, tokens: string[]) => {
  if (tokens.includes(spoken)) return 2;
  const similar = tokens.some((token) =>
    (spoken.length >= 4 && token.length >= 4 && (token.startsWith(spoken) || spoken.startsWith(token)))
    || (Math.min(spoken.length, token.length) >= 5 && editDistance(spoken, token) <= (spoken.length >= 8 ? 2 : 1))
  );
  return similar ? 1 : 0;
};
const tokensOf = (text: string | null | undefined): string[] => foldText(text ?? "").match(/[a-z0-9]+/g) ?? [];

// Busca por "contains" no banco: a palavra como foi dita (com acento) e sem acento.
const searchTerms = (text: string, minLength: number) =>
  unique(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .flatMap((word) => [word, foldText(word)])
      .filter((word) => word.length >= minLength && meaningfulWords(word).length > 0)
  );

const readWeightKg = (rawErpPayload: Prisma.JsonValue | null) => {
  if (!rawErpPayload || typeof rawErpPayload !== "object" || Array.isArray(rawErpPayload)) return null;
  const raw = (rawErpPayload as Record<string, unknown>).PESO_PRODUTO;
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const text = String(raw).trim();
  const parsed = Number(text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const clientSelect = (tenantId: string) => ({
  id: true,
  name: true,
  fantasyName: true,
  city: true,
  state: true,
  ownerSeller: {
    select: { id: true, name: true, role: true, isActive: true, tenantMemberships: { where: { tenantId, status: "active" as const }, select: { tenantId: true } } }
  }
});

export class OpportunityDraftService {
  async parse(raw: unknown, viewer: OpportunityDraftViewer, scope: OpportunityDraftScope): Promise<OpportunityDraft> {
    const { text } = requestSchema.parse(raw);
    const today = brazilTodayKey();
    const parsed = parseDraftText(text, today);
    const warnings: DraftWarning[] = [];
    const aiFields: string[] = [];

    let clientName = parsed.clientName;
    let clientCity = parsed.clientCity;
    let stage = parsed.stage;
    let refusedStage = parsed.refusedStage;
    let priceTable = parsed.priceTable;
    let spokenItems: SpokenItem[] = parsed.items;
    let spokenValue = parsed.value;
    let observationDate: ObservationDate | null = parsed.observationDate;

    // Fora do padrão: sem cliente, ou falou de sacas/quilos/dinheiro que as regras não leram como produto ou valor.
    const needsFields = !clientName || (spokenItems.length === 0 && spokenValue === null && parsed.productOrValueHint);
    const needsDate = Boolean(parsed.notes) && !observationDate && parsed.observationHasDateHint;
    if (needsFields || needsDate) {
      const ai = await timeAiStage("interpret", () => this.askAi(needsFields ? text : parsed.notes ?? text, today, viewer));
      if (!ai) {
        warnings.push({ code: "ai_unavailable", field: "text", message: "Não consegui interpretar toda a frase. Confira os campos pendentes." });
      } else {
        if (needsFields && !clientName && ai.clientName) {
          clientName = ai.clientName;
          aiFields.push("clientName");
          if (!clientCity && ai.city) { clientCity = ai.city; aiFields.push("clientCity"); }
        }
        if (needsFields && !stage && !refusedStage && !parsed.stageUnrecognized && ai.stage) {
          if (ai.stage === "ganho" || ai.stage === "perdido") refusedStage = ai.stage;
          else stage = ai.stage;
          aiFields.push("stage");
        }
        if (needsFields && !priceTable && ai.priceTable) { priceTable = ai.priceTable; aiFields.push("priceTable"); }
        if (needsFields && spokenItems.length === 0 && ai.products?.length) {
          spokenItems = ai.products.map((product) => ({
            spokenName: product.name,
            words: meaningfulWords(product.name),
            kg: product.kg ?? null,
            quantity: product.sacks ?? null,
            price: product.price ? { mode: "informed" as const, amount: product.price } : { mode: "registered" as const }
          }));
          aiFields.push("items");
        }
        if (needsFields && spokenItems.length === 0 && spokenValue === null && ai.value) { spokenValue = ai.value; aiFields.push("value"); }
        if (needsDate && ai.followUpDate) {
          const [year, month, day] = ai.followUpDate.split("-").map(Number);
          const valid = parseObservationDate(`${day}/${month}/${year}`, today);
          if (valid) { observationDate = valid; if (valid.kind === "date") aiFields.push("followUpDate"); }
        }
      }
    }

    if (refusedStage) {
      warnings.push({ code: "stage_refused", field: "stage", message: `Etapa "${STAGE_LABELS[refusedStage]}" não pode ser usada numa oportunidade nova; ficou Prospecção.` });
    } else if (parsed.stageUnrecognized && !stage) {
      warnings.push({ code: "stage_unrecognized", field: "stage", message: "Etapa não reconhecida; ficou Prospecção. Use prospecção, negociação ou proposta." });
    }
    const finalStage: DraftStage = stage ?? "prospeccao";
    if (parsed.priceTableUnrecognized && !priceTable) {
      warnings.push({ code: "price_table_unrecognized", field: "priceTable", message: "Tabela não reconhecida; ficou a Tabela 1." });
    }
    const finalTable: DraftPriceTable = priceTable ?? "1";

    const [clientCandidates, items] = await Promise.all([
      timeAiStage("clients", () => this.findClients(clientName, clientCity, viewer, scope)),
      timeAiStage("products", () => this.findProducts(spokenItems, finalTable))
    ]);

    // Cliente e produto ficam pendentes até o vendedor escolher um candidato, mesmo com um só.
    const pendingFields: string[] = ["clientId"];
    if (!clientCandidates.length) {
      warnings.push({ code: "client_not_found", field: "clientId", message: clientName ? "Cliente a definir: nenhum cliente da sua carteira bate com o nome falado." : "Cliente a definir: o nome do cliente não foi dito." });
    }
    const owner: OpportunityDraft["owner"] = viewer.role === "vendedor" ? { mode: "self", sellerId: viewer.id } : { mode: "client_owner" };
    if (owner.mode === "client_owner") {
      pendingFields.push("ownerSellerId");
      if (clientCandidates.some((candidate) => candidate.ownerPending)) {
        warnings.push({ code: "owner_pending", field: "ownerSellerId", message: "Responsável pendente em algum cliente sugerido: o dono do cliente não é vendedor ativo neste ambiente." });
      }
    }

    items.forEach((item, index) => {
      const position = items.length > 1 ? ` (item ${index + 1})` : "";
      pendingFields.push(`items.${index}.productId`);
      if (!item.candidates.length) {
        warnings.push({ code: "product_not_found", field: `items.${index}.productId`, message: `Produto "${item.spokenName || "sem nome"}"${position} não encontrado com preço válido na ${PRICE_TABLE_LABELS[finalTable]}.` });
      }
      if (item.quantity === null) {
        pendingFields.push(`items.${index}.quantity`);
        warnings.push({ code: "quantity_missing", field: `items.${index}.quantity`, message: `Quantidade de sacas não informada${position}.` });
      }
      const top = item.candidates[0];
      if (item.price.mode === "informed" && top && top.priceDiffPercent !== null && top.priceDiffPercent !== 0) {
        const direction = top.priceDiffPercent < 0 ? "abaixo" : "acima";
        warnings.push({
          code: "price_differs",
          field: `items.${index}.unitPrice`,
          message: `Preço informado ${formatMoney(item.price.amount)}${position} está ${Math.abs(top.priceDiffPercent).toLocaleString("pt-BR")}% ${direction} do preço da ${PRICE_TABLE_LABELS[finalTable]} (${formatMoney(top.tablePrice)}) para o 1º produto sugerido.`
        });
      }
    });

    let value: OpportunityDraft["value"] = { amount: null, source: null };
    if (items.length) {
      const totals = items.map((item) => item.candidates[0]?.total ?? null);
      value = totals.every((total) => total !== null)
        ? { amount: Number(totals.reduce((sum, total) => sum + (total ?? 0), 0).toFixed(2)), source: "items" }
        : { amount: null, source: null };
      if (value.amount === null) pendingFields.push("value");
      if (spokenValue !== null) warnings.push({ code: "value_ignored", field: "value", message: "Valor falado não usado: com produtos, o valor vem da soma dos itens." });
    } else if (spokenValue !== null) {
      value = { amount: spokenValue, source: "spoken" };
    } else {
      pendingFields.push("value");
      warnings.push({ code: "value_missing", field: "value", message: "Sem produto e sem valor: informe o valor da oportunidade." });
    }

    let followUp: OpportunityDraft["followUp"] = { date: defaultFollowUpDate(today), source: "default", suggestedByAi: false };
    if (observationDate?.kind === "date") {
      followUp = { date: observationDate.date, source: "observation", suggestedByAi: true };
    } else if (observationDate?.kind === "past") {
      warnings.push({ code: "followup_past_ignored", field: "followUpDate", message: `A data citada na observação (${formatDayKey(observationDate.date)}) já passou; o retorno ficou em ${formatDayKey(followUp.date)}.` });
    }

    const clientLabel = clientName ? titleCase(clientName) : "Cliente a definir";
    const productLabel = spokenItems[0]?.spokenName ? titleCase(spokenItems[0].spokenName).slice(0, 60).trim() : null;
    const draft: OpportunityDraft = {
      client: { spokenName: clientName, spokenCity: clientCity, candidates: clientCandidates },
      owner,
      title: productLabel ? `${productLabel} – ${clientLabel}` : `Oportunidade – ${clientLabel}`,
      stage: { value: finalStage, label: STAGE_LABELS[finalStage] },
      probability: DRAFT_STAGE_PROBABILITY[finalStage],
      priceTable: { code: finalTable, label: PRICE_TABLE_LABELS[finalTable] },
      items,
      value,
      proposalDate: today,
      followUp,
      expectedCloseDate: shiftDayKey(today, 30),
      notes: parsed.notes,
      warnings,
      pendingFields: unique(pendingFields),
      aiFields,
      source: aiFields.length ? "ai" : "deterministic"
    };
    logApiEvent("INFO", "[opportunity-draft] parsed", {
      viewerRole: viewer.role,
      clientCandidates: clientCandidates.length,
      items: items.length,
      itemsWithoutCandidates: items.filter((item) => !item.candidates.length).length,
      warningCodes: warnings.map((warning) => warning.code),
      aiFields,
      source: draft.source
    });
    return draft;
  }

  private async askAi(text: string, today: string, viewer: OpportunityDraftViewer): Promise<AiDraft | null> {
    const weekday = WEEKDAY_LABELS[new Date(`${today}T00:00:00.000Z`).getUTCDay()];
    try {
      const response = await aiService.chat({
        system: [
          "Extraia de uma frase ditada por um vendedor os campos de uma oportunidade de venda de sementes.",
          "Responda somente JSON com as chaves: clientName, city, stage (prospeccao|negociacao|proposta|ganho|perdido),",
          "priceTable (\"1\" para revenda/cooperativa, \"2\" para consumidor final), products (lista de {name, kg, sacks, price}),",
          "value (valor total em reais, só se não houver produto) e followUpDate (YYYY-MM-DD, data de retorno citada).",
          `Hoje é ${today} (${weekday}). Use null no que a frase não disser. Não invente.`
        ].join(" "),
        messages: [{ role: "user", content: text.slice(0, AI_TEXT_LIMIT) }],
        temperature: 0,
        maxTokens: 400,
        responseFormat: "json_object"
      }, { userId: viewer.id });
      const parsed = response?.content ? parseAiJsonObject(response.content)?.parsed : null;
      if (!parsed) return null;
      const validated = aiDraftSchema.safeParse(parsed);
      if (!validated.success) {
        logApiEvent("WARN", "[opportunity-draft] ai-rejected", { viewerRole: viewer.role });
        return null;
      }
      return validated.data;
    } catch {
      logApiEvent("WARN", "[opportunity-draft] ai-failed", { viewerRole: viewer.role });
      return null;
    }
  }

  // Carteira do usuário (mesmo escopo da criação de oportunidade) e do tenant, sem arquivados. Pontua por palavras do
  // nome/fantasia e pela cidade; nunca escolhe sozinho.
  private async findClients(clientName: string | null, clientCity: string | null, viewer: OpportunityDraftViewer, scope: OpportunityDraftScope): Promise<DraftClientCandidate[]> {
    if (!clientName) return [];
    const terms = searchTerms(clientName, 2);
    if (!terms.length) return [];
    const rows = await prisma.client.findMany({
      where: {
        AND: [
          { tenantId: scope.tenantId, isArchived: false },
          scope.clientScope,
          { OR: terms.flatMap((term) => [{ name: { contains: term, mode: "insensitive" as const } }, { fantasyName: { contains: term, mode: "insensitive" as const } }]) }
        ]
      },
      select: clientSelect(scope.tenantId),
      take: 200
    });
    const nameWords = meaningfulWords(clientName);
    const cityWords = clientCity ? meaningfulWords(clientCity) : [];
    const spokenCity = clientCity ? foldText(clientCity).trim() : null;
    return rows
      .map((row) => {
        const tokens = [...tokensOf(row.name), ...tokensOf(row.fantasyName)];
        const nameScore = nameWords.reduce((sum, word) => sum + wordScore(word, tokens), 0);
        const rowCity = foldText(row.city ?? "").trim();
        const cityTokens = tokensOf(row.city);
        // Cidade dita à parte: igual vale 3. Sem cidade à parte, uma palavra do nome falado que seja a cidade também vale.
        const cityScore = spokenCity
          ? (rowCity && rowCity === spokenCity ? 3 : cityWords.length && cityWords.every((word) => cityTokens.includes(word)) ? 3 : 0)
          : (cityTokens.length && cityTokens.every((token) => nameWords.includes(token)) ? 3 : 0);
        const owner = row.ownerSeller;
        const ownerValid = Boolean(owner && owner.role === "vendedor" && owner.isActive && owner.tenantMemberships.length);
        const suggestedOwner: SuggestedOwner = viewer.role === "vendedor" ? null : ownerValid ? { id: owner!.id, name: owner!.name } : null;
        return {
          id: row.id,
          name: row.name,
          fantasyName: row.fantasyName,
          city: row.city,
          state: row.state,
          score: nameScore + cityScore,
          nameScore,
          suggestedOwner,
          ownerPending: viewer.role !== "vendedor" && !ownerValid
        };
      })
      .filter((row) => row.nameScore > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, "pt-BR"))
      .slice(0, MAX_CANDIDATES)
      .map(({ nameScore: _nameScore, ...candidate }) => candidate);
  }

  // Só produtos ativos, sincronizados e com preço válido na tabela escolhida (mesma regra da busca de produtos).
  private async findProducts(spokenItems: SpokenItem[], priceTable: DraftPriceTable): Promise<DraftItem[]> {
    if (!spokenItems.length) return [];
    const priceRules = await loadOpportunityPriceRules();
    return Promise.all(spokenItems.map(async (item) => {
      const base = { spokenName: item.spokenName, kg: item.kg, quantity: item.quantity, price: item.price };
      const terms = searchTerms(item.spokenName, 3);
      if (!terms.length) return { ...base, candidates: [] };
      const products = await prisma.product.findMany({
        where: {
          isActive: true,
          isSuspended: false,
          OR: terms.flatMap((term) => [
            { name: { contains: term, mode: "insensitive" as const } },
            { className: { contains: term, mode: "insensitive" as const } },
            { brand: { contains: term, mode: "insensitive" as const } }
          ])
        },
        include: { prices: { orderBy: [{ validFrom: "desc" }] } },
        take: 200
      });
      const candidates = products
        .flatMap((product) => {
          const picked = calculateOpportunityPriceForTable({ product, priceTableCode: priceTable, priceVariations: priceRules.priceVariations, erpPrices: priceRules.erpPrices });
          const selectable = isOpportunityProductSelectable({
            isActive: product.isActive,
            isSuspended: product.isSuspended,
            isSynchronized: isSynchronizedProduct(product),
            price: picked.price,
            priceTableMatched: picked.priceTableMatched
          });
          if (!selectable) return [];
          const tokens = [...tokensOf(product.name), ...tokensOf(product.className), ...tokensOf(product.brand)];
          const wordsScore = item.words.reduce((sum, word) => sum + wordScore(word, tokens), 0);
          if (wordsScore <= 0) return [];
          const weightKg = readWeightKg(product.rawErpPayload);
          const kgScore = item.kg !== null && (weightKg === item.kg || tokensOf(product.className).includes(`${item.kg}kg`)) ? 3 : 0;
          const tablePrice = Number(picked.price.toFixed(2));
          const unitPrice = item.price.mode === "informed" ? item.price.amount : tablePrice;
          return [{
            productId: product.id,
            name: product.name,
            className: product.className,
            brand: product.brand,
            unit: product.unit,
            weightKg,
            tablePrice,
            unitPrice,
            total: item.quantity !== null ? Number((item.quantity * unitPrice).toFixed(2)) : null,
            priceDiffPercent: item.price.mode === "informed" ? Number((((unitPrice - tablePrice) / tablePrice) * 100).toFixed(1)) : null,
            score: wordsScore + kgScore
          }];
        })
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, "pt-BR"))
        .slice(0, MAX_CANDIDATES);
      return { ...base, candidates };
    }));
  }
}

export const opportunityDraftService = new OpportunityDraftService();
