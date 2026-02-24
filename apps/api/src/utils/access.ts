import { Request } from "express";

export const resolveOwnerId = (req: Request, bodyOwner?: string) => (req.user?.role === "vendedor" ? req.user.id : bodyOwner || req.user!.id);

export const sellerWhere = (req: Request) => {
  if (req.user?.role === "vendedor") return { ownerSellerId: req.user.id };
  const sellerId = req.query.sellerId as string | undefined;
  if (sellerId) return { ownerSellerId: sellerId };
  return {};
};
