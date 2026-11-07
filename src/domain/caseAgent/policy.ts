import type { CaseAgentProgram } from "./config";

/** Bump when the meaning or required fields of an enrollment policy change. */
export const CASE_AGENT_POLICY_VERSION = 1;

export type CaseAgentPolicySnapshot = {
  version: typeof CASE_AGENT_POLICY_VERSION;
  maxAmountCents: number;
  intakeDays: number;
  responseDays: number;
  respondentMayWithdraw: boolean;
  consentOnlyResolution: boolean;
};

type PolicyTerms = Pick<CaseAgentProgram,
  "maxAmountCents" | "intakeDays" | "responseDays" | "respondentMayWithdraw" | "consentOnlyResolution"
>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function createCaseAgentPolicySnapshot(program: PolicyTerms): CaseAgentPolicySnapshot {
  return {
    version: CASE_AGENT_POLICY_VERSION,
    maxAmountCents: program.maxAmountCents,
    intakeDays: program.intakeDays,
    responseDays: program.responseDays,
    respondentMayWithdraw: program.respondentMayWithdraw,
    consentOnlyResolution: program.consentOnlyResolution,
  };
}

/** Missing, malformed, or unknown policy versions fail closed for active cases. */
export function parseCaseAgentPolicySnapshot(value: unknown): CaseAgentPolicySnapshot | null {
  const candidate = record(value);
  if (!candidate
    || candidate.version !== CASE_AGENT_POLICY_VERSION
    || !positiveSafeInteger(candidate.maxAmountCents)
    || !positiveSafeInteger(candidate.intakeDays)
    || !positiveSafeInteger(candidate.responseDays)
    || typeof candidate.respondentMayWithdraw !== "boolean"
    || typeof candidate.consentOnlyResolution !== "boolean") return null;

  return {
    version: CASE_AGENT_POLICY_VERSION,
    maxAmountCents: candidate.maxAmountCents,
    intakeDays: candidate.intakeDays,
    responseDays: candidate.responseDays,
    respondentMayWithdraw: candidate.respondentMayWithdraw,
    consentOnlyResolution: candidate.consentOnlyResolution,
  };
}

/** The first enrollment event is the case's immutable policy source. */
export function caseAgentPolicyFromEvents(events: readonly { type: string; payload?: unknown }[]): CaseAgentPolicySnapshot | null {
  const enrollment = events.find((event) => event.type === "AGENT_ENROLLED");
  const payload = record(enrollment?.payload);
  const snapshot = parseCaseAgentPolicySnapshot(payload?.policySnapshot);
  if (!snapshot || !payload
    || (payload?.origin !== "case_manager" && payload?.origin !== "program_rules")
    || payload.consentOnlyResolution !== snapshot.consentOnlyResolution) return null;
  return snapshot;
}
