import { createHash } from "node:crypto";
import type { CaseDetailsRevision, Event } from "../generated/prisma";
import { canonicalJson } from "./events";

/** This exact JSON shape is exported so its digest is independently reproducible. */
export function caseDetailsRevisionRecord(revision: CaseDetailsRevision) {
  return {
    schemaVersion: 1,
    id: revision.id,
    caseId: revision.caseId,
    actorId: revision.actorId,
    createdAt: revision.createdAt.toISOString(),
    before: revision.before,
    after: revision.after,
    // The nonce stays with the source record, preventing guesses of private
    // snapshot content using only the immutable event's digest.
    nonce: revision.nonce,
  };
}

export function digestCaseDetailsRevision(revision: CaseDetailsRevision): string {
  return createHash("sha256").update(canonicalJson(caseDetailsRevisionRecord(revision)), "utf8").digest("hex");
}

/** Only event-bound, same-case records may enter an export. Legacy events keep their original payload. */
export function verifyCaseDetailsRevisions(
  events: Pick<Event, "type" | "caseId" | "actorId" | "seq" | "payload">[],
  revisions: CaseDetailsRevision[],
) {
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const verified: CaseDetailsRevision[] = [];
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const event of events) {
    if (event.type !== "CASE_DETAILS_UPDATED") continue;
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown> : {};
    if (!("revisionId" in payload) && !("revisionDigest" in payload) && payload.before && payload.after) continue;
    if (typeof payload.revisionId !== "string" || typeof payload.revisionDigest !== "string" || !/^[a-f0-9]{64}$/.test(payload.revisionDigest)) {
      issues.push(`seq ${event.seq}: case details revision reference is invalid.`);
      continue;
    }
    const revision = byId.get(payload.revisionId);
    if (!revision || revision.caseId !== event.caseId || revision.actorId !== event.actorId) {
      issues.push(`seq ${event.seq}: case details revision is missing or belongs to another case or actor.`);
    } else if (digestCaseDetailsRevision(revision) !== payload.revisionDigest) {
      issues.push(`seq ${event.seq}: case details revision digest mismatch.`);
    } else if (seen.has(revision.id)) {
      issues.push(`seq ${event.seq}: case details revision is referenced more than once.`);
    } else {
      seen.add(revision.id);
      verified.push(revision);
    }
  }
  return { revisions: verified, issues };
}
