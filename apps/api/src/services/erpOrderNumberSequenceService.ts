import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../config/prisma.js";

export const ERP_ORDER_NUMBER_SEQUENCE_START = 900_001;
export const ERP_ORDER_NUMBER_SEQUENCE_NAME = "erp_order_number_seq";

export class ErpOrderNumberSequenceService {
  async reserveNextErpOrderNumber(client: Prisma.TransactionClient | PrismaClient = prisma): Promise<number> {
    try {
      const [reserved] = await client.$queryRaw<Array<{ value: bigint }>>`SELECT nextval('erp_order_number_seq') AS value`;
      const value = Number(reserved?.value);
      if (!Number.isSafeInteger(value) || value < ERP_ORDER_NUMBER_SEQUENCE_START) {
        throw Object.assign(new Error("erp_order_sequence_invalid_value"), { code: "erp_order_sequence_invalid_value" });
      }
      return value;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2010" && /42P01|does not exist|não existe/i.test(String(error.meta?.message || error.message))) {
        throw Object.assign(new Error("erp_order_sequence_not_configured"), {
          code: "erp_order_sequence_not_configured",
          status: 503,
        });
      }
      throw error;
    }
  }
}

export const erpOrderNumberSequenceService = new ErpOrderNumberSequenceService();
export const reserveNextErpOrderNumber = (client?: Prisma.TransactionClient | PrismaClient) => erpOrderNumberSequenceService.reserveNextErpOrderNumber(client);
