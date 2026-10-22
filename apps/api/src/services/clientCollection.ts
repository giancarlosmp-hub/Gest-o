import type { Prisma } from "@prisma/client";
import { isClientInCollection } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import { buildClientDelayMetrics } from "./clientErpProjection.js";
import { isSalesReceivableTitle } from "./ultraFv3FinancialMerge.js";

// Cliente em cobrança pela regra de packages/shared (isClientInCollection). Os dias são os do "Maior atraso em
// aberto" (buildClientDelayMetrics: vencimento mais antigo com saldo, dia de Brasília), só com títulos de venda
// (isSalesReceivableTitle; a sincronização já grava só esses, o filtro aqui cobre dado gravado antes dela).
// O total vencido é o overdueTitlesTotal do cliente, o mesmo do banner de crédito.
export type ClientCollectionStatus = { oldestOverdueDays: number; overdueTitlesTotal: number };

type CollectionSource = { partnerTitles?: unknown; overdueTitlesTotal?: number | null };

const salesTitles = (partnerTitles: unknown) =>
  Array.isArray(partnerTitles)
    ? partnerTitles.filter((title): title is Record<string, unknown> => Boolean(title) && typeof title === "object" && !Array.isArray(title) && isSalesReceivableTitle(title))
    : [];

export const collectionStatusOf = (client: CollectionSource, now = new Date()): ClientCollectionStatus | null => {
  const days = buildClientDelayMetrics(salesTitles(client.partnerTitles), now).openDelayDays;
  return isClientInCollection(days) ? { oldestOverdueDays: days!, overdueTitlesTotal: client.overdueTitlesTotal ?? 0 } : null;
};

// Só cliente com título em aberto pode estar em cobrança: a sincronização grava openTitlesTotal com a soma dos
// saldos dos mesmos títulos. O filtro evita ler partnerTitles da carteira inteira.
const WITH_OPEN_TITLES: Prisma.ClientWhereInput = { OR: [{ openTitlesTotal: { gt: 0 } }, { overdueTitlesTotal: { gt: 0 } }] };

/** Clientes em cobrança dentro do recorte, na ordem pedida (o Map mantém a ordem de inserção). */
export const loadClientCollection = async (
  scope: Prisma.ClientWhereInput,
  now = new Date(),
  orderBy?: Prisma.ClientOrderByWithRelationInput | Prisma.ClientOrderByWithRelationInput[]
): Promise<Map<string, ClientCollectionStatus>> => {
  const rows = await prisma.client.findMany({
    where: { AND: [scope, WITH_OPEN_TITLES] },
    ...(orderBy ? { orderBy } : {}),
    select: { id: true, partnerTitles: true, overdueTitlesTotal: true }
  });
  const inCollection = new Map<string, ClientCollectionStatus>();
  for (const row of rows) {
    const status = collectionStatusOf(row, now);
    if (status) inCollection.set(row.id, status);
  }
  return inCollection;
};

export const loadClientIdsInCollection = async (scope: Prisma.ClientWhereInput, now = new Date()) =>
  new Set((await loadClientCollection(scope, now)).keys());

/** Tira das listas de sugestão e prioridade o que é de cliente em cobrança (oportunidades, atividades). */
export const withoutClientsInCollection = async <T extends { clientId: string | null }>(rows: T[], now = new Date()): Promise<T[]> => {
  const clientIds = [...new Set(rows.map((row) => row.clientId).filter((id): id is string => Boolean(id)))];
  if (!clientIds.length) return rows;
  const inCollection = await loadClientIdsInCollection({ id: { in: clientIds } }, now);
  return inCollection.size ? rows.filter((row) => !row.clientId || !inCollection.has(row.clientId)) : rows;
};
