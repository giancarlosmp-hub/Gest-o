import type { Prisma } from "@prisma/client";
import { ABC_WINDOW_DAYS, classifyAbcCurve, type AbcClass } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import { shiftDayKey } from "../utils/dateRange.js";
import { closedOpportunityPeriodWhere } from "../utils/periodFilters.js";
import { loadEffectiveWonContributions } from "./effectiveWins.js";

export type ClientAbcCurve = {
  classByClient: Map<string, AbcClass>;
  revenueByClass: Record<AbcClass, number>;
  totalRevenue: number;
};

/**
 * Curva ABC da carteira (recorte de clientes, sempre sem arquivados): ganhos efetivos do CRM dos clientes do
 * recorte nos 90 dias de Brasília que terminam em endDayKey, de qualquer dono da oportunidade. Pedido
 * cancelado no ERP zera o ganho (loadEffectiveWonContributions). Usada pelo Dashboard e pelo filtro da lista.
 */
export const loadClientAbcCurve = async (scope: Prisma.ClientWhereInput, endDayKey: string): Promise<ClientAbcCurve> => {
  const opportunities = await prisma.opportunity.findMany({
    where: {
      stage: "ganho",
      client: { ...scope, isArchived: false },
      ...closedOpportunityPeriodWhere(shiftDayKey(endDayKey, -(ABC_WINDOW_DAYS - 1)), endDayKey)
    },
    select: { id: true, client: { select: { tenantId: true } }, clientId: true, value: true }
  });
  const states = await loadEffectiveWonContributions(opportunities);
  const revenueByClient = new Map<string, number>();
  for (const opportunity of opportunities) {
    revenueByClient.set(opportunity.clientId, (revenueByClient.get(opportunity.clientId) || 0) + states.get(opportunity.id)!.value);
  }
  const classByClient = classifyAbcCurve(revenueByClient);
  const revenueByClass: Record<AbcClass, number> = { A: 0, B: 0, C: 0 };
  for (const [clientId, abcClass] of classByClient) revenueByClass[abcClass] += revenueByClient.get(clientId)!;
  return { classByClient, revenueByClass, totalRevenue: revenueByClass.A + revenueByClass.B + revenueByClass.C };
};
