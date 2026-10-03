import { prisma } from "./prisma";

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.EMAIL_REPLY_TO && process.env.APP_URL);
}

function appUrl(path: string) {
  const base = new URL(process.env.APP_URL!);
  if (process.env.NODE_ENV === "production" && base.protocol !== "https:") throw new Error("Invalid mail configuration");
  return new URL(path, base).toString();
}

async function sendEmail(to: string, subject: string, text: string, idempotencyKey: string) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, reply_to: process.env.EMAIL_REPLY_TO, to: [to], subject, text }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.id !== "string") throw new Error("Email provider did not accept the message");
}

export async function sendInvitationEmail(input: { email: string; locale: string; claimPath: string; invitationId: string }) {
  if (!emailConfigured()) return "not_configured" as const;
  const french = input.locale === "fr-CA";
  const link = appUrl(input.claimPath);
  await sendEmail(input.email, french ? "Votre invitation à Aequitas" : "Your invitation to Aequitas", french
    ? `Vous avez reçu une invitation à Aequitas. Créez votre clé d’accès avec ce lien, valable 72 heures :\n\n${link}\n\nSi vous n’attendiez pas cette invitation, vous pouvez l’ignorer.`
    : `You have been invited to Aequitas. Create your passkey using this link, valid for 72 hours:\n\n${link}\n\nIf you were not expecting this invitation, you can ignore it.`, `invitation/${input.invitationId}`);
  try { await prisma.invitation.update({ where: { id: input.invitationId }, data: { emailedAt: new Date() } }); }
  catch { console.error("Invitation email accepted; delivery timestamp could not be persisted."); }
  return "accepted" as const;
}

/** Transactional outbox: failures remain pending; retries use the same Resend idempotency key. */
export async function deliverPendingNotifications(caseId?: string) {
  if (!emailConfigured()) return { accepted: 0, pending: true };
  const pending = await prisma.notification.findMany({ where: { sentAt: null, user: { credentials: { some: {} } }, ...(caseId ? { caseId } : {}) }, include: { user: { select: { email: true } } }, orderBy: { createdAt: "asc" }, take: 20 });
  let accepted = 0;
  for (const notification of pending) {
    try {
      const french = notification.locale === "fr-CA";
      await sendEmail(notification.user.email, french ? "Une mise à jour dans Aequitas" : "An update in Aequitas", `${french ? "Votre dossier a été mis à jour. Connectez-vous pour consulter le dossier :" : "Your case has been updated. Sign in to read the record:"}\n\n${appUrl(`/${notification.locale}/cases/${notification.caseId}`)}`, `notification/${notification.id}`);
      await prisma.notification.update({ where: { id: notification.id }, data: { sentAt: new Date() } });
      accepted++;
    } catch {
      // Keep recipient addresses, case contents and provider errors out of logs.
      console.error("Case notification delivery failed; retained for retry.");
    }
  }
  return { accepted, pending: pending.length > accepted };
}
