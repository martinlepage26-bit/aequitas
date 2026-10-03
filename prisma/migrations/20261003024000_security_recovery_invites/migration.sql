ALTER TYPE "EventType" ADD VALUE 'RECOMMENDATION_DRAFT_FAILED';
ALTER TABLE "Case" ADD COLUMN "draftRequestId" TEXT, ADD COLUMN "draftRequestedAt" TIMESTAMP(3);
CREATE TABLE "Invitation" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "issuedById" TEXT,
  "locale" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
  "claimedAt" TIMESTAMP(3), "emailedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Invitation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX "Invitation_userId_createdAt_idx" ON "Invitation"("userId", "createdAt");
