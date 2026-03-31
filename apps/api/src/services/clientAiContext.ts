import { OpportunityStage } from "@prisma/client";
import { prisma } from "../config/prisma.js";

export type ClientAiContext = {
  clientId: string;
  clientName: string;
  openOpportunitiesCount: number;
  lastActivityAt: Date | null;
  lastPurchaseDate: Date | null;
  lastPurchaseValue: number | null;
  totalCompletedActivities: number;
  latestObservation: string | null;
};

export const buildClientAiContext = async (params: {
  clientId: string;
  ownerSellerId?: string;
}): Promise<ClientAiContext | null> => {
  const where = {
    id: params.clientId,
    ...(params.ownerSellerId ? { ownerSellerId: params.ownerSellerId } : {})
  };

  const client = await prisma.client.findFirst({
    where,
    select: {
      id: true,
      name: true,
      lastPurchaseDate: true,
      lastPurchaseValue: true
    }
  });

  if (!client) return null;

  const [openOpportunitiesCount, lastActivityAggregate, totalCompletedActivities, latestActivity, latestTimelineEvent] =
    await Promise.all([
      prisma.opportunity.count({
        where: {
          clientId: client.id,
          stage: {
            notIn: [OpportunityStage.ganho, OpportunityStage.perdido]
          }
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
      prisma.activity.count({
        where: {
          clientId: client.id,
          done: true
        }
      }),
      prisma.activity.findFirst({
        where: { clientId: client.id },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        select: {
          date: true,
          createdAt: true,
          notes: true,
          description: true,
          result: true
        }
      }),
      prisma.timelineEvent.findFirst({
        where: {
          opportunity: {
            clientId: client.id
          }
        },
        orderBy: { createdAt: "desc" },
        select: {
          createdAt: true,
          description: true
        }
      })
    ]);

  const latestActivityText = latestActivity
    ? [latestActivity.notes, latestActivity.description, latestActivity.result]
      .map((text) => text?.trim() || "")
      .find(Boolean) || null
    : null;

  const latestActivityDate = latestActivity ? (latestActivity.date || latestActivity.createdAt).getTime() : 0;
  const latestTimelineDate = latestTimelineEvent?.createdAt.getTime() || 0;

  const latestObservation = latestActivityDate >= latestTimelineDate
    ? latestActivityText
    : (latestTimelineEvent?.description?.trim() || latestActivityText);

  return {
    clientId: client.id,
    clientName: client.name,
    openOpportunitiesCount,
    lastActivityAt: lastActivityAggregate._max.date ?? lastActivityAggregate._max.createdAt ?? null,
    lastPurchaseDate: client.lastPurchaseDate ?? null,
    lastPurchaseValue: client.lastPurchaseValue ?? null,
    totalCompletedActivities,
    latestObservation: latestObservation || null
  };
};
