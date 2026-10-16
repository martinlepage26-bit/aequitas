ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "AccountRecovery" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "emailedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountRecovery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountRecovery_tokenHash_key" ON "AccountRecovery"("tokenHash");
CREATE INDEX "AccountRecovery_userId_createdAt_idx" ON "AccountRecovery"("userId", "createdAt");
ALTER TABLE "AccountRecovery" ADD CONSTRAINT "AccountRecovery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
