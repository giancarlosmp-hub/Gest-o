CREATE TABLE "AppConfig" (
  "id" INTEGER NOT NULL,
  "minimumWeeklyVisits" INTEGER NOT NULL DEFAULT 15,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AppConfig_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AppConfig" ("id", "minimumWeeklyVisits", "updatedAt")
VALUES (1, 15, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
