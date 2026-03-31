import { OpportunityStage, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

const OPEN_STAGES = [OpportunityStage.prospeccao, OpportunityStage.negociacao, OpportunityStage.proposta] as const;

type ClientScope = Prisma.ClientWhereInput;

export type ClientAiContextPayload = {
  client: {
    id: string;
    name: string;
    fantasyName: string | null;
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
  scope = {}
}: {
  clientId: string;
  scope?: ClientScope;
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
      lastPurchaseDate: true,
      lastPurchaseValue: true
    }
  });

  if (!client) return null;

  const [openOpportunitiesCount, totalCompletedActivities, lastActivityAggregate, recentActivities, recentOpportunities, latestTimelineEvent] = await Promise.all([
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

  return {
    client: {
      id: client.id,
      name: client.name,
      fantasyName: client.fantasyName,
      city: client.city,
      state: client.state,
      region: client.region,
      potentialHa: client.potentialHa
    },
    commercialSummary: {
      openOpportunitiesCount,
      totalCompletedActivities,
      lastActivityAt: lastActivityAggregate._max.date ?? lastActivityAggregate._max.createdAt ?? null,
      lastPurchaseDate: client.lastPurchaseDate,
      lastPurchaseValue: client.lastPurchaseValue
    },
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
