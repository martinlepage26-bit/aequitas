import { createHash } from "node:crypto";
import type { GlobalRole } from "../generated/prisma";
import { extractStoredEvidence } from "../lib/evidenceText";
import { prisma } from "../lib/prisma";
import { evidenceObjectKey } from "../lib/storage";
import { caseReadAccess } from "./caseAccess";

export type PartyOutcomeCitationRead =
  | { ok: true; excerpt: string }
  | { ok: false; status: 404 | 409 };

/** Reveal an excerpt only to its submitting party or the assigned manager. */
export async function readPartyOutcomeCitation(input: {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
  outcomeId: string;
  citationId: string;
}): Promise<PartyOutcomeCitationRead> {
  const [caseRow, actor] = await Promise.all([
    prisma.case.findUnique({ where: { id: input.caseId } }),
    prisma.user.findUnique({ where: { id: input.actorId }, select: { isApprover: true } }),
  ]);
  if (!caseRow) return { ok: false, status: 404 };
  const access = caseReadAccess(caseRow, {
    userId: input.actorId,
    globalRole: input.actorRole,
    isApprover: actor?.isApprover ?? false,
  });
  if (access !== "party" && access !== "assigned-manager") return { ok: false, status: 404 };

  const outcome = await prisma.partyOutcome.findFirst({
    where: {
      id: input.outcomeId,
      caseId: input.caseId,
      status: "ISSUED",
      ...(access === "party" ? { partyId: input.actorId } : {}),
    },
    include: {
      citations: {
        where: { id: input.citationId },
        include: { evidenceItem: true },
        take: 1,
      },
    },
  });
  const citation = outcome?.citations[0];
  const evidence = citation?.evidenceItem;
  if (!outcome || !citation || !evidence) return { ok: false, status: 404 };
  if (evidence.caseId !== caseRow.id || evidence.submittedById !== outcome.partyId
    || evidence.scanStatus !== "CLEAN" || evidence.simulated !== caseRow.simulated
    || evidence.storageKey !== evidenceObjectKey(caseRow.simulated, caseRow.id, evidence.id)) {
    return { ok: false, status: 404 };
  }
  if (await prisma.evidenceItem.count({ where: { caseId: caseRow.id, supersedesId: evidence.id } }) > 0) {
    return { ok: false, status: 404 };
  }

  let extracted;
  try { extracted = await extractStoredEvidence(evidence); }
  catch { return { ok: false, status: 409 }; }
  const extractedHash = createHash("sha256").update(extracted.text).digest("hex");
  if (extracted.status !== "extracted" || extracted.method !== citation.extractionMethod
    || evidence.sha256 !== citation.sourceSha256 || extractedHash !== citation.extractedTextSha256) {
    return { ok: false, status: 409 };
  }

  const codePoints = Array.from(extracted.text);
  if (!Number.isSafeInteger(citation.startChar) || !Number.isSafeInteger(citation.endChar)
    || citation.startChar < 0 || citation.endChar <= citation.startChar || citation.endChar > codePoints.length) {
    return { ok: false, status: 409 };
  }
  return { ok: true, excerpt: codePoints.slice(citation.startChar, citation.endChar).join("") };
}
