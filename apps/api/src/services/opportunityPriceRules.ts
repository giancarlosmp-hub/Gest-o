import type { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

export const loadOpportunityPriceRules = async () => {
  const configs = await prisma.appConfig.findMany({
    where: { key: { in: ["erp.ultrafv3.priceVariations", "erp.ultrafv3.prices"] } },
    select: { key: true, value: true },
  });
  const configByKey = new Map(configs.map((config) => [config.key, config.value]));

  const parseRows = (value: string | undefined) => {
    if (!value?.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        for (const key of ["items", "data", "rows", "results", "content"]) {
          if (Array.isArray(record[key])) return record[key] as unknown[];
        }
      }
    } catch {
      return [];
    }
    return [];
  };

  return {
    priceVariations: parseRows(configByKey.get("erp.ultrafv3.priceVariations")),
    erpPrices: parseRows(configByKey.get("erp.ultrafv3.prices")),
  };
};

export const isSynchronizedProduct = (product: { rawErpPayload?: Prisma.JsonValue | null }) => {
  if (product.rawErpPayload == null) return false;
  if (typeof product.rawErpPayload !== "object") return true;
  if (Array.isArray(product.rawErpPayload)) return product.rawErpPayload.length > 0;
  return Object.keys(product.rawErpPayload).length > 0;
};
