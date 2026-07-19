import { Prisma } from "@prisma/client";
import { type Request } from "express";
import { sellerWhere } from "./access.js";

const hasScopedSellerFilter = (scope: Prisma.ClientWhereInput) => Object.keys(scope).length > 0;

/**
 * Builds the read-only access rule for historical archived clients.
 *
 * Active clients keep the current sellerWhere model. Archived clients are readable only through
 * a direct sellerWhere match or through an opportunity linked to the same client that matches
 * the same scoped seller rule. This keeps list/search/write paths on isArchived:false while
 * allowing opportunity detail screens to resolve their historical client record.
 */
export const archivedHistoricalClientReadWhere = (req: Request): Prisma.ClientWhereInput => {
  const scope = sellerWhere(req) as Prisma.ClientWhereInput;

  if (!hasScopedSellerFilter(scope)) return {};

  return {
    OR: [
      scope,
      {
        opportunities: {
          some: scope as Prisma.OpportunityWhereInput
        }
      }
    ]
  };
};

export const clientReadableForDetailsWhere = (req: Request): Prisma.ClientWhereInput => {
  const scope = sellerWhere(req) as Prisma.ClientWhereInput;
  const archivedScope = archivedHistoricalClientReadWhere(req);

  return {
    OR: [
      {
        isArchived: false,
        ...scope
      },
      {
        isArchived: true,
        ...archivedScope
      }
    ]
  };
};
