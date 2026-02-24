import { Role } from "@salesforce-pro/shared";

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
    }
  }
}

export {};
