ALTER TABLE "Invitation"
  ADD COLUMN "deliveryPayloadCiphertext" BYTEA,
  ADD COLUMN "deliveryPayloadNonce" BYTEA,
  ADD COLUMN "deliveryPayloadTag" BYTEA,
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "deliveryLeaseUntil" TIMESTAMP(3);

CREATE INDEX "Invitation_emailedAt_deliveryAttempts_deliveryLeaseUntil_idx"
  ON "Invitation"("emailedAt", "deliveryAttempts", "deliveryLeaseUntil");
CREATE INDEX "Invitation_expiresAt_emailedAt_idx"
  ON "Invitation"("expiresAt", "emailedAt");

ALTER TABLE "AccountRecovery"
  ADD COLUMN "deliveryPayloadCiphertext" BYTEA,
  ADD COLUMN "deliveryPayloadNonce" BYTEA,
  ADD COLUMN "deliveryPayloadTag" BYTEA,
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "deliveryLeaseUntil" TIMESTAMP(3);

CREATE INDEX "AccountRecovery_emailedAt_deliveryAttempts_deliveryLeaseUntil_idx"
  ON "AccountRecovery"("emailedAt", "deliveryAttempts", "deliveryLeaseUntil");
CREATE INDEX "AccountRecovery_expiresAt_emailedAt_idx"
  ON "AccountRecovery"("expiresAt", "emailedAt");
