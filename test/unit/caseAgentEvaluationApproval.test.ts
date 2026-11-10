import { describe, expect, it } from "vitest";
import { resolveCaseAgentModel } from "../../src/domain/caseAgent/agent";
import { CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256, CASE_AGENT_EVALUATION_PROTOCOL_VERSION, CASE_AGENT_SELECTED_EVALUATION_PROVIDER_IDENTITY, caseAgentAllowedRemediesSha256, caseAgentEvaluationApprovalBlocker, caseAgentEvaluationApprovalIdentity, caseAgentLiveEvaluationPreflightBlockers, caseAgentProgramPolicySha256 } from "../../src/domain/caseAgent/evaluationApproval";
import { AGENT_PROMPT_VERSION } from "../../src/domain/caseAgent/output";
import { resolveCaseDataModel } from "../../src/domain/pipeline/provider";

const providerIdentity = "workers-ai:acct-synthetic:@cf/google/gemma-4-26b-a4b-it";
const allowedRemedies = "refund_full,refund_partial,store_credit,replacement,repair";
const env: Record<string, string | undefined> = {
  AEQUITAS_CASE_AGENT_ENABLED: "true",
  AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS: "500000",
  AEQUITAS_CASE_AGENT_ALLOWED_REMEDIES: allowedRemedies,
  AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY: "10",
  AEQUITAS_CASE_AGENT_INTAKE_DAYS: "7",
  AEQUITAS_CASE_AGENT_RESPONSE_DAYS: "5",
  AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW: "false",
  AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION: "false",
  AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN: "Synthetic test notice: case content would be sent to the configured model provider.",
  AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR: "Avis de test synthétique : le contenu du dossier serait transmis au fournisseur de modèle configuré.",
  AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
  CLOUDFLARE_ACCOUNT_ID: "acct-synthetic",
  CLOUDFLARE_API_TOKEN: "synthetic-token",
  AEQUITAS_WORKERS_AI_MODEL: "@cf/google/gemma-4-26b-a4b-it",
  AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: providerIdentity,
};

describe("case-agent evaluation approval", () => {
  it("binds the approval to provider, complete program policy, prompt, and evaluation protocol versions", () => {
    expect(caseAgentEvaluationApprovalIdentity(env)).toBe(`${providerIdentity}:remedies:${caseAgentAllowedRemediesSha256(env)}:program:${caseAgentProgramPolicySha256(env)}:prompt:${AGENT_PROMPT_VERSION}:evaluation:${CASE_AGENT_EVALUATION_PROTOCOL_VERSION}:fixtures:${CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256}`);
    expect(CASE_AGENT_SELECTED_EVALUATION_PROVIDER_IDENTITY).toBe("workers-ai:1713c51cc6fbcf8d7143526b93495b76:@cf/google/gemma-4-26b-a4b-it");
  });

  it("invalidates approval when any workflow-affecting program setting changes", () => {
    const identity = caseAgentEvaluationApprovalIdentity(env);
    const changedPolicies = [
      { AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS: "500001" },
      { AEQUITAS_CASE_AGENT_ALLOWED_REMEDIES: "replacement" },
      { AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY: "11" },
      { AEQUITAS_CASE_AGENT_INTAKE_DAYS: "2" },
      { AEQUITAS_CASE_AGENT_RESPONSE_DAYS: "2" },
      { AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW: "true" },
      { AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION: "true" },
      { AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN: "Updated English notice." },
      { AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR: "Avis français mis à jour." },
    ];
    for (const change of changedPolicies) {
      expect(caseAgentEvaluationApprovalIdentity({ ...env, ...change })).not.toBe(identity);
    }
  });

  it("keeps live case processing blocked without an exact human-review attestation", () => {
    expect(caseAgentEvaluationApprovalBlocker(env)).toContain("AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR");
    expect(resolveCaseAgentModel(env)).toMatchObject({ ok: false });

    const stale = { ...env, AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR: `${providerIdentity}:remedies:${caseAgentAllowedRemediesSha256(env)}:prompt:${AGENT_PROMPT_VERSION}:evaluation:old-version` };
    expect(caseAgentEvaluationApprovalBlocker(stale)).toContain(`prompt:${AGENT_PROMPT_VERSION}`);
    expect(resolveCaseAgentModel(stale)).toMatchObject({ ok: false });
  });

  it("rejects the previous evaluation protocol's approval identity", () => {
    const previous = {
      ...env,
      AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR: `${providerIdentity}:remedies:${caseAgentAllowedRemediesSha256(env)}:program:${caseAgentProgramPolicySha256(env)}:prompt:${AGENT_PROMPT_VERSION}:evaluation:case-agent-evaluation-2026-11-09.1`,
    };
    expect(caseAgentEvaluationApprovalBlocker(previous)).toContain("AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR");
    expect(resolveCaseAgentModel(previous)).toMatchObject({ ok: false });
  });

  it("allows the evaluator to obtain the terms-approved provider before quality approval", () => {
    expect(resolveCaseDataModel({ ...env, AEQUITAS_PIPELINE_ENABLED: "true" }).ok).toBe(true);
    const approved = {
      ...env,
      AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR: caseAgentEvaluationApprovalIdentity(env)!,
    };
    expect(caseAgentEvaluationApprovalBlocker(approved)).toBeNull();
    expect(resolveCaseAgentModel(approved).ok).toBe(true);
  });

  it("blocks a live evaluation until the human pre-model baseline is approved for the exact identity", () => {
    const identity = caseAgentEvaluationApprovalIdentity(env)!;
    const missing = caseAgentLiveEvaluationPreflightBlockers(env);
    expect(missing).toHaveLength(2);
    expect(missing.join(" ")).toContain("single-run spend authorization");
    expect(missing.join(" ")).toContain("Before any model output");
    expect(missing.join(" ")).toContain("AEQUITAS_CASE_AGENT_BASELINE_REVIEWED_FOR");
    expect(missing.join(" ")).toContain(identity);

    const approved = {
      ...env,
      AEQUITAS_CASE_AGENT_BASELINE_REVIEWED_FOR: identity,
    };
    expect(caseAgentLiveEvaluationPreflightBlockers(approved, true)).toEqual([]);
    expect(caseAgentLiveEvaluationPreflightBlockers(approved, false).join(" ")).toContain("single-run spend authorization");
    expect(caseAgentLiveEvaluationPreflightBlockers({ ...approved, AEQUITAS_CASE_AGENT_EVAL_APPROVED: "true" }).join(" "))
      .toContain("single-run spend authorization");

    const stale = { ...approved, AEQUITAS_CASE_AGENT_BASELINE_REVIEWED_FOR: `${identity}:stale` };
    expect(caseAgentLiveEvaluationPreflightBlockers(stale, true).join(" ")).toContain(identity);
  });
});
