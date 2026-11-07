import type { DisputeCategory } from "../generated/prisma";
import { resolveCategoryLabel } from "../i18n/categoryGlossary";
import { prisma } from "./prisma";
import { decryptEmailPayload, type ProviderEmailPayload } from "./emailPayload";

/** Queued when a complainant submits a case and a case manager should see it. */
export const CASE_AWAITING_MANAGER_KIND = "case_awaiting_manager";
/** Queued for one party when a new outcome replaces the version they already answered. */
export const OUTCOME_NEEDS_ANSWER_KIND = "outcome_needs_answer";
/** Queued for the other party when a resolved case returns to issued. No outcome text. */
export const CASE_REOPENED_KIND = "case_reopened";
/** Queued for both parties when an automated case agent opens the position stage. */
export const CASE_AGENT_POSITIONS_REQUESTED_KIND = "case_agent_positions_requested";
/** Queued for independent approvers when an agent's proposal needs sign-off. */
export const RECOMMENDATION_APPROVAL_REQUIRED_KIND = "recommendation_approval_required";

function replyToAddress() {
  return process.env.EMAIL_REPLY_TO?.trim() || process.env.REPLY_TO?.trim() || "";
}

export function emailConfigured() {
  const encryptionKey = process.env.AEQUITAS_EMAIL_OUTBOX_ENCRYPTION_KEY;
  const baseUrl = process.env.APP_URL?.trim();
  if (!process.env.RESEND_API_KEY?.trim() || !process.env.EMAIL_FROM?.trim() || !replyToAddress()
    || !baseUrl || !encryptionKey || Buffer.byteLength(encryptionKey, "utf8") < 32) return false;
  try {
    const url = new URL(baseUrl);
    return process.env.NODE_ENV !== "production" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function appUrl(path: string) {
  const base = new URL(process.env.APP_URL!);
  if (process.env.NODE_ENV === "production" && base.protocol !== "https:") throw new Error("Invalid mail configuration");
  return new URL(path, base).toString();
}

export class EmailDeliveryError extends Error {
  constructor(readonly certainty: "rejected" | "uncertain") {
    super(certainty === "rejected" ? "Email provider rejected the message." : "Email delivery could not be confirmed.");
    this.name = "EmailDeliveryError";
  }
}

async function retryOnceOnUncertain(sendAndRecord: () => Promise<void>) {
  try {
    await sendAndRecord();
  } catch (error) {
    if (!(error instanceof EmailDeliveryError) || error.certainty !== "uncertain") throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await sendAndRecord();
  }
}

async function sendEmail(payload: ProviderEmailPayload, idempotencyKey: string) {
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // A timeout or lost connection can occur after the provider accepted and
    // queued the message. Callers must not invalidate a link that may be in it.
    throw new EmailDeliveryError("uncertain");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const definitelyRejected = response.status >= 400 && response.status < 500 && ![408, 409, 425].includes(response.status);
    throw new EmailDeliveryError(definitelyRejected ? "rejected" : "uncertain");
  }
  if (typeof data?.id !== "string") throw new EmailDeliveryError("uncertain");
}

type TokenEmailKind = "invitation" | "recovery";
type TokenEmailStatus = "accepted" | "pending" | "rejected" | "not_configured" | "not_queued";
const TOKEN_EMAIL_LEASE_MS = 2 * 60_000;
const TOKEN_EMAIL_RETRY_DELAY_MS = 15 * 60_000;

async function clearExpiredTokenEmailPayloads(now = new Date()) {
  const clearPayload = {
    deliveryPayloadCiphertext: null,
    deliveryPayloadNonce: null,
    deliveryPayloadTag: null,
    deliveryLeaseUntil: null,
  };
  await Promise.all([
    prisma.invitation.updateMany({ where: { expiresAt: { lte: now }, deliveryPayloadCiphertext: { not: null } }, data: clearPayload }),
    prisma.accountRecovery.updateMany({ where: { expiresAt: { lte: now }, deliveryPayloadCiphertext: { not: null } }, data: clearPayload }),
  ]);
}

async function claimInvitationEmail(id: string) {
  const now = new Date();
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Invitation" WHERE id = ${id} FOR UPDATE`;
    const row = await tx.invitation.findUnique({ where: { id } });
    if (!row || row.emailedAt || row.revokedAt || row.claimedAt || row.expiresAt <= now
      || !row.deliveryPayloadCiphertext || !row.deliveryPayloadNonce || !row.deliveryPayloadTag
      || row.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS
      || (row.deliveryLastAttemptAt && now.getTime() - row.deliveryLastAttemptAt.getTime() < TOKEN_EMAIL_RETRY_DELAY_MS)
      || (row.deliveryLeaseUntil && row.deliveryLeaseUntil > now)) return null;
    await tx.invitation.update({ where: { id }, data: {
      deliveryAttempts: { increment: 1 },
      deliveryLastAttemptAt: now,
      deliveryLeaseUntil: new Date(now.getTime() + TOKEN_EMAIL_LEASE_MS),
    } });
    return {
      ciphertext: row.deliveryPayloadCiphertext,
      nonce: row.deliveryPayloadNonce,
      tag: row.deliveryPayloadTag,
    };
  });
}

async function claimRecoveryEmail(id: string) {
  const now = new Date();
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AccountRecovery" WHERE id = ${id} FOR UPDATE`;
    const row = await tx.accountRecovery.findUnique({ where: { id } });
    if (!row || row.emailedAt || row.revokedAt || row.usedAt || row.expiresAt <= now
      || !row.deliveryPayloadCiphertext || !row.deliveryPayloadNonce || !row.deliveryPayloadTag
      || row.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS
      || (row.deliveryLastAttemptAt && now.getTime() - row.deliveryLastAttemptAt.getTime() < TOKEN_EMAIL_RETRY_DELAY_MS)
      || (row.deliveryLeaseUntil && row.deliveryLeaseUntil > now)) return null;
    await tx.accountRecovery.update({ where: { id }, data: {
      deliveryAttempts: { increment: 1 },
      deliveryLastAttemptAt: now,
      deliveryLeaseUntil: new Date(now.getTime() + TOKEN_EMAIL_LEASE_MS),
    } });
    return {
      ciphertext: row.deliveryPayloadCiphertext,
      nonce: row.deliveryPayloadNonce,
      tag: row.deliveryPayloadTag,
    };
  });
}

async function deliverTokenEmail(kind: TokenEmailKind, id: string): Promise<TokenEmailStatus> {
  if (!emailConfigured()) return "not_configured";
  const claim = kind === "invitation" ? await claimInvitationEmail(id) : await claimRecoveryEmail(id);
  if (!claim) return "not_queued";

  const clearPayload = {
    deliveryPayloadCiphertext: null,
    deliveryPayloadNonce: null,
    deliveryPayloadTag: null,
    deliveryLeaseUntil: null,
  };
  const payloadUpdate = kind === "invitation"
    ? (data: Record<string, unknown>) => prisma.invitation.updateMany({ where: { id, emailedAt: null }, data })
    : (data: Record<string, unknown>) => prisma.accountRecovery.updateMany({ where: { id, emailedAt: null }, data });

  try {
    const payload = decryptEmailPayload({ kind, id, ciphertext: claim.ciphertext, nonce: claim.nonce, tag: claim.tag });
    const sendAndRecord = async () => {
      await sendEmail(payload, `${kind}/${id}`);
      try {
        const changed = await payloadUpdate({ emailedAt: new Date(), ...clearPayload });
        if (changed.count !== 1) throw new Error("Email record changed before acceptance could be stored.");
      } catch {
        console.error("Email provider acceptance could not be persisted; retained for retry.");
        throw new EmailDeliveryError("uncertain");
      }
    };
    await retryOnceOnUncertain(sendAndRecord);
    return "accepted";
  } catch (error) {
    const rejected = error instanceof EmailDeliveryError && error.certainty === "rejected";
    const permanentFailure = rejected || !(error instanceof EmailDeliveryError);
    const data = permanentFailure
      ? {
          deliveryAttempts: MAX_DELIVERY_ATTEMPTS,
          ...clearPayload,
          ...(kind === "recovery" ? { revokedAt: new Date() } : {}),
        }
      : { deliveryLeaseUntil: null };
    try { await payloadUpdate(data); }
    catch { console.error("Token email retry state could not be recorded."); }
    if (permanentFailure) return "rejected";
    return "pending";
  }
}

export async function sendInvitationEmail(input: { invitationId: string }): Promise<TokenEmailStatus> {
  return deliverTokenEmail("invitation", input.invitationId);
}

export async function sendAccountRecoveryEmail(input: { recoveryId: string }): Promise<TokenEmailStatus> {
  return deliverTokenEmail("recovery", input.recoveryId);
}

/** Retries encrypted, single-use invitation and recovery messages from their records. */
export async function deliverPendingTokenEmails(limit = 20) {
  const now = new Date();
  await clearExpiredTokenEmailPayloads(now);
  if (!emailConfigured()) return { accepted: 0, pending: false };
  const [invitations, recoveries] = await Promise.all([
    prisma.invitation.findMany({
      where: {
        emailedAt: null, revokedAt: null, claimedAt: null, expiresAt: { gt: now },
        deliveryAttempts: { lt: MAX_DELIVERY_ATTEMPTS }, deliveryPayloadCiphertext: { not: null },
        AND: [
          { OR: [{ deliveryLeaseUntil: null }, { deliveryLeaseUntil: { lte: now } }] },
          { OR: [{ deliveryLastAttemptAt: null }, { deliveryLastAttemptAt: { lte: new Date(now.getTime() - TOKEN_EMAIL_RETRY_DELAY_MS) } }] },
        ],
      },
      select: { id: true }, orderBy: [{ deliveryLastAttemptAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }], take: limit,
    }),
    prisma.accountRecovery.findMany({
      where: {
        emailedAt: null, revokedAt: null, usedAt: null, expiresAt: { gt: now },
        deliveryAttempts: { lt: MAX_DELIVERY_ATTEMPTS }, deliveryPayloadCiphertext: { not: null },
        AND: [
          { OR: [{ deliveryLeaseUntil: null }, { deliveryLeaseUntil: { lte: now } }] },
          { OR: [{ deliveryLastAttemptAt: null }, { deliveryLastAttemptAt: { lte: new Date(now.getTime() - TOKEN_EMAIL_RETRY_DELAY_MS) } }] },
        ],
      },
      select: { id: true }, orderBy: [{ deliveryLastAttemptAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }], take: limit,
    }),
  ]);
  let accepted = 0;
  let pending = false;
  for (const invitation of invitations) {
    const status = await deliverTokenEmail("invitation", invitation.id);
    if (status === "accepted") accepted += 1;
    else if (status === "pending") pending = true;
  }
  for (const recovery of recoveries) {
    const status = await deliverTokenEmail("recovery", recovery.id);
    if (status === "accepted") accepted += 1;
    else if (status === "pending") pending = true;
  }
  return { accepted, pending: pending || invitations.length === limit || recoveries.length === limit };
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
  if (input.kind === OUTCOME_NEEDS_ANSWER_KIND) {
    const link = appUrl(`/${input.locale}/cases/${input.caseId}`);
    return french
      ? {
          subject: "Un nouveau résultat demande votre réponse",
          text: `Le médiateur a émis un nouveau résultat dans votre dossier. Votre réponse précédente ne s'applique plus. Connectez-vous pour lire le résultat et consentir ou refuser :\n\n${link}`,
        }
      : {
          subject: "A new outcome needs your answer",
          text: `The mediator issued a new outcome on your case. Your earlier answer no longer applies. Sign in to read the outcome and consent or decline:\n\n${link}`,
        };
  }
  if (input.kind === RECOMMENDATION_APPROVAL_REQUIRED_KIND) {
    const link = appUrl(`/${input.locale}/cases/${input.caseId}`);
    const reference = input.referenceNumber ? ` ${input.referenceNumber}` : "";
    const category = input.category ? resolveCategoryLabel(input.category, input.locale) : null;
    return french
      ? {
          subject: "Un dossier attend une approbation indépendante",
          text: `La recommandation actuelle du dossier${reference} attend l’examen d’une personne approbatrice avant que le consentement des deux parties puisse régler le dossier.${category ? `\nCatégorie : ${category}.` : ""}\n\nConnectez-vous pour examiner le dossier :\n\n${link}`,
        }
      : {
          subject: "A case needs independent sign-off",
          text: `The current recommendation in case${reference} needs an independent approver's review before both parties' consent can resolve it.${category ? `\nCategory: ${category}.` : ""}\n\nSign in to review the case:\n\n${link}`,
        };
  }
  if (input.kind === "agent_managing") {
    const link = appUrl(`/${input.locale}/cases/${input.caseId}`);
    return french
      ? { subject: "Un assistant automatisé s’occupe de votre dossier", text: `Un assistant automatisé s’occupe des étapes courantes de votre dossier. Ses propositions ne sont pas contraignantes, ne constituent pas un avis juridique et ne jugent pas qui dit vrai. Votre participation est volontaire : vous pouvez demander qu’une personne examine le dossier ou mettre fin à votre participation en tout temps.\n\n${link}` }
      : { subject: "An automated assistant is handling your case", text: `An automated assistant handles the routine steps of your case. Its proposals are not binding, are not legal advice, and do not judge who is telling the truth. Taking part is voluntary: you can ask for a person to review the case or end your participation at any time.\n\n${link}` };
  }
  if (input.kind === "agent_escalated") {
    const link = appUrl(`/${input.locale}/cases/${input.caseId}`);
    const reference = input.referenceNumber ?? "";
    return french
      ? { subject: "Un dossier a besoin d’une personne", text: `L’assistant automatisé a cessé de traiter le dossier ${reference}. Une personne doit le prendre en charge :\n\n${link}` }
      : { subject: "A case needs a person", text: `The automated assistant stopped handling case ${reference}. A person needs to take it:\n\n${link}` };
  }
  if (input.kind === CASE_REOPENED_KIND) {
    const link = appUrl(`/${input.locale}/cases/${input.caseId}`);
    return french
      ? { subject: "Le dossier a été rouvert", text: `Le dossier a été rouvert. Connectez-vous pour consulter le dossier :\n\n${link}` }
      : { subject: "The case was reopened", text: `The case was reopened. Sign in to read the record:\n\n${link}` };
  }
  if (input.kind === CASE_AGENT_POSITIONS_REQUESTED_KIND) {
    const link = appUrl(`/${input.locale}/cases/${input.caseId}`);
    return french
      ? { subject: "La collecte de preuves est terminée", text: `La collecte de preuves est terminée. Connectez-vous pour soumettre ou mettre à jour votre position dans le dossier :\n\n${link}` }
      : { subject: "Evidence intake is complete", text: `Evidence intake is complete. Sign in to submit or update your position in the case:\n\n${link}` };
  }
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

/**
 * A queued notification is tried at most this many times. After that it
 * stays unsent and is counted by notificationBacklog() for an operator.
 */
export const MAX_DELIVERY_ATTEMPTS = 8;

/**
 * Transactional outbox: failures remain pending; retries use the same Resend
 * idempotency key. Least-recently-tried rows go first, so a few rows that
 * keep failing cannot block newer ones, and each row is tried a bounded
 * number of times.
 */
export async function deliverPendingNotifications(caseId?: string) {
  if (!emailConfigured()) return { accepted: 0, pending: true };
  const pending = await prisma.notification.findMany({
    where: { sentAt: null, attempts: { lt: MAX_DELIVERY_ATTEMPTS }, user: { credentials: { some: {} } }, ...(caseId ? { caseId } : {}) },
    include: { user: { select: { email: true } }, case: { select: { referenceNumber: true, category: true } } },
    orderBy: [{ lastAttemptAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
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
      await sendEmail({
        from: process.env.EMAIL_FROM!.trim(),
        reply_to: replyToAddress(),
        to: [notification.user.email],
        subject: copy.subject,
        text: copy.text,
      }, `notification/${notification.id}`);
      await prisma.notification.update({ where: { id: notification.id }, data: { sentAt: new Date(), attempts: { increment: 1 }, lastAttemptAt: new Date() } });
      accepted++;
    } catch {
      // Keep recipient addresses, case contents and provider errors out of logs.
      console.error("Case notification delivery failed; retained for retry.");
      try { await prisma.notification.update({ where: { id: notification.id }, data: { attempts: { increment: 1 }, lastAttemptAt: new Date() } }); }
      catch { console.error("Notification attempt could not be recorded."); }
    }
  }
  return { accepted, pending: pending.length > accepted };
}

/** Counts only, for operators: no addresses or case content. */
export async function notificationBacklog() {
  const now = new Date();
  const [retrying, exhausted, invitationRetrying, recoveryRetrying, invitationExhausted, recoveryExhausted] = await Promise.all([
    prisma.notification.count({ where: { sentAt: null, attempts: { lt: MAX_DELIVERY_ATTEMPTS } } }),
    prisma.notification.count({ where: { sentAt: null, attempts: { gte: MAX_DELIVERY_ATTEMPTS } } }),
    prisma.invitation.count({ where: { emailedAt: null, revokedAt: null, claimedAt: null, expiresAt: { gt: now }, deliveryAttempts: { lt: MAX_DELIVERY_ATTEMPTS }, deliveryPayloadCiphertext: { not: null } } }),
    prisma.accountRecovery.count({ where: { emailedAt: null, revokedAt: null, usedAt: null, expiresAt: { gt: now }, deliveryAttempts: { lt: MAX_DELIVERY_ATTEMPTS }, deliveryPayloadCiphertext: { not: null } } }),
    prisma.invitation.count({ where: { emailedAt: null, revokedAt: null, claimedAt: null, expiresAt: { gt: now }, deliveryAttempts: { gte: MAX_DELIVERY_ATTEMPTS } } }),
    prisma.accountRecovery.count({ where: { emailedAt: null, revokedAt: null, usedAt: null, expiresAt: { gt: now }, deliveryAttempts: { gte: MAX_DELIVERY_ATTEMPTS } } }),
  ]);
  return {
    retrying,
    exhausted,
    tokenEmailRetrying: invitationRetrying + recoveryRetrying,
    tokenEmailExhausted: invitationExhausted + recoveryExhausted,
  };
}
