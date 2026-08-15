import { describe, expect, it } from "vitest";
import type { CaseState, GlobalRole } from "../../src/generated/prisma";
import {
  ALL_STATES,
  NONE,
  SYSTEM,
  TRIGGERS,
  isActorRoleAllowed,
  isFromStateAllowed,
  transitionsFor,
  type Trigger,
} from "../../src/domain/stateMachine";

const ROLES: GlobalRole[] = ["COMPLAINANT", "RESPONDENT", "CASE_MANAGER", "ADMIN"];
const STATES_WITH_NONE: Array<CaseState | typeof NONE> = [NONE, ...ALL_STATES];
const ACTORS: Array<GlobalRole | typeof SYSTEM> = [...ROLES, SYSTEM];

/**
 * Ground truth transcribed directly from Section 6 of
 * aequitas-implementation-handoff.md, independently of stateMachine.ts, so
 * this test catches transcription errors rather than checking the
 * implementation against itself.
 */
const EXPECTED: Record<Trigger, { from: Array<CaseState | typeof NONE>; roles: Array<GlobalRole | typeof SYSTEM> }> = {
  create_case: { from: [NONE], roles: ["COMPLAINANT"] },
  submit_case: { from: ["DRAFT"], roles: ["COMPLAINANT"] },
  open_intake: { from: ["OPEN"], roles: ["CASE_MANAGER"] },
  submit_evidence: { from: ["EVIDENCE_INTAKE"], roles: ["COMPLAINANT", "RESPONDENT"] },
  supersede_evidence: { from: ["EVIDENCE_INTAKE"], roles: ["COMPLAINANT", "RESPONDENT"] },
  close_intake: { from: ["EVIDENCE_INTAKE"], roles: ["CASE_MANAGER"] },
  submit_position: { from: ["POSITIONS"], roles: ["COMPLAINANT", "RESPONDENT"] },
  request_draft: { from: ["POSITIONS"], roles: ["CASE_MANAGER"] },
  draft_completed: { from: ["DRAFTING"], roles: [SYSTEM] },
  issue_recommendation: { from: ["DRAFTING"], roles: ["CASE_MANAGER"] },
  give_consent: { from: ["ISSUED"], roles: ["COMPLAINANT", "RESPONDENT"] },
  decline_consent: { from: ["ISSUED"], roles: ["COMPLAINANT", "RESPONDENT"] },
  revoke_consent: { from: ["ISSUED", "RESOLVED_CONSENT"], roles: ["COMPLAINANT", "RESPONDENT"] },
  request_new_version: { from: ["RESOLVED_DECLINED", "ISSUED"], roles: ["CASE_MANAGER"] },
  withdraw: { from: ALL_STATES.filter((s) => s !== "CLOSED"), roles: ["COMPLAINANT"] },
  close_case: { from: ["RESOLVED_CONSENT", "RESOLVED_DECLINED", "WITHDRAWN"], roles: ["CASE_MANAGER"] },
};

describe("state machine: exhaustive (state, trigger, role) coverage", () => {
  it("covers every trigger defined in Section 6", () => {
    expect(new Set(TRIGGERS)).toEqual(new Set(Object.keys(EXPECTED)));
  });

  for (const trigger of TRIGGERS) {
    describe(trigger, () => {
      const def = transitionsFor(trigger);
      const expected = EXPECTED[trigger];

      for (const state of STATES_WITH_NONE) {
        const expectedStateOk = expected.from.includes(state);
        it(`from=${state} -> ${expectedStateOk ? "allowed" : "rejected"}`, () => {
          expect(isFromStateAllowed(def, state)).toBe(expectedStateOk);
        });
      }

      for (const actor of ACTORS) {
        const expectedRoleOk = expected.roles.includes(actor);
        it(`role=${actor} -> ${expectedRoleOk ? "allowed" : "rejected"}`, () => {
          expect(isActorRoleAllowed(def, actor)).toBe(expectedRoleOk);
        });
      }
    });
  }

  it("asserts the full state x trigger x role cross product (880 combinations)", () => {
    let checked = 0;
    for (const trigger of TRIGGERS) {
      const def = transitionsFor(trigger);
      const expected = EXPECTED[trigger];
      for (const state of STATES_WITH_NONE) {
        for (const actor of ACTORS) {
          const expectedOk = expected.from.includes(state) && expected.roles.includes(actor);
          const actualOk = isFromStateAllowed(def, state) && isActorRoleAllowed(def, actor);
          expect(actualOk, `${trigger} from=${state} role=${actor}`).toBe(expectedOk);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(TRIGGERS.length * STATES_WITH_NONE.length * ACTORS.length);
  });

  it("ADMIN is never a valid actor for any state-machine trigger (guardrail 10)", () => {
    for (const trigger of TRIGGERS) {
      expect(isActorRoleAllowed(transitionsFor(trigger), "ADMIN")).toBe(false);
    }
  });
});
