ALTER TABLE "ProductPrice"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "availabilityState" TEXT NOT NULL DEFAULT 'available';

CREATE INDEX "ProductPrice_source_availabilityState_idx"
  ON "ProductPrice"("source", "availabilityState");
