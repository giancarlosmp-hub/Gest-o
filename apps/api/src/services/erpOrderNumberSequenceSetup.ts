import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { logApiEvent } from "../utils/logger.js";

const ORDER_SEQUENCE_SETUP_SQL = `
  CREATE SEQUENCE IF NOT EXISTS public.erp_order_number_seq
    AS bigint
    START WITH 900001
    INCREMENT BY 1
    MINVALUE 900001
    MAXVALUE 999999999999999
    NO CYCLE
    CACHE 1
`;

const ORDER_SEQUENCE_ALIGN_SQL = `
  DO $$
  DECLARE
    max_reserved bigint := NULL;
    current_last_value bigint;
    current_is_called boolean;
    current_effective_last_value bigint;
    desired_last_value bigint;
  BEGIN
    IF to_regclass('public."ErpOrderSync"') IS NOT NULL THEN
      SELECT MAX("numPedido"::bigint)
        INTO max_reserved
      FROM public."ErpOrderSync"
      WHERE "numPedido" ~ '^[1-9][0-9]{0,14}$'
        AND "numPedido"::bigint >= 900001;
    END IF;

    SELECT last_value, is_called
      INTO current_last_value, current_is_called
    FROM public.erp_order_number_seq;

    current_effective_last_value := CASE
      WHEN current_is_called THEN current_last_value
      ELSE current_last_value - 1
    END;

    desired_last_value := GREATEST(900000, COALESCE(max_reserved, 900000), current_effective_last_value);

    IF desired_last_value >= 900001 THEN
      PERFORM setval('public.erp_order_number_seq', desired_last_value, true);
    END IF;
  END $$;
`;

const sanitizeSequenceSetupError = (error: unknown) => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return { name: error.name, code: error.code, message: error.message, meta: error.meta ?? null };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
};

export async function ensureErpOrderNumberSequence(): Promise<void> {
  console.log("ERP order sequence setup started");
  logApiEvent("INFO", "[erp-order-sequence] setup started", { sequence: "public.erp_order_number_seq" });
  try {
    await prisma.$executeRawUnsafe(ORDER_SEQUENCE_SETUP_SQL);
    await prisma.$executeRawUnsafe(ORDER_SEQUENCE_ALIGN_SQL);
    console.log("ERP order sequence setup completed");
    logApiEvent("INFO", "[erp-order-sequence] setup completed", { sequence: "public.erp_order_number_seq" });
  } catch (error) {
    const sanitized = sanitizeSequenceSetupError(error);
    console.error("ERP order sequence setup failed", sanitized);
    logApiEvent("ERROR", "[erp-order-sequence] setup failed", sanitized);
    throw error;
  }
}
