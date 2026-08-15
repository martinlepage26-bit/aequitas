import { beforeAll, describe, expect, it } from "vitest";
import { signPayload, verifyPayload } from "../../src/lib/signedCookie";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-do-not-use-in-prod";
});

describe("signedCookie", () => {
  it("round-trips a payload", () => {
    const token = signPayload({ userId: "u1", role: "COMPLAINANT" }, 60);
    expect(verifyPayload<{ userId: string; role: string }>(token)).toEqual({ userId: "u1", role: "COMPLAINANT" });
  });

  it("rejects a token with a tampered payload", () => {
    const token = signPayload({ userId: "u1" }, 60);
    const [data, signature] = token.split(".");
    const tamperedBody = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    tamperedBody.payload.userId = "attacker";
    const tamperedData = Buffer.from(JSON.stringify(tamperedBody), "utf8").toString("base64url");
    expect(verifyPayload(`${tamperedData}.${signature}`)).toBeNull();
  });

  it("rejects a token with a wrong signature", () => {
    const token = signPayload({ userId: "u1" }, 60);
    const [data] = token.split(".");
    expect(verifyPayload(`${data}.not-the-real-signature`)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signPayload({ userId: "u1" }, -1);
    expect(verifyPayload(token)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyPayload("not-a-valid-token")).toBeNull();
    expect(verifyPayload("")).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signPayload({ userId: "u1" }, 60);
    process.env.SESSION_SECRET = "a-different-secret";
    expect(verifyPayload(token)).toBeNull();
    process.env.SESSION_SECRET = "test-secret-do-not-use-in-prod";
  });
});
