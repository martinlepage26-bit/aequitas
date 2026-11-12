import { createHash } from "node:crypto";
import { caseDataProviderApprovalIdentity } from "../pipeline/provider";
import { caseAgentProgram } from "./config";
import { parseAllowedRemedies } from "./proposal";
import { AGENT_PROMPT_VERSION } from "./output";

const APPROVAL_ENV = "AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR";
const BASELINE_REVIEW_ENV = "AEQUITAS_CASE_AGENT_BASELINE_REVIEWED_FOR";
export const CASE_AGENT_EVALUATION_PROTOCOL_VERSION = "case-agent-evaluation-2026-11-10.1";
export const CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256 = "555baa9b27487cd9028cdadb9fa975aaf53ec14c187f92110b0951589dc5ab5c";
export const CASE_AGENT_SELECTED_EVALUATION_PROVIDER_IDENTITY = "workers-ai:1713c51cc6fbcf8d7143526b93495b76:@cf/google/gemma-4-26b-a4b-it";
export const CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256_ENV = "AEQUITAS_CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256";

function evaluationFixtureDigest(env: Record<string, string | undefined>): string | null {
  const configured = env[CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256_ENV]?.trim();
  if (!configured) return null;
  return /^[a-f0-9]{64}$/i.test(configured) ? configured.toLowerCase() : null;
}

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
  const fixtureDigest = evaluationFixtureDigest(env);
  return providerIdentity && remediesDigest && policyDigest && fixtureDigest
    ? [
        providerIdentity,
        "remedies",
        remediesDigest,
        "program",
        policyDigest,
        "prompt",
        AGENT_PROMPT_VERSION,
        "evaluation",
        CASE_AGENT_EVALUATION_PROTOCOL_VERSION,
        "fixtures",
        fixtureDigest,
      ].join(":")
    : null;
}

/** Refuse a live call until spend/terms and the pre-model references are attested for this exact fixture digest. */
export function caseAgentLiveEvaluationPreflightBlockers(
  env: Record<string, string | undefined>,
  singleRunSpendApprovalProvided = false,
): string[] {
  const blockers: string[] = [];
  if (!singleRunSpendApprovalProvided) blockers.push("Pass the explicit single-run spend authorization on this command after checking the provider terms and spend bound.");

  const identity = caseAgentEvaluationApprovalIdentity(env);
  if (!identity) {
    blockers.push("The live evaluation identity is unavailable; configure the selected provider account/model, a complete synthetic policy, and an explicit private fixture-set digest first.");
  } else if (evaluationFixtureDigest(env) === CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256) {
    blockers.push("Live evaluation requires an unpublished private fixture set; the repository's public CI fixture digest cannot be used.");
  } else if (env[BASELINE_REVIEW_ENV]?.trim() !== identity) {
    blockers.push(
      `Before any model output, freeze the private structured review for all seven synthetic references: program review for every case, counsel review for each case that raises a legal question, and Québec French review for each case with an fr-CA party. Then set ${BASELINE_REVIEW_ENV} to this exact identity: ${identity}`,
    );
  }
  return blockers;
}

/** A stale or missing review keeps the case agent unavailable for real cases. */
export function caseAgentEvaluationApprovalBlocker(env: Record<string, string | undefined>): string | null {
  const configuredFixtureDigest = env[CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256_ENV]?.trim();
  if (!configuredFixtureDigest) {
    return CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256_ENV + " must be set to the digest of the privately reviewed synthetic evaluation fixtures.";
  }
  if (!/^[a-f0-9]{64}$/i.test(configuredFixtureDigest)) {
    return CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256_ENV + " must be a SHA-256 hex digest.";
  }
  if (configuredFixtureDigest.toLowerCase() === CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256) {
    return "The public CI fixture digest cannot approve live case processing; configure the digest from the privately reviewed evaluation set.";
  }
  const identity = caseAgentEvaluationApprovalIdentity(env);
  if (!identity) return "The case-agent evaluation identity is unavailable; configure the selected provider and complete program policy.";
  if (env[APPROVAL_ENV]?.trim() === identity) return null;
  return `Run and review a successful live synthetic evaluation for the exact provider, account/project, complete program policy, prompt, protocol, and fixture-set digest; then set ${APPROVAL_ENV} to ${identity}.`;
}
