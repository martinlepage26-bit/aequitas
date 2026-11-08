import { caseDataProviderApprovalIdentity } from "../pipeline/provider";
import { AGENT_PROMPT_VERSION } from "./output";

const APPROVAL_ENV = "AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR";
const BASELINE_REVIEW_ENV = "AEQUITAS_CASE_AGENT_BASELINE_REVIEWED_FOR";
const LIVE_EVALUATION_APPROVAL_ENV = "AEQUITAS_CASE_AGENT_EVAL_APPROVED";
export const CASE_AGENT_EVALUATION_PROTOCOL_VERSION = "case-agent-evaluation-2026-11-08.2";

/** Bind a human-reviewed synthetic evaluation to the exact model, prompt, and evaluation protocol. */
export function caseAgentEvaluationApprovalIdentity(env: Record<string, string | undefined>): string | null {
  const providerIdentity = caseDataProviderApprovalIdentity(env);
  return providerIdentity
    ? `${providerIdentity}:prompt:${AGENT_PROMPT_VERSION}:evaluation:${CASE_AGENT_EVALUATION_PROTOCOL_VERSION}`
    : null;
}

/** Refuse a live call until spend/terms and the pre-model reference set are attested for this exact evaluation. */
export function caseAgentLiveEvaluationPreflightBlockers(env: Record<string, string | undefined>): string[] {
  const blockers: string[] = [];
  if (env[LIVE_EVALUATION_APPROVAL_ENV] !== "true") {
    blockers.push(`Set ${LIVE_EVALUATION_APPROVAL_ENV}=true only after reviewing the provider's current data terms and the authorized spend cap.`);
  }

  const identity = caseAgentEvaluationApprovalIdentity(env);
  if (!identity) {
    blockers.push("The live evaluation identity is unavailable; configure the selected provider account/project and model first.");
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
  return `Run and review a successful live synthetic evaluation for the exact provider, account/project, model, prompt, and evaluation protocol; then set ${APPROVAL_ENV} to ${identity}.`;
}
