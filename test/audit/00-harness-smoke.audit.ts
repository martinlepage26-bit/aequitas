import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setSuite } from "./lib/http";
import { closePool, caseEvents, caseRow } from "./lib/db";
import { driveCase, makeCast, type Cast } from "./lib/world";
import { legality, verifyChain } from "./lib/chain";
import { keysForCase } from "./lib/storage";

/** Proves the harness itself works end to end before any finding is trusted: one full real-HTTP lifecycle. */
let cast: Cast;
beforeAll(async () => { setSuite("00-harness-smoke"); cast = await makeCast("smoke"); });
afterAll(async () => { await closePool(); });

describe("harness smoke (production-mode server, real WebAuthn, mocked AI)", () => {
  it("drives a case from creation to CLOSED and the log verifies independently", async () => {
    const { caseId } = await driveCase(cast, "CLOSED");
    expect((await caseRow(caseId))!.state).toBe("CLOSED");
    const events = await caseEvents(caseId);
    expect(verifyChain(events)).toEqual([]);
    expect(legality(events)).toEqual({ issues: [], finalState: "CLOSED" });
    expect((await keysForCase(caseId)).length).toBeGreaterThanOrEqual(3); // 2 evidence objects + 1 export
  });
});
