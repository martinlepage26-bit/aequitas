import { describe, expect, it } from "vitest";
import { resolveCaseAgentModel } from "../../src/domain/caseAgent/agent";
import { caseAgentEvaluationApprovalBlocker, caseAgentEvaluationApprovalIdentity } from "../../src/domain/caseAgent/evaluationApproval";
import { AGENT_PROMPT_VERSION } from "../../src/domain/caseAgent/output";
import { resolveCaseDataModel } from "../../src/domain/pipeline/provider";

const providerIdentity = "workers-ai:acct-synthetic:@cf/google/gemma-4-26b-a4b-it";
const env: Record<string, string | undefined> = {
  AEQUITAS_CASE_AGENT_ENABLED: "true",
  AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS: "500000",
  AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY: "10",
  AEQUITAS_CASE_AGENT_INTAKE_DAYS: "7",
  AEQUITAS_CASE_AGENT_RESPONSE_DAYS: "5",
  AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW: "false",
  AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION: "false",
  AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
  CLOUDFLARE_ACCOUNT_ID: "acct-synthetic",
  CLOUDFLARE_API_TOKEN: "synthetic-token",
  AEQUITAS_WORKERS_AI_MODEL: "@cf/google/gemma-4-26b-a4b-it",
  AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: providerIdentity,
};

describe("case-agent evaluation approval", () => {
  it("binds the approval to provider, account, model, and prompt version", () => {
    expect(caseAgentEvaluationApprovalIdentity(env)).toBe(`${providerIdentity}:prompt:${AGENT_PROMPT_VERSION}`);
  });

  it("keeps live case processing blocked without an exact human-review attestation", () => {
    expect(caseAgentEvaluationApprovalBlocker(env)).toContain("AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR");
    expect(resolveCaseAgentModel(env)).toMatchObject({ ok: false });

    const stale = { ...env, AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR: `${providerIdentity}:prompt:old-version` };
    expect(caseAgentEvaluationApprovalBlocker(stale)).toContain(`prompt:${AGENT_PROMPT_VERSION}`);
    expect(resolveCaseAgentModel(stale)).toMatchObject({ ok: false });
  });

  it("allows the evaluator to obtain the terms-approved provider before quality approval", () => {
    expect(resolveCaseDataModel({ ...env, AEQUITAS_PIPELINE_ENABLED: "true" }).ok).toBe(true);
    const approved = {
      ...env,
      AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR: `${providerIdentity}:prompt:${AGENT_PROMPT_VERSION}`,
    };
    expect(caseAgentEvaluationApprovalBlocker(approved)).toBeNull();
    expect(resolveCaseAgentModel(approved).ok).toBe(true);
  });
});
