CREATE SEQUENCE IF NOT EXISTS public.erp_order_number_seq
  AS bigint
  START WITH 900001
  INCREMENT BY 1
  MINVALUE 900001
  MAXVALUE 999999999999999
  NO CYCLE
  CACHE 1;

DO $$
DECLARE
  max_reserved bigint;
  current_last_value bigint;
  current_is_called boolean;
  current_effective_last_value bigint;
  desired_last_value bigint;
BEGIN
  SELECT MAX("numPedido"::bigint)
    INTO max_reserved
  FROM "ErpOrderSync"
  WHERE "numPedido" ~ '^[1-9][0-9]{0,14}$'
    AND "numPedido"::bigint >= 900001;

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
