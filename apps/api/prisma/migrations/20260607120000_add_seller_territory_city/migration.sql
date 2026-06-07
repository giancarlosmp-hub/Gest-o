-- CreateTable
CREATE TABLE "SellerTerritoryCity" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "ibgeCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerTerritoryCity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerTerritoryCity_sellerId_state_city_key" ON "SellerTerritoryCity"("sellerId", "state", "city");

-- CreateIndex
CREATE INDEX "SellerTerritoryCity_sellerId_idx" ON "SellerTerritoryCity"("sellerId");

-- CreateIndex
CREATE INDEX "SellerTerritoryCity_state_city_idx" ON "SellerTerritoryCity"("state", "city");

-- AddForeignKey
ALTER TABLE "SellerTerritoryCity" ADD CONSTRAINT "SellerTerritoryCity_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
