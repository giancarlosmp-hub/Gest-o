import { prisma } from "../config/prisma.js";

// Raio do agrupamento de visitas do planejamento semanal (km em linha reta entre as cidades das visitas do mesmo dia).
export const PLANNING_VISIT_RADIUS_KEY = "planning.visitClusterRadiusKm";
export const DEFAULT_PLANNING_VISIT_RADIUS_KM = 70;
export const MIN_PLANNING_VISIT_RADIUS_KM = 10;
export const MAX_PLANNING_VISIT_RADIUS_KM = 300;

export const parsePlanningVisitRadiusKm = (value: string | null | undefined) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_PLANNING_VISIT_RADIUS_KM && parsed <= MAX_PLANNING_VISIT_RADIUS_KM ? parsed : DEFAULT_PLANNING_VISIT_RADIUS_KM;
};

export const getPlanningVisitRadiusKm = async () => {
  const stored = await prisma.appConfig.findUnique({ where: { key: PLANNING_VISIT_RADIUS_KEY }, select: { value: true } });
  return parsePlanningVisitRadiusKm(stored?.value);
};
