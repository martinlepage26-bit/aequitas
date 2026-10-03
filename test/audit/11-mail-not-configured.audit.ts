import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setSuite } from "./lib/http";
import { closePool, one, q } from "./lib/db";
import { createCase, makeAccount, makeAdmin, makeManager, ok, type Account } from "./lib/world";
import { syntheticEmail } from "./lib/config";
import { stub } from "./lib/stub";
import { tokenFromClaimPath } from "./lib/webauthn";
import { Client } from "./lib/http";

/** Area 2, "provider not configured" mode. Run with the server started by `stack.sh server-start <storage> off`. */
let admin: Account, comp: Account, resp: Account;
beforeAll(async () => { setSuite("11-mail-not-configured"); admin = await makeAdmin("off-admin"); comp = await makeAccount("COMPLAINANT", "off-comp"); resp = await makeAccount("RESPONDENT", "off-resp"); await stub.reset(); });
afterAll(async () => { await closePool(); });

describe("mail provider not configured", () => {
  it("reports the missing configuration honestly and makes no provider call", async () => {
    const email = syntheticEmail("off-invitee");
    const res = await admin.client.post("/api/auth/invite", { email, displayName: "Off Invitee", globalRole: "RESPONDENT", sendEmail: true });
    expect(res.status).toBe(200);
    expect(res.json.delivery).toBe("not_configured");
    expect((await admin.client.get("/api/auth/invite")).json.emailConfigured).toBe(false);
    expect((await new Client("c").post("/api/auth/invite/claim", { step: "options", token: tokenFromClaimPath(res.json.claimPath) })).status, "the manual link still works").toBe(200);
    expect(await stub.log("resend")).toHaveLength(0);
    expect((await one<{ emailedAt: Date | null }>(`select "emailedAt" from "Invitation" where id=$1`, [res.json.invitationId]))!.emailedAt).toBeNull();
  });
  it("case actions still succeed; notifications wait in the outbox; the retry endpoint reports pending without sending", async () => {
    const { res, caseId } = await createCase(comp, resp); ok(res, "create");
    ok(await comp.client.post(`/api/cases/${caseId}/submit`), "submit");
    const rows = await q<{ sentAt: Date | null }>(`select "sentAt" from "Notification" where "caseId"=$1`, [caseId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sentAt).toBeNull();
    const retry = await admin.client.request("PATCH", "/api/auth/invite");
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual({ accepted: 0, pending: true });
    expect(await stub.log("resend")).toHaveLength(0);
  });
  it("a manager can still be invited and claim through the manual link", async () => {
    const cm = await makeManager(admin, "off-cm");
    expect((await cm.client.get("/fr-CA/cases")).status).toBe(200);
  });
});
