import { arePlanningVisitTiersOrdered, PLANNING_VISIT_VALUE_MAX, type PlanningVisitRules } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";

// Regras das visitas sugeridas pelo valor estimado do cliente (decisão da diretoria de 26/10/2026). Os valores ficam no
// AppConfig, ao lado do raio; os dias sem visita de cada faixa são fixos.
export const PLANNING_VISIT_TIER1_KEY = "planning.visitTier1MinEstimatedValue";
export const PLANNING_VISIT_TIER2_KEY = "planning.visitTier2MinEstimatedValue";
export const PLANNING_VISIT_OPPORTUNITY_KEY = "planning.visitOpportunityMinValue";
export const PLANNING_VISIT_TIER1_DAYS = 45;
export const PLANNING_VISIT_TIER2_DAYS = 90;
export const DEFAULT_PLANNING_VISIT_RULES: PlanningVisitRules = { tier1MinEstimatedValue: 20000, tier2MinEstimatedValue: 5000, opportunityMinValue: 20000 };

const parseValue = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= PLANNING_VISIT_VALUE_MAX ? parsed : null;
};

// Valor gravado inválido volta ao padrão; faixas fora de ordem (faixa 2 não menor que a 1) voltam as duas ao padrão.
export const parsePlanningVisitRules = (stored: Map<string, string>): PlanningVisitRules => {
  const tier1 = parseValue(stored.get(PLANNING_VISIT_TIER1_KEY)) ?? DEFAULT_PLANNING_VISIT_RULES.tier1MinEstimatedValue;
  const tier2 = parseValue(stored.get(PLANNING_VISIT_TIER2_KEY)) ?? DEFAULT_PLANNING_VISIT_RULES.tier2MinEstimatedValue;
  const tiersValid = arePlanningVisitTiersOrdered({ tier1MinEstimatedValue: tier1, tier2MinEstimatedValue: tier2 });
  return {
    tier1MinEstimatedValue: tiersValid ? tier1 : DEFAULT_PLANNING_VISIT_RULES.tier1MinEstimatedValue,
    tier2MinEstimatedValue: tiersValid ? tier2 : DEFAULT_PLANNING_VISIT_RULES.tier2MinEstimatedValue,
    opportunityMinValue: parseValue(stored.get(PLANNING_VISIT_OPPORTUNITY_KEY)) ?? DEFAULT_PLANNING_VISIT_RULES.opportunityMinValue
  };
};

export const getPlanningVisitRules = async () => {
  const rows = await prisma.appConfig.findMany({ where: { key: { in: [PLANNING_VISIT_TIER1_KEY, PLANNING_VISIT_TIER2_KEY, PLANNING_VISIT_OPPORTUNITY_KEY] } }, select: { key: true, value: true } });
  return parsePlanningVisitRules(new Map(rows.map((row) => [row.key, row.value])));
};
