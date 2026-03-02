CREATE UNIQUE INDEX IF NOT EXISTS "Client_cnpjNormalized_unique_not_empty"
  ON "Client" ("cnpjNormalized")
  WHERE "cnpjNormalized" IS NOT NULL AND "cnpjNormalized" <> '';

CREATE UNIQUE INDEX IF NOT EXISTS "Client_name_city_state_unique_when_cnpj_empty"
  ON "Client" ("nameNormalized", "cityNormalized", "state")
  WHERE "cnpjNormalized" IS NULL OR "cnpjNormalized" = '';
