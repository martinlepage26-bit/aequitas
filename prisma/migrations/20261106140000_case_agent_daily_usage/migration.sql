CREATE TABLE "CaseAgentDailyUsage" (
    "utcDay" DATE NOT NULL,
    "modelCalls" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaseAgentDailyUsage_pkey" PRIMARY KEY ("utcDay"),
    CONSTRAINT "CaseAgentDailyUsage_modelCalls_check" CHECK ("modelCalls" >= 0)
);
