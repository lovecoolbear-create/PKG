-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ProductType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisSession" (
    "id" TEXT NOT NULL,
    "productTypeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "inputData" TEXT NOT NULL,
    "uploadedFiles" TEXT,
    "completeness" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "resultData" TEXT,
    "totalCostMin" DOUBLE PRECISION,
    "totalCostMax" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "agentLogs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedReport" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeEntry" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'analysis',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "tags" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostRule" (
    "id" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "formula" TEXT NOT NULL,
    "parameters" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductType_code_key" ON "ProductType"("code");

-- CreateIndex
CREATE UNIQUE INDEX "SharedReport_token_key" ON "SharedReport"("token");

-- CreateIndex
CREATE INDEX "KnowledgeEntry_category_key_idx" ON "KnowledgeEntry"("category", "key");

-- CreateIndex
CREATE INDEX "CostRule_productType_dimension_idx" ON "CostRule"("productType", "dimension");

-- AddForeignKey
ALTER TABLE "AnalysisSession" ADD CONSTRAINT "AnalysisSession_productTypeId_fkey" FOREIGN KEY ("productTypeId") REFERENCES "ProductType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedReport" ADD CONSTRAINT "SharedReport_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AnalysisSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AnalysisSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

