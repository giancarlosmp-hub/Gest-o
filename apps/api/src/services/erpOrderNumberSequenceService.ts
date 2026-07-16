import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

export const ERP_ORDER_NUMBER_SEQUENCE_START = 900_001;
const ERP_ORDER_NUMBER_SEQUENCE_NAME = "erp_order_number_seq";
const ERP_ORDER_NUMBER_SEQUENCE_LOCK_NAMESPACE = 90_001;

const numericErpOrderNumberSql = Prisma.sql`
  CASE
    WHEN "numPedido" ~ '^[1-9][0-9]{0,14}$' THEN "numPedido"::bigint
    ELSE NULL
  END
`;

export class ErpOrderNumberSequenceService {
  async reserveNextErpOrderNumber(): Promise<number> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ERP_ORDER_NUMBER_SEQUENCE_LOCK_NAMESPACE}::integer)`;
      await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${ERP_ORDER_NUMBER_SEQUENCE_NAME}" AS bigint START WITH ${ERP_ORDER_NUMBER_SEQUENCE_START} INCREMENT BY 1 MINVALUE ${ERP_ORDER_NUMBER_SEQUENCE_START} NO MAXVALUE CACHE 1`);

      const [sequenceState] = await tx.$queryRawUnsafe<Array<{ last_value: bigint; is_called: boolean }>>(`SELECT last_value, is_called FROM "${ERP_ORDER_NUMBER_SEQUENCE_NAME}"`);
      const [historyState] = await tx.$queryRaw<Array<{ max_num_pedido: bigint | null }>>(Prisma.sql`
        SELECT MAX(${numericErpOrderNumberSql}) AS max_num_pedido
        FROM "ErpOrderSync"
        WHERE ${numericErpOrderNumberSql} >= ${ERP_ORDER_NUMBER_SEQUENCE_START}
      `);

      const lastValue = Number(sequenceState?.last_value ?? ERP_ORDER_NUMBER_SEQUENCE_START);
      const nextSequenceValue = sequenceState?.is_called === false ? lastValue : lastValue + 1;
      const maxReserved = historyState?.max_num_pedido == null ? null : Number(historyState.max_num_pedido);
      if (maxReserved !== null && maxReserved >= nextSequenceValue) {
        await tx.$executeRaw`SELECT setval('erp_order_number_seq', ${maxReserved}::bigint, true)`;
      }

      const [reserved] = await tx.$queryRaw<Array<{ value: bigint }>>`SELECT nextval('erp_order_number_seq') AS value`;
      const value = Number(reserved?.value);
      if (!Number.isSafeInteger(value) || value < ERP_ORDER_NUMBER_SEQUENCE_START) {
        throw new Error("erp_order_number_sequence_invalid_value");
      }
      return value;
    });
  }
}

export const erpOrderNumberSequenceService = new ErpOrderNumberSequenceService();
export const reserveNextErpOrderNumber = () => erpOrderNumberSequenceService.reserveNextErpOrderNumber();
