ALTER TABLE "ProductPrice"
  ADD COLUMN "erpSourcePriceId" TEXT,
  ADD COLUMN "sourceChangedAt" TIMESTAMP(3),
  ADD COLUMN "observedAt" TIMESTAMP(3);

CREATE INDEX "ProductPrice_erpSourcePriceId_idx" ON "ProductPrice"("erpSourcePriceId");
