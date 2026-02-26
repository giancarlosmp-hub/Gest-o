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
export const EventTypeEnum = z.enum(["comentario", "mudanca_etapa", "status"]);

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

export const timelineEventSchema = z.object({
  type: EventTypeEnum.default("comentario"),
  description: z.string().min(2),
  clientId: z.string().optional(),
  opportunityId: z.string().optional(),
  ownerSellerId: z.string().optional()
});

export const eventSchema = z.object({
  type: z.literal("comentario").default("comentario"),
  description: z.string().min(2),
  opportunityId: z.string(),
  ownerSellerId: z.string().optional()
});

export const goalSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  targetValue: z.number().positive(),
  sellerId: z.string()
});

export const objectiveUpsertSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  amount: z.number().positive()
});

export const dashboardPerformanceSchema = z.object({
  sellerId: z.string(),
  seller: z.string(),
  sales: z.number(),
  revenue: z.number(),
  objective: z.number(),
  realizedPercent: z.number()
});

export const dashboardSummarySchema = z.object({
  totalRevenue: z.number(),
  totalSales: z.number(),
  newLeads: z.number(),
  conversionRate: z.number(),
  objectiveTotal: z.number(),
  performance: z.array(dashboardPerformanceSchema),
  recentActivities: z.array(z.unknown())
});

export const dashboardSalesSeriesSchema = z.object({
  labels: z.array(z.string()),
  realizedDaily: z.array(z.number()),
  realizedAccumulated: z.array(z.number()),
  objectiveDaily: z.array(z.number()),
  objectiveAccumulated: z.array(z.number()),
  objectiveTotal: z.number(),
  realizedTotal: z.number()
});

export const dashboardPortfolioSchema = z.object({
  walletStatus: z.object({
    active: z.number(),
    inactiveRecent: z.number(),
    inactiveOld: z.number()
  }),
  abcCurve: z.object({
    A: z.object({ clients: z.number(), percentRevenue: z.number() }),
    B: z.object({ clients: z.number(), percentRevenue: z.number() }),
    C: z.object({ clients: z.number(), percentRevenue: z.number() })
  }),
  totalClients: z.number(),
  soldToday: z.number()
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ClientInput = z.infer<typeof clientSchema>;
export type CompanyInput = z.infer<typeof companySchema>;
export type ContactInput = z.infer<typeof contactSchema>;
export type OpportunityInput = z.infer<typeof opportunitySchema>;
export type ActivityInput = z.infer<typeof activitySchema>;
export type GoalInput = z.infer<typeof goalSchema>;
export type ObjectiveUpsertInput = z.infer<typeof objectiveUpsertSchema>;
export type TimelineEventInput = z.infer<typeof timelineEventSchema>;
export type EventInput = z.infer<typeof eventSchema>;
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;
export type DashboardSalesSeries = z.infer<typeof dashboardSalesSeriesSchema>;
export type DashboardPortfolio = z.infer<typeof dashboardPortfolioSchema>;

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  region?: string | null;
}
