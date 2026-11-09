import { describe, expect, it } from "vitest";
import { resolveCaseAgentModel } from "../../src/domain/caseAgent/agent";
import { CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256, CASE_AGENT_EVALUATION_PROTOCOL_VERSION, caseAgentEvaluationApprovalBlocker, caseAgentEvaluationApprovalIdentity, caseAgentLiveEvaluationPreflightBlockers } from "../../src/domain/caseAgent/evaluationApproval";
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
  AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN: "Synthetic test notice: case content would be sent to the configured model provider.",
  AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR: "Avis de test synthétique : le contenu du dossier serait transmis au fournisseur de modèle configuré.",
  AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
  CLOUDFLARE_ACCOUNT_ID: "acct-synthetic",
  CLOUDFLARE_API_TOKEN: "synthetic-token",
  AEQUITAS_WORKERS_AI_MODEL: "@cf/google/gemma-4-26b-a4b-it",
  AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR: providerIdentity,
};

describe("case-agent evaluation approval", () => {
  it("binds the approval to provider, account, model, prompt, and evaluation protocol versions", () => {
    expect(caseAgentEvaluationApprovalIdentity(env)).toBe(`${providerIdentity}:prompt:${AGENT_PROMPT_VERSION}:evaluation:${CASE_AGENT_EVALUATION_PROTOCOL_VERSION}:fixtures:${CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256}`);
  });

  it("keeps live case processing blocked without an exact human-review attestation", () => {
    expect(caseAgentEvaluationApprovalBlocker(env)).toContain("AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR");
    expect(resolveCaseAgentModel(env)).toMatchObject({ ok: false });

    const stale = { ...env, AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR: `${providerIdentity}:prompt:${AGENT_PROMPT_VERSION}:evaluation:old-version` };
    expect(caseAgentEvaluationApprovalBlocker(stale)).toContain(`prompt:${AGENT_PROMPT_VERSION}`);
    expect(resolveCaseAgentModel(stale)).toMatchObject({ ok: false });
  });

  it("rejects the previous evaluation protocol's approval identity", () => {
    const previous = {
      ...env,
      AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR: `${providerIdentity}:prompt:${AGENT_PROMPT_VERSION}:evaluation:case-agent-evaluation-2026-11-08.1`,
    };
    expect(caseAgentEvaluationApprovalBlocker(previous)).toContain("AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR");
    expect(resolveCaseAgentModel(previous)).toMatchObject({ ok: false });
  });

  it("allows the evaluator to obtain the terms-approved provider before quality approval", () => {
    expect(resolveCaseDataModel({ ...env, AEQUITAS_PIPELINE_ENABLED: "true" }).ok).toBe(true);
    const approved = {
      ...env,
      AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR: `${providerIdentity}:prompt:${AGENT_PROMPT_VERSION}:evaluation:${CASE_AGENT_EVALUATION_PROTOCOL_VERSION}:fixtures:${CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256}`,
    };
    expect(caseAgentEvaluationApprovalBlocker(approved)).toBeNull();
    expect(resolveCaseAgentModel(approved).ok).toBe(true);
  });

  it("blocks a live evaluation until the human pre-model baseline is approved for the exact identity", () => {
    const identity = caseAgentEvaluationApprovalIdentity(env)!;
    const missing = caseAgentLiveEvaluationPreflightBlockers(env);
    expect(missing).toHaveLength(2);
    expect(missing.join(" ")).toContain("AEQUITAS_CASE_AGENT_EVAL_APPROVED=true");
    expect(missing.join(" ")).toContain("Before any model output");
    expect(missing.join(" ")).toContain("AEQUITAS_CASE_AGENT_BASELINE_REVIEWED_FOR");
    expect(missing.join(" ")).toContain(identity);

    const approved = {
      ...env,
      AEQUITAS_CASE_AGENT_EVAL_APPROVED: "true",
      AEQUITAS_CASE_AGENT_BASELINE_REVIEWED_FOR: identity,
    };
    expect(caseAgentLiveEvaluationPreflightBlockers(approved)).toEqual([]);

    const stale = { ...approved, AEQUITAS_CASE_AGENT_BASELINE_REVIEWED_FOR: `${identity}:stale` };
    expect(caseAgentLiveEvaluationPreflightBlockers(stale).join(" ")).toContain(identity);
  });
});
