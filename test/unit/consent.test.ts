import { describe, expect, it } from "vitest";
import { deriveGiveConsentState, nextConsentState } from "../../src/domain/consent";

describe("consent lifecycle (Section 7)", () => {
  it("NOT_GIVEN --give--> GIVEN", () => {
    expect(nextConsentState("NOT_GIVEN", "give")).toEqual({ ok: true, next: "GIVEN" });
  });

  it("NOT_GIVEN --decline--> DECLINED", () => {
    expect(nextConsentState("NOT_GIVEN", "decline")).toEqual({ ok: true, next: "DECLINED" });
  });

  it("GIVEN --revoke--> REVOKED", () => {
    expect(nextConsentState("GIVEN", "revoke")).toEqual({ ok: true, next: "REVOKED" });
  });

  it("REVOKED --give--> GIVEN (a new explicit action)", () => {
    expect(nextConsentState("REVOKED", "give")).toEqual({ ok: true, next: "GIVEN" });
  });

  it("DECLINED is terminal for that version: no action succeeds", () => {
    expect(nextConsentState("DECLINED", "give").ok).toBe(false);
    expect(nextConsentState("DECLINED", "decline").ok).toBe(false);
    expect(nextConsentState("DECLINED", "revoke").ok).toBe(false);
  });

  it("rejects actions with no defined transition", () => {
    expect(nextConsentState("GIVEN", "give").ok).toBe(false);
    expect(nextConsentState("NOT_GIVEN", "revoke").ok).toBe(false);
    expect(nextConsentState("REVOKED", "decline").ok).toBe(false);
    expect(nextConsentState("REVOKED", "revoke").ok).toBe(false);
  });

  it("give_consent stays ISSUED until both parties have given consent", () => {
    expect(deriveGiveConsentState("GIVEN", "NOT_GIVEN")).toBe("ISSUED");
    expect(deriveGiveConsentState("NOT_GIVEN", "GIVEN")).toBe("ISSUED");
    expect(deriveGiveConsentState("REVOKED", "GIVEN")).toBe("ISSUED");
  });

  it("give_consent resolves to RESOLVED_CONSENT once both parties are GIVEN", () => {
    expect(deriveGiveConsentState("GIVEN", "GIVEN")).toBe("RESOLVED_CONSENT");
  });
});
