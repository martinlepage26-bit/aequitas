import { describe, expect, it } from "vitest";
import {
  caseAgentPolicyFromEvents,
  createCaseAgentPolicySnapshot,
  parseCaseAgentPolicySnapshot,
} from "../../src/domain/caseAgent/policy";

const terms = {
  maxAmountCents: 500_000,
  intakeDays: 7,
  responseDays: 5,
  respondentMayWithdraw: true,
  consentOnlyResolution: false,
};

describe("case agent enrollment policy", () => {
  it("serializes and validates the fixed party terms", () => {
    const snapshot = createCaseAgentPolicySnapshot(terms);
    expect(parseCaseAgentPolicySnapshot(snapshot)).toEqual({ version: 1, ...terms });
  });

  it("reads the first enrollment snapshot and ignores later events", () => {
    const first = { type: "AGENT_ENROLLED", payload: { origin: "case_manager", consentOnlyResolution: false, policySnapshot: createCaseAgentPolicySnapshot(terms) } };
    const later = { type: "AGENT_ENROLLED", payload: { origin: "program_rules", consentOnlyResolution: false, policySnapshot: { ...createCaseAgentPolicySnapshot(terms), responseDays: 90 } } };
    expect(caseAgentPolicyFromEvents([first, later])).toEqual({ version: 1, ...terms });
  });

  it.each([
    ["missing", undefined],
    ["unknown version", { ...createCaseAgentPolicySnapshot(terms), version: 2 }],
    ["invalid amount", { ...createCaseAgentPolicySnapshot(terms), maxAmountCents: 0 }],
    ["invalid deadline", { ...createCaseAgentPolicySnapshot(terms), responseDays: 1.5 }],
    ["invalid withdrawal rule", { ...createCaseAgentPolicySnapshot(terms), respondentMayWithdraw: "yes" }],
  ])("fails closed for %s snapshot data", (_label, snapshot) => {
    expect(parseCaseAgentPolicySnapshot(snapshot)).toBeNull();
    expect(caseAgentPolicyFromEvents([{
      type: "AGENT_ENROLLED",
      payload: {
        origin: "case_manager",
        consentOnlyResolution: false,
        policySnapshot: snapshot,
      },
    }])).toBeNull();
  });

  it("does not infer policy from a legacy enrollment event", () => {
    expect(caseAgentPolicyFromEvents([{ type: "AGENT_ENROLLED", payload: { origin: "case_manager", consentOnlyResolution: true } }])).toBeNull();
    expect(caseAgentPolicyFromEvents([{ type: "AGENT_ESCALATED", payload: { policySnapshot: createCaseAgentPolicySnapshot(terms) } }])).toBeNull();
  });
});
