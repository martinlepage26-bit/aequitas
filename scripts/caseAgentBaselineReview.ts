import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CASE_AGENT_EVALUATION_FIXTURES, type CaseAgentEvaluationFixture } from "./caseAgentEvaluationFixtures";
import { CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256 } from "../src/domain/caseAgent/evaluationApproval";

export const CASE_AGENT_BASELINE_REVIEW_SCHEMA_VERSION = "aequitas.case-agent-baseline-review.v2";
const MAX_BASELINE_REVIEW_BYTES = 256 * 1024;

type ReviewRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ReviewRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown, minimum = 12): value is string {
  return typeof value === "string" && value.trim().length >= minimum && value.length <= 4000;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function reviewIsBeforeFreeze(review: ReviewRecord, frozenAt: number): boolean {
  return isIsoDate(review.reviewedAt) && Date.parse(review.reviewedAt) <= frozenAt;
}

function validateReviewer(value: unknown, role: string): value is ReviewRecord {
  return isRecord(value)
    && value.role === role
    && typeof value.reviewerId === "string"
    && /^[A-Za-z0-9._-]{3,80}$/.test(value.reviewerId)
    && hasText(value.name, 2)
    && hasText(value.qualificationBasis, 12)
    && value.independentOfAequitasDevelopment === true
    && value.publicBenchmarkAnswersSeenBeforeReview === false
    && hasText(value.conflictDeclaration, 2);
}

/** Validate the operator-attested, pre-model human reference artifact without exposing its private notes. */
export function caseAgentBaselineReviewBlockers(
  review: unknown,
  expectedIdentity: string | null,
  fixtures: readonly CaseAgentEvaluationFixture[] = CASE_AGENT_EVALUATION_FIXTURES,
  fixtureSetSha256 = CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256,
): string[] {
  const blockers: string[] = [];
  if (!isRecord(review)) return ["The baseline review must be a JSON object."];
  if (!expectedIdentity) blockers.push("The current evaluation identity could not be constructed.");
  if (review.schemaVersion !== CASE_AGENT_BASELINE_REVIEW_SCHEMA_VERSION) blockers.push("The baseline review schema is unsupported.");
  if (review.evaluationIdentity !== expectedIdentity) blockers.push("The baseline review is not for the current provider, policy, prompt, protocol, and fixture identity.");
  if (review.fixtureSetSha256 !== fixtureSetSha256) blockers.push("The baseline review fixture digest is stale.");
  if (review.syntheticOnly !== true || review.noRealCaseInformation !== true) blockers.push("The baseline review must attest that it contains synthetic cases only.");
  if (review.modelOutputsSeenBeforeFreeze !== false) blockers.push("The baseline review must attest that no model output was seen before references were frozen.");
  if (review.preModelAttestationConfirmed !== true) blockers.push("The operator must confirm the independent reviewers used the blind packet before any model output.");
  if (review.disagreementsResolved !== true || !hasText(review.disagreementResolution)) blockers.push("The baseline review must record how disagreements were resolved, or state that none occurred.");
  if (review.referencesAgreeWithProtocol !== true) blockers.push("The reviewed references must agree with the pinned protocol; otherwise revise and reapprove the protocol before a live run.");
  if (review.referencesFrozen !== true || !isIsoDate(review.frozenAt)) blockers.push("The baseline references must be frozen with an ISO UTC timestamp.");
  const frozenAt = isIsoDate(review.frozenAt) ? Date.parse(review.frozenAt) : Number.NaN;

  if (!isRecord(review.reviewers)
    || !validateReviewer(review.reviewers.program, "program_case_reviewer")
    || !validateReviewer(review.reviewers.counsel, "qualified_counsel")
    || !validateReviewer(review.reviewers.quebecFrench, "quebec_french_reviewer")) {
    blockers.push("The baseline review must identify qualified reviewers for all required roles and record their independence, public-answer exposure, and conflict declarations.");
  }

  if (!Array.isArray(review.fixtures)) {
    blockers.push("The baseline review must contain one record for each of the seven fixtures.");
    return blockers;
  }
  const records = new Map<string, ReviewRecord>();
  for (const fixture of review.fixtures) {
    if (!isRecord(fixture) || typeof fixture.caseReference !== "string") {
      blockers.push("A fixture review record is malformed.");
      continue;
    }
    if (records.has(fixture.caseReference)) blockers.push(`${fixture.caseReference} appears more than once.`);
    else records.set(fixture.caseReference, fixture);
  }

  const blindLabels = fixtures.map((_, index) => "Case " + String.fromCharCode(65 + index));
  const knownLabels = new Set(blindLabels);
  for (const label of records.keys()) {
    if (!knownLabels.has(label)) blockers.push(`${label} is not part of the private blind review set.`);
  }

  for (const [index, fixture] of fixtures.entries()) {
    const caseLabel = blindLabels[index];
    const record = records.get(caseLabel);
    if (!record) {
      blockers.push(`${caseLabel} has no baseline review.`);
      continue;
    }

    const program = record.programReview;
    if (!isRecord(program)
      || program.reviewedBeforeModelOutput !== true
      || program.approved !== true
      || !reviewIsBeforeFreeze(program, frozenAt)
      || !hasText(program.supportableFacts)
      || !hasText(program.counterevidenceAndUnknowns)
      || !hasText(program.rationale)
      || !hasText(program.policyFit)
      || !hasText(program.partyPrivacyLimits)
      || (program.disposition !== "proposal" && program.disposition !== "handoff")) {
      blockers.push(`${caseLabel} needs a complete, pre-model program case review.`);
    } else if (program.disposition !== (fixture.expect === "issued" ? "proposal" : "handoff")) {
      blockers.push(`${caseLabel} conflicts with the private fixture-set reference disposition; revise and reapprove the evaluation protocol before a live run.`);
    }

    const needsCounsel = fixture.expectedEscalationReason === "legal_language_detected";
    if (needsCounsel) {
      const counsel = record.counselReview;
      if (!isRecord(counsel)
        || counsel.reviewedBeforeModelOutput !== true
        || !reviewIsBeforeFreeze(counsel, frozenAt)
        || counsel.humanHandoffRequired !== true
        || counsel.noModelLegalInterpretation !== true
        || !hasText(counsel.rationale)) {
        blockers.push(`${caseLabel} needs counsel's pre-model legal-handoff review.`);
      }
    } else if (record.counselReview !== undefined && record.counselReview !== null) {
      const counsel = record.counselReview;
      if (!isRecord(counsel) || !reviewIsBeforeFreeze(counsel, frozenAt) || !hasText(counsel.rationale)) {
        blockers.push(`${caseLabel} has an incomplete optional counsel review.`);
      }
    }

    const needsFrench = fixture.complainantLocale === "fr-CA" || fixture.respondentLocale === "fr-CA";
    if (needsFrench) {
      const french = record.quebecFrenchReview;
      if (!isRecord(french)
        || french.reviewedBeforeModelOutput !== true
        || !reviewIsBeforeFreeze(french, frozenAt)
        || french.noticeReviewed !== true
        || french.accepted !== true
        || !hasText(french.languageAcceptanceCriteria)
        || !hasText(french.partyPrivacyLimits)) {
        blockers.push(`${caseLabel} needs an accepted pre-model Québec French and privacy review.`);
      }
    } else if (record.quebecFrenchReview !== undefined && record.quebecFrenchReview !== null) {
      const french = record.quebecFrenchReview;
      if (!isRecord(french) || !reviewIsBeforeFreeze(french, frozenAt) || !hasText(french.languageAcceptanceCriteria)) {
        blockers.push(`${caseLabel} has an incomplete optional Québec French review.`);
      }
    }
  }

  if (review.fixtures.length !== fixtures.length) {
    blockers.push("The baseline review must contain exactly the seven private fixtures.");
  }
  return [...new Set(blockers)];
}

/** Read a private local review file and return only its content hash and safe validation messages. */
export function readPrivateCaseAgentBaselineReviewFile(
  path: string,
  expectedIdentity: string | null,
  fixtures: readonly CaseAgentEvaluationFixture[] = CASE_AGENT_EVALUATION_FIXTURES,
  fixtureSetSha256 = CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256,
): { sha256: string | null; blockers: string[] } {
  if (!path.trim()) return { sha256: null, blockers: ["Provide a private baseline review file path."] };
  let absolutePath: string;
  try {
    absolutePath = join(realpathSync(dirname(resolve(path))), basename(resolve(path)));
  } catch {
    return { sha256: null, blockers: ["The private baseline review file could not be safely read."] };
  }
  const relativePath = relative(process.cwd(), absolutePath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) === false) {
    return { sha256: null, blockers: ["The private baseline review file must be stored outside the repository."] };
  }

  let fd: number | undefined;
  try {
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const mode = stat.mode & 0o777;
    const uidMatches = typeof process.getuid !== "function" || stat.uid === process.getuid();
    if (!stat.isFile() || stat.nlink !== 1 || !uidMatches || (mode & 0o077) !== 0 || (mode & 0o400) === 0 || (mode & 0o100) !== 0) {
      return { sha256: null, blockers: ["The baseline review file must be a regular file owned by this user with owner-only read/write permissions (for example, mode 0600)."] };
    }
    if (stat.size < 2 || stat.size > MAX_BASELINE_REVIEW_BYTES) {
      return { sha256: null, blockers: ["The baseline review file is empty or exceeds the 256 KiB limit."] };
    }
    const bytes = readFileSync(fd);
    let review: unknown;
    try {
      review = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      return { sha256: null, blockers: ["The baseline review file is not valid JSON."] };
    }
    const blockers = caseAgentBaselineReviewBlockers(review, expectedIdentity, fixtures, fixtureSetSha256);
    return blockers.length > 0
      ? { sha256: null, blockers }
      : { sha256: createHash("sha256").update(bytes).digest("hex"), blockers: [] };
  } catch {
    return { sha256: null, blockers: ["The private baseline review file could not be safely read."] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Return a blank private-file shape with fixture-specific reviewer sections. */
export function blankCaseAgentBaselineReview(
  evaluationIdentity: string,
  fixtures: readonly CaseAgentEvaluationFixture[] = CASE_AGENT_EVALUATION_FIXTURES,
  fixtureSetSha256 = CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256,
) {
  return {
    schemaVersion: CASE_AGENT_BASELINE_REVIEW_SCHEMA_VERSION,
    evaluationIdentity,
    fixtureSetSha256,
    syntheticOnly: null as boolean | null,
    noRealCaseInformation: null as boolean | null,
    modelOutputsSeenBeforeFreeze: null as boolean | null,
    preModelAttestationConfirmed: false,
    disagreementsResolved: false,
    disagreementResolution: "",
    referencesAgreeWithProtocol: false,
    referencesFrozen: false,
    frozenAt: "",
    reviewers: {
      program: {
        reviewerId: "",
        name: "",
        role: "program_case_reviewer",
        qualificationBasis: "",
        independentOfAequitasDevelopment: false,
        publicBenchmarkAnswersSeenBeforeReview: null as boolean | null,
        conflictDeclaration: "",
      },
      counsel: {
        reviewerId: "",
        name: "",
        role: "qualified_counsel",
        qualificationBasis: "",
        independentOfAequitasDevelopment: false,
        publicBenchmarkAnswersSeenBeforeReview: null as boolean | null,
        conflictDeclaration: "",
      },
      quebecFrench: {
        reviewerId: "",
        name: "",
        role: "quebec_french_reviewer",
        qualificationBasis: "",
        independentOfAequitasDevelopment: false,
        publicBenchmarkAnswersSeenBeforeReview: null as boolean | null,
        conflictDeclaration: "",
      },
    },
    fixtures: fixtures.map((fixture, index) => ({
      caseReference: `Case ${String.fromCharCode(65 + index)}`,
      programReview: {
        reviewedBeforeModelOutput: false,
        reviewedAt: "",
        approved: false,
        supportableFacts: "",
        counterevidenceAndUnknowns: "",
        disposition: "",
        rationale: "",
        policyFit: "",
        partyPrivacyLimits: "",
      },
      ...(fixture.expectedEscalationReason === "legal_language_detected" ? {
        counselReview: {
          reviewedBeforeModelOutput: false,
          reviewedAt: "",
          humanHandoffRequired: false,
          noModelLegalInterpretation: false,
          rationale: "",
        },
      } : {}),
      ...(fixture.complainantLocale === "fr-CA" || fixture.respondentLocale === "fr-CA" ? {
        quebecFrenchReview: {
          reviewedBeforeModelOutput: false,
          reviewedAt: "",
          noticeReviewed: false,
          accepted: false,
          languageAcceptanceCriteria: "",
          partyPrivacyLimits: "",
        },
      } : {}),
    })),
  };
}
