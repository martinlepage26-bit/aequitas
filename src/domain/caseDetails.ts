import type { CaseState, DisputeCategory, GlobalRole } from "../generated/prisma";
import { DISPUTE_CATEGORIES } from "../i18n/categoryGlossary";
import { prisma } from "../lib/prisma";
import { appendEvent } from "./events";
import { normalizeAmountAtStake, normalizeDisputeDescription } from "./intake";

export const caseDetailsEditable = (state: CaseState) =>
  state === "DRAFT" || state === "OPEN" || state === "EVIDENCE_INTAKE";

export interface CaseDetailsInput {
  caseId: string;
  actorId: string;
  actorRole: GlobalRole;
  expectedRevision: string | null;
  category: unknown;
  disputeDescription: unknown;
  amountAtStake: unknown;
  respondentEmail: unknown;
  respondentDisplayName: unknown;
  simulated: unknown;
}

type Failure = { ok: false; status: 400 | 403 | 404 | 409; message: string };
type Result = Failure | { ok: true; revision: string | null; changed: boolean };
const fail = (status: Failure["status"], message: string): Failure => ({ ok: false, status, message });

/** Save the complainant's initial dossier fields without rewriting an activated party's identity. */
export async function saveCaseDetails(input: CaseDetailsInput): Promise<Result> {
  if (input.actorRole !== "COMPLAINANT") return fail(403, "Only the complainant can edit dossier details.");
  if (typeof input.category !== "string" || !DISPUTE_CATEGORIES.includes(input.category as DisputeCategory)) {
    return fail(400, "Choose a valid dispute category.");
  }
  const description = normalizeDisputeDescription(input.disputeDescription);
  if (!description.ok) return fail(400, description.reason);
  const amount = normalizeAmountAtStake(input.amountAtStake);
  if (!amount.ok) return fail(400, amount.reason);
  const email = typeof input.respondentEmail === "string" ? input.respondentEmail.trim().toLowerCase() : "";
  const name = typeof input.respondentDisplayName === "string" ? input.respondentDisplayName.trim() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, "Enter a valid respondent email.");
  if (!name || name.length > 200) return fail(400, "Enter the respondent's name (up to 200 characters).");
  if (typeof input.simulated !== "boolean") return fail(400, "Choose whether this is a simulated dossier.");
  if (input.expectedRevision !== null && typeof input.expectedRevision !== "string") return fail(400, "Invalid dossier revision.");

  return prisma.$transaction(async (tx): Promise<Result> => {
    await tx.$queryRaw`SELECT id FROM "Case" WHERE id = ${input.caseId} FOR UPDATE`;
    const row = await tx.case.findUnique({
      where: { id: input.caseId },
      include: { respondent: { select: { id: true, email: true, displayName: true, locale: true, _count: { select: { credentials: true, casesAsRespondent: true } } } } },
    });
    if (!row || row.complainantId !== input.actorId) return fail(404, "Dossier not found.");
    if (!caseDetailsEditable(row.state)) return fail(409, "This dossier can no longer be edited at this stage.");
    const latest = await tx.event.findFirst({ where: { caseId: input.caseId, type: "CASE_DETAILS_UPDATED" }, orderBy: { seq: "desc" }, select: { id: true } });
    if ((latest?.id ?? null) !== input.expectedRevision) return fail(409, "This dossier changed. Reload it before saving.");

    const respondentChanged = email !== row.respondent.email.toLowerCase();
    const respondentNameChanged = name !== row.respondent.displayName;
    const simulationChanged = row.simulated !== input.simulated;
    const detailsChanged = row.category !== input.category || row.disputeDescription !== description.description || row.amountAtStakeCents !== amount.cents || simulationChanged;
    if (!respondentChanged && !respondentNameChanged && !detailsChanged) return { ok: true, revision: latest?.id ?? null, changed: false };

    if (simulationChanged) {
      const [evidence, chronology, positions, recommendations] = await Promise.all([
        tx.evidenceItem.count({ where: { caseId: input.caseId } }),
        tx.chronologyEntry.count({ where: { caseId: input.caseId } }),
        tx.positionStatement.count({ where: { caseId: input.caseId } }),
        tx.recommendation.count({ where: { caseId: input.caseId } }),
      ]);
      if (evidence + chronology + positions + recommendations > 0) return fail(409, "The simulation setting cannot change after submissions have begun.");
    }

    let respondentId = row.respondentId;
    let respondentName = row.respondent.displayName;
    if (respondentChanged || respondentNameChanged) {
      if (row.respondent._count.credentials > 0) return fail(409, "The respondent has activated this account. Contact an administrator to change their identity.");
      const [evidence, positions, chronology, consents, contestations, sentNotices, sentInvites] = await Promise.all([
        tx.evidenceItem.count({ where: { caseId: input.caseId, submittedById: row.respondentId } }),
        tx.positionStatement.count({ where: { caseId: input.caseId, partyId: row.respondentId } }),
        tx.chronologyEntry.count({ where: { caseId: input.caseId, submittedById: row.respondentId } }),
        tx.consentRecord.count({ where: { caseId: input.caseId, partyId: row.respondentId } }),
        tx.contestation.count({ where: { caseId: input.caseId, openedById: row.respondentId } }),
        tx.notification.count({ where: { caseId: input.caseId, userId: row.respondentId, sentAt: { not: null } } }),
        tx.invitation.count({ where: { userId: row.respondentId, revokedAt: null, claimedAt: null, expiresAt: { gt: new Date() } } }),
      ]);
      if (evidence + positions + chronology + consents + contestations + sentNotices + sentInvites > 0) {
        return fail(409, "The respondent has already participated or been invited. Their identity cannot be changed here.");
      }
      if (respondentChanged) {
        const existing = await tx.user.findUnique({ where: { email } });
        if (existing && existing.globalRole !== "RESPONDENT") return fail(409, "That email belongs to an account with a different role.");
        const respondent = existing ?? await tx.user.create({ data: { email, displayName: name, globalRole: "RESPONDENT", locale: row.respondent.locale ?? "fr-CA" } });
        respondentId = respondent.id;
        respondentName = respondent.displayName;
        await tx.notification.updateMany({ where: { caseId: input.caseId, userId: row.respondentId, sentAt: null }, data: { userId: respondentId } });
      } else {
        if (row.respondent._count.casesAsRespondent > 1) return fail(409, "This respondent appears in another dossier; an administrator must update their name.");
        await tx.user.update({ where: { id: row.respondentId }, data: { displayName: name } });
        respondentName = name;
      }
    }

    await tx.case.update({ where: { id: input.caseId }, data: {
      category: input.category as DisputeCategory,
      disputeDescription: description.description,
      amountAtStakeCents: amount.cents,
      respondentId,
      simulated: input.simulated as boolean,
    } });
    const event = await appendEvent(tx, { caseId: input.caseId, actorId: input.actorId, type: "CASE_DETAILS_UPDATED", payload: {
      before: { category: row.category, disputeDescription: row.disputeDescription, amountAtStakeCents: row.amountAtStakeCents, simulated: row.simulated, respondentId: row.respondentId, respondentEmail: row.respondent.email, respondentName: row.respondent.displayName },
      after: { category: input.category, disputeDescription: description.description, amountAtStakeCents: amount.cents, simulated: input.simulated, respondentId, respondentEmail: email, respondentName },
    } });
    return { ok: true, revision: event.id, changed: true };
  });
}
