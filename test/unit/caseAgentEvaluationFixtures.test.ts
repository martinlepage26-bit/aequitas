import { describe, expect, it } from "vitest";
import { CASE_AGENT_EVALUATION_FIXTURES, caseAgentEvaluationFixtureSetSha256 } from "../../scripts/caseAgentEvaluationFixtures";
import { CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256 } from "../../src/domain/caseAgent/evaluationApproval";

describe("case-agent baseline fixture identity", () => {
  it("pins all seven exact synthetic fixture records to the review digest", () => {
    expect(CASE_AGENT_EVALUATION_FIXTURES).toHaveLength(7);
    expect(caseAgentEvaluationFixtureSetSha256()).toBe(CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256);
  });
});
