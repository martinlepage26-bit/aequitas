-- AlterTable
ALTER TABLE "WebAuthnCredential" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "transports" TEXT[];
