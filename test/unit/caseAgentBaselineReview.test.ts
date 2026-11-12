import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASE_AGENT_EVALUATION_FIXTURES, caseAgentEvaluationFixtureSetSha256 } from "../../scripts/caseAgentEvaluationFixtures";
import { CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256 } from "../../src/domain/caseAgent/evaluationApproval";
import {
  blankCaseAgentBaselineReview,
  caseAgentBaselineReviewBlockers,
  CASE_AGENT_BASELINE_REVIEW_SCHEMA_VERSION,
  readPrivateCaseAgentBaselineReviewFile,
} from "../../scripts/caseAgentBaselineReview";

const identity = "workers-ai:acct-synthetic:@cf/google/gemma-4-26b-a4b-it:remedies:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:program:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:prompt:prompt-v1:evaluation:eval-v1:fixtures:555baa9b27487cd9028cdadb9fa975aaf53ec14c187f92110b0951589dc5ab5c";

function completeBaselineReview(
  fixtureSet = CASE_AGENT_EVALUATION_FIXTURES,
  fixtureSetSha256 = CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256,
  reviewIdentity = identity,
) {
  const review = blankCaseAgentBaselineReview(reviewIdentity, fixtureSet, fixtureSetSha256);
  review.schemaVersion = CASE_AGENT_BASELINE_REVIEW_SCHEMA_VERSION;
  review.syntheticOnly = true;
  review.noRealCaseInformation = true;
  review.modelOutputsSeenBeforeFreeze = false;
  review.preModelAttestationConfirmed = true;
  review.disagreementsResolved = true;
  review.disagreementResolution = "No disagreements remained after the independent records were compared and reconciled.";
  review.referencesAgreeWithProtocol = true;
  review.referencesFrozen = true;
  review.frozenAt = "2026-10-02T12:00:00Z";
  for (const reviewer of Object.values(review.reviewers)) {
    reviewer.independentOfAequitasDevelopment = true;
    reviewer.publicBenchmarkAnswersSeenBeforeReview = false;
    reviewer.conflictDeclaration = "No conflicts declared.";
  }
  review.reviewers.program.reviewerId = "reviewer-program";
  review.reviewers.program.name = "Synthetic Program Reviewer";
  review.reviewers.program.qualificationBasis = "Experienced case reviewer for the synthetic dispute program.";
  review.reviewers.counsel.reviewerId = "reviewer-counsel";
  review.reviewers.counsel.name = "Synthetic Counsel";
  review.reviewers.counsel.qualificationBasis = "Qualified Québec consumer law counsel.";
  review.reviewers.quebecFrench.reviewerId = "reviewer-french";
  review.reviewers.quebecFrench.name = "Synthetic French Reviewer";
  review.reviewers.quebecFrench.qualificationBasis = "Qualified reviewer of Québec French service language.";
  for (const [index, fixture] of review.fixtures.entries()) {
    const expected = fixtureSet[index];
    fixture.programReview.reviewedBeforeModelOutput = true;
    fixture.programReview.reviewedAt = "2026-10-01T12:00:00Z";
    fixture.programReview.approved = true;
    fixture.programReview.supportableFacts = "The evidence supports the dated purchase and the described defect.";
    fixture.programReview.counterevidenceAndUnknowns = "The response records an offer; acceptance and cause remain unknown.";
    fixture.programReview.disposition = expected.expect === "issued" ? "proposal" : "handoff";
    fixture.programReview.rationale = "The disposition follows the reviewed synthetic case facts and limits.";
    fixture.programReview.policyFit = "The case fits only the synthetic benchmark profile used for evaluation.";
    fixture.programReview.partyPrivacyLimits = "Do not disclose one party's private evidence to the other party.";
    if ("counselReview" in fixture && fixture.counselReview) {
      fixture.counselReview.reviewedBeforeModelOutput = true;
      fixture.counselReview.reviewedAt = "2026-10-01T12:00:00Z";
      fixture.counselReview.humanHandoffRequired = true;
      fixture.counselReview.noModelLegalInterpretation = true;
      fixture.counselReview.rationale = "A human must take over without a model interpretation of Québec law.";
    }
    if ("quebecFrenchReview" in fixture && fixture.quebecFrenchReview) {
      fixture.quebecFrenchReview.reviewedBeforeModelOutput = true;
      fixture.quebecFrenchReview.reviewedAt = "2026-10-01T12:00:00Z";
      fixture.quebecFrenchReview.noticeReviewed = true;
      fixture.quebecFrenchReview.accepted = true;
      fixture.quebecFrenchReview.languageAcceptanceCriteria = "The French notice and handoff must be clear and non-coercive.";
      fixture.quebecFrenchReview.partyPrivacyLimits = "French responses must preserve each party's confidential details.";
    }
  }
  return review;
}

describe("case-agent pre-model baseline review", () => {
  it("accepts a complete frozen review only for the exact identity and fixture set", () => {
    expect(caseAgentBaselineReviewBlockers(completeBaselineReview(), identity)).toEqual([]);
  });

  it("accepts the same review structure for a fresh private fixture identity", () => {
    const privateFixtures = CASE_AGENT_EVALUATION_FIXTURES.map((fixture, index) => ({
      ...fixture,
      name: "private-" + String.fromCharCode(97 + index),
    }));
    const digest = caseAgentEvaluationFixtureSetSha256(privateFixtures);
    const privateIdentity = identity.slice(0, identity.lastIndexOf(":fixtures:") + 10) + digest;
    const review = completeBaselineReview(privateFixtures, digest, privateIdentity);
    expect(caseAgentBaselineReviewBlockers(review, privateIdentity, privateFixtures, digest)).toEqual([]);
  });

  it("allows one qualified person to attest multiple roles when each role is separately recorded", () => {
    const review = completeBaselineReview();
    review.reviewers.counsel.reviewerId = review.reviewers.program.reviewerId;
    review.reviewers.quebecFrench.reviewerId = review.reviewers.program.reviewerId;
    expect(caseAgentBaselineReviewBlockers(review, identity)).toEqual([]);
  });

  it("requires each reviewer to attest independence, no prior public-answer exposure, and conflicts", () => {
    const exposed = completeBaselineReview();
    exposed.reviewers.program.publicBenchmarkAnswersSeenBeforeReview = true;
    expect(caseAgentBaselineReviewBlockers(exposed, identity).join(" ")).toContain("public-answer exposure");

    const notIndependent = completeBaselineReview();
    notIndependent.reviewers.counsel.independentOfAequitasDevelopment = false;
    expect(caseAgentBaselineReviewBlockers(notIndependent, identity).join(" ")).toContain("independence");

    const noConflictStatement = completeBaselineReview();
    noConflictStatement.reviewers.quebecFrench.conflictDeclaration = "";
    expect(caseAgentBaselineReviewBlockers(noConflictStatement, identity).join(" ")).toContain("conflict declarations");
  });

  it("rejects the blank template and records missing reviewer work without exposing reviewer notes", () => {
    const blank = blankCaseAgentBaselineReview(identity);
    blank.reviewers.program.name = "Private reviewer name";
    const blockers = caseAgentBaselineReviewBlockers(blank, identity);
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.join(" ")).not.toContain("Private reviewer name");
    for (const fixture of CASE_AGENT_EVALUATION_FIXTURES) expect(blockers.join(" ")).not.toContain(fixture.name);
  });

  it("keeps expected fixture names and dispositions out of the blind reviewer template", () => {
    const template = JSON.stringify(blankCaseAgentBaselineReview(identity));
    for (const fixture of CASE_AGENT_EVALUATION_FIXTURES) expect(template).not.toContain(fixture.name);
    expect(template).not.toContain('"disposition":"proposal"');
    expect(template).not.toContain('"disposition":"handoff"');
  });

  it("requires all seven fixtures, the two legal reviews, and five French reviews", () => {
    const review = completeBaselineReview();
    review.fixtures.pop();
    expect(caseAgentBaselineReviewBlockers(review, identity).join(" ")).toContain("exactly the seven private fixtures");

    const withoutCounsel = completeBaselineReview();
    const legal = withoutCounsel.fixtures.find((fixture) => fixture.caseReference === "Case D");
    if (legal && "counselReview" in legal && legal.counselReview) legal.counselReview = undefined;
    expect(caseAgentBaselineReviewBlockers(withoutCounsel, identity).join(" ")).toContain("counsel's pre-model legal-handoff review");

    const withoutFrench = completeBaselineReview();
    const french = withoutFrench.fixtures.find((fixture) => fixture.caseReference === "Case F");
    if (french && "quebecFrenchReview" in french && french.quebecFrenchReview) french.quebecFrenchReview = undefined;
    expect(caseAgentBaselineReviewBlockers(withoutFrench, identity).join(" ")).toContain("pre-model Québec French and privacy review");
  });

  it("rejects a disposition that conflicts with the pinned evaluation reference", () => {
    const review = completeBaselineReview();
    const legal = review.fixtures.find((fixture) => fixture.caseReference === "Case D");
    if (legal) legal.programReview.disposition = "proposal";
    expect(caseAgentBaselineReviewBlockers(review, identity).join(" ")).toContain("conflicts with the private fixture-set reference disposition");
  });

  it("reads only an owner-private regular file and reports the raw artifact hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "aeq-baseline-review-test-"));
    const path = join(dir, "baseline.json");
    const content = `${JSON.stringify(completeBaselineReview())}\n`;
    try {
      writeFileSync(path, content, { mode: 0o600 });
      const result = readPrivateCaseAgentBaselineReviewFile(path, identity);
      expect(result.blockers).toEqual([]);
      expect(result.sha256).toBe(createHash("sha256").update(content).digest("hex"));

      chmodSync(path, 0o644);
      const publicFile = readPrivateCaseAgentBaselineReviewFile(path, identity);
      expect(publicFile.sha256).toBeNull();
      expect(publicFile.blockers.join(" ")).toContain("owner-only read/write permissions");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a private review file placed inside the repository", () => {
    const dir = mkdtempSync(join(process.cwd(), ".aeq-baseline-review-test-"));
    const path = join(dir, "baseline.json");
    try {
      writeFileSync(path, JSON.stringify(completeBaselineReview()), { mode: 0o600 });
      const result = readPrivateCaseAgentBaselineReviewFile(path, identity);
      expect(result.sha256).toBeNull();
      expect(result.blockers).toContain("The private baseline review file must be stored outside the repository.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
