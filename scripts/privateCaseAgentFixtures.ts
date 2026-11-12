import { constants } from "node:fs";
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  caseAgentEvaluationFixtureSetSha256,
  type CaseAgentEvaluationFixture,
} from "./caseAgentEvaluationFixtures";
import { hasExplicitLegalIssueMarker } from "../src/domain/caseAgent/legalEscalation";

export const PRIVATE_CASE_AGENT_FIXTURE_SET_SCHEMA_VERSION = "aequitas.case-agent-private-fixtures.v1";
const MAX_PRIVATE_FIXTURE_SET_BYTES = 128 * 1024;
const ALLOWED_FIXTURE_KEYS = new Set([
  "name",
  "complainantLocale",
  "respondentLocale",
  "disputeDescription",
  "amountAtStakeCents",
  "complainantPosition",
  "respondentPosition",
  "complainantText",
  "respondentText",
  "expect",
  "expectedEscalationReason",
  "expectedModelCalls",
]);

type PrivateFixtureSetDocument = {
  schemaVersion: string;
  syntheticOnly: boolean;
  unpublished: boolean;
  fixtures: CaseAgentEvaluationFixture[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 8_000
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}

export function privateCaseAgentFixtureSetBlockers(value: unknown): string[] {
  if (!isRecord(value)) return ["The private fixture set must be a JSON object."];
  const blockers: string[] = [];
  const allowedDocumentKeys = new Set(["schemaVersion", "syntheticOnly", "unpublished", "fixtures"]);
  if (Object.keys(value).some((key) => !allowedDocumentKeys.has(key))) {
    blockers.push("The private fixture-set document contains an unsupported field.");
  }
  if (value.schemaVersion !== PRIVATE_CASE_AGENT_FIXTURE_SET_SCHEMA_VERSION) {
    blockers.push("The private fixture-set schema is unsupported.");
  }
  if (value.syntheticOnly !== true || value.unpublished !== true) {
    blockers.push("The private fixture set must attest to synthetic-only, unpublished cases.");
  }
  if (!Array.isArray(value.fixtures) || value.fixtures.length !== 7) {
    blockers.push("The private fixture set must contain exactly seven cases.");
    return blockers;
  }

  const names = new Set<string>();
  for (const [index, candidate] of value.fixtures.entries()) {
    const label = "Case " + String.fromCharCode(65 + index);
    if (!isRecord(candidate)) {
      blockers.push(label + " is malformed.");
      continue;
    }
    if (Object.keys(candidate).some((key) => !ALLOWED_FIXTURE_KEYS.has(key))) {
      blockers.push(label + " contains an unsupported field.");
    }
    if (typeof candidate.name !== "string" || !/^private-[a-g]$/.test(candidate.name) || names.has(candidate.name)) {
      blockers.push(label + " needs a unique opaque private-a through private-g fixture name.");
    } else {
      names.add(candidate.name);
    }
    if (candidate.complainantLocale !== "en-CA" && candidate.complainantLocale !== "fr-CA") {
      blockers.push(label + " has an unsupported complainant locale.");
    }
    if (candidate.respondentLocale !== "en-CA" && candidate.respondentLocale !== "fr-CA") {
      blockers.push(label + " has an unsupported respondent locale.");
    }
    for (const field of [
      "disputeDescription",
      "complainantPosition",
      "respondentPosition",
      "complainantText",
      "respondentText",
    ]) {
      if (!boundedText(candidate[field])) blockers.push(label + " has an empty, oversized, or malformed text field.");
    }
    if (!Number.isSafeInteger(candidate.amountAtStakeCents) || Number(candidate.amountAtStakeCents) < 0 || Number(candidate.amountAtStakeCents) > 10_000_000) {
      blockers.push(label + " has an invalid amount.");
    }
    if (candidate.expect !== "issued" && candidate.expect !== "escalated") {
      blockers.push(label + " has an invalid expected workflow disposition.");
    }
    if (candidate.expectedModelCalls !== 0 && candidate.expectedModelCalls !== 1) {
      blockers.push(label + " has an invalid expected provider-call count.");
    }
    const reason = candidate.expectedEscalationReason;
    if (candidate.expect === "issued") {
      if (reason !== undefined || candidate.expectedModelCalls !== 1) {
        blockers.push(label + " has inconsistent proposal expectations.");
      }
    } else if (reason === "legal_language_detected") {
      if (candidate.expectedModelCalls !== 0) blockers.push(label + " must not call a model for a legal-language handoff.");
    } else if (reason === "model_requested_review") {
      if (candidate.expectedModelCalls !== 1) blockers.push(label + " must record the model call required for a model-requested handoff.");
    } else {
      blockers.push(label + " must identify a supported expected handoff reason.");
    }
  }
  return [...new Set(blockers)];
}

/** Reject private benchmark expectations the configured deterministic workflow cannot exercise. */
export function privateCaseAgentFixturePolicyBlockers(
  fixtures: readonly CaseAgentEvaluationFixture[],
  maxAmountCents: number,
): string[] {
  const blockers: string[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const label = "Case " + String.fromCharCode(65 + index);
    if (fixture.amountAtStakeCents > maxAmountCents) {
      blockers.push(label + " exceeds the configured program amount limit.");
    }
    if (fixture.expectedEscalationReason === "legal_language_detected"
      && !hasExplicitLegalIssueMarker([
        fixture.disputeDescription,
        fixture.complainantPosition,
        fixture.respondentPosition,
        fixture.complainantText,
        fixture.respondentText,
      ])) {
      blockers.push(label + " expects a pre-model legal handoff but has no locally detectable legal marker.");
    }
  }
  return blockers;
}

function resolvePrivatePath(path: string): string {
  const absolute = resolve(path);
  return join(realpathSync(dirname(absolute)), basename(absolute));
}

/** Read a private synthetic fixture file without exposing its contents in errors or output. */
export function readPrivateCaseAgentFixtureSet(
  path: string,
  repositoryRoot = process.cwd(),
): { fixtures: CaseAgentEvaluationFixture[] | null; fixtureSetSha256: string | null; blockers: string[] } {
  if (!path.trim()) {
    return { fixtures: null, fixtureSetSha256: null, blockers: ["Provide a private fixture-set file path."] };
  }
  let absolutePath: string;
  try {
    absolutePath = resolvePrivatePath(path);
  } catch {
    return { fixtures: null, fixtureSetSha256: null, blockers: ["The private fixture-set file could not be safely located."] };
  }
  const relativePath = relative(repositoryRoot, absolutePath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(".." + sep) === false) {
    return { fixtures: null, fixtureSetSha256: null, blockers: ["The private fixture-set file must be stored outside the repository."] };
  }

  let fd: number | undefined;
  try {
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const mode = stat.mode & 0o777;
    const uidMatches = typeof process.getuid !== "function" || stat.uid === process.getuid();
    if (!stat.isFile() || stat.nlink !== 1 || !uidMatches || (mode & 0o077) !== 0 || (mode & 0o400) === 0 || (mode & 0o100) !== 0) {
      return { fixtures: null, fixtureSetSha256: null, blockers: ["The fixture-set file must be a regular file owned by this user with owner-only permissions (for example, mode 0600)."] };
    }
    if (stat.size < 2 || stat.size > MAX_PRIVATE_FIXTURE_SET_BYTES) {
      return { fixtures: null, fixtureSetSha256: null, blockers: ["The private fixture-set file is empty or exceeds the size limit."] };
    }
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(fd).toString("utf8")) as unknown;
    } catch {
      return { fixtures: null, fixtureSetSha256: null, blockers: ["The private fixture-set file is not valid JSON."] };
    }
    const blockers = privateCaseAgentFixtureSetBlockers(document);
    if (blockers.length > 0 || !isRecord(document) || !Array.isArray(document.fixtures)) {
      return { fixtures: null, fixtureSetSha256: null, blockers };
    }
    const fixtures = document.fixtures as CaseAgentEvaluationFixture[];
    return {
      fixtures,
      fixtureSetSha256: caseAgentEvaluationFixtureSetSha256(fixtures),
      blockers: [],
    };
  } catch {
    return { fixtures: null, fixtureSetSha256: null, blockers: ["The private fixture-set file could not be safely read."] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function privateFixtureSetDocument(fixtures: CaseAgentEvaluationFixture[]): PrivateFixtureSetDocument {
  return {
    schemaVersion: PRIVATE_CASE_AGENT_FIXTURE_SET_SCHEMA_VERSION,
    syntheticOnly: true,
    unpublished: true,
    fixtures,
  };
}

export type BlindPacketPolicy = {
  providerIdentity: string;
  maxAmountCents: number;
  allowedRemedies: readonly string[];
  intakeDays: number;
  responseDays: number;
  respondentMayWithdraw: boolean;
  consentOnlyResolution: boolean;
  processingNoticeEn: string;
  processingNoticeFr: string;
};

function quoteLines(value: string): string {
  return value.split(/\r?\n/).map((line) => "> " + line).join("\n");
}

/** Render reviewer inputs only; internal fixture names and expected answers never enter the packet. */
export function renderPrivateCaseAgentBlindPacket(
  fixtures: readonly CaseAgentEvaluationFixture[],
  policy: BlindPacketPolicy,
): string {
  const lines = [
    "# Independent pre-model review packet",
    "",
    "All cases in this packet are synthetic. Review these inputs before any model output is generated.",
    "This packet omits internal fixture names, expected dispositions, escalation reasons, and model-call counts.",
    "",
    "## Evaluation profile",
    "",
    "- Scope: Québec retail purchase complaints.",
    "- Provider and model: " + policy.providerIdentity + ".",
    "- Maximum amount: C$" + (policy.maxAmountCents / 100).toFixed(2) + ".",
    "- Allowed non-binding remedies: " + policy.allowedRemedies.join(", ") + ".",
    "- Intake period: " + policy.intakeDays + " day(s); response period: " + policy.responseDays + " day(s).",
    "- Respondent may withdraw: " + (policy.respondentMayWithdraw ? "yes" : "no") + ".",
    "- The synthetic profile allows resolution after both parties consent: " + (policy.consentOnlyResolution ? "yes" : "no") + ".",
    "- Do not decide disputed facts or answer legal questions for the parties; hand such cases to a person.",
    "- Each party may see only citations and evidence from their own submissions.",
    "",
    "### English processing notice",
    "",
    quoteLines(policy.processingNoticeEn),
    "",
    "### French processing notice",
    "",
    quoteLines(policy.processingNoticeFr),
    "",
    "## Cases",
    "",
  ];
  for (const [index, fixture] of fixtures.entries()) {
    lines.push(
      "### Case " + String.fromCharCode(65 + index),
      "",
      "- Complainant locale: " + fixture.complainantLocale,
      "- Respondent locale: " + fixture.respondentLocale,
      "- Amount at stake: C$" + (fixture.amountAtStakeCents / 100).toFixed(2),
      "- Dispute description:",
      "",
      quoteLines(fixture.disputeDescription),
      "",
      "- Complainant position:",
      "",
      quoteLines(fixture.complainantPosition),
      "",
      "- Respondent position:",
      "",
      quoteLines(fixture.respondentPosition),
      "",
      "- Complainant evidence text:",
      "",
      quoteLines(fixture.complainantText),
      "",
      "- Respondent evidence text:",
      "",
      quoteLines(fixture.respondentText),
      "",
    );
  }
  lines.push(
    "## Review record",
    "",
    "Record each independent assessment and date before viewing any model output. Do not infer missing facts.",
    "",
  );
  return lines.join("\n");
}
