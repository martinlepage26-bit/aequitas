import type { CaseState } from "../generated/prisma";

export type SubmissionKind = "evidence" | "position" | "chronology";
export type SubmissionAvailability = "available" | "submitCaseFirst" | "waitingForManager" | "afterEvidence" | "intakeClosed" | "readOnly" | "partiesOnly";

/** Explanations remain visible; they never grant a mutation permission. */
export function submissionAvailability(kind: SubmissionKind, state: CaseState, isParty: boolean): SubmissionAvailability {
  if (state === "CLOSED" || state === "WITHDRAWN") return "readOnly";
  if (!isParty) return "partiesOnly";
  if (state === "DRAFT") return "submitCaseFirst";
  if (state === "OPEN") return "waitingForManager";
  if (state === "EVIDENCE_INTAKE") return kind === "position" ? "afterEvidence" : "available";
  if (state === "POSITIONS") return kind === "position" ? "available" : "intakeClosed";
  return "readOnly";
}
