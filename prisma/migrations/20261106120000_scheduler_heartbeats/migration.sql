CREATE TYPE "ScheduledOperationOutcome" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED');

CREATE TABLE "ScheduledOperationHeartbeat" (
    "name" TEXT NOT NULL,
    "intervalMs" INTEGER NOT NULL,
    "lastStartedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastFinishedAt" TIMESTAMP(3),
    "lastSuccessfulAt" TIMESTAMP(3),
    "lastOutcome" "ScheduledOperationOutcome",
    "lastExitCode" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScheduledOperationHeartbeat_pkey" PRIMARY KEY ("name"),
    CONSTRAINT "ScheduledOperationHeartbeat_intervalMs_check" CHECK ("intervalMs" > 0)
);
