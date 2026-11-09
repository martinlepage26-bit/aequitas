import type { CaseAgentProgram } from "./config";
import { REMEDIES, type Remedy } from "./proposal";

/** Bump when the meaning or required fields of an enrollment policy change. */
export const CASE_AGENT_POLICY_VERSION = 2;

export type CaseAgentPolicySnapshot = {
  version: typeof CASE_AGENT_POLICY_VERSION;
  maxAmountCents: number;
  allowedRemedies: Remedy[];
  intakeDays: number;
  responseDays: number;
  respondentMayWithdraw: boolean;
  consentOnlyResolution: boolean;
};

type PolicyTerms = Pick<CaseAgentProgram,
  "maxAmountCents" | "allowedRemedies" | "intakeDays" | "responseDays" | "respondentMayWithdraw" | "consentOnlyResolution"
>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function canonicalAllowedRemedies(value: unknown): Remedy[] | null {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || !(REMEDIES as readonly string[]).includes(item))
    || new Set(value).size !== value.length) return null;
  const selected = new Set(value as Remedy[]);
  const canonical = REMEDIES.filter((remedy) => selected.has(remedy));
  return canonical.length === value.length && canonical.every((remedy, index) => remedy === value[index])
    ? [...canonical]
    : null;
}

export function createCaseAgentPolicySnapshot(program: PolicyTerms): CaseAgentPolicySnapshot {
  return {
    version: CASE_AGENT_POLICY_VERSION,
    maxAmountCents: program.maxAmountCents,
    allowedRemedies: [...program.allowedRemedies],
    intakeDays: program.intakeDays,
    responseDays: program.responseDays,
    respondentMayWithdraw: program.respondentMayWithdraw,
    consentOnlyResolution: program.consentOnlyResolution,
  };
}

/** Missing, malformed, or unknown policy versions fail closed for active cases. */
export function parseCaseAgentPolicySnapshot(value: unknown): CaseAgentPolicySnapshot | null {
  const candidate = record(value);
  const allowedRemedies = canonicalAllowedRemedies(candidate?.allowedRemedies);
  if (!candidate
    || candidate.version !== CASE_AGENT_POLICY_VERSION
    || !positiveSafeInteger(candidate.maxAmountCents)
    || !positiveSafeInteger(candidate.intakeDays)
    || !positiveSafeInteger(candidate.responseDays)
    || !allowedRemedies
    || typeof candidate.respondentMayWithdraw !== "boolean"
    || typeof candidate.consentOnlyResolution !== "boolean") return null;

  return {
    version: CASE_AGENT_POLICY_VERSION,
    maxAmountCents: candidate.maxAmountCents,
    allowedRemedies,
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
