import { createHash } from "node:crypto";
import { caseDataProviderApprovalIdentity } from "../pipeline/provider";
import { caseAgentProgram } from "./config";
import { parseAllowedRemedies } from "./proposal";
import { AGENT_PROMPT_VERSION } from "./output";

const APPROVAL_ENV = "AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR";
const BASELINE_REVIEW_ENV = "AEQUITAS_CASE_AGENT_BASELINE_REVIEWED_FOR";
const LIVE_EVALUATION_APPROVAL_ENV = "AEQUITAS_CASE_AGENT_EVAL_APPROVED";
export const CASE_AGENT_EVALUATION_PROTOCOL_VERSION = "case-agent-evaluation-2026-11-09.4";
export const CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256 = "555baa9b27487cd9028cdadb9fa975aaf53ec14c187f92110b0951589dc5ab5c";

export type CaseAgentProgramPolicyIdentityRecord = {
  maxAmountCents: number;
  allowedRemedies: readonly string[];
  maxModelCallsPerUtcDay: number;
  intakeDays: number;
  responseDays: number;
  respondentMayWithdraw: boolean;
  consentOnlyResolution: boolean;
  providerIdentity: string;
  processingNoticeHash: string;
};

export function caseAgentAllowedRemediesSha256(env: Record<string, string | undefined>): string | null {
  const remedies = parseAllowedRemedies(env.AEQUITAS_CASE_AGENT_ALLOWED_REMEDIES);
  return remedies ? createHash("sha256").update(JSON.stringify(remedies)).digest("hex") : null;
}

/** Hash a normalized, reportable set of workflow settings that changes agent behavior. */
export function caseAgentProgramPolicySha256FromRecord(policy: CaseAgentProgramPolicyIdentityRecord): string {
  const canonicalPolicy = {
    maxAmountCents: policy.maxAmountCents,
    allowedRemedies: [...policy.allowedRemedies],
    maxModelCallsPerUtcDay: policy.maxModelCallsPerUtcDay,
    intakeDays: policy.intakeDays,
    responseDays: policy.responseDays,
    respondentMayWithdraw: policy.respondentMayWithdraw,
    consentOnlyResolution: policy.consentOnlyResolution,
    providerIdentity: policy.providerIdentity,
    processingNoticeHash: policy.processingNoticeHash,
  };
  return createHash("sha256").update(JSON.stringify(canonicalPolicy)).digest("hex");
}

/** Return the exact workflow settings represented by the policy digest. */
export function caseAgentProgramPolicyIdentityRecord(env: Record<string, string | undefined>): CaseAgentProgramPolicyIdentityRecord | null {
  const result = caseAgentProgram(env);
  if (!result.ok) return null;
  const { program } = result;
  return {
    maxAmountCents: program.maxAmountCents,
    allowedRemedies: [...program.allowedRemedies],
    maxModelCallsPerUtcDay: program.maxModelCallsPerUtcDay,
    intakeDays: program.intakeDays,
    responseDays: program.responseDays,
    respondentMayWithdraw: program.respondentMayWithdraw,
    consentOnlyResolution: program.consentOnlyResolution,
    providerIdentity: program.processingDisclosure.providerIdentity,
    processingNoticeHash: program.processingDisclosure.noticeHash,
  };
}

/** Hash every workflow setting that changes what the agent may do for a program. */
export function caseAgentProgramPolicySha256(env: Record<string, string | undefined>): string | null {
  const policy = caseAgentProgramPolicyIdentityRecord(env);
  return policy ? caseAgentProgramPolicySha256FromRecord(policy) : null;
}

/** Bind a human-reviewed evaluation to the exact model, workflow policy, prompt, protocol, and fixture set. */
export function caseAgentEvaluationApprovalIdentity(env: Record<string, string | undefined>): string | null {
  const providerIdentity = caseDataProviderApprovalIdentity(env);
  const remediesDigest = caseAgentAllowedRemediesSha256(env);
  const policyDigest = caseAgentProgramPolicySha256(env);
  return providerIdentity && remediesDigest && policyDigest
    ? `${providerIdentity}:remedies:${remediesDigest}:program:${policyDigest}:prompt:${AGENT_PROMPT_VERSION}:evaluation:${CASE_AGENT_EVALUATION_PROTOCOL_VERSION}:fixtures:${CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256}`
    : null;
}

/** Refuse a live call until spend/terms and the pre-model references are attested for this exact fixture digest. */
export function caseAgentLiveEvaluationPreflightBlockers(env: Record<string, string | undefined>): string[] {
  const blockers: string[] = [];
  if (env[LIVE_EVALUATION_APPROVAL_ENV] !== "true") {
    blockers.push(`Set ${LIVE_EVALUATION_APPROVAL_ENV}=true only after reviewing the provider's current data terms and the authorized spend cap.`);
  }

  const identity = caseAgentEvaluationApprovalIdentity(env);
  if (!identity) {
    blockers.push("The live evaluation identity is unavailable; configure the selected provider account/model and a complete synthetic evaluation policy first.");
  } else if (env[BASELINE_REVIEW_ENV]?.trim() !== identity) {
    blockers.push(
      `Before any model output, have the program reviewer confirm all seven synthetic references, counsel review the two legal-handoff fixtures, and a Québec French reviewer assess the French fixture; then set ${BASELINE_REVIEW_ENV} to this exact identity: ${identity}`,
    );
  }
  return blockers;
}

/** A stale or missing review keeps the case agent unavailable for real cases. */
export function caseAgentEvaluationApprovalBlocker(env: Record<string, string | undefined>): string | null {
  const identity = caseAgentEvaluationApprovalIdentity(env);
  if (!identity) return null;
  if (env[APPROVAL_ENV]?.trim() === identity) return null;
  return `Run and review a successful live synthetic evaluation for the exact provider, account/project, complete program policy, prompt, protocol, and fixture-set digest; then set ${APPROVAL_ENV} to ${identity}.`;
}
