CREATE SEQUENCE IF NOT EXISTS "erp_order_number_seq"
  AS bigint
  START WITH 900001
  INCREMENT BY 1
  MINVALUE 900001
  NO MAXVALUE
  CACHE 1;

DO $$
DECLARE
  max_reserved bigint;
BEGIN
  SELECT MAX("numPedido"::bigint)
    INTO max_reserved
  FROM "ErpOrderSync"
  WHERE "numPedido" ~ '^[1-9][0-9]{0,14}$'
    AND "numPedido"::bigint >= 900001;

  IF max_reserved IS NOT NULL THEN
    PERFORM setval('erp_order_number_seq', max_reserved, true);
  END IF;
END $$;
