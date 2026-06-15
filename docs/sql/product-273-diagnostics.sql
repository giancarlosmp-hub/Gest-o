-- Diagnóstico direto do produto ERP 273 no CRM após Sincronização Completa ERP.
-- Use para confirmar se o produto foi persistido e quais preços estão associados.

SELECT *
FROM "Product"
WHERE "erpProductCode" = '273';

SELECT *
FROM "ProductPrice"
WHERE "productId" IN (
  SELECT id
  FROM "Product"
  WHERE "erpProductCode" = '273'
);
