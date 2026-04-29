-- CreateEnum
CREATE TYPE "OpportunityItemDiscountType" AS ENUM ('value', 'percent');

-- CreateTable
CREATE TABLE "Product" (
  "id" TEXT NOT NULL,
  "erpProductCode" TEXT NOT NULL,
  "erpProductClassCode" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "className" TEXT,
  "unit" TEXT,
  "brand" TEXT,
  "groupName" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isSuspended" BOOLEAN NOT NULL DEFAULT false,
  "stockQuantity" DOUBLE PRECISION,
  "minPrice" DOUBLE PRECISION,
  "defaultPrice" DOUBLE PRECISION,
  "rawErpPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPrice" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "erpPriceId" TEXT,
  "branchCode" TEXT,
  "validFrom" TIMESTAMP(3),
  "price" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityItem" (
  "id" TEXT NOT NULL,
  "opportunityId" TEXT NOT NULL,
  "productId" TEXT,
  "lineNumber" INTEGER NOT NULL,
  "erpProductCode" TEXT NOT NULL,
  "erpProductClassCode" TEXT NOT NULL,
  "productNameSnapshot" TEXT NOT NULL,
  "unit" TEXT,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unitPrice" DOUBLE PRECISION NOT NULL,
  "discountType" "OpportunityItemDiscountType" NOT NULL DEFAULT 'value',
  "discountValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "grossTotal" DOUBLE PRECISION NOT NULL,
  "discountTotal" DOUBLE PRECISION NOT NULL,
  "netTotal" DOUBLE PRECISION NOT NULL,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OpportunityItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Product_erpProductCode_erpProductClassCode_key" ON "Product"("erpProductCode", "erpProductClassCode");
CREATE INDEX "Product_name_idx" ON "Product"("name");
CREATE INDEX "ProductPrice_productId_idx" ON "ProductPrice"("productId");
CREATE INDEX "ProductPrice_branchCode_idx" ON "ProductPrice"("branchCode");
CREATE INDEX "OpportunityItem_opportunityId_idx" ON "OpportunityItem"("opportunityId");
CREATE INDEX "OpportunityItem_productId_idx" ON "OpportunityItem"("productId");
CREATE UNIQUE INDEX "OpportunityItem_opportunityId_lineNumber_key" ON "OpportunityItem"("opportunityId", "lineNumber");

ALTER TABLE "ProductPrice" ADD CONSTRAINT "ProductPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityItem" ADD CONSTRAINT "OpportunityItem_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityItem" ADD CONSTRAINT "OpportunityItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
