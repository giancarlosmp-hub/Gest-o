import { Role } from "@prisma/client";

declare global {
  namespace Express {
    interface UserPayload {
      id: string;
      email: string;
      role: Role;
      region?: string | null;
    }
    interface Request {
      user?: UserPayload;
      requestId?: string;
      correlationId?: string;
      erpOrderRouteHit?: boolean;
      rateLimit?: {
        limit: number;
        used: number;
        remaining: number;
        resetTime?: Date;
      };
    }
  }
}

export {};
