import type { CaseState, GlobalRole } from "../generated/prisma";

/**
 * Who may READ a case (workspace page, GET /api/cases/[id], its timeline).
 * Mutations keep their own guards in mutate.ts; this is the read side (H2).
 *
 *  - "party":            the complainant or the respondent
 *  - "assigned-manager": the case manager who claimed the case; the only
 *                        viewer with the full timeline (private notes, drafts)
 *  - "claimable":        any case manager, but only while the case is OPEN
 *                        and unclaimed, so they can reach the claim action
 *                        (open_intake self-claim, DECISIONS.md M2)
 *  - "admin":            unchanged party-level view; emitting
 *                        ACCESS_STAFF_GRANTED is recorded by authorized
 *                        read handlers (staffAccess.ts)
 * Anyone else gets null, which callers turn into a 404 (Section 16).
 */
export type CaseReadAccess = "party" | "assigned-manager" | "claimable" | "admin";

export function caseReadAccess(
  caseRow: { complainantId: string; respondentId: string; caseManagerId: string | null; state: CaseState },
  viewer: { userId: string; globalRole: GlobalRole }
): CaseReadAccess | null {
  if (viewer.userId === caseRow.complainantId || viewer.userId === caseRow.respondentId) return "party";
  if (viewer.globalRole === "CASE_MANAGER") {
    if (caseRow.caseManagerId === viewer.userId) return "assigned-manager";
    if (caseRow.caseManagerId === null && caseRow.state === "OPEN") return "claimable";
    return null;
  }
  if (viewer.globalRole === "ADMIN") return "admin";
  return null;
}
