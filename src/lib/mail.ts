import type { DisputeCategory } from "../generated/prisma";
import { resolveCategoryLabel } from "../i18n/categoryGlossary";
import { prisma } from "./prisma";
import { RECOVERY_TTL_MINUTES } from "./accountRecovery";

/** Queued when a complainant submits a case and a case manager should see it. */
export const CASE_AWAITING_MANAGER_KIND = "case_awaiting_manager";

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

export async function sendAccountRecoveryEmail(input: { email: string; locale: string; token: string; recoveryId: string }) {
  if (!emailConfigured()) return "not_configured" as const;
  const french = input.locale === "fr-CA";
  const link = appUrl(`/${french ? "fr-CA" : "en-CA"}/auth/recover/${encodeURIComponent(input.token)}`);
  await sendEmail(input.email, french ? "Récupérer votre accès Aequitas" : "Recover your Aequitas access", french
    ? `Une demande de récupération de votre accès Aequitas a été reçue. Pour créer une nouvelle clé d’accès, ouvrez ce lien à usage unique dans les ${RECOVERY_TTL_MINUTES} prochaines minutes :\n\n${link}\n\nSi vous n’avez pas demandé cette récupération, ignorez ce message. Votre clé d’accès actuelle reste valide tant que la récupération n’est pas terminée.`
    : `A request to recover your Aequitas access was received. To create a new passkey, open this single-use link within ${RECOVERY_TTL_MINUTES} minutes:\n\n${link}\n\nIf you did not request this, ignore this message. Your current passkey remains valid until recovery is completed.`, `recovery/${input.recoveryId}`);
  try { await prisma.accountRecovery.update({ where: { id: input.recoveryId }, data: { emailedAt: new Date() } }); }
  catch { console.error("Recovery email accepted; delivery timestamp could not be persisted."); }
  return "accepted" as const;
}

/**
 * Email copy for one queued notification. Case-manager alerts name only the
 * reference number and category. Every other kind stays a generic update
 * with a link, and never includes the dispute description.
 */
export function notificationEmail(input: {
  kind: string;
  locale: string;
  caseId: string;
  referenceNumber?: string;
  category?: DisputeCategory;
}): { subject: string; text: string } {
  const french = input.locale === "fr-CA";
  if (input.kind === CASE_AWAITING_MANAGER_KIND && input.referenceNumber && input.category) {
    const category = resolveCategoryLabel(input.category, input.locale);
    const reference = input.referenceNumber;
    const link = appUrl(`/${input.locale}/cases`);
    return french
      ? {
          subject: "Un nouveau dossier attend un gestionnaire",
          text: `Un nouveau dossier est ouvert et attend qu’un gestionnaire le prenne en charge.\n\nRéférence : ${reference}\nCatégorie : ${category}\n\nConnectez-vous pour voir les dossiers en attente :\n${link}`,
        }
      : {
          subject: "A new case is waiting for a case manager",
          text: `A new case is open and waiting for a case manager to take it.\n\nReference: ${reference}\nCategory: ${category}\n\nSign in to see cases that are waiting:\n${link}`,
        };
  }
  return {
    subject: french ? "Une mise à jour dans Aequitas" : "An update in Aequitas",
    text: `${french ? "Votre dossier a été mis à jour. Connectez-vous pour consulter le dossier :" : "Your case has been updated. Sign in to read the record:"}\n\n${appUrl(`/${input.locale}/cases/${input.caseId}`)}`,
  };
}

/** Transactional outbox: failures remain pending; retries use the same Resend idempotency key. */
export async function deliverPendingNotifications(caseId?: string) {
  if (!emailConfigured()) return { accepted: 0, pending: true };
  const pending = await prisma.notification.findMany({
    where: { sentAt: null, user: { credentials: { some: {} } }, ...(caseId ? { caseId } : {}) },
    include: { user: { select: { email: true } }, case: { select: { referenceNumber: true, category: true } } },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  let accepted = 0;
  for (const notification of pending) {
    try {
      const copy = notificationEmail({
        kind: notification.kind,
        locale: notification.locale,
        caseId: notification.caseId,
        referenceNumber: notification.case?.referenceNumber,
        category: notification.case?.category,
      });
      await sendEmail(notification.user.email, copy.subject, copy.text, `notification/${notification.id}`);
      await prisma.notification.update({ where: { id: notification.id }, data: { sentAt: new Date() } });
      accepted++;
    } catch {
      // Keep recipient addresses, case contents and provider errors out of logs.
      console.error("Case notification delivery failed; retained for retry.");
    }
  }
  return { accepted, pending: pending.length > accepted };
}
