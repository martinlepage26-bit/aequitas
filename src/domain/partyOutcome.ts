import { z } from "zod";
import type { CaseState, GlobalRole, PartyOutcomeStatus, Prisma } from "../generated/prisma";
import { CASE_REOPENED_KIND, OUTCOME_NEEDS_ANSWER_KIND, deliverPendingNotifications } from "../lib/mail";
import { prisma } from "../lib/prisma";
import { caseReadAccess } from "./caseAccess";
import { consentAnswerCounts, stateAfterOutcomeReissue } from "./consent";
import { appendEvent } from "./events";
import type { CodedOutcome } from "./resolution";

/**
 * A mediator writes one outcome per party. The party sees only their latest
 * ISSUED text, and only that text unlocks consent or decline. Drafts stay
 * with the assigned mediator, an approver, and an admin.
 */

const WRITABLE_STATES: CaseState[] = ["ISSUED", "RESOLVED_CONSENT", "RESOLVED_DECLINED"];

const outcomeText = z.string().trim().min(1).max(20_000);
const outcomeLocale = z.string().trim().min(2).max(16);

export const partyOutcomeWriteSchema = z.object({
  caseId: z.string().uuid(),
  partyId: z.string().uuid(),
  body: outcomeText,
  locale: outcomeLocale.default("fr-CA"),
});

export type PartyOutcomeWriteInput = {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
  partyId: string;
  body: string;
  locale?: string;
};

export interface OutcomeVersionView {
  id: string;
  version: number;
  status: PartyOutcomeStatus;
  body: string;
  locale: string;
  issuedAt: string | null;
}

export interface PartyOutcomePartyView {
  partyId: string;
  displayName: string;
  issued: OutcomeVersionView | null;
  draft: OutcomeVersionView | null;
}

export interface PartyOutcomeView {
  canWrite: boolean;
  parties: PartyOutcomePartyView[];
}

type OutcomeRow = {
  id: string;
  partyId: string;
  version: number;
  status: PartyOutcomeStatus;
  body: string;
  locale: string;
  issuedAt: Date | null;
};

function fail(step: "authorize-role" | "authorize-state" | "guard" | "not-found", reason: string, code?: string): Extract<CodedOutcome<never>, { ok: false }> {
  return { ok: false, step, reason, ...(code ? { code } : {}) };
}

function toView(row: OutcomeRow): OutcomeVersionView {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    body: row.body,
    locale: row.locale,
    issuedAt: row.issuedAt?.toISOString() ?? null,
  };
}

function latest(rows: OutcomeRow[], status: PartyOutcomeStatus): OutcomeRow | null {
  const matching = rows.filter((row) => row.status === status);
  return matching.length === 0 ? null : matching[matching.length - 1];
}

export async function readPartyOutcomes(
  caseId: string,
  viewer: { userId: string; globalRole: GlobalRole; isApprover?: boolean },
): Promise<PartyOutcomeView | null> {
  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    include: {
      complainant: { select: { id: true, displayName: true } },
      respondent: { select: { id: true, displayName: true } },
    },
  });
  if (!caseRow) return null;
  const access = caseReadAccess(caseRow, viewer);
  if (!access || access === "claimable") return null;

  const rows = await prisma.partyOutcome.findMany({
    where: { caseId },
    orderBy: [{ partyId: "asc" }, { version: "asc" }],
  });
  const people = [caseRow.complainant, caseRow.respondent];
  const visible = access === "party" ? people.filter((person) => person.id === viewer.userId) : people;
  return {
    canWrite: access === "assigned-manager" && WRITABLE_STATES.includes(caseRow.state),
    parties: visible.map((person) => {
      const mine = rows.filter((row) => row.partyId === person.id);
      const issued = latest(mine, "ISSUED");
      const draft = access === "party" ? null : latest(mine, "DRAFT");
      return {
        partyId: person.id,
        displayName: person.displayName,
        issued: issued ? toView(issued) : null,
        draft: draft ? toView(draft) : null,
      };
    }),
  };
}

async function authorizeWrite(
  input: PartyOutcomeWriteInput,
  parsedBody: string,
  parsedLocale: string,
): Promise<{ ok: true; body: string; locale: string } | Extract<CodedOutcome<never>, { ok: false }>> {
  const [caseRow, actor] = await Promise.all([
    prisma.case.findUnique({ where: { id: input.caseId } }),
    prisma.user.findUnique({ where: { id: input.actorId }, select: { isApprover: true } }),
  ]);
  if (!caseRow) return fail("not-found", "Case not found.");
  const access = caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole, isApprover: actor?.isApprover ?? false });
  if (!access || access === "claimable") return fail("not-found", "Case not found.");
  if (access !== "assigned-manager" || input.actorRole !== "CASE_MANAGER") {
    return fail("authorize-role", "Only the assigned mediator can write a party outcome.");
  }
  if (!WRITABLE_STATES.includes(caseRow.state)) {
    return fail("authorize-state", `A party outcome can be written once the recommendation is issued, not from ${caseRow.state}.`);
  }
  if (input.partyId !== caseRow.complainantId && input.partyId !== caseRow.respondentId) {
    return fail("guard", "That person is not a party on this case.", "NOT_A_PARTY");
  }
  return { ok: true as const, body: parsedBody, locale: parsedLocale };
}

async function writePartyOutcome(
  input: PartyOutcomeWriteInput,
  action: "save" | "issue",
): Promise<CodedOutcome<{ id: string; version: number; status: PartyOutcomeStatus }>> {
  const parsed = partyOutcomeWriteSchema.safeParse({
    caseId: input.caseId,
    partyId: input.partyId,
    body: input.body,
    locale: input.locale ?? "fr-CA",
  });
  if (!parsed.success) return fail("guard", "A party outcome needs written text.", "INVALID_INPUT");
  const allowed = await authorizeWrite(input, parsed.data.body, parsed.data.locale);
  if (!allowed.ok) return allowed;
  const { body, locale } = allowed;

  const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Case" WHERE id = ${input.caseId} FOR UPDATE`;
      const latest = await tx.partyOutcome.findFirst({
        where: { caseId: input.caseId, partyId: input.partyId },
        orderBy: { version: "desc" },
      });

      if (action === "save") {
        if (latest?.status === "DRAFT") {
          if (latest.body === body && latest.locale === locale) return latest;
          const updated = await tx.partyOutcome.update({ where: { id: latest.id }, data: { body, locale } });
          await appendOutcomeEvent(tx, input, "PARTY_OUTCOME_EDITED", updated.id, updated.version);
          return updated;
        }
        const created = await tx.partyOutcome.create({
          data: {
            caseId: input.caseId,
            partyId: input.partyId,
            version: (latest?.version ?? 0) + 1,
            status: "DRAFT",
            body,
            locale,
            authoredById: input.actorId,
          },
        });
        await appendOutcomeEvent(tx, input, "PARTY_OUTCOME_EDITED", created.id, created.version);
        return created;
      }

      let draft = latest?.status === "DRAFT" ? latest : null;
      if (draft) {
        if (draft.body !== body || draft.locale !== locale) {
          draft = await tx.partyOutcome.update({ where: { id: draft.id }, data: { body, locale } });
          await appendOutcomeEvent(tx, input, "PARTY_OUTCOME_EDITED", draft.id, draft.version);
        }
      } else if (!latest || latest.body !== body || latest.locale !== locale || latest.status !== "ISSUED") {
        draft = await tx.partyOutcome.create({
          data: {
            caseId: input.caseId,
            partyId: input.partyId,
            version: (latest?.version ?? 0) + 1,
            status: "DRAFT",
            body,
            locale,
            authoredById: input.actorId,
          },
        });
        await appendOutcomeEvent(tx, input, "PARTY_OUTCOME_EDITED", draft.id, draft.version);
      } else {
        return latest;
      }

      const issued = await tx.partyOutcome.update({
        where: { id: draft.id },
        data: { status: "ISSUED", issuedAt: new Date() },
      });
      await appendOutcomeEvent(tx, input, "PARTY_OUTCOME_ISSUED", issued.id, issued.version);
      await revokeSupersededAnswer(tx, input, issued);
      return issued;
    });
  if (action === "issue") {
    try { await deliverPendingNotifications(input.caseId); }
    catch { console.error("Notification dispatch unavailable; retained for retry."); }
  }
  return { ok: true, data: { id: saved.id, version: saved.version, status: saved.status } };
}

async function revokeSupersededAnswer(
  tx: Prisma.TransactionClient,
  input: PartyOutcomeWriteInput,
  issued: { id: string; version: number },
) {
  const caseRow = await tx.case.findUniqueOrThrow({
    where: { id: input.caseId },
    include: { complainant: { select: { locale: true } }, respondent: { select: { locale: true } } },
  });
  const recommendationId = caseRow.currentRecommendationId;
  if (!recommendationId) return;
  const record = await tx.consentRecord.findFirst({ where: { recommendationId, partyId: input.partyId } });
  if (!record || (record.state !== "GIVEN" && record.state !== "DECLINED")) return;
  if (record.partyOutcomeId === issued.id && record.partyOutcomeVersion === issued.version) return;

  await tx.consentRecord.update({
    where: { id: record.id },
    data: { state: "REVOKED", revokedAt: new Date(), revokedReason: "outcome_reissued" },
  });
  const otherPartyId = input.partyId === caseRow.complainantId ? caseRow.respondentId : caseRow.complainantId;
  const [otherRecord, otherOutcome] = await Promise.all([
    tx.consentRecord.findFirst({ where: { recommendationId, partyId: otherPartyId } }),
    tx.partyOutcome.findFirst({
      where: { caseId: input.caseId, partyId: otherPartyId, status: "ISSUED" },
      orderBy: { version: "desc" },
      select: { id: true, version: true },
    }),
  ]);
  const actorAnswer = consentAnswerCounts(
    { state: "REVOKED", partyOutcomeId: record.partyOutcomeId, partyOutcomeVersion: record.partyOutcomeVersion },
    issued,
  );
  const otherAnswer = consentAnswerCounts(otherRecord, otherOutcome);
  const complainantAnswer = input.partyId === caseRow.complainantId ? actorAnswer : otherAnswer;
  const respondentAnswer = input.partyId === caseRow.respondentId ? actorAnswer : otherAnswer;
  const nextState = stateAfterOutcomeReissue(caseRow.state, complainantAnswer, respondentAnswer);
  if (nextState !== caseRow.state) {
    await tx.case.update({ where: { id: input.caseId }, data: { state: nextState } });
  }
  await appendEvent(tx, {
    caseId: input.caseId,
    type: "CONSENT_REVOKED",
    actorId: input.actorId,
    payload: {
      recommendationId,
      partyId: input.partyId,
      outcomeId: record.partyOutcomeId,
      outcomeVersion: record.partyOutcomeVersion,
      reason: "outcome_reissued",
    },
  });
  if ((caseRow.state === "RESOLVED_CONSENT" || caseRow.state === "RESOLVED_DECLINED") && nextState === "ISSUED") {
    await appendEvent(tx, { caseId: input.caseId, type: "CASE_REOPENED", actorId: input.actorId, payload: { reason: "outcome_reissued", partyId: input.partyId } });
    const otherLocale = input.partyId === caseRow.complainantId ? caseRow.respondent.locale : caseRow.complainant.locale;
    await tx.notification.create({ data: { userId: otherPartyId, caseId: input.caseId, kind: CASE_REOPENED_KIND, locale: otherLocale } });
  }
  const locale = input.partyId === caseRow.complainantId ? caseRow.complainant.locale : caseRow.respondent.locale;
  await tx.notification.create({
    data: { userId: input.partyId, caseId: input.caseId, kind: OUTCOME_NEEDS_ANSWER_KIND, locale },
  });
}

function appendOutcomeEvent(
  tx: Prisma.TransactionClient,
  input: PartyOutcomeWriteInput,
  type: "PARTY_OUTCOME_EDITED" | "PARTY_OUTCOME_ISSUED",
  outcomeId: string,
  version: number,
) {
  return appendEvent(tx, {
    caseId: input.caseId,
    type,
    actorId: input.actorId,
    payload: { partyId: input.partyId, outcomeId, version },
  });
}

export function savePartyOutcomeDraft(input: PartyOutcomeWriteInput) {
  return writePartyOutcome(input, "save");
}

export function issuePartyOutcome(input: PartyOutcomeWriteInput) {
  return writePartyOutcome(input, "issue");
}
