import { beforeEach, describe, expect, it, vi } from "vitest";
import { signPayload } from "../../src/lib/signedCookie";

const cookieStore = vi.hoisted(() => ({ token: "", set: vi.fn(), delete: vi.fn() }));
const userLookup = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/prisma", () => ({ prisma: { user: { findUnique: userLookup } } }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: () => cookieStore.token ? { value: cookieStore.token } : undefined,
  set: cookieStore.set, delete: cookieStore.delete,
}) }));
import { createSessionCookie, getSession, getSessionToken } from "../../src/lib/session";

beforeEach(() => {
  process.env.SESSION_SECRET = "unit-session-purpose-test-secret";
  cookieStore.token = "";
  vi.clearAllMocks();
  userLookup.mockResolvedValue({ globalRole: "COMPLAINANT", sessionVersion: 0 });
});

describe("session token boundary", () => {
  it.each([
    { challenge: "challenge", userId: "victim" },
    { purpose: "authenticate", challenge: "challenge", userId: "victim" },
    { purpose: "invite", userId: "victim", nonce: "nonce" },
    { purpose: "invite-claim", userId: "victim", challenge: "challenge" },
    { userId: "victim", globalRole: "ADMIN", authMethod: "passkey" },
    { purpose: "session", userId: "victim" },
    { purpose: "session", userId: "victim", globalRole: "SYSTEM", authMethod: "passkey" },
    { purpose: "session", userId: "", globalRole: "ADMIN", authMethod: "passkey" },
    { purpose: "session", userId: "victim", globalRole: "ADMIN", authMethod: "unknown" },
    null,
  ])("rejects a signed non-session or malformed claim: %j", async payload => {
    cookieStore.token = signPayload(payload, 300);
    expect(await getSession()).toBeNull();
    expect(await getSessionToken()).toBeNull();
  });

  it("accepts a complete purpose-bound authenticated session", async () => {
    const payload = { purpose: "session", userId: "owner", globalRole: "COMPLAINANT", authMethod: "passkey" };
    cookieStore.token = signPayload(payload, 300);
    expect(await getSession()).toEqual({ ...payload, sessionVersion: 0 });
    expect(await getSessionToken()).toBe(cookieStore.token);
  });

  it("session creation adds its required purpose", async () => {
    await createSessionCookie({ userId: "owner", globalRole: "COMPLAINANT", authMethod: "passkey" });
    const [, token] = cookieStore.set.mock.calls[0];
    cookieStore.token = token;
    expect(await getSession()).toMatchObject({ purpose: "session", userId: "owner" });
  });

  it("rejects an old session after account recovery increments its version", async () => {
    cookieStore.token = signPayload({ purpose: "session", userId: "owner", globalRole: "COMPLAINANT", authMethod: "passkey", sessionVersion: 0 }, 300);
    userLookup.mockResolvedValue({ globalRole: "COMPLAINANT", sessionVersion: 1 });
    expect(await getSession()).toBeNull();
    expect(await getSessionToken()).toBeNull();
  });
});
