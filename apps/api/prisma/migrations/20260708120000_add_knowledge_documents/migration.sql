CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceName" TEXT,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KnowledgeDocument_category_idx" ON "KnowledgeDocument"("category");
CREATE INDEX "KnowledgeDocument_sourceType_idx" ON "KnowledgeDocument"("sourceType");
CREATE INDEX "KnowledgeDocument_isActive_idx" ON "KnowledgeDocument"("isActive");
CREATE INDEX "KnowledgeDocument_createdById_idx" ON "KnowledgeDocument"("createdById");

ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
