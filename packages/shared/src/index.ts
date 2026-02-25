import { z } from "zod";

export const RoleEnum = z.enum(["diretor", "gerente", "vendedor"]);
export type Role = z.infer<typeof RoleEnum>;

export const OpportunityStageEnum = z.enum([
  "prospeccao",
  "negociacao",
  "proposta",
  "ganho",
  "perdido"
]);

export const ActivityTypeEnum = z.enum(["ligacao", "whatsapp", "visita", "reuniao"]);

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

export const clientSchema = z.object({
  name: z.string().min(2),
  city: z.string().min(2),
  state: z.string().min(2),
  region: z.string().min(2),
  potentialHa: z.number().nonnegative().optional(),
  farmSizeHa: z.number().nonnegative().optional(),
  ownerSellerId: z.string().optional()
});

export const companySchema = z.object({
  name: z.string().min(2),
  cnpj: z.string().optional(),
  segment: z.string().min(2),
  ownerSellerId: z.string().optional()
});

export const contactSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(8),
  email: z.string().email(),
  companyId: z.string(),
  ownerSellerId: z.string().optional()
});

export const opportunitySchema = z.object({
  title: z.string().min(2),
  value: z.number().nonnegative(),
  stage: OpportunityStageEnum,
  crop: z.string().min(2).optional(),
  season: z.string().min(2).optional(),
  areaHa: z.number().nonnegative().optional(),
  productOffered: z.string().min(2).optional(),
  plantingForecastDate: z.string().optional(),
  expectedTicketPerHa: z.number().nonnegative().optional(),
  proposalEntryDate: z.string().optional(),
  expectedReturnDate: z.string().optional(),
  proposalDate: z.string(),
  followUpDate: z.string(),
  expectedCloseDate: z.string(),
  lastContactAt: z.string().optional(),
  probability: z.number().int().min(0).max(100).optional(),
  notes: z.string().max(2000).optional(),
  clientId: z.string(),
  ownerSellerId: z.string().optional()
});

export const activitySchema = z.object({
  type: ActivityTypeEnum,
  notes: z.string().min(2),
  dueDate: z.string(),
  done: z.boolean().optional(),
  opportunityId: z.string().optional(),
  ownerSellerId: z.string().optional()
});


export const timelineCommentSchema = z.object({
  message: z.string().min(1).max(2000),
  opportunityId: z.string().optional()
});

export const goalSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  targetValue: z.number().positive(),
  sellerId: z.string()
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ClientInput = z.infer<typeof clientSchema>;
export type CompanyInput = z.infer<typeof companySchema>;
export type ContactInput = z.infer<typeof contactSchema>;
export type OpportunityInput = z.infer<typeof opportunitySchema>;
export type ActivityInput = z.infer<typeof activitySchema>;
export type GoalInput = z.infer<typeof goalSchema>;
export type TimelineCommentInput = z.infer<typeof timelineCommentSchema>;

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  region?: string | null;
}
