import "../src/lib/loadEnv";
import { deliverPendingNotifications, emailConfigured, notificationBacklog } from "../src/lib/mail";
import { prisma } from "../src/lib/prisma";

/**
 * Retry the notification outbox. Meant for a scheduled job (for example a
 * cron entry every 15 minutes) on the single pilot deployment. Prints counts
 * only. Each run sends at most `batches` x 20 messages; each message is
 * tried at most MAX_DELIVERY_ATTEMPTS times in total.
 */
async function main() {
  const batches = Math.min(Math.max(Number(process.argv[2] ?? 5) || 5, 1), 50);
  if (!emailConfigured()) {
    console.log(JSON.stringify({ configured: false, ...(await notificationBacklog()) }));
    return;
  }
  let accepted = 0;
  for (let i = 0; i < batches; i += 1) {
    const result = await deliverPendingNotifications();
    accepted += result.accepted;
    if (!result.pending && result.accepted === 0) break;
  }
  console.log(JSON.stringify({ configured: true, accepted, ...(await notificationBacklog()) }));
}

main()
  .catch(() => { console.error("Notification retry run failed."); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
