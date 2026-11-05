import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linkClaimEvidence, recordClaim, recordSource } from "../../src/domain/claimWrites";
import { appendEvent } from "../../src/domain/events";
import { closeIntake, createCase, openIntake, submitCase, submitChronology, submitEvidence, submitPosition, supersedeEvidence } from "../../src/domain/mutate";
import { readPipeline } from "../../src/domain/pipeline/writes";
import { openContestation, respondToContestation } from "../../src/domain/resolution";
import { prisma } from "../../src/lib/prisma";
import { signPayload } from "../../src/lib/signedCookie";
import { SESSION_COOKIE } from "../../src/lib/session";
import { startNextDev, type DevServer } from "../helpers/nextDevServer";

/**
 * Neither party may see the other party's submissions. A submission is
 * that party's evidence (title, description, and file bytes), position,
 * and chronology. The assigned mediator, an approver, and an admin keep
 * the case read they already have. These requests are every read route
 * plus the case workspace.
 */

const PORT = 3461;
const A = {
  title: "A-TITLE-4c91aa only the complainant evidence",
  description: "A-DESC-4c91aa only the complainant description",
  bytes: "A-BYTES-4c91aa only the complainant file",
  position: "A-POSITION-4c91aa only the complainant position",
};
const B = {
  title: "B-TITLE-7e20bb only the respondent evidence",
  description: "B-DESC-7e20bb only the respondent description",
  bytes: "B-BYTES-7e20bb only the respondent file",
  position: "B-POSITION-7e20bb only the respondent position",
};
const SHORT = "Xy7k";
const SPACED = "b-title-7e20bb";
const PARTIAL = "B-POSITION-7e";
const PARAPHRASE = "PARAPHRASE-bb22";
const DRAFT_ONLY = "DRAFT-ONLY-9f3c";
const ISSUED = "ISSUED-SHARED-2a11";
const OWN_NOTE = "OWN-NOTE-aa11";
const HIDDEN_CLAIM = "HIDDEN-CLAIM-cc33";
const NOTE_REASON = "NOTE-PRIVATE-8c41";
const A_CHRONO = "A-CHRONO-4c91aa";
const A_CHRONO_DESC = "A-CHRONO-DESC own account";
const C2 = "C2-SECRET-91ab only case two";
const MIXED_CLAIM = "MIXED-CLAIM-dd44 both filings";
const OWN_FACTOR = "OWN-FACTOR-aa11 complainant context";
const OTHER_FACTOR = "OTHER-FACTOR-bb22 respondent context";
const SYNTH_MIXED = "SYNTH-MIXED-ee55 combined account";
const GROUNDS = "GROUNDS-gg88 complainant contest";
const OPEN_GROUNDS = "OPEN-GROUNDS-jj22 still open";
const RESPONSE = "RESPONSE-hh99 mediator reply";
const TRACE_OWN = "TRACE-OWN-aa77 complainant claim";
const TRACE_MIXED = "TRACE-MIXED-ff66 cites both";
const POSITION_CLAIM = "POSITION-CLAIM-cd34 complainant position";
const CHRONO_CLAIM = "CHRONO-CLAIM-ab12 respondent event";
const SYN_OWN = "SYN-OWN-11aa complainant sentence";
const SYN_OTHER = "SYN-OTHER-22bb respondent sentence";
const SYN_MIXED = "SYN-MIXED-33cc both sentences";
const SYN_UNMAP = "SYN-UNMAP-44dd no provenance";
const PROP_OWN = "PROP-OWN-55ee complainant proposal";
const PROP_OTHER = "PROP-OTHER-66ff respondent proposal";
const ASSUMPTION = "ASSUMPTION-77aa combined note";

let server: DevServer;
let base: string;
let complainantId: string;
let respondentId: string;
let managerId: string;
let adminId: string;
let approverId: string;
let caseId: string;
let complainantEvidenceId: string;
let respondentEvidenceId: string;
let replacedEvidenceId: string;
let caseTwoId: string;
let ownSourceId: string;
let otherSourceId: string;

function cookie(userId: string, globalRole: string) {
  return { Cookie: `${SESSION_COOKIE}=${signPayload({ purpose: "session", userId, globalRole, authMethod: "passkey" }, 3600)}` };
}

function readRoutes(evidenceId: string): Array<[string, string]> {
  return [
    ["workspace fr-CA", `/fr-CA/cases/${caseId}`],
    ["workspace en-CA", `/en-CA/cases/${caseId}`],
    ["case list fr-CA", `/fr-CA/cases`],
    ["case list en-CA", `/en-CA/cases`],
    ["case projection", `/api/cases/${caseId}`],
    ["events", `/api/cases/${caseId}/events`],
    ["chronology", `/api/cases/${caseId}/chronology`],
    ["claims", `/api/cases/${caseId}/claims`],
    ["knowledge map", `/api/cases/${caseId}/knowledge-map`],
    ["draft", `/api/cases/${caseId}/draft`],
    ["resolution", `/api/cases/${caseId}/resolution`],
    ["evidence file", `/api/cases/${caseId}/evidence/${evidenceId}`],
    ["export", `/api/cases/${caseId}/export`],
  ];
}

async function responseText(res: Response, path: string): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  if (path.endsWith("/export") && res.ok) {
    const file = `/tmp/party-isolation-export-${randomUUID()}.zip`;
    writeFileSync(file, buf);
    try {
      return execFileSync(
        "python3",
        [
          "-c",
          "import sys, zipfile\n"
            + "z = zipfile.ZipFile(sys.argv[1])\n"
            + "parts = []\n"
            + "for name in z.namelist():\n"
            + "    parts.append(name)\n"
            + "    parts.append(z.read(name).decode('utf-8', 'replace'))\n"
            + "sys.stdout.write('\\n'.join(parts))\n",
          file,
        ],
        { encoding: "utf8", maxBuffer: 20_000_000 },
      );
    } finally {
      unlinkSync(file);
    }
  }
  return buf.toString("utf8");
}

beforeAll(async () => {
  server = await startNextDev(PORT);
  base = server.baseUrl;
  const stamp = randomUUID();
  const [complainant, respondent, manager, admin, approver, statement] = await Promise.all([
    prisma.user.create({ data: { email: `iso-c-${stamp}@example.com`, displayName: "Isolation complainant", globalRole: "COMPLAINANT", locale: "fr-CA" } }),
    prisma.user.create({ data: { email: `iso-r-${stamp}@example.com`, displayName: "Isolation respondent", globalRole: "RESPONDENT", locale: "en-CA" } }),
    prisma.user.create({ data: { email: `iso-m-${stamp}@example.com`, displayName: "Isolation manager", globalRole: "CASE_MANAGER", locale: "fr-CA" } }),
    prisma.user.create({ data: { email: `iso-a-${stamp}@example.com`, displayName: "Isolation admin", globalRole: "ADMIN", locale: "fr-CA" } }),
    prisma.user.create({ data: { email: `iso-p-${stamp}@example.com`, displayName: "Isolation approver", globalRole: "CASE_MANAGER", locale: "fr-CA", isApprover: true } }),
    prisma.consentStatementVersion.create({
      data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale: "fr-CA", body: "Isolation test.", effectiveFrom: new Date() },
    }),
  ]);
  complainantId = complainant.id;
  respondentId = respondent.id;
  managerId = manager.id;
  adminId = admin.id;
  approverId = approver.id;

  const created = await createCase({
    actorId: complainantId,
    actorRole: "COMPLAINANT",
    referenceNumber: `AE-ISO-${stamp.slice(0, 8)}`,
    complainantId,
    respondentId,
    simulated: true,
    disputeDescription: "A shared case description that is not a submission.",
    requestedStatementVersionId: statement.id,
    currentStatementVersionId: statement.id,
  });
  if (!created.ok) throw new Error(`setup createCase: ${created.reason}`);
  caseId = created.data.caseId;
  if (!(await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId })).ok) throw new Error("setup submitCase");
  if (!(await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId, hasConflict: false })).ok) throw new Error("setup openIntake");

  const complainantEvidence = await submitEvidence({
    actorId: complainantId,
    actorRole: "COMPLAINANT",
    caseId,
    kind: "DOCUMENT",
    title: A.title,
    description: A.description,
    buffer: Buffer.from(A.bytes),
    mimeType: "text/plain",
  });
  if (!complainantEvidence.ok) throw new Error(`setup complainant evidence: ${complainantEvidence.reason}`);
  const respondentEvidence = await submitEvidence({
    actorId: respondentId,
    actorRole: "RESPONDENT",
    caseId,
    kind: "DOCUMENT",
    title: B.title,
    description: B.description,
    buffer: Buffer.from(B.bytes),
    mimeType: "text/plain",
  });
  if (!respondentEvidence.ok) throw new Error(`setup respondent evidence: ${respondentEvidence.reason}`);
  complainantEvidenceId = (await prisma.evidenceItem.findFirstOrThrow({ where: { caseId, submittedById: complainantId } })).id;
  respondentEvidenceId = (await prisma.evidenceItem.findFirstOrThrow({ where: { caseId, submittedById: respondentId, supersedesId: null } })).id;
  const replaced = await supersedeEvidence({
    actorId: respondentId,
    actorRole: "RESPONDENT",
    caseId,
    priorEvidenceItemId: respondentEvidenceId,
    kind: "DOCUMENT",
    title: SHORT,
    description: `${SPACED}   only the retitled file`,
    buffer: Buffer.from("B-BYTES-NEW-7e20bb replacement file"),
    mimeType: "text/plain",
  });
  if (!replaced.ok) throw new Error(`setup supersede: ${replaced.reason}`);
  replacedEvidenceId = (await prisma.evidenceItem.findFirstOrThrow({ where: { caseId, supersedesId: respondentEvidenceId } })).id;

  const complainantChronology = await submitChronology({
    actorId: complainantId, actorRole: "COMPLAINANT", caseId,
    occurredOn: "2026-01-02", title: A_CHRONO, description: A_CHRONO_DESC, locale: "fr-CA",
  });
  if (!complainantChronology.ok) throw new Error(`setup complainant chronology: ${complainantChronology.reason}`);
  const respondentChronology = await submitChronology({
    actorId: respondentId, actorRole: "RESPONDENT", caseId,
    occurredOn: "2026-01-03", title: SHORT, description: `${PARTIAL} quoted from the reply, then ${SPACED}`, locale: "en-CA",
  });
  if (!respondentChronology.ok) throw new Error(`setup respondent chronology: ${respondentChronology.reason}`);
  const respondentChronologyId = (await prisma.chronologyEntry.findFirstOrThrow({ where: { caseId, submittedById: respondentId } })).id;

  if (!(await closeIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId })).ok) throw new Error("setup closeIntake");
  const complainantPosition = await submitPosition({
    actorId: complainantId, actorRole: "COMPLAINANT", caseId, body: A.position, locale: "fr-CA",
  });
  if (!complainantPosition.ok) throw new Error(`setup complainant position: ${complainantPosition.reason}`);
  const respondentPosition = await submitPosition({
    actorId: respondentId, actorRole: "RESPONDENT", caseId, body: B.position, locale: "en-CA",
  });
  if (!respondentPosition.ok) throw new Error(`setup respondent position: ${respondentPosition.reason}`);

  const actor = { caseId, actorId: managerId, actorRole: "CASE_MANAGER" as const };
  const source = await recordSource({
    ...actor,
    kind: "EVIDENCE_ITEM",
    title: B.title,
    evidenceItemId: respondentEvidenceId,
  });
  if (!source.ok) throw new Error(`setup source: ${source.reason}`);
  otherSourceId = source.data.id;
  const ownSource = await recordSource({
    ...actor,
    kind: "EVIDENCE_ITEM",
    title: A.title,
    evidenceItemId: complainantEvidenceId,
  });
  if (!ownSource.ok) throw new Error(`setup own source: ${ownSource.reason}`);
  ownSourceId = ownSource.data.id;
  const claim = await recordClaim({
    ...actor,
    claimType: "FACTUAL",
    text: "The respondent's file is quoted below.",
    confidence: "PROBABLE",
    confidenceRationale: "Quoted from one party's evidence.",
    locale: "en-CA",
  });
  if (!claim.ok) throw new Error(`setup claim: ${claim.reason}`);
  const link = await linkClaimEvidence({
    ...actor,
    claimId: claim.data.id,
    sourceId: otherSourceId,
    predicate: "ORIGINATES_FROM",
    excerpt: PARTIAL,
  });
  if (!link.ok) throw new Error(`setup link: ${link.reason}`);
  const ownTrace = await recordClaim({
    ...actor,
    claimType: "FACTUAL",
    text: TRACE_OWN,
    confidence: "PROBABLE",
    confidenceRationale: "Quoted from the complainant's evidence.",
    locale: "en-CA",
  });
  if (!ownTrace.ok) throw new Error(`setup own trace: ${ownTrace.reason}`);
  if (!(await linkClaimEvidence({ ...actor, claimId: ownTrace.data.id, sourceId: ownSourceId, predicate: "ORIGINATES_FROM", excerpt: OWN_NOTE })).ok) {
    throw new Error("setup own trace link");
  }
  const mixedTrace = await recordClaim({
    ...actor,
    claimType: "FACTUAL",
    text: TRACE_MIXED,
    confidence: "UNKNOWN",
    confidenceRationale: "The two filings are both cited.",
    locale: "en-CA",
  });
  if (!mixedTrace.ok) throw new Error(`setup mixed trace: ${mixedTrace.reason}`);
  if (!(await linkClaimEvidence({ ...actor, claimId: mixedTrace.data.id, sourceId: ownSourceId, predicate: "ORIGINATES_FROM", excerpt: OWN_NOTE })).ok) {
    throw new Error("setup mixed trace own link");
  }
  if (!(await linkClaimEvidence({ ...actor, claimId: mixedTrace.data.id, sourceId: otherSourceId, predicate: "ORIGINATES_FROM", excerpt: PARTIAL })).ok) {
    throw new Error("setup mixed trace other link");
  }
  await prisma.pipelineProposal.create({
    data: {
      caseId, kind: "CLAIM", status: "PROPOSED", modelId: "test", promptVersion: "test",
      payload: { text: "A mediator note that does not quote a party.", excerpt: PARTIAL },
    },
  });
  await prisma.pipelineProposal.create({
    data: {
      caseId, kind: "CLAIM", status: "PROPOSED", modelId: "test", promptVersion: "test",
      payload: { text: PROP_OWN, excerpt: OWN_NOTE, sourceId: ownSourceId },
    },
  });
  await prisma.pipelineProposal.create({
    data: {
      caseId, kind: "CLAIM", status: "PROPOSED", modelId: "test", promptVersion: "test",
      payload: { text: PROP_OTHER, excerpt: PARTIAL, sourceId: otherSourceId },
    },
  });
  await prisma.pipelineProposal.create({
    data: {
      caseId, kind: "CONTEXT_FACTOR", status: "PROPOSED", modelId: "test", promptVersion: "test",
      payload: { description: OTHER_FACTOR, evidenceId: respondentEvidenceId },
    },
  });
  await prisma.assumption.create({
    data: { caseId, text: ASSUMPTION, origin: "ANALYST_NOTE", status: "PROPOSED", createdById: managerId },
  });
  await prisma.synthesisVersion.create({
    data: {
      caseId,
      version: 1,
      createdById: managerId,
      diagE: "disputed_present",
      diagP: "positionality_gap",
      diagC: "third_factor_missing",
      sections: {
        established: [
          { id: "s-own", text: SYN_OWN },
          { id: "s-other", text: SYN_OTHER },
          { id: "s-mixed", text: SYN_MIXED },
          { id: "s-unmap", text: SYN_UNMAP },
        ],
        disputed: [],
        unknown: [],
        actionable: [],
        reviewable: [],
      },
      sentenceMap: [
        { sentenceId: "s-own", claimIds: [], sourceIds: [ownSourceId] },
        { sentenceId: "s-other", claimIds: [], sourceIds: [otherSourceId] },
        { sentenceId: "s-mixed", claimIds: [], sourceIds: [ownSourceId, otherSourceId] },
      ],
    },
  });

  const complainantPositionId = (await prisma.positionStatement.findFirstOrThrow({ where: { caseId, partyId: complainantId } })).id;
  const sharedExplanation = {
    evidence_citations: [
      { evidence_item_id: complainantEvidenceId, relevance: `${OWN_NOTE} complainant document` },
      { evidence_item_id: respondentEvidenceId, relevance: `${PARAPHRASE} the billed reply` },
      { evidence_item_id: replacedEvidenceId, relevance: `${SPACED} spaced title note` },
    ],
    proposed_outcome: "A shared outcome the parties are asked to consider.",
    reasoning: "The issued reasoning does not repeat either party's words.",
    limits: ["This does not verify documents outside the case."],
    not_considered: ["Messages outside this case were not considered."],
    model: { id: "test-model", prompt_version: "isolation" },
    reviewer: { user_id: null, issued_at: null },
    knowledge_sources: [
      { id: "src-own", kind: "evidence_metadata", record_id: complainantEvidenceId, version: 1, locale: "fr-CA", submitted_by_role: "complainant", created_at: null, sha256: null, fields: { title: OWN_NOTE } },
      { id: "src-other", kind: "evidence_content", record_id: respondentEvidenceId, version: 1, locale: "en-CA", submitted_by_role: "respondent", created_at: null, sha256: null, fields: { content: `${PARAPHRASE} ${PARTIAL} ${SPACED}` } },
      { id: "src-chrono", kind: "chronology", record_id: respondentChronologyId, version: 1, locale: "en-CA", submitted_by_role: "respondent", created_at: null, sha256: null, fields: { description: `${PARTIAL} quoted from the reply, then ${SPACED}` } },
      { id: "src-pos", kind: "position", record_id: complainantPositionId, version: 1, locale: "fr-CA", submitted_by_role: "complainant", created_at: null, sha256: null, fields: { body: A.position } },
    ],
    conflict_knowledge: {
      method_version: "aequitas-core-v1",
      claims: [
        { id: "c-own", statement: "The complainant reported their own document.", type: "factual", assessment: "reported", citations: [{ source_id: "src-own", field: "title", excerpt: OWN_NOTE }], rationale: "The note cites the complainant's evidence.", revision_conditions: "The party can clarify." },
        { id: "c-hidden", statement: HIDDEN_CLAIM, type: "factual", assessment: "reported", citations: [{ source_id: "src-other", field: "content", excerpt: PARAPHRASE }], rationale: "The note cites the other file.", revision_conditions: "The party can clarify." },
        { id: "c-mixed", statement: MIXED_CLAIM, type: "factual", assessment: "unresolved", citations: [{ source_id: "src-own", field: "title", excerpt: OWN_NOTE }, { source_id: "src-other", field: "content", excerpt: PARAPHRASE }], rationale: "Both filings are cited.", revision_conditions: "Each party can clarify their own filing." },
        { id: "c-pos", statement: POSITION_CLAIM, type: "factual", assessment: "reported", citations: [{ source_id: "src-pos", field: "body", excerpt: A.position }], rationale: "The note cites the complainant's position.", revision_conditions: "The party can clarify." },
        { id: "c-chrono", statement: CHRONO_CLAIM, type: "factual", assessment: "reported", citations: [{ source_id: "src-chrono", field: "description", excerpt: PARTIAL }], rationale: "The note cites the respondent's event.", revision_conditions: "The party can clarify." },
      ],
      narratives: [
        { id: "n1", interpretation: "One account is the complainant's.", claim_ids: ["c-own"], standpoint: "Complainant.", assumptions: ["The document is theirs."] },
        { id: "n2", interpretation: "The other account is separate.", claim_ids: ["c-hidden"], standpoint: "Respondent.", assumptions: ["The reply is theirs."] },
      ],
      contexts: [
        { id: "ctx1", factor: "The records were filed separately.", layer: "relational", status: "hypothesis", claim_ids: ["c-own"], citations: [], power_and_positionality: "Each party holds their own file.", alternative_explanation: "The files may describe one event.", question_to_test: "Which file belongs to which party?" },
        { id: "ctx-own", factor: OWN_FACTOR, layer: "relational", status: "hypothesis", claim_ids: ["c-own"], citations: [{ source_id: "src-own", field: "title", excerpt: OWN_NOTE }], power_and_positionality: "", alternative_explanation: "", question_to_test: "" },
        { id: "ctx-other", factor: OTHER_FACTOR, layer: "relational", status: "hypothesis", claim_ids: ["c-hidden"], citations: [{ source_id: "src-other", field: "content", excerpt: PARAPHRASE }], power_and_positionality: "", alternative_explanation: "", question_to_test: "" },
      ],
      experiences: [],
      relationships: [],
      triangulation: { source_groups: [{ source_ids: ["src-own"], independence: "unknown", rationale: "Origin was not rechecked." }], data: "Party filings.", investigators: "None.", theories: "Separate filings.", methods: "Filings only.", missing_evidence: ["Nothing further."] },
      synthesis: { supported_claim_ids: [], disputed_claim_ids: ["c-own"], unresolved_questions: ["Which filing is which?"], conditional_account: SYNTH_MIXED, revision_conditions: "Review if a party adds a filing." },
      repair_paths: [{ id: "r1", action: "Ask each party about their own filing.", addresses_ids: ["c-own"], prerequisites: ["The party agrees."], consent_and_safety: "No compelled disclosure.", accountable_role: "Assigned case manager.", review_conditions: "Revisit on request." }],
    },
  };
  const draft = await prisma.recommendation.create({
    data: {
      caseId, version: 1, status: "DRAFT", modelId: "test-model", promptVersion: "isolation",
      explanation: { ...sharedExplanation, summary: DRAFT_ONLY } as unknown as import("../../src/generated/prisma").Prisma.InputJsonValue,
    },
  });
  const issued = await prisma.recommendation.create({
    data: {
      caseId, version: 2, status: "ISSUED", modelId: "test-model", promptVersion: "isolation",
      explanation: { ...sharedExplanation, summary: ISSUED } as unknown as import("../../src/generated/prisma").Prisma.InputJsonValue,
    },
  });
  await prisma.case.update({ where: { id: caseId }, data: { currentRecommendationId: issued.id } });
  await prisma.$transaction(async (tx) => {
    await appendEvent(tx, { caseId, actorId: managerId, type: "RECOMMENDATION_DRAFTED", payload: { recommendationId: draft.id, version: 1 } });
    await appendEvent(tx, { caseId, actorId: managerId, type: "NOTE_ADDED", payload: { kind: "case_note", reason: NOTE_REASON } });
  });
  const contest = await openContestation({
    actorId: complainantId, actorRole: "COMPLAINANT", caseId,
    targetType: "RECOMMENDATION", targetId: issued.id, grounds: GROUNDS,
  });
  if (!contest.ok) throw new Error(`setup contestation: ${contest.reason}`);
  const replied = await respondToContestation({
    actorId: managerId, actorRole: "CASE_MANAGER", caseId,
    contestationId: contest.data.id, response: RESPONSE,
  });
  if (!replied.ok) throw new Error(`setup contestation response: ${replied.reason}`);
  const stillOpen = await openContestation({
    actorId: complainantId, actorRole: "COMPLAINANT", caseId,
    targetType: "RECOMMENDATION", targetId: issued.id, grounds: OPEN_GROUNDS,
  });
  if (!stillOpen.ok) throw new Error(`setup open contestation: ${stillOpen.reason}`);

  const caseTwoRespondent = await prisma.user.create({
    data: { email: `iso-r2-${stamp}@example.com`, displayName: "Isolation second respondent", globalRole: "RESPONDENT", locale: "fr-CA" },
  });
  const second = await createCase({
    actorId: complainantId, actorRole: "COMPLAINANT", referenceNumber: `AE-ISO2-${stamp.slice(0, 8)}`,
    complainantId, respondentId: caseTwoRespondent.id, simulated: true,
    disputeDescription: "A second case description that is not a submission.",
    requestedStatementVersionId: statement.id, currentStatementVersionId: statement.id,
  });
  if (!second.ok) throw new Error(`setup second case: ${second.reason}`);
  caseTwoId = second.data.caseId;
  if (!(await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId: caseTwoId })).ok) throw new Error("setup second submit");
  if (!(await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId: caseTwoId, hasConflict: false })).ok) throw new Error("setup second intake");
  const secondEvidence = await submitEvidence({
    actorId: caseTwoRespondent.id, actorRole: "RESPONDENT", caseId: caseTwoId, kind: "DOCUMENT",
    title: C2, description: "C2-DESC only case two", buffer: Buffer.from("C2-BYTES only case two"), mimeType: "text/plain",
  });
  if (!secondEvidence.ok) throw new Error(`setup second evidence: ${secondEvidence.reason}`);

  const generated = await fetch(`${base}/api/cases/${caseId}/export`, { headers: cookie(managerId, "CASE_MANAGER") });
  if (!generated.ok) throw new Error(`setup export: ${generated.status} ${await generated.text()}`);
  await prisma.case.update({ where: { id: caseId }, data: { state: "CLOSED" } });
}, 240_000);

afterAll(async () => {
  await server?.stop();
  await prisma.$disconnect();
});

describe("party isolation over HTTP", () => {
  async function leaks(userId: string, role: string, evidenceId: string, secrets: string[]) {
    const found: string[] = [];
    for (const [label, path] of readRoutes(evidenceId)) {
      const res = await fetch(`${base}${path}`, { headers: cookie(userId, role) });
      const text = await responseText(res, path);
      for (const secret of secrets) {
        if (text.includes(secret)) found.push(`${label} ${path} (${res.status}) contains ${secret}`);
      }
    }
    return found;
  }

  it("the complainant cannot read the respondent's evidence, position, or chronology on any route", async () => {
    const otherFile = await fetch(`${base}/api/cases/${caseId}/evidence/${respondentEvidenceId}`, { headers: cookie(complainantId, "COMPLAINANT") });
    const replacedFile = await fetch(`${base}/api/cases/${caseId}/evidence/${replacedEvidenceId}`, { headers: cookie(complainantId, "COMPLAINANT") });
    expect(otherFile.status).toBe(404);
    expect(replacedFile.status).toBe(404);
    expect(await leaks(complainantId, "COMPLAINANT", respondentEvidenceId, [
      B.title, B.description, B.bytes, B.position, SHORT, SPACED, PARTIAL, PARAPHRASE, DRAFT_ONLY, HIDDEN_CLAIM, NOTE_REASON,
      MIXED_CLAIM, OTHER_FACTOR, SYNTH_MIXED, TRACE_MIXED, CHRONO_CLAIM, PROP_OTHER, SYN_OTHER, SYN_MIXED, SYN_UNMAP, ASSUMPTION,
    ])).toEqual([]);
    const events = await (await fetch(`${base}/api/cases/${caseId}/events`, { headers: cookie(complainantId, "COMPLAINANT") })).text();
    expect(events).not.toContain("NOTE_ADDED");
    expect(events).not.toContain("RECOMMENDATION_DRAFTED");
  }, 60_000);

  it("the respondent cannot read the complainant's evidence, position, or chronology on any route", async () => {
    const otherFile = await fetch(`${base}/api/cases/${caseId}/evidence/${complainantEvidenceId}`, { headers: cookie(respondentId, "RESPONDENT") });
    expect(otherFile.status).toBe(404);
    expect(await leaks(respondentId, "RESPONDENT", complainantEvidenceId, [
      A.title, A.description, A.bytes, A.position, A_CHRONO, A_CHRONO_DESC, OWN_NOTE, DRAFT_ONLY, NOTE_REASON,
      ISSUED, MIXED_CLAIM, OWN_FACTOR, SYNTH_MIXED, TRACE_OWN, TRACE_MIXED, POSITION_CLAIM, GROUNDS, OPEN_GROUNDS, RESPONSE,
      PROP_OWN, SYN_OWN, SYN_MIXED, SYN_UNMAP, ASSUMPTION,
    ])).toEqual([]);
    const respondentPage = await (await fetch(`${base}/fr-CA/cases/${caseId}`, { headers: cookie(respondentId, "RESPONDENT") })).text();
    expect(respondentPage).toContain(HIDDEN_CLAIM);
    expect(respondentPage).toContain(OTHER_FACTOR);
    expect(respondentPage).toContain(CHRONO_CLAIM);
    expect(respondentPage).not.toContain(ISSUED);
    expect(respondentPage).not.toContain(GROUNDS);
    expect(respondentPage).not.toContain(RESPONSE);
  }, 60_000);

  it("hides the other party's contestation from the activity feed and from that party's blockers", async () => {
    const respondentEvents = await (await fetch(`${base}/api/cases/${caseId}/events`, { headers: cookie(respondentId, "RESPONDENT") })).json() as { type: string; actorId: string; createdAt: string }[];
    expect(respondentEvents.some((event) => event.type.startsWith("CONTESTATION_"))).toBe(false);
    const complainantEvents = await (await fetch(`${base}/api/cases/${caseId}/events`, { headers: cookie(complainantId, "COMPLAINANT") })).json() as { type: string; actorId: string; createdAt: string }[];
    const opened = complainantEvents.find((event) => event.type === "CONTESTATION_OPENED");
    const answered = complainantEvents.find((event) => event.type === "CONTESTATION_RESPONDED");
    expect(opened?.actorId).toBe(complainantId);
    expect(answered?.actorId).toBe(managerId);
    const respondentFeed = JSON.stringify(respondentEvents);
    expect(respondentFeed).not.toContain(opened?.createdAt);
    expect(respondentFeed).not.toContain(answered?.createdAt);

    for (const locale of ["fr-CA", "en-CA"]) {
      const html = (await (await fetch(`${base}/${locale}/cases/${caseId}`, { headers: cookie(respondentId, "RESPONDENT") })).text()).replace(/<script[\s\S]*?<\/script>/gi, "");
      expect(html).not.toContain("Contestation opened");
      expect(html).not.toContain("Contestation answered");
      expect(html).not.toContain("Contestation ouverte");
      expect(html).not.toContain("Réponse à une contestation");
    }
    const complainantHtml = (await (await fetch(`${base}/fr-CA/cases/${caseId}`, { headers: cookie(complainantId, "COMPLAINANT") })).text()).replace(/<script[\s\S]*?<\/script>/gi, "");
    expect(complainantHtml).toContain("Contestation ouverte");

    const respondentResolution = await (await fetch(`${base}/api/cases/${caseId}/resolution`, { headers: cookie(respondentId, "RESPONDENT") })).json() as { blockers: string[] };
    const complainantResolution = await (await fetch(`${base}/api/cases/${caseId}/resolution`, { headers: cookie(complainantId, "COMPLAINANT") })).json() as { blockers: string[] };
    expect(respondentResolution.blockers).toContain("RESOLUTION_PAUSED");
    expect(respondentResolution.blockers).not.toContain("OPEN_CONTESTATION");
    expect(complainantResolution.blockers).toContain("OPEN_CONTESTATION");
    expect(complainantResolution.blockers).not.toContain("RESOLUTION_PAUSED");
    const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, "").replaceAll("&#x27;", "'").replaceAll("&#39;", "'");
    const respondentFr = visible(await (await fetch(`${base}/fr-CA/cases/${caseId}`, { headers: cookie(respondentId, "RESPONDENT") })).text());
    const respondentEn = visible(await (await fetch(`${base}/en-CA/cases/${caseId}`, { headers: cookie(respondentId, "RESPONDENT") })).text());
    expect(respondentFr).toContain("Règlement suspendu en attendant l'examen.");
    expect(respondentFr).not.toContain("Une contestation est encore ouverte");
    expect(respondentEn).toContain("Resolution paused pending review");
    expect(respondentEn).not.toContain("A contestation is still open");
    for (const [userId, role] of [[managerId, "CASE_MANAGER"], [approverId, "CASE_MANAGER"], [adminId, "ADMIN"]] as const) {
      const view = await (await fetch(`${base}/api/cases/${caseId}/resolution`, { headers: cookie(userId, role) })).json() as { blockers: string[] };
      expect(view.blockers, role).toContain("OPEN_CONTESTATION");
    }
    for (const [userId, role] of [[managerId, "CASE_MANAGER"], [adminId, "ADMIN"]] as const) {
      const feed = await (await fetch(`${base}/api/cases/${caseId}/events`, { headers: cookie(userId, role) })).json() as { type: string }[];
      expect(feed.map((event) => event.type), role).toEqual(expect.arrayContaining(["CONTESTATION_OPENED", "CONTESTATION_RESPONDED"]));
    }
    const approverHtml = (await (await fetch(`${base}/fr-CA/cases/${caseId}`, { headers: cookie(approverId, "CASE_MANAGER") })).text()).replace(/<script[\s\S]*?<\/script>/gi, "");
    expect(approverHtml).toContain("Contestation ouverte");
  }, 60_000);

  it("each party still receives their own evidence and position", async () => {
    const page = await fetch(`${base}/fr-CA/cases/${caseId}`, { headers: cookie(complainantId, "COMPLAINANT") });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain(A.title);
    expect(html).toContain(A.position);
    expect(html).toContain(A_CHRONO);
    expect(html).toContain(OWN_NOTE);
    expect(html).toContain(OWN_FACTOR);
    expect(html).toContain(POSITION_CLAIM);
    expect(html).toContain(TRACE_OWN);
    expect(html).toContain(GROUNDS);
    expect(html).toContain(OPEN_GROUNDS);
    expect(html).toContain(RESPONSE);
    expect(html).not.toContain(ISSUED);
    expect(html).not.toContain(MIXED_CLAIM);
    expect(html).not.toContain(SYNTH_MIXED);
    expect(html).not.toContain(B.title);
    expect(html).not.toContain(B.position);
    expect(html).not.toContain(SHORT);
    expect(html).not.toContain(PARAPHRASE);
    expect(html).not.toContain(DRAFT_ONLY);

    const file = await fetch(`${base}/api/cases/${caseId}/evidence/${complainantEvidenceId}`, { headers: cookie(complainantId, "COMPLAINANT") });
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(A.bytes);

    const exported = await fetch(`${base}/api/cases/${caseId}/export`, { headers: cookie(complainantId, "COMPLAINANT") });
    expect(exported.status).toBe(200);
    const archive = await responseText(exported, `/api/cases/${caseId}/export`);
    expect(archive).toContain(A.title);
    expect(archive).toContain(A.description);
    expect(archive).toContain(A.position);
    expect(archive).toContain(A_CHRONO);
    expect(archive).toContain(OWN_NOTE);
    expect(archive).toContain(OWN_FACTOR);
    expect(archive).toContain(POSITION_CLAIM);
    expect(archive).toContain(GROUNDS);
    expect(archive).toContain(OPEN_GROUNDS);
    expect(archive).toContain(RESPONSE);
    expect(archive).not.toContain(ISSUED);
    expect(archive).not.toContain(MIXED_CLAIM);
    expect(archive).not.toContain(SYNTH_MIXED);
    expect(archive).not.toContain(B.title);
    expect(archive).not.toContain(B.position);
    expect(archive).not.toContain(B.description);
    expect(archive).not.toContain(SHORT);
    expect(archive).not.toContain(PARTIAL);
    expect(archive).not.toContain(PARAPHRASE);
    expect(archive).not.toContain(SPACED);
    expect(archive).not.toContain(DRAFT_ONLY);
    expect(archive).not.toContain(HIDDEN_CLAIM);
    expect(archive).not.toContain(OTHER_FACTOR);
    expect(archive).not.toContain(CHRONO_CLAIM);
    expect(archive).not.toContain(TRACE_MIXED);
    expect(archive).not.toContain(NOTE_REASON);
    expect(archive).not.toContain("NOTE_ADDED");
    expect(archive).not.toContain("RECOMMENDATION_DRAFTED");
    expect(archive).not.toContain(respondentEvidenceId);
    expect(archive).not.toContain(replacedEvidenceId);
    expect(exported.headers.get("x-export-sha256")).toBeNull();
  }, 60_000);

  it("the assigned mediator, an approver, and an admin still see both submissions", async () => {
    for (const [userId, role] of [
      [managerId, "CASE_MANAGER"],
      [approverId, "CASE_MANAGER"],
      [adminId, "ADMIN"],
    ] as const) {
      const page = await fetch(`${base}/fr-CA/cases/${caseId}`, { headers: cookie(userId, role) });
      expect(page.status, role).toBe(200);
      const html = await page.text();
      expect(html, role).toContain(A.title);
      expect(html, role).toContain(B.title);
      expect(html, role).toContain(SHORT);
      expect(html, role).toContain(A.position);
      expect(html, role).toContain(B.position);
      expect(html, role).toContain(A_CHRONO);
      expect(html, role).toContain(PARTIAL);
      expect(html, role).toContain(ISSUED);
      expect(html, role).toContain(MIXED_CLAIM);
      expect(html, role).toContain(SYNTH_MIXED);
      expect(html, role).toContain(OWN_FACTOR);
      expect(html, role).toContain(OTHER_FACTOR);
      expect(html, role).toContain(GROUNDS);
      expect(html, role).toContain(OPEN_GROUNDS);
      expect(html, role).toContain(RESPONSE);
      expect(html, role).toContain(TRACE_OWN);
      expect(html, role).toContain(TRACE_MIXED);
    }

    for (const evidenceId of [complainantEvidenceId, respondentEvidenceId]) {
      const managerFile = await fetch(`${base}/api/cases/${caseId}/evidence/${evidenceId}`, { headers: cookie(managerId, "CASE_MANAGER") });
      expect(managerFile.status).toBe(200);
      // Admins and approvers could not download the file bytes before this change.
      expect((await fetch(`${base}/api/cases/${caseId}/evidence/${evidenceId}`, { headers: cookie(adminId, "ADMIN") })).status).toBe(404);
      expect((await fetch(`${base}/api/cases/${caseId}/evidence/${evidenceId}`, { headers: cookie(approverId, "CASE_MANAGER") })).status).toBe(404);
    }

    const managerExport = await responseText(
      await fetch(`${base}/api/cases/${caseId}/export`, { headers: cookie(managerId, "CASE_MANAGER") }),
      `/api/cases/${caseId}/export`,
    );
    expect(managerExport).toContain(A.position);
    expect(managerExport).toContain(B.position);
    expect(managerExport).toContain(A.description);
    expect(managerExport).toContain(B.description);
    expect(managerExport).toContain(A_CHRONO);
    expect(managerExport).toContain(SHORT);
    expect(managerExport).toContain(DRAFT_ONLY);
    expect(managerExport).toContain(ISSUED);
    expect(managerExport).toContain(MIXED_CLAIM);
    expect(managerExport).toContain(SYNTH_MIXED);
    expect(managerExport).toContain(GROUNDS);
    expect(managerExport).toContain(OPEN_GROUNDS);
    expect(managerExport).toContain(RESPONSE);
    expect(managerExport).toContain(PARAPHRASE);
    expect(managerExport).toContain(NOTE_REASON);
    expect(managerExport).toContain("NOTE_ADDED");
    expect(managerExport).toContain("RECOMMENDATION_DRAFTED");
  }, 60_000);

  it("keeps a party on two cases, a replacement, the list, and search on their own side", async () => {
    const complainantList = await fetch(`${base}/fr-CA/cases?q=${encodeURIComponent(B.title)}`, { headers: cookie(complainantId, "COMPLAINANT") });
    expect(complainantList.headers.get("cache-control") ?? "").not.toMatch(/public|s-maxage/);
    const listHtml = (await complainantList.text()).replace(/<script[\s\S]*?<\/script>/gi, "");
    for (const secret of [A.title, B.title, SHORT, C2, A.position, B.position]) expect(listHtml).not.toContain(secret);

    const caseOne = await (await fetch(`${base}/fr-CA/cases/${caseId}`, { headers: cookie(complainantId, "COMPLAINANT") })).text();
    const caseTwo = await (await fetch(`${base}/fr-CA/cases/${caseTwoId}`, { headers: cookie(complainantId, "COMPLAINANT") })).text();
    expect(caseOne).not.toContain(C2);
    expect(caseTwo).not.toContain(B.title);
    expect(caseTwo).not.toContain(A.title);
    expect(caseTwo).not.toContain(PARTIAL);
    expect((await fetch(`${base}/fr-CA/cases/${caseTwoId}`, { headers: cookie(respondentId, "RESPONDENT") })).status).toBe(404);

    const managerPage = await (await fetch(`${base}/fr-CA/cases/${caseId}`, { headers: cookie(managerId, "CASE_MANAGER") })).text();
    expect(managerPage).toContain(B.title);
    expect(managerPage).toContain(SHORT);
  }, 60_000);

  it("sends private no-store responses that differ between the two parties", async () => {
    const paths = [
      `/fr-CA/cases/${caseId}`,
      `/en-CA/cases/${caseId}`,
      `/fr-CA/cases`,
      `/api/cases/${caseId}`,
      `/api/cases/${caseId}/evidence/${complainantEvidenceId}`,
      `/api/cases/${caseId}/export`,
      `/api/cases/${caseId}/chronology`,
      `/api/cases/${caseId}/claims`,
      `/api/cases/${caseId}/events`,
    ];
    const pages: string[] = [];
    for (const [userId, role] of [[complainantId, "COMPLAINANT"], [respondentId, "RESPONDENT"]] as const) {
      for (const path of paths) {
        const res = await fetch(`${base}${path}`, { headers: cookie(userId, role) });
        const cache = res.headers.get("cache-control") ?? "";
        expect(cache, `${role} ${path}`).not.toMatch(/public|s-maxage/);
        if (path.startsWith("/api/")) expect(cache, `${role} ${path}`).toBe("private, no-store");
        if (path === `/fr-CA/cases/${caseId}`) pages.push(await res.text());
        else await res.arrayBuffer();
      }
    }
    expect(pages[0]).toContain(A.title);
    expect(pages[1]).toContain(SHORT);
    expect(pages[0]).not.toBe(pages[1]);
  }, 60_000);

  it("hides a closed intake from the other party before saying the intake is closed", async () => {
    const foreign = await postSupersede(complainantId, "COMPLAINANT", respondentEvidenceId);
    const foreignBody = await foreign.text();
    expect(foreign.status).toBe(404);
    expect(foreignBody.toLowerCase()).not.toContain("intake");

    const missing = await postSupersede(complainantId, "COMPLAINANT", "00000000-0000-4000-8000-000000000000");
    expect(missing.status).toBe(404);
    expect((await missing.text()).toLowerCase()).not.toContain("intake");

    const owner = await postSupersede(complainantId, "COMPLAINANT", complainantEvidenceId);
    expect(owner.status).toBe(409);
    expect(await owner.text()).toContain("Evidence intake is not open.");
  }, 60_000);

  it("keeps pipeline synthesis and proposals to the party whose evidence they cite", async () => {
    const complainant = await readPipeline(caseId, { userId: complainantId, globalRole: "COMPLAINANT" });
    const respondent = await readPipeline(caseId, { userId: respondentId, globalRole: "RESPONDENT" });
    const manager = await readPipeline(caseId, { userId: managerId, globalRole: "CASE_MANAGER" });
    const approver = await readPipeline(caseId, { userId: approverId, globalRole: "CASE_MANAGER", isApprover: true });
    const admin = await readPipeline(caseId, { userId: adminId, globalRole: "ADMIN" });
    expect(complainant).not.toBeNull();
    expect(respondent).not.toBeNull();

    const complainantText = JSON.stringify(complainant);
    const respondentText = JSON.stringify(respondent);
    expect(complainantText).toContain(SYN_OWN);
    expect(complainantText).toContain(PROP_OWN);
    expect(complainantText).not.toContain(SYN_OTHER);
    expect(complainantText).not.toContain(SYN_MIXED);
    expect(complainantText).not.toContain(SYN_UNMAP);
    expect(complainantText).not.toContain(PROP_OTHER);
    expect(complainantText).not.toContain(PARTIAL);
    expect(complainantText).not.toContain(OTHER_FACTOR);
    expect(complainantText).not.toContain(ASSUMPTION);
    expect(complainant?.synthesis?.diagE).toBe("disputed_present");

    expect(respondentText).toContain(SYN_OTHER);
    expect(respondentText).toContain(PROP_OTHER);
    expect(respondentText).not.toContain(SYN_OWN);
    expect(respondentText).not.toContain(SYN_MIXED);
    expect(respondentText).not.toContain(PROP_OWN);
    expect(respondentText).not.toContain(ASSUMPTION);

    for (const view of [manager, approver, admin]) {
      const text = JSON.stringify(view);
      expect(text).toContain(SYN_OWN);
      expect(text).toContain(SYN_OTHER);
      expect(text).toContain(SYN_MIXED);
      expect(text).toContain(SYN_UNMAP);
      expect(text).toContain(PROP_OWN);
      expect(text).toContain(PROP_OTHER);
      expect(text).toContain(ASSUMPTION);
      expect(text).toContain(OTHER_FACTOR);
    }
  });
});

async function postSupersede(userId: string, role: string, evidenceId: string) {
  const form = new FormData();
  form.set("kind", "DOCUMENT");
  form.set("title", "replacement attempt");
  form.set("description", "a later file");
  form.set("file", new File(["plain text replacement"], "note.txt", { type: "text/plain" }));
  return fetch(`${base}/api/cases/${caseId}/evidence/${evidenceId}/supersede`, {
    method: "POST",
    headers: cookie(userId, role),
    body: form,
  });
}
