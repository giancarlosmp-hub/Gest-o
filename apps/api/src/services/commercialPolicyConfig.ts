import { parseCommercialPolicy, type CommercialPolicy } from "@salesforce-pro/shared";
import { prisma } from "../config/prisma.js";

// Política comercial (liga/desliga, limite de desconto por perfil e texto do aviso) num JSON só no AppConfig. Sem
// registro, ou com campo inválido, vale o padrão de packages/shared (3% para todos, ligada).
export const COMMERCIAL_POLICY_KEY = "commercial.policy";

export const getCommercialPolicy = async (): Promise<CommercialPolicy> => {
  const row = await prisma.appConfig.findUnique({ where: { key: COMMERCIAL_POLICY_KEY }, select: { value: true } });
  return parseCommercialPolicy(row?.value);
};

export const saveCommercialPolicy = async (policy: CommercialPolicy): Promise<CommercialPolicy> => {
  const value = JSON.stringify(policy);
  const row = await prisma.appConfig.upsert({
    where: { key: COMMERCIAL_POLICY_KEY },
    update: { value },
    create: { key: COMMERCIAL_POLICY_KEY, value },
    select: { value: true }
  });
  return parseCommercialPolicy(row.value);
};
