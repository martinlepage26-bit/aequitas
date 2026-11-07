import { caseDataProviderApprovalIdentity } from "../pipeline/provider";
import { AGENT_PROMPT_VERSION } from "./output";

const APPROVAL_ENV = "AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR";
export const CASE_AGENT_EVALUATION_PROTOCOL_VERSION = "case-agent-evaluation-2026-11-07.1";

/** Bind a human-reviewed synthetic evaluation to the exact model, prompt, and evaluation protocol. */
export function caseAgentEvaluationApprovalIdentity(env: Record<string, string | undefined>): string | null {
  const providerIdentity = caseDataProviderApprovalIdentity(env);
  return providerIdentity
    ? `${providerIdentity}:prompt:${AGENT_PROMPT_VERSION}:evaluation:${CASE_AGENT_EVALUATION_PROTOCOL_VERSION}`
    : null;
}

/** A stale or missing review keeps the case agent unavailable for real cases. */
export function caseAgentEvaluationApprovalBlocker(env: Record<string, string | undefined>): string | null {
  const identity = caseAgentEvaluationApprovalIdentity(env);
  if (!identity) return null;
  if (env[APPROVAL_ENV]?.trim() === identity) return null;
  return `Run and review a successful live synthetic evaluation for the exact provider, account/project, model, prompt, and evaluation protocol; then set ${APPROVAL_ENV} to ${identity}.`;
}
