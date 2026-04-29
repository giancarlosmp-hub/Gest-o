import { prisma } from "../config/prisma.js";

const ERP_BASE_URL = (process.env.ERP_INTEGRATION_BASE_URL || "http://localhost:4000").replace(/\/+$/, "");
const ERP_SYNC_STATUS_KEY = "erp.ultrafv3.sync.status";

type SyncStatusPayload = {
  scope: string;
  status: "idle" | "running" | "success" | "error";
  lastSyncAt?: string;
  syncedCount?: number;
  errors?: string[];
};

async function fetchErp<T>(path: string): Promise<T> {
  const response = await fetch(`${ERP_BASE_URL}${path}`, { headers: { "content-type": "application/json" } });
  if (!response.ok) throw new Error(`Falha ao consultar ERP (${path}): ${response.status}`);
  return response.json() as Promise<T>;
}

async function writeSyncStatus(payload: SyncStatusPayload) {
  const current = await prisma.appConfig.findUnique({ where: { key: ERP_SYNC_STATUS_KEY }, select: { value: true } });
  const parsed = current?.value ? JSON.parse(current.value) : {};
  parsed[payload.scope] = payload;
  await prisma.appConfig.upsert({
    where: { key: ERP_SYNC_STATUS_KEY },
    update: { value: JSON.stringify(parsed) },
    create: { key: ERP_SYNC_STATUS_KEY, value: JSON.stringify(parsed) }
  });
}

export async function syncProducts() {
  await writeSyncStatus({ scope: "products", status: "running" });
  try {
    const rows = await fetchErp<any[]>("/erp/ultrafv3/products");
    let syncedCount = 0;
    for (const row of rows) {
      const isActive = row.isActive !== false && row.active !== false && row.status !== "suspended";
      const defaultPrice = Number(row.price ?? row.defaultPrice ?? row.minPrice ?? 0);
      if (!isActive || !Number.isFinite(defaultPrice) || defaultPrice <= 0) continue;

      await prisma.product.upsert({
        where: { erpProductCode_erpProductClassCode: { erpProductCode: String(row.code ?? row.erpProductCode), erpProductClassCode: String(row.classification ?? row.erpProductClassCode ?? "default") } },
        update: {
          name: String(row.description ?? row.name ?? "Produto sem descrição"),
          className: row.classificationName ?? row.className ?? null,
          groupName: row.group ?? row.groupName ?? null,
          unit: row.unit ?? null,
          brand: row.brand ?? null,
          stockQuantity: row.stockQuantity == null ? null : Number(row.stockQuantity),
          defaultPrice,
          minPrice: Number(row.minPrice ?? defaultPrice),
          isActive: true,
          isSuspended: false,
          rawErpPayload: row
        },
        create: {
          erpProductCode: String(row.code ?? row.erpProductCode),
          erpProductClassCode: String(row.classification ?? row.erpProductClassCode ?? "default"),
          name: String(row.description ?? row.name ?? "Produto sem descrição"),
          className: row.classificationName ?? row.className ?? null,
          groupName: row.group ?? row.groupName ?? null,
          unit: row.unit ?? null,
          brand: row.brand ?? null,
          stockQuantity: row.stockQuantity == null ? null : Number(row.stockQuantity),
          defaultPrice,
          minPrice: Number(row.minPrice ?? defaultPrice),
          isActive: true,
          isSuspended: false,
          rawErpPayload: row
        }
      });
      syncedCount += 1;
    }
    await writeSyncStatus({ scope: "products", status: "success", lastSyncAt: new Date().toISOString(), syncedCount });
    return { syncedCount };
  } catch (error) {
    await writeSyncStatus({ scope: "products", status: "error", errors: [error instanceof Error ? error.message : String(error)] });
    throw error;
  }
}

export async function syncPartners() { /* similar */
  await writeSyncStatus({ scope: "partners", status: "running" });
  try {
    const rows = await fetchErp<any[]>("/erp/ultrafv3/partners");
    const fallbackSeller = await prisma.user.findFirst({ where: { role: "vendedor", isActive: true }, select: { id: true } });
    if (!fallbackSeller) throw new Error("Nenhum vendedor ativo encontrado para vincular clientes sincronizados.");
    let syncedCount = 0;
    for (const row of rows) {
      const code = String(row.code ?? row.erpCode ?? "").trim();
      if (!code) continue;
      const existing = await prisma.client.findFirst({ where: { code } });
      const data = {
        code,
        name: String(row.corporateName ?? row.name ?? "Cliente sem nome"),
        fantasyName: row.fantasyName ?? null,
        cnpj: row.cpfCnpj ?? row.cnpj ?? null,
        city: row.city ?? "Não informado",
        state: row.state ?? "NI",
        region: row.region ?? "Não informado",
        ownerSellerId: fallbackSeller.id,
        erpUpdatedAt: new Date(),
      };
      if (existing) await prisma.client.update({ where: { id: existing.id }, data });
      else await prisma.client.create({ data });
      syncedCount += 1;
    }
    await writeSyncStatus({ scope: "partners", status: "success", lastSyncAt: new Date().toISOString(), syncedCount });
    return { syncedCount };
  } catch (error) {
    await writeSyncStatus({ scope: "partners", status: "error", errors: [error instanceof Error ? error.message : String(error)] });
    throw error;
  }
}

async function syncReferenceData(scope: string, endpoint: string) {
  const rows = await fetchErp<any[]>(endpoint);
  await prisma.appConfig.upsert({ where: { key: `erp.ultrafv3.${scope}` }, update: { value: JSON.stringify(rows) }, create: { key: `erp.ultrafv3.${scope}`, value: JSON.stringify(rows) } });
  await writeSyncStatus({ scope, status: "success", lastSyncAt: new Date().toISOString(), syncedCount: rows.length });
  return { syncedCount: rows.length };
}

export const syncPriceTables = () => syncReferenceData("priceTables", "/erp/ultrafv3/price-tables");
export const syncPaymentMethods = () => syncReferenceData("paymentMethods", "/erp/ultrafv3/payment-methods");
export const syncReceivingConditions = () => syncReferenceData("receivingConditions", "/erp/ultrafv3/receiving-conditions");
export const syncBranches = () => syncReferenceData("branches", "/erp/ultrafv3/branches");
export const syncOperations = () => syncReferenceData("operations", "/erp/ultrafv3/operations");
export const syncSalesmen = () => syncReferenceData("salesmen", "/erp/ultrafv3/salesmen");

export async function getUltraFv3SyncStatus() {
  const config = await prisma.appConfig.findUnique({ where: { key: ERP_SYNC_STATUS_KEY }, select: { value: true } });
  return config?.value ? JSON.parse(config.value) : {};
}
