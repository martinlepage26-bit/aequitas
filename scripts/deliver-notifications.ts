import "../src/lib/loadEnv";
import { assertRetentionRestoreSafe } from "../src/domain/retentionLedger";
import { deliverPendingNotifications, deliverPendingTokenEmails, emailConfigured, notificationBacklog } from "../src/lib/mail";
import { prisma } from "../src/lib/prisma";

/**
 * Retry notification, invitation, and recovery outboxes. Meant for a scheduled job (for example a
 * cron entry every 15 minutes) on the single pilot deployment. Prints counts
 * only. Each batch processes up to 20 ordinary notifications, 20 invitations,
 * and 20 recovery emails; each queued message is tried at most
 * MAX_DELIVERY_ATTEMPTS times in total.
 */
async function main() {
  await assertRetentionRestoreSafe();
  const batches = Math.min(Math.max(Number(process.argv[2] ?? 5) || 5, 1), 50);
  if (!emailConfigured()) {
    await deliverPendingTokenEmails(); // Clears expired encrypted links even while delivery is unconfigured.
    console.log(JSON.stringify({ configured: false, ...(await notificationBacklog()) }));
    return;
  }
  let notificationsAccepted = 0;
  let tokenEmailsAccepted = 0;
  for (let i = 0; i < batches; i += 1) {
    const [notifications, tokenEmails] = await Promise.all([deliverPendingNotifications(), deliverPendingTokenEmails()]);
    notificationsAccepted += notifications.accepted;
    tokenEmailsAccepted += tokenEmails.accepted;
    if (!notifications.pending && !tokenEmails.pending && notifications.accepted === 0 && tokenEmails.accepted === 0) break;
  }
  console.log(JSON.stringify({ configured: true, notificationsAccepted, tokenEmailsAccepted, ...(await notificationBacklog()) }));
}

main()
  .catch(() => { console.error("Notification retry run failed."); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
