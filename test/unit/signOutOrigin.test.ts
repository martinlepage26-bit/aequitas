import { describe, expect, it } from "vitest";
import { signOutOriginAllowed } from "../../src/lib/authPaths";

describe("sign-out origin", () => {
  const internalUrl = "http://aeq-prod-app:3000/api/auth/sign-out";
  const publicUrl = "https://aequitas.app.pharos-ai.ca";

  it("accepts the configured public origin behind the Cloudflare tunnel", () => {
    expect(signOutOriginAllowed(internalUrl, publicUrl, publicUrl)).toBe(true);
  });

  it("rejects an unrelated origin", () => {
    expect(signOutOriginAllowed(internalUrl, "https://other.example", publicUrl)).toBe(false);
  });
});
