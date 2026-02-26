import type { Prisma } from "@prisma/client";

type BuildTimelineEventWhereParams = {
  baseWhere: Prisma.TimelineEventWhereInput;
  opportunityId?: string;
  clientId?: string;
};

export const buildTimelineEventWhere = ({
  baseWhere,
  opportunityId,
  clientId
}: BuildTimelineEventWhereParams): Prisma.TimelineEventWhereInput => {
  const where: Prisma.TimelineEventWhereInput = {
    ...baseWhere,
    ...(opportunityId ? { opportunityId } : {})
  };

  if (clientId) {
    where.OR = [
      { clientId },
      {
        AND: [
          { clientId: null },
          { opportunity: { clientId } }
        ]
      }
    ];
  }

  return where;
};
