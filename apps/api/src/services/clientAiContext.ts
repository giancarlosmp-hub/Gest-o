import { OpportunityStage, Prisma } from "@prisma/client";
import { CLIENT_IN_COLLECTION_LABEL, PORTFOLIO_STATUS_LABELS, type PortfolioStatus } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";
import { isClientCoolingActive, loadLastSentCrmOrderByClient, portfolioStatusOf, resolveLastPurchase, type LastPurchase } from "./clientPortfolioStatus.js";
import { collectionStatusOf } from "./clientCollection.js";

const OPEN_STAGES = [OpportunityStage.prospeccao, OpportunityStage.negociacao, OpportunityStage.proposta] as const;

type ClientScope = Prisma.ClientWhereInput;

// Abordagem comercial pela situação oficial da carteira: reativação para inativo recente e ex-cliente,
// primeira venda para prospect, manutenção/recompra para ativo esfriando e manutenção para os demais ativos.
export type PortfolioApproach = "reativacao" | "primeiraVenda" | "recompra" | "manutencao";

export const PORTFOLIO_APPROACH_LABELS: Record<PortfolioApproach, string> = {
  reativacao: "Reativação: retomar a compra de quem parou de comprar",
  primeiraVenda: "Primeira venda: apresentar a empresa e entender a operação do cliente",
  recompra: "Manutenção e recompra: antecipar a reposição antes que o cliente fique inativo",
  manutencao: "Manutenção: manter o relacionamento e identificar nova demanda"
};

export const portfolioApproachOf = (status: PortfolioStatus, cooling: boolean): PortfolioApproach => {
  if (status === "inativoRecente" || status === "exCliente") return "reativacao";
  if (status === "prospect") return "primeiraVenda";
  return cooling ? "recompra" : "manutencao";
};

export type ClientAiPortfolio = {
  status: PortfolioStatus;
  cooling: boolean;
  approach: PortfolioApproach;
  lastPurchase: LastPurchase | null;
};

export type ClientAiContextPayload = {
  client: {
    id: string;
    name: string;
    fantasyName: string | null;
    isArchived: boolean;
    archiveReason: string | null;
    city: string;
    state: string;
    region: string;
    potentialHa: number | null;
  };
  commercialSummary: {
    openOpportunitiesCount: number;
    totalCompletedActivities: number;
    lastActivityAt: Date | null;
    lastPurchaseDate: Date | null;
    lastPurchaseValue: number | null;
  };
  // Situação oficial da carteira (data do ERP ou pedido sent do CRM, o mais recente).
  portfolio: ClientAiPortfolio;
  // Cliente em cobrança (clientCollection.ts): sem oferta de venda nem reativação. Sem dias nem valores.
  inCollection?: boolean;
  recentActivities: Array<{
    id: string;
    type: string;
    done: boolean;
    date: Date | null;
    dueDate: Date;
    createdAt: Date;
    notes: string;
    description: string | null;
    result: string | null;
    opportunityTitle: string | null;
  }>;
  recentOpportunities: Array<{
    id: string;
    title: string;
    stage: OpportunityStage;
    value: number;
    followUpDate: Date;
    expectedCloseDate: Date;
    createdAt: Date;
    lastContactAt: Date | null;
    notes: string | null;
  }>;
  latestObservation: string | null;
};

const getActivityEventDate = (activity: { date: Date | null; dueDate: Date; createdAt: Date }) =>
  activity.date ?? activity.dueDate ?? activity.createdAt;

const getTextFromActivity = (activity: { notes: string; description: string | null; result: string | null }) => {
  const texts = [activity.notes, activity.description, activity.result]
    .map((value) => value?.trim() || "")
    .filter(Boolean);

  return texts.length ? texts[0] : null;
};

export const buildClientAiContext = async ({
  clientId,
  scope = {},
  now = new Date()
}: {
  clientId: string;
  scope?: ClientScope;
  now?: Date;
}): Promise<ClientAiContextPayload | null> => {
  const client = await prisma.client.findFirst({
    where: {
      id: clientId,
      ...scope
    },
    select: {
      id: true,
      name: true,
      fantasyName: true,
      city: true,
      state: true,
      region: true,
      potentialHa: true,
      isArchived: true,
      archiveReason: true,
      lastPurchaseDate: true,
      lastPurchaseValue: true,
      financialProfile: true,
      partnerTitles: true,
      overdueTitlesTotal: true
    }
  });

  if (!client) return null;

  const [lastSentCrmOrderByClient, openOpportunitiesCount, totalCompletedActivities, lastActivityAggregate, recentActivities, recentOpportunities, latestTimelineEvent] = await Promise.all([
    loadLastSentCrmOrderByClient({ id: client.id }),
    prisma.opportunity.count({
      where: {
        clientId: client.id,
        stage: {
          in: [...OPEN_STAGES]
        }
      }
    }),
    prisma.activity.count({
      where: {
        clientId: client.id,
        done: true
      }
    }),
    prisma.activity.aggregate({
      where: {
        clientId: client.id
      },
      _max: {
        date: true,
        createdAt: true
      }
    }),
    prisma.activity.findMany({
      where: {
        clientId: client.id
      },
      orderBy: [{ date: "desc" }, { dueDate: "desc" }, { createdAt: "desc" }],
      take: 10,
      select: {
        id: true,
        type: true,
        done: true,
        date: true,
        dueDate: true,
        createdAt: true,
        notes: true,
        description: true,
        result: true,
        opportunity: {
          select: {
            title: true
          }
        }
      }
    }),
    prisma.opportunity.findMany({
      where: {
        clientId: client.id,
        stage: {
          in: [...OPEN_STAGES]
        }
      },
      orderBy: [{ followUpDate: "asc" }, { createdAt: "desc" }],
      take: 10,
      select: {
        id: true,
        title: true,
        stage: true,
        value: true,
        followUpDate: true,
        expectedCloseDate: true,
        createdAt: true,
        lastContactAt: true,
        notes: true
      }
    }),
    prisma.timelineEvent.findFirst({
      where: {
        clientId: client.id,
        description: {
          not: ""
        }
      },
      orderBy: {
        createdAt: "desc"
      },
      select: {
        description: true,
        createdAt: true
      }
    })
  ]);

  const latestActivityWithText = recentActivities
    .filter((activity) => Boolean(getTextFromActivity(activity)))
    .sort((a, b) => getActivityEventDate(b).getTime() - getActivityEventDate(a).getTime())[0];

  const latestActivityObservation = latestActivityWithText ? getTextFromActivity(latestActivityWithText) : null;
  const latestActivityTimestamp = latestActivityWithText ? getActivityEventDate(latestActivityWithText).getTime() : 0;
  const latestTimelineTimestamp = latestTimelineEvent?.createdAt.getTime() ?? 0;
  const portfolioStatus = portfolioStatusOf(client, lastSentCrmOrderByClient, now);
  const cooling = isClientCoolingActive(client, lastSentCrmOrderByClient, now);

  return {
    client: {
      id: client.id,
      name: client.name,
      fantasyName: client.fantasyName,
      city: client.city,
      state: client.state,
      region: client.region,
      potentialHa: client.potentialHa,
      isArchived: client.isArchived,
      archiveReason: client.archiveReason
    },
    commercialSummary: {
      openOpportunitiesCount,
      totalCompletedActivities,
      lastActivityAt: lastActivityAggregate._max.date ?? lastActivityAggregate._max.createdAt ?? null,
      lastPurchaseDate: client.lastPurchaseDate,
      lastPurchaseValue: client.lastPurchaseValue
    },
    portfolio: {
      status: portfolioStatus,
      cooling,
      approach: portfolioApproachOf(portfolioStatus, cooling),
      lastPurchase: resolveLastPurchase(client, lastSentCrmOrderByClient)
    },
    inCollection: collectionStatusOf(client, now) !== null,
    recentActivities: recentActivities.map((activity) => ({
      id: activity.id,
      type: activity.type,
      done: activity.done,
      date: activity.date,
      dueDate: activity.dueDate,
      createdAt: activity.createdAt,
      notes: activity.notes,
      description: activity.description,
      result: activity.result,
      opportunityTitle: activity.opportunity?.title ?? null
    })),
    recentOpportunities,
    latestObservation:
      latestActivityTimestamp >= latestTimelineTimestamp
        ? latestActivityObservation
        : (latestTimelineEvent?.description?.trim() || latestActivityObservation)
  };
};

const compactText = (value: string | null | undefined, maxLength: number) => {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
};

const formatBrazilDate = (value: Date | null | undefined) =>
  value ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(value) : null;

export const portfolioSituationLabel = (portfolio: Pick<ClientAiPortfolio, "status" | "cooling">) =>
  `${PORTFOLIO_STATUS_LABELS[portfolio.status]}${portfolio.cooling ? " (esfriando)" : ""}`;

// O que vai para a IA externa sobre o cliente: nome, cidade/UF, situação da carteira, data da última compra e
// textos operacionais curtos. Sem ids, valores, potencial ou motivo de arquivamento. O AiService ainda passa tudo
// pelo filtro central (sanitizeAiPayload). Cliente em cobrança vai só com a situação "Em cobrança": sem dias,
// valores, última compra nem abordagem de venda.
export const buildClientAiPromptContext = (context: ClientAiContextPayload) => ({
  cliente: {
    nome: compactText(context.client.name, 100),
    cidade: compactText(context.client.city, 80) || null,
    uf: compactText(context.client.state, 20) || null
  },
  carteira: context.inCollection
    ? { situacao: CLIENT_IN_COLLECTION_LABEL }
    : {
        situacao: portfolioSituationLabel(context.portfolio),
        esfriando: context.portfolio.cooling,
        ultimaCompra: formatBrazilDate(context.portfolio.lastPurchase?.date),
        abordagem: PORTFOLIO_APPROACH_LABELS[context.portfolio.approach]
      },
  resumo: {
    oportunidadesAbertas: context.commercialSummary.openOpportunitiesCount,
    atividadesConcluidas: context.commercialSummary.totalCompletedActivities,
    ultimaAtividade: formatBrazilDate(context.commercialSummary.lastActivityAt)
  },
  oportunidadesAbertas: context.recentOpportunities.slice(0, 5).map((opportunity) => ({
    titulo: compactText(opportunity.title, 120),
    etapa: opportunity.stage,
    retorno: formatBrazilDate(opportunity.followUpDate)
  })),
  historicoRecente: context.recentActivities.slice(0, 5).map((activity) => ({
    tipo: activity.type,
    data: formatBrazilDate(getActivityEventDate(activity)),
    texto: compactText(getTextFromActivity(activity), 160) || null
  })),
  observacaoRecente: compactText(context.latestObservation, 220) || null
});
