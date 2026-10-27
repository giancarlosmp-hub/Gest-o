import type { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { brazilDayKeyOf, shiftDayKey } from "../utils/dateRange.js";
import { closedOpportunityPeriodWhere } from "../utils/periodFilters.js";
import { loadEffectiveWonContributions } from "./effectiveWins.js";

/**
 * Valor estimado do cliente: o maior entre (a) os ganhos efetivos do CRM nos 365 dias de Brasília que terminam em
 * todayKey (mesma base da Curva ABC: pedido cancelado no ERP zera o ganho) e (b) o VALOR_ULTFATURA do perfil do ERP,
 * só quando o DATA_ULTFATURA cai nesses mesmos 365 dias (senão 0). É uma aproximação até o ERP enviar notas ou vendas
 * por cliente (TD-CLIENT-ESTIMATED-VALUE): não é faturamento nem valor comprado.
 */
export const ESTIMATED_VALUE_WINDOW_DAYS = 365;

const ISO_WITH_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const PLAIN_NUMBER = /^\s*\d+(\.\d+)?\s*$/;

// Dia de Brasília do DATA_ULTFATURA: ISO com hora pelo fuso de Brasília; só data, o próprio dia; outro formato, nenhum.
export const lastInvoiceDayKey = (value: unknown) => {
  if (typeof value !== "string") return null;
  if (ISO_WITH_TIME.test(value)) {
    const instant = new Date(value);
    return Number.isNaN(instant.getTime()) ? null : brazilDayKeyOf(instant);
  }
  return ISO_DATE_ONLY.test(value) ? value : null;
};

// VALOR_ULTFATURA: número do JSON ou texto no formato pt-BR (como a tela do cliente); outro formato, nenhum.
export const lastInvoiceAmount = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\./g, "").replace(",", ".");
  return PLAIN_NUMBER.test(normalized) ? Number(normalized) : null;
};

export const recentLastInvoiceValue = (financialProfile: Prisma.JsonValue | null, todayKey: string) => {
  if (!financialProfile || typeof financialProfile !== "object" || Array.isArray(financialProfile)) return 0;
  const profile = financialProfile as Record<string, unknown>;
  const dayKey = lastInvoiceDayKey(profile.DATA_ULTFATURA);
  if (!dayKey || dayKey < shiftDayKey(todayKey, -(ESTIMATED_VALUE_WINDOW_DAYS - 1)) || dayKey > todayKey) return 0;
  return lastInvoiceAmount(profile.VALOR_ULTFATURA) ?? 0;
};

export const loadClientEstimatedValues = async (clients: Array<{ id: string; financialProfile: Prisma.JsonValue | null }>, todayKey: string) => {
  const values = new Map<string, number>();
  if (!clients.length) return values;
  const opportunities = await prisma.opportunity.findMany({
    where: {
      stage: "ganho",
      clientId: { in: clients.map((client) => client.id) },
      client: { isArchived: false },
      ...closedOpportunityPeriodWhere(shiftDayKey(todayKey, -(ESTIMATED_VALUE_WINDOW_DAYS - 1)), todayKey)
    },
    select: { id: true, clientId: true, value: true, client: { select: { tenantId: true } } }
  });
  const states = await loadEffectiveWonContributions(opportunities);
  const crmWins = new Map<string, number>();
  for (const opportunity of opportunities) crmWins.set(opportunity.clientId, (crmWins.get(opportunity.clientId) || 0) + states.get(opportunity.id)!.value);
  for (const client of clients) values.set(client.id, Math.max(crmWins.get(client.id) || 0, recentLastInvoiceValue(client.financialProfile, todayKey)));
  return values;
};
