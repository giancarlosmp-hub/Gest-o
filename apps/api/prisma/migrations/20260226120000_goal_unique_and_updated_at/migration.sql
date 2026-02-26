ALTER TABLE "Goal"
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "Goal_sellerId_month_key" ON "Goal"("sellerId", "month");
