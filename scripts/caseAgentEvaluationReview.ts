import { createHash } from "node:crypto";
import { parseAllowedRemedies } from "../src/domain/caseAgent/proposal";
import { caseAgentProgramPolicySha256FromRecord, type CaseAgentProgramPolicyIdentityRecord } from "../src/domain/caseAgent/evaluationApproval";
import { CASE_AGENT_EVALUATION_FIXTURES, type CaseAgentEvaluationFixture } from "./caseAgentEvaluationFixtures";

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const NORTH_AMERICAN_PHONE = /\b(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const CANADIAN_POSTAL_CODE = /\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_REVIEW_TEXT_CHARACTERS = 4000;
export const CASE_AGENT_REVIEW_REPORT_SCHEMA_VERSION = "aequitas.case-agent-human-review.v9";

const HUMAN_REVIEW_FIELDS = [
  "dispositionAppropriate",
  "summaryFaithfulToCitedEvidence",
  "proposalBasisFaithfulToCitedEvidence",
  "reasoningNeutralAndBalanced",
  "relevantCounterevidenceIncluded",
  "proposalWithinEvaluatedPolicy",
  "partyPrivacyPreserved",
  "languageClearForEachParty",
] as const;

/**
 * The review artifact contains only generated text and exact cited excerpts
 * from synthetic fixtures. Redact common contact identifiers again before
 * writing it so a model echo cannot copy them into the report.
 */
export function sanitizeReviewText(value: string): string {
  const redacted = value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(EMAIL, "[REDACTED EMAIL]")
    .replace(NORTH_AMERICAN_PHONE, "[REDACTED PHONE]")
    .replace(CANADIAN_POSTAL_CODE, "[REDACTED POSTAL CODE]");
  if (redacted.length <= MAX_REVIEW_TEXT_CHARACTERS) return redacted;
  return `${redacted.slice(0, MAX_REVIEW_TEXT_CHARACTERS)}…[TRUNCATED]`;
}

/** Return only a bounded, sanitized needs_human field; never echo malformed provider output. */
export function sanitizedHumanHandoffRequest(raw: string | null): string | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reason = (value as Record<string, unknown>).needs_human;
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 500) return null;
  return sanitizeReviewText(reason);
}

/** Match only the seeded synthetic phone marker, including common formatting variants. */
export function containsNormalizedContactMarker(value: string | null | undefined, marker: string): boolean {
  const normalizedMarker = marker.replace(/\D/g, "");
  if (normalizedMarker.length < 7) return false;
  return (value ?? "").replace(/\D/g, "").includes(normalizedMarker);
}

/** Detect any exact contact marker found in the other party's submitted text. */
export function containsContactMarkerFromSource(
  output: string | null | undefined,
  otherPartySource: string,
): boolean {
  const outputText = output ?? "";
  const emailMarkers = otherPartySource.match(EMAIL) ?? [];
  const phoneMarkers = otherPartySource.match(NORTH_AMERICAN_PHONE) ?? [];
  const postalMarkers = otherPartySource.match(CANADIAN_POSTAL_CODE) ?? [];
  if (emailMarkers.some((marker) => outputText.toLowerCase().includes(marker.toLowerCase()))) return true;
  if (phoneMarkers.some((marker) => {
    const normalized = marker.replace(/\D/g, "");
    return normalized.length >= 10 && outputText.replace(/\D/g, "").includes(normalized);
  })) return true;
  return postalMarkers.some((marker) => {
    const normalized = marker.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    return normalized.length === 6 && outputText.replace(/[^A-Z0-9]/gi, "").toUpperCase().includes(normalized);
  });
}

/** Empty fields require a human to record judgments; automation does not grade semantic quality. */
export function blankHumanReviewChecklist() {
  return {
    dispositionAppropriate: null as "pass" | "fail" | null,
    summaryFaithfulToCitedEvidence: null as "pass" | "fail" | null,
    proposalBasisFaithfulToCitedEvidence: null as "pass" | "fail" | null,
    reasoningNeutralAndBalanced: null as "pass" | "fail" | null,
    relevantCounterevidenceIncluded: null as "pass" | "fail" | null,
    proposalWithinEvaluatedPolicy: null as "pass" | "fail" | null,
    partyPrivacyPreserved: null as "pass" | "fail" | null,
    languageClearForEachParty: null as "pass" | "fail" | null,
    reviewerNotes: "",
  };
}

type ReviewObject = Record<string, unknown>;

function isObject(value: unknown): value is ReviewObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectedIdentityParts(identity: string): {
  provider: string;
  providerIdentity: string;
  model: string;
  allowedRemediesSha256: string;
  programPolicySha256: string;
  promptVersion: string;
  evaluationProtocolVersion: string;
  fixtureSetSha256: string;
} | null {
  const match = identity.match(/^(gemini|workers-ai|vertex-ai):(.+):remedies:([a-f0-9]{64}):program:([a-f0-9]{64}):prompt:([A-Za-z0-9._-]+):evaluation:([A-Za-z0-9._-]+):fixtures:([a-f0-9]{64})$/);
  if (!match || !/^[A-Za-z0-9@._/:+-]+$/.test(identity)) return null;
  const identityParts = match[2].split(":");
  const expectedParts = match[1] === "vertex-ai" ? 3 : 2;
  if (identityParts.length !== expectedParts || identityParts.some((part) => part.length === 0)) return null;
  return {
    provider: match[1],
    providerIdentity: `${match[1]}:${match[2]}`,
    model: identityParts.at(-1)!,
    allowedRemediesSha256: match[3],
    programPolicySha256: match[4],
    promptVersion: match[5],
    evaluationProtocolVersion: match[6],
    fixtureSetSha256: match[7],
  };
}

function validatedProgramPolicy(report: ReviewObject, expectedProviderIdentity: string): CaseAgentProgramPolicyIdentityRecord | null {
  const value = report.programPolicy;
  if (!isObject(value)
    || !Number.isSafeInteger(value.maxAmountCents) || (value.maxAmountCents as number) < 1
    || !Number.isSafeInteger(value.maxModelCallsPerUtcDay) || (value.maxModelCallsPerUtcDay as number) < 1
    || !Number.isSafeInteger(value.intakeDays) || (value.intakeDays as number) < 1
    || !Number.isSafeInteger(value.responseDays) || (value.responseDays as number) < 1
    || typeof value.respondentMayWithdraw !== "boolean"
    || typeof value.consentOnlyResolution !== "boolean"
    || value.providerIdentity !== expectedProviderIdentity
    || typeof value.processingNoticeHash !== "string" || !/^[a-f0-9]{64}$/.test(value.processingNoticeHash)) return null;
  const supplied = Array.isArray(value.allowedRemedies) && value.allowedRemedies.every((item) => typeof item === "string")
    ? value.allowedRemedies as string[]
    : null;
  const canonical = supplied ? parseAllowedRemedies(supplied.join(",")) : null;
  if (!canonical || supplied?.some((remedy, index) => remedy !== canonical[index])) return null;
  if (!Array.isArray(report.allowedRemedies) || JSON.stringify(report.allowedRemedies) !== JSON.stringify(canonical)) return null;
  return {
    maxAmountCents: value.maxAmountCents as number,
    allowedRemedies: canonical,
    maxModelCallsPerUtcDay: value.maxModelCallsPerUtcDay as number,
    intakeDays: value.intakeDays as number,
    responseDays: value.responseDays as number,
    respondentMayWithdraw: value.respondentMayWithdraw,
    consentOnlyResolution: value.consentOnlyResolution,
    providerIdentity: value.providerIdentity,
    processingNoticeHash: value.processingNoticeHash,
  };
}

/**
 * Check that a locally completed review artifact is for the current runtime
 * identity and contains every required mechanical and human-review result.
 * This checks the supplied file; it cannot prove who completed the checklist.
 */
export function evaluationReviewBlockers(
  report: unknown,
  expectedIdentity: string | null,
  expectedFixtures: readonly CaseAgentEvaluationFixture[] = CASE_AGENT_EVALUATION_FIXTURES,
): string[] {
  const blockers: string[] = [];
  if (!isObject(report)) return ["Review report must be a JSON object."];
  if (report.schemaVersion !== CASE_AGENT_REVIEW_REPORT_SCHEMA_VERSION) blockers.push("Review report schema is unsupported.");
  if (report.mode !== "live") blockers.push("Only a live synthetic evaluation can be approved.");
  if (report.syntheticOnly !== true) blockers.push("Report is not marked synthetic-only.");
  if (report.automatedChecksPassed !== true) blockers.push("Automated evaluation checks did not all pass.");
  if (report.status !== "human_review_complete") blockers.push("Report status must be set to human_review_complete after review.");
  if (typeof report.baselineReviewArtifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(report.baselineReviewArtifactSha256)) {
    blockers.push("Report must retain the SHA-256 of the validated pre-model baseline review artifact.");
  }
  if (!expectedIdentity) blockers.push("The current provider, account/project, model, or workflow-policy identity is unavailable.");
  if (typeof expectedIdentity === "string") {
    const parts = expectedIdentityParts(expectedIdentity);
    if (!parts) blockers.push("The current evaluation identity has an unsupported format.");
    if (report.evaluationApprovalIdentity !== expectedIdentity) blockers.push("Report identity does not match the current runtime identity.");
    if (report.promptVersion !== parts?.promptVersion) blockers.push("Report prompt version does not match the current identity.");
    if (report.evaluationProtocolVersion !== parts?.evaluationProtocolVersion) blockers.push("Report evaluation protocol does not match the current identity.");
    if (report.evaluationFixtureSetSha256 !== parts?.fixtureSetSha256) blockers.push("Report fixture-set digest does not match the current identity.");
    if (report.provider !== parts?.provider) blockers.push("Report provider does not match the current identity.");
    if (report.model !== parts?.model) blockers.push("Report model does not match the current identity.");
    const programPolicy = parts ? validatedProgramPolicy(report, parts.providerIdentity) : null;
    const programPolicySha256 = programPolicy ? caseAgentProgramPolicySha256FromRecord(programPolicy) : null;
    if (!programPolicy || report.programPolicySha256 !== programPolicySha256
      || programPolicySha256 !== parts?.programPolicySha256) blockers.push("Report workflow policy does not match the current evaluation identity.");
    const suppliedRemedies = Array.isArray(report.allowedRemedies)
      && report.allowedRemedies.every((item) => typeof item === "string")
      ? report.allowedRemedies as string[]
      : null;
    const canonicalRemedies = suppliedRemedies ? parseAllowedRemedies(suppliedRemedies.join(",")) : null;
    const remediesDigest = canonicalRemedies && suppliedRemedies?.every((remedy, index) => remedy === canonicalRemedies[index])
      ? createHash("sha256").update(JSON.stringify(canonicalRemedies)).digest("hex")
      : null;
    if (!canonicalRemedies || report.allowedRemediesSha256 !== remediesDigest
      || remediesDigest !== parts?.allowedRemediesSha256) blockers.push("Report remedy allowlist does not match the current evaluation identity.");
  }

  if (!Array.isArray(report.fixtures) || report.fixtures.length !== expectedFixtures.length) {
    blockers.push("Report must contain the complete seven-fixture evaluation.");
    return blockers;
  }

  const fixtures = new Map<string, ReviewObject>();
  for (const item of report.fixtures) {
    if (!isObject(item) || typeof item.fixture !== "string" || fixtures.has(item.fixture)) {
      blockers.push("Fixture names must be present and unique.");
      continue;
    }
    fixtures.set(item.fixture, item);
  }
  if (fixtures.size !== expectedFixtures.length
    || expectedFixtures.some((expected) => !fixtures.has(expected.name))) {
    blockers.push("Report does not contain the exact required fixture set.");
  }

  for (const expectation of expectedFixtures) {
    const name = expectation.name;
    const fixture = fixtures.get(name);
    if (!fixture) continue;
    const expectedDisposition = expectation.expect;
    if (fixture.expectedDisposition !== expectedDisposition || fixture.actualDisposition !== expectedDisposition) {
      blockers.push("Fixture " + name + " did not produce its required disposition.");
    }
    if (fixture.escalationReason !== (expectation.expectedEscalationReason ?? null)) {
      blockers.push("Fixture " + name + " did not use its required escalation reason.");
    }
    if (fixture.expectedProviderCalls !== expectation.expectedModelCalls || fixture.actualProviderCalls !== expectation.expectedModelCalls) {
      blockers.push("Fixture " + name + " did not use the expected number of provider calls.");
    }
    if (fixture.automatedChecksPassed !== true) blockers.push("Fixture " + name + " failed automated checks.");
    if (fixture.crossPartyContactLeakDetected !== false) {
      blockers.push("Fixture " + name + " has an unverified or detected cross-party contact leak.");
    }

    if (expectedDisposition === "escalated") {
      if (fixture.generatedOutput !== null || fixture.generatedOutputStatus !== "no_issued_recommendation") {
        blockers.push(`Escalated fixture ${name} must contain no issued recommendation.`);
      }
    } else {
      const output = fixture.generatedOutput;
      const citations = isObject(output) ? output.citations : undefined;
      const claimEvidence = isObject(output) ? output.claimEvidence : undefined;
      const outcomes = isObject(output) ? output.partyOutcomes : undefined;
      if (fixture.generatedOutputStatus !== "verified_citations" || !isObject(output)
        || !Array.isArray(citations) || citations.length === 0
        || !citations.every((citation) => isObject(citation)
          && citation.excerptStatus === "verified"
          && typeof citation.excerpt === "string"
          && citation.excerpt.trim().length > 0)) {
        blockers.push(`Issued fixture ${name} needs hash-verified evidence excerpts.`);
      }
      const citationIds = new Set(Array.isArray(citations)
        ? citations.flatMap((citation) => isObject(citation) && typeof citation.citationId === "string" ? [citation.citationId] : [])
        : []);
      const proposalClaims = Array.isArray(claimEvidence)
        ? claimEvidence.filter((claim) => isObject(claim) && claim.section === "proposal")
        : [];
      if (proposalClaims.length === 0 || !proposalClaims.every((claim) => isObject(claim)
        && typeof claim.text === "string" && claim.text.trim().length > 0
        && Array.isArray(claim.citationIds) && claim.citationIds.length > 0
        && claim.citationIds.every((id) => typeof id === "string" && citationIds.has(id)))) {
        blockers.push(`Issued fixture ${name} needs an evidence-linked proposal basis.`);
      }
      for (const party of ["complainant", "respondent"] as const) {
        const partyOutcome = isObject(outcomes) ? outcomes[party] : undefined;
        if (!isObject(partyOutcome) || partyOutcome.citationsUseOnlyThatPartyEvidence !== true
          || typeof partyOutcome.citationCount !== "number" || partyOutcome.citationCount < 1) {
          blockers.push(`Issued fixture ${name} needs a cited, party-isolated ${party} outcome.`);
        }
      }
    }

    const checklist = fixture.humanReviewChecklist;
    if (!isObject(checklist)) {
      blockers.push(`Fixture ${name} has no human-review checklist.`);
      continue;
    }
    const expectedChecklistKeys = [...HUMAN_REVIEW_FIELDS, "reviewerNotes"].sort();
    if (Object.keys(checklist).sort().join("\n") !== expectedChecklistKeys.join("\n")) {
      blockers.push(`Fixture ${name} has an incomplete or unexpected human-review checklist.`);
    }
    for (const field of HUMAN_REVIEW_FIELDS) {
      if (checklist[field] !== "pass") blockers.push(`Fixture ${name} needs a passing human review for ${field}.`);
    }
    if (typeof checklist.reviewerNotes !== "string" || checklist.reviewerNotes.length > MAX_REVIEW_TEXT_CHARACTERS) {
      blockers.push(`Fixture ${name} has invalid reviewer notes.`);
    }
  }
  return blockers;
}
