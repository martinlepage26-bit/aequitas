import { describe, expect, it } from "vitest";
import { pilotContactUrl } from "../../src/lib/pilotContact";

describe("pilotContactUrl", () => {
  it("hides the call to action when unset or blank", () => {
    expect(pilotContactUrl(undefined)).toBeNull();
    expect(pilotContactUrl("   ")).toBeNull();
  });
  it("accepts https and mailto addresses", () => {
    expect(pilotContactUrl("https://example.org/pilot")).toBe("https://example.org/pilot");
    expect(pilotContactUrl("mailto:pilot@example.org")).toBe("mailto:pilot@example.org");
  });
  it("rejects other schemes and malformed values", () => {
    expect(pilotContactUrl("http://example.org")).toBeNull();
    expect(pilotContactUrl("javascript:alert(1)")).toBeNull();
    expect(pilotContactUrl("mailto:")).toBeNull();
    expect(pilotContactUrl("not a url")).toBeNull();
  });
});
