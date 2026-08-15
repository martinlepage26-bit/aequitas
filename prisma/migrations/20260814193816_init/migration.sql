-- CreateEnum
CREATE TYPE "GlobalRole" AS ENUM ('CONSUMER', 'RETAILER_HANDLER', 'CASE_MANAGER', 'ADMIN');

-- CreateEnum
CREATE TYPE "CaseState" AS ENUM ('DRAFT', 'OPEN', 'EVIDENCE_INTAKE', 'POSITIONS', 'DRAFTING', 'ISSUED', 'RESOLVED_CONSENT', 'RESOLVED_DECLINED', 'WITHDRAWN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ConsentState" AS ENUM ('NOT_GIVEN', 'GIVEN', 'DECLINED', 'REVOKED');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('DOCUMENT', 'PHOTO', 'MESSAGE', 'RECEIPT', 'OTHER');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'CLEAN', 'REJECTED');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('DRAFT', 'ISSUED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('CASE_CREATED', 'CASE_SUBMITTED', 'CASE_ASSIGNED', 'COI_DECLARED', 'EVIDENCE_INTAKE_OPENED', 'EVIDENCE_SUBMITTED', 'EVIDENCE_SUPERSEDED', 'EVIDENCE_INTAKE_CLOSED', 'POSITION_SUBMITTED', 'RECOMMENDATION_DRAFT_REQUESTED', 'RECOMMENDATION_DRAFTED', 'RECOMMENDATION_ISSUED', 'RECOMMENDATION_SUPERSEDED', 'CONSENT_GIVEN', 'CONSENT_DECLINED', 'CONSENT_REVOKED', 'CASE_RESOLVED', 'CASE_RESOLVED_DECLINED', 'CASE_REOPENED', 'CASE_WITHDRAWN', 'CASE_CLOSED', 'EXPORT_GENERATED', 'DEADLINE_EXPIRED', 'PARTY_NOTIFIED', 'NOTE_ADDED', 'ACCESS_STAFF_GRANTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'fr-CA',
    "globalRole" "GlobalRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebAuthnCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL,

    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "state" "CaseState" NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "consumerId" TEXT NOT NULL,
    "retailerHandlerId" TEXT NOT NULL,
    "caseManagerId" TEXT,
    "currentRecommendationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceItem" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "scanStatus" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "simulated" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionStatement" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "RecommendationStatus" NOT NULL,
    "explanation" JSONB NOT NULL,
    "modelId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "state" "ConsentState" NOT NULL,
    "statementVersionId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "authContext" JSONB NOT NULL,
    "givenAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentStatementVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "locale" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentStatementVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoiDeclaration" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "caseManagerId" TEXT NOT NULL,
    "hasConflict" BOOLEAN NOT NULL,
    "details" TEXT,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoiDeclaration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" "EventType" NOT NULL,
    "actorId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportBundle" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "generatedById" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "Case_referenceNumber_key" ON "Case"("referenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceItem_storageKey_key" ON "EvidenceItem"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "Recommendation_caseId_version_key" ON "Recommendation"("caseId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentStatementVersion_version_locale_key" ON "ConsentStatementVersion"("version", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "Event_hash_key" ON "Event"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "Event_caseId_seq_key" ON "Event"("caseId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ExportBundle_storageKey_key" ON "ExportBundle"("storageKey");

-- AddForeignKey
ALTER TABLE "WebAuthnCredential" ADD CONSTRAINT "WebAuthnCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_retailerHandlerId_fkey" FOREIGN KEY ("retailerHandlerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_caseManagerId_fkey" FOREIGN KEY ("caseManagerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionStatement" ADD CONSTRAINT "PositionStatement_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionStatement" ADD CONSTRAINT "PositionStatement_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_statementVersionId_fkey" FOREIGN KEY ("statementVersionId") REFERENCES "ConsentStatementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoiDeclaration" ADD CONSTRAINT "CoiDeclaration_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoiDeclaration" ADD CONSTRAINT "CoiDeclaration_caseManagerId_fkey" FOREIGN KEY ("caseManagerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportBundle" ADD CONSTRAINT "ExportBundle_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportBundle" ADD CONSTRAINT "ExportBundle_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
