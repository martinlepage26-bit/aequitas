import { describe, expect, it } from "vitest";
import { caseAgentProgram } from "../../src/domain/caseAgent/config";
import { buildCaseAgentEvaluationEnvironment, CASE_AGENT_EVALUATION_WORKERS_AI_ACCOUNT_ID } from "../../src/domain/caseAgent/evaluationEnvironment";
import { caseAgentProgramPolicySha256 } from "../../src/domain/caseAgent/evaluationApproval";
import { REMEDIES } from "../../src/domain/caseAgent/proposal";
import { WORKERS_AI_MODEL } from "../../src/domain/pipeline/provider";

describe("synthetic case-agent evaluation policy", () => {
  it("builds a complete test-only profile without configuring a buyer's remedy policy", () => {
    const env = buildCaseAgentEvaluationEnvironment({}, false);
    expect(env).toMatchObject({
      AEQUITAS_CASE_AGENT_ENABLED: "true",
      CLOUDFLARE_ACCOUNT_ID: CASE_AGENT_EVALUATION_WORKERS_AI_ACCOUNT_ID,
      AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
      AEQUITAS_WORKERS_AI_MODEL: WORKERS_AI_MODEL,
      AEQUITAS_CASE_AGENT_ALLOWED_REMEDIES: REMEDIES.join(","),
      AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION: "true",
      RESEND_API_KEY: "",
    });
    expect(caseAgentProgram(env).ok).toBe(true);
    expect(caseAgentProgramPolicySha256(env)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses explicit policy overrides in the policy digest while fixing the selected evaluation account and model", () => {
    const env = buildCaseAgentEvaluationEnvironment({
      CLOUDFLARE_ACCOUNT_ID: "some-other-account",
      AEQUITAS_WORKERS_AI_MODEL: "some-other-model",
      AEQUITAS_CASE_AGENT_ALLOWED_REMEDIES: "replacement",
      AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS: "120000",
      AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION: "false",
    }, false);
    expect(env).toMatchObject({
      CLOUDFLARE_ACCOUNT_ID: CASE_AGENT_EVALUATION_WORKERS_AI_ACCOUNT_ID,
      AEQUITAS_WORKERS_AI_MODEL: WORKERS_AI_MODEL,
      AEQUITAS_CASE_AGENT_ALLOWED_REMEDIES: "replacement",
      AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS: "120000",
      AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION: "false",
    });
    expect(caseAgentProgram(env).ok).toBe(true);
  });

  it("uses an isolated synthetic provider identity for the stub run", () => {
    const env = buildCaseAgentEvaluationEnvironment({}, true);
    expect(env).toMatchObject({
      AEQUITAS_PIPELINE_PROVIDER: "gemini",
      GEMINI_PROJECT_ID: "synthetic-evaluation-project",
      GEMINI_MODEL: "gemini-3.8-flash",
    });
    expect(caseAgentProgram(env).ok).toBe(true);
  });
});
