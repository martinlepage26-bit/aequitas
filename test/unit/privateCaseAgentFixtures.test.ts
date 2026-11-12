import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASE_AGENT_EVALUATION_FIXTURES } from "../../scripts/caseAgentEvaluationFixtures";
import {
  privateCaseAgentFixtureSetBlockers,
  privateCaseAgentFixturePolicyBlockers,
  privateFixtureSetDocument,
  readPrivateCaseAgentFixtureSet,
  renderPrivateCaseAgentBlindPacket,
} from "../../scripts/privateCaseAgentFixtures";

const fixtures = CASE_AGENT_EVALUATION_FIXTURES.map((fixture, index) => ({
  ...fixture,
  name: "private-" + String.fromCharCode(97 + index),
}));
const policy = {
  providerIdentity: "workers-ai:synthetic-account:@cf/google/gemma-4-26b-a4b-it",
  maxAmountCents: 500_000,
  allowedRemedies: ["refund_full", "refund_partial", "store_credit", "replacement", "repair"],
  intakeDays: 1,
  responseDays: 1,
  respondentMayWithdraw: true,
  consentOnlyResolution: true,
  processingNoticeEn: "Synthetic notice in English.",
  processingNoticeFr: "Avis synthétique en français.",
};

describe("private case-agent evaluation fixtures", () => {
  it("requires seven synthetic unpublished cases with coherent expected calls", () => {
    const document = privateFixtureSetDocument(fixtures);
    expect(privateCaseAgentFixtureSetBlockers(document)).toEqual([]);
    expect(privateCaseAgentFixtureSetBlockers({ ...document, unpublished: false })).toContain(
      "The private fixture set must attest to synthetic-only, unpublished cases.",
    );
    expect(privateCaseAgentFixtureSetBlockers({ ...document, unreviewedExpectedAnswers: true })).toContain(
      "The private fixture-set document contains an unsupported field.",
    );
    const malformed = privateFixtureSetDocument(fixtures.map((fixture, index) =>
      index === 0 ? { ...fixture, expectedModelCalls: 0 } : fixture,
    ));
    expect(privateCaseAgentFixtureSetBlockers(malformed).join(" ")).toContain("inconsistent proposal expectations");
  });

  it("renders a reviewer packet without expected answers, internal names, or model-call counts", () => {
    const digest = createHash("sha256").update(JSON.stringify(fixtures)).digest("hex");
    const packet = renderPrivateCaseAgentBlindPacket(fixtures, policy);
    expect(packet).toContain("Independent pre-model review packet");
    expect(packet).toContain("Provider and model: ");
    expect(packet).not.toContain(digest);
    expect(packet).not.toContain("private-a");
    expect(packet).not.toContain("expectedEscalationReason");
    expect(packet).not.toContain("expectedModelCalls");
    expect(packet).not.toContain("model_requested_review");
    expect(packet).not.toContain("legal_language_detected");
    expect(packet).not.toContain('"expect"');
  });

  it("rejects fixtures outside the policy and legal handoffs without a local legal marker", () => {
    expect(privateCaseAgentFixturePolicyBlockers(fixtures, 500_000)).toEqual([]);
    expect(privateCaseAgentFixturePolicyBlockers(fixtures, 100)).toContain("Case A exceeds the configured program amount limit.");
    const missingLegalMarker = fixtures.map((fixture, index) => index === 3
      ? {
          ...fixture,
          complainantPosition: "My tablet stopped charging after nine months.",
          complainantText: "Receipt: tablet purchased for $640.",
        }
      : fixture);
    expect(privateCaseAgentFixturePolicyBlockers(missingLegalMarker, 500_000)).toContain(
      "Case D expects a pre-model legal handoff but has no locally detectable legal marker.",
    );
  });

  it("loads only owner-private fixture files outside the repository and binds the fixture digest", () => {
    const directory = mkdtempSync(join(tmpdir(), "aeq-private-fixtures-test-"));
    const path = join(directory, "fixtures.json");
    const document = privateFixtureSetDocument(fixtures);
    const content = JSON.stringify(document);
    try {
      writeFileSync(path, content, { mode: 0o600 });
      const result = readPrivateCaseAgentFixtureSet(path);
      expect(result.blockers).toEqual([]);
      expect(result.fixtures).toEqual(fixtures);
      expect(result.fixtureSetSha256).toBe(createHash("sha256").update(JSON.stringify(fixtures)).digest("hex"));

      const publicFile = join(directory, "public.json");
      writeFileSync(publicFile, content, { mode: 0o644 });
      chmodSync(publicFile, 0o644);
      expect(readPrivateCaseAgentFixtureSet(publicFile).blockers.join(" ")).toContain("owner-only permissions");

      expect(readPrivateCaseAgentFixtureSet(join(process.cwd(), "package.json")).blockers.join(" "))
        .toContain("outside the repository");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
