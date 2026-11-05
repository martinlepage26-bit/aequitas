-- Bounded retry for the notification outbox. Additive only: existing rows
-- start at zero attempts and stay eligible for delivery.
ALTER TABLE "Notification" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Notification" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
CREATE INDEX "Notification_sentAt_attempts_idx" ON "Notification"("sentAt", "attempts");
