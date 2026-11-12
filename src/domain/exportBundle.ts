import { withCaseOperation, registerCaseOperationStorageKey } from "../lib/caseOperation";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { knowledgeReportLines } from "./knowledgeReport";
import { randomUUID } from "node:crypto";
import { ZipArchive } from "archiver";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { prisma } from "../lib/prisma";
import type { Prisma } from "../generated/prisma";
import { rollbackBuffer, uploadBuffer } from "../lib/storage";
import { canonicalJson } from "./events";
import { caseDetailsRevisionRecord, verifyCaseDetailsRevisions } from "./caseDetailsRevision";
import type { ExplanationRecord } from "./explanationRecord";
import { partySeesOutcomeEvent, projectPartyTimelineEvent } from "./eventTimeline";
import { filterExplanationForParty, type HiddenSubmissionIds } from "./submissionVisibility";
import { resolveRoleTerm } from "../i18n/categoryGlossary";
import { TaggedPdf, bilingual, en, fr, pdfLanguage, wrapPdfRuns, type PdfLanguage, type PdfTextRun } from "../lib/taggedPdf";

/**
 * Section 15: on case closure (and on demand for closed cases), generate a
 * bundle containing case-record.pdf, case-record.json, and
 * verification.txt, zipped into one archive whose SHA-256 is what
 * ExportBundle.sha256 (and close_case's exportBundleGeneratedAndHashed
 * guard) actually records — matching the schema's single storageKey/sha256
 * pair, rather than tracking three separate hashes.
 *
 * The text report has a logical Document/H1/H2/P/Span structure, language
 * spans, per-page marked content and a reverse ParentTree. Both sealed and
 * party views use the same renderer. Automated tag/reading-order checks are
 * distinct from a claim of certified PDF/UA or a human screen-reader review.
 */

const SIMULATED_PREFIX = "exports/simulated/";
const LIVE_PREFIX = "exports/live/";

export interface GenerateExportBundleInput {
  caseId: string;
  actorId: string;
}

export interface GenerateExportBundleResult {
  exportId: string;
  storageKey: string;
  sha256: string;
}

export async function generateExportBundle(input: GenerateExportBundleInput): Promise<GenerateExportBundleResult> {
  return withCaseOperation(input.caseId, "generateExportBundle", async () => {
  const { record, caseRow } = await buildExportRecord(input.caseId);

  const jsonBuffer = Buffer.from(canonicalJson(record), "utf8");
  const verificationBuffer = Buffer.from(buildVerificationText(caseRow.referenceNumber), "utf8");
  const pdfBuffer = await buildExportPdf(record);

  const zipBuffer = await zipFiles([
    { name: "case-record.json", buffer: jsonBuffer },
    { name: "case-record.pdf", buffer: pdfBuffer },
    { name: "verification.txt", buffer: verificationBuffer },
  ]);

  const exportId = randomUUID();
  const prefix = caseRow.simulated ? SIMULATED_PREFIX : LIVE_PREFIX;
  const storageKey = `${prefix}${input.caseId}/${exportId}.zip`;

  await registerCaseOperationStorageKey(input.caseId, storageKey);
  const { sha256 } = await uploadBuffer({ storageKey, buffer: zipBuffer, mimeType: "application/zip" });

  try {
    await prisma.exportBundle.create({
      data: { caseId: input.caseId, generatedById: input.actorId, storageKey, sha256 },
    });
  } catch (error) { await rollbackBuffer(storageKey); throw error; }

  return { exportId, storageKey, sha256 };

  });
}

/**
 * A closed-case download for one party. It keeps that party's evidence,
 * position, chronology, and issued outcome, and the latest issued
 * recommendation with the other party's citations removed. Draft
 * recommendations, draft outcomes, the other party's outcome, and
 * mediator-only timeline events are omitted. This zip is not the sealed
 * ExportBundle.
 */
export async function buildPartyExportArchive(caseId: string, viewerId: string): Promise<Buffer> {
  return withCaseOperation(caseId, "buildPartyExportArchive", async () => {
  const { record, caseRow } = await buildExportRecord(caseId);
  const filtered = filterPartyExportRecord(record, viewerId);
  const jsonBuffer = Buffer.from(canonicalJson(filtered), "utf8");
  const verificationBuffer = Buffer.from(buildPartyVerificationText(caseRow.referenceNumber), "utf8");
  const pdfBuffer = await buildExportPdf(filtered, { partyView: true });
  return zipFiles([
    { name: "case-record.json", buffer: jsonBuffer },
    { name: "case-record.pdf", buffer: pdfBuffer },
    { name: "verification.txt", buffer: verificationBuffer },
  ]);

  });
}

export async function buildExportRecord(caseId: string) {
  return withCaseOperation(caseId, "buildExportRecord", async () => {
  // Case, events, source revisions and relation/actor reads must describe
  // one point in time, even when another connection commits a correction.
  // Rendering and storage happen after this bounded read transaction ends.
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return readExportRecord(tx, caseId);
  }, {
    isolationLevel: "RepeatableRead",
    maxWait: 5_000,
    timeout: 30_000,
  });

  });
}

async function readExportRecord(tx: Prisma.TransactionClient, caseId: string) {
  const caseRow = await tx.case.findUniqueOrThrow({
    where: { id: caseId },
    include: {
      complainant: { select: { id: true, displayName: true, email: true, locale: true } },
      respondent: { select: { id: true, displayName: true, email: true, locale: true } },
      caseManager: { select: { id: true, displayName: true, email: true, locale: true } },
    },
  });

  if (caseRow.deletionStartedAt !== null) throw new Error("Case not found.");

  // The transaction uses one connection; read sequentially rather than
  // queue concurrent queries on the pg driver.
  const events = await tx.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } });
  const evidenceItems = await tx.evidenceItem.findMany({ where: { caseId }, include: { submittedBy: { select: { displayName: true } } }, orderBy: { createdAt: "asc" } });
  const positionStatements = await tx.positionStatement.findMany({ where: { caseId }, include: { party: { select: { displayName: true } } }, orderBy: [{ partyId: "asc" }, { version: "asc" }] });
  const recommendations = await tx.recommendation.findMany({ where: { caseId }, include: { issuedBy: { select: { displayName: true } } }, orderBy: { version: "asc" } });
  const consentRecords = await tx.consentRecord.findMany({ where: { caseId }, include: { party: { select: { displayName: true } }, statementVersion: true }, orderBy: { createdAt: "asc" } });
  const chronologyEntries = await tx.chronologyEntry.findMany({ where: { caseId }, include: { submittedBy: { select: { displayName: true } } }, orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
  const partyOutcomes = await tx.partyOutcome.findMany({
    where: { caseId },
    include: {
      party: { select: { displayName: true } },
      authoredBy: { select: { displayName: true } },
      citations: { include: { evidenceItem: { select: { title: true } } }, orderBy: { evidenceItemId: "asc" } },
    },
    orderBy: [{ partyId: "asc" }, { version: "asc" }],
  });
  const detailsRevisions = await tx.caseDetailsRevision.findMany({ where: { caseId } });

  const verifiedDetails = verifyCaseDetailsRevisions(events, detailsRevisions);
  if (verifiedDetails.issues.length > 0) {
    throw new Error(`Cannot export unverified case details: ${verifiedDetails.issues.join(" ")}`);
  }

  const actorIds = [...new Set(events.map((e) => e.actorId))];
  const actors = await tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } });
  const actorNameById = new Map(actors.map((a) => [a.id, a.displayName]));

  const record = {
    exportedAt: new Date().toISOString(),
    case: {
      id: caseRow.id,
      referenceNumber: caseRow.referenceNumber,
      category: caseRow.category,
      disputeDescription: caseRow.disputeDescription,
      amountAtStakeCents: caseRow.amountAtStakeCents,
      state: caseRow.state,
      simulated: caseRow.simulated,
      createdAt: caseRow.createdAt.toISOString(),
      closedAt: caseRow.closedAt?.toISOString() ?? null,
    },
    parties: {
      complainant: { id: caseRow.complainant.id, displayName: caseRow.complainant.displayName, email: caseRow.complainant.email, locale: caseRow.complainant.locale },
      respondent: { id: caseRow.respondent.id, displayName: caseRow.respondent.displayName, email: caseRow.respondent.email, locale: caseRow.respondent.locale },
      caseManager: caseRow.caseManager
        ? { id: caseRow.caseManager.id, displayName: caseRow.caseManager.displayName, email: caseRow.caseManager.email, locale: caseRow.caseManager.locale }
        : null,
    },
    // Unfiltered — the sealed record is the full audit trail, not the
    // role-filtered projection Section 313 requires for the live workspace.
    caseDetailsRevisions: verifiedDetails.revisions.map(caseDetailsRevisionRecord),
    timeline: events.map((e) => ({
      seq: e.seq,
      type: e.type,
      actorId: e.actorId,
      actorName: actorNameById.get(e.actorId) ?? null,
      payload: e.payload,
      prevHash: e.prevHash,
      hash: e.hash,
      createdAt: e.createdAt.toISOString(),
    })),
    evidence: evidenceItems.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      description: e.description,
      submittedById: e.submittedById,
      submittedByName: e.submittedBy.displayName,
      sha256: e.sha256,
      byteSize: e.byteSize,
      mimeType: e.mimeType,
      scanStatus: e.scanStatus,
      version: e.version,
      supersedesId: e.supersedesId,
      createdAt: e.createdAt.toISOString(),
    })),
    chronology: chronologyEntries.map(entry => ({
      id: entry.id, occurredOn: entry.occurredOn.toISOString().slice(0, 10), title: entry.title,
      description: entry.description, locale: entry.locale, submittedById: entry.submittedById,
      submittedByName: entry.submittedBy.displayName, createdAt: entry.createdAt.toISOString(),
    })),
    positions: positionStatements.map((p) => ({
      id: p.id,
      partyId: p.partyId,
      partyName: p.party.displayName,
      body: p.body,
      locale: p.locale,
      version: p.version,
      createdAt: p.createdAt.toISOString(),
    })),
    recommendations: recommendations.map((r) => ({
      id: r.id,
      version: r.version,
      status: r.status,
      explanation: r.explanation as unknown as ExplanationRecord,
      modelId: r.modelId,
      promptVersion: r.promptVersion,
      issuedById: r.issuedById,
      issuedByName: r.issuedBy?.displayName ?? null,
      issuedAt: r.issuedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    partyOutcomes: partyOutcomes.map((outcome) => ({
      id: outcome.id,
      partyId: outcome.partyId,
      partyName: outcome.party.displayName,
      version: outcome.version,
      status: outcome.status,
      body: outcome.body,
      locale: outcome.locale,
      authoredById: outcome.authoredById,
      authoredByName: outcome.authoredBy.displayName,
      issuedAt: outcome.issuedAt?.toISOString() ?? null,
      createdAt: outcome.createdAt.toISOString(),
      citations: outcome.citations.map((citation) => ({
        id: citation.id,
        evidenceItemId: citation.evidenceItemId,
        evidenceTitle: citation.evidenceItem.title,
        relevance: citation.relevance,
        startChar: citation.startChar,
        endChar: citation.endChar,
        sourceSha256: citation.sourceSha256,
        extractedTextSha256: citation.extractedTextSha256,
        extractionMethod: citation.extractionMethod,
      })),
    })),
    consent: consentRecords.map((c) => ({
      id: c.id,
      recommendationId: c.recommendationId,
      partyId: c.partyId,
      partyName: c.party.displayName,
      state: c.state,
      statementVersion: {
        id: c.statementVersion.id,
        version: c.statementVersion.version,
        locale: c.statementVersion.locale,
        body: c.statementVersion.body,
        effectiveFrom: c.statementVersion.effectiveFrom.toISOString(),
      },
      locale: c.locale,
      givenAt: c.givenAt?.toISOString() ?? null,
      declinedAt: c.declinedAt?.toISOString() ?? null,
      revokedAt: c.revokedAt?.toISOString() ?? null,
      partyOutcomeId: c.partyOutcomeId,
      partyOutcomeVersion: c.partyOutcomeVersion,
      createdAt: c.createdAt.toISOString(),
    })),
  };

  return { record, caseRow };
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
}

function eventReferencesHidden(type: string, payload: unknown, hidden: HiddenSubmissionIds): boolean {
  if (type === "RECOMMENDATION_DRAFTED" || type === "NOTE_ADDED") return true;
  const record = payloadObject(payload);
  const evidenceId = typeof record.evidenceItemId === "string" ? record.evidenceItemId : null;
  const priorId = typeof record.priorEvidenceItemId === "string" ? record.priorEvidenceItemId : null;
  const newId = typeof record.newEvidenceItemId === "string" ? record.newEvidenceItemId : null;
  const positionId = typeof record.positionId === "string" ? record.positionId : null;
  const chronologyId = typeof record.chronologyEntryId === "string" ? record.chronologyEntryId : null;
  if (evidenceId && hidden.evidenceIds.has(evidenceId)) return true;
  if (priorId && hidden.evidenceIds.has(priorId)) return true;
  if (newId && hidden.evidenceIds.has(newId)) return true;
  if (positionId && hidden.positionIds.has(positionId)) return true;
  if (chronologyId && hidden.chronologyIds.has(chronologyId)) return true;
  return false;
}

const CONTESTATION_EVENT_TYPES = new Set([
  "CONTESTATION_OPENED",
  "CONTESTATION_RESPONDED",
  "CONTESTATION_OVERRULED",
  "CONTESTATION_WITHDRAWN",
]);

function partyCanSeeTimelineEvent(
  event: { type: string; payload: unknown },
  hidden: HiddenSubmissionIds,
  ownContestationIds: ReadonlySet<string>,
  viewerId: string,
): boolean {
  if (eventReferencesHidden(event.type, event.payload, hidden)) return false;
  if (!partySeesOutcomeEvent(event.type, event.payload, viewerId)) return false;
  if (!CONTESTATION_EVENT_TYPES.has(event.type)) return true;
  const contestationId = payloadObject(event.payload).contestationId;
  return typeof contestationId === "string" && ownContestationIds.has(contestationId);
}

export function visiblePartyOutcomesForExport<T extends { partyId: string; status: string }>(rows: T[], viewerId: string): T[] {
  return rows.filter((row) => row.partyId === viewerId && row.status === "ISSUED");
}

function filterPartyExportRecord<T extends {
  evidence: { id: string; submittedById: string }[];
  positions: { id: string; partyId: string }[];
  chronology?: { id: string; submittedById: string }[];
  timeline: { type: string; payload: unknown; actorId?: string }[];
  caseDetailsRevisions?: { id: string }[];
  recommendations: { status: string; version: number; explanation: Parameters<typeof filterExplanationForParty>[0] }[];
  partyOutcomes?: {
    partyId: string;
    status: string;
    citations?: { evidenceItemId: string; relevance?: string }[];
  }[];
  consent?: { partyId: string; state: string; revokedAt: string | null; partyOutcomeId: string | null; partyOutcomeVersion: number | null }[];
}>(record: T, viewerId: string): T {
  const hidden: HiddenSubmissionIds = {
    evidenceIds: new Set(record.evidence.filter((item) => item.submittedById !== viewerId).map((item) => item.id)),
    positionIds: new Set(record.positions.filter((item) => item.partyId !== viewerId).map((item) => item.id)),
    chronologyIds: new Set((record.chronology ?? []).filter((entry) => entry.submittedById !== viewerId).map((entry) => entry.id)),
  };
  const ownContestationIds = new Set(
    record.timeline.flatMap((event) => {
      if (event.type !== "CONTESTATION_OPENED" || event.actorId !== viewerId) return [];
      const contestationId = payloadObject(event.payload).contestationId;
      return typeof contestationId === "string" ? [contestationId] : [];
    }),
  );
  const issued = record.recommendations.filter((item) => item.status === "ISSUED");
  const finalIssued = issued.length === 0 ? [] : [issued.reduce((latest, item) => item.version > latest.version ? item : latest)];
  const ownEvidenceIds = new Set(record.evidence.filter((item) => item.submittedById === viewerId).map((item) => item.id));
  const ownOutcomes = visiblePartyOutcomesForExport(record.partyOutcomes ?? [], viewerId).map((outcome) => ({
    ...outcome,
    citations: (outcome.citations ?? [])
      .filter((citation) => ownEvidenceIds.has(citation.evidenceItemId))
      .map((citation) => ({ ...citation, relevance: "" })),
  }));
  const timeline = record.timeline.flatMap((event) => {
    if (!partyCanSeeTimelineEvent(event, hidden, ownContestationIds, viewerId)) return [];
    const projected = projectPartyTimelineEvent(event, viewerId);
    return projected ? [projected] : [];
  });
  const visibleRevisionIds = new Set(timeline.flatMap((event) => {
    const revisionId = payloadObject(event.payload).revisionId;
    return event.type === "CASE_DETAILS_UPDATED" && typeof revisionId === "string" ? [revisionId] : [];
  }));
  return {
    ...record,
    evidence: record.evidence.filter((item) => item.submittedById === viewerId),
    positions: record.positions.filter((item) => item.partyId === viewerId),
    chronology: (record.chronology ?? []).filter((entry) => entry.submittedById === viewerId),
    timeline,
    caseDetailsRevisions: (record.caseDetailsRevisions ?? []).filter((revision) => visibleRevisionIds.has(revision.id)),
    partyOutcomes: ownOutcomes,
    ...(record.consent
      ? {
          consent: record.consent.map((entry) => entry.partyId === viewerId
            ? entry
            : {
                ...entry,
                partyOutcomeId: null,
                partyOutcomeVersion: null,
                revokedAt: null,
                state: entry.state === "REVOKED" ? "NOT_GIVEN" : entry.state,
              }),
        }
      : {}),
    recommendations: finalIssued.map((item) => ({
      ...item,
      explanation: filterExplanationForParty(item.explanation, hidden),
    })),
  };
}

function buildPartyVerificationText(referenceNumber: string): string {
  return `Aequitas party view / Vue d'une partie
========================================

Case / Dossier: ${referenceNumber}
Generated / Généré : ${new Date().toISOString()}

This archive is a view for one party. It omits the other party's evidence,
position, chronology, and outcome, their timeline records, draft
recommendations, draft outcomes, and citations of the other party's
evidence. It is not the sealed export.
The ExportBundle SHA-256 does not cover this file.

Cette archive est la vue d'une seule partie. Elle omet les pièces, la
position, la chronologie et le résultat de l'autre partie, leurs
événements, les recommandations en brouillon, les résultats en brouillon,
et les citations des pièces de l'autre partie. Ce n'est pas l'export scellé.
Le SHA-256 du dossier ExportBundle ne couvre pas ce fichier.
`;
}

function buildVerificationText(referenceNumber: string): string {
  return `Aequitas case record verification / Vérification du dossier Aequitas
========================================================================

Case / Dossier: ${referenceNumber}
Generated / Généré : ${new Date().toISOString()}

1. Hash chain verification / Vérification de la chaîne de hachage
--------------------------------------------------------------------
Each entry in case-record.json's "timeline" array has "hash" and "prevHash"
fields. For each event, in order, recompute:

  hash = SHA256(prevHash || canonicalJson(payload) || actorId || seq || createdAt_iso)

  - "||" is concatenation, not a delimiter.
  - canonicalJson = the JSON payload with object keys sorted recursively,
    no whitespace, UTF-8.
  - createdAt_iso = the event's own "createdAt" field.
  - The first event's prevHash must equal 64 zero characters (genesis).
  - Each event's prevHash must equal the immediately prior event's hash.

If every recomputed hash matches the stored "hash", and every "prevHash"
matches the prior event's hash, the timeline has not been altered or
reordered since it was recorded.

Chaque entrée du tableau "timeline" de case-record.json comporte les champs
"hash" et "prevHash". Pour chaque événement, dans l'ordre, recalculez le
hachage selon la formule ci-dessus. Si chaque hachage recalculé correspond
à la valeur "hash" enregistrée, et que chaque "prevHash" correspond au
hachage de l'événement précédent, la chronologie n'a pas été modifiée ni
réordonnée depuis son enregistrement.

For each CASE_DETAILS_UPDATED payload containing revisionId and revisionDigest,
find the matching id in caseDetailsRevisions and recompute
SHA256(canonicalJson(revision)), over the entire exported revision object.
It must equal revisionDigest; caseId and actorId must match the event's case
and actor. The source includes its random nonce. Missing or altered source
records fail verification. Older events keep their original before/after
payloads and continue to use the event hash formula above.

Pour chaque correction avec revisionId et revisionDigest, recalculez le
SHA-256 du JSON canonique de la révision complète dans caseDetailsRevisions.
Le résultat doit correspondre à revisionDigest, avec le même dossier et
acteur. Une révision absente ou modifiée invalide la vérification.

2. Evidence integrity / Intégrité des pièces
------------------------------------------------
Each entry in case-record.json's "evidence" array has a "sha256" field,
computed from the original file's bytes at intake. Recomputing SHA-256 over
a retained copy of the original file and comparing it to this value
confirms the file has not been altered since submission. Original files are
not included in this bundle.

Chaque entrée du tableau "evidence" comporte un champ "sha256", calculé à
partir des octets du fichier original lors de sa soumission. Le recalcul du
SHA-256 sur une copie conservée du fichier original, comparé à cette
valeur, confirme que le fichier n'a pas été modifié depuis sa soumission.
Les fichiers originaux ne sont pas inclus dans cette archive.

3. This bundle's own integrity / Intégrité de cette archive
------------------------------------------------------------
This archive's own SHA-256, recorded in the platform's ExportBundle record
at generation time, covers this exact zip file (case-record.json,
case-record.pdf, and this file, as generated). Any modification after
export invalidates that recorded hash.

Le SHA-256 de cette archive, enregistré dans le dossier ExportBundle de la
plateforme au moment de la génération, couvre exactement ce fichier zip
(case-record.json, case-record.pdf et ce fichier, tels que générés). Toute
modification après l'exportation invalide ce hachage enregistré.
`;
}

function zipFiles(files: { name: string; buffer: Buffer }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    for (const file of files) archive.append(file.buffer, { name: file.name });
    archive.finalize();
  });
}

// --- PDF rendering ----------------------------------------------------

const PAGE_SIZE: [number, number] = [612, 792]; // US Letter
const MARGIN = 54;
const LINE_HEIGHT = 14;
const BODY_SIZE = 10;
const HEADING_SIZE = 14;
const SUBHEADING_SIZE = 11;

interface PdfCursor {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  tags: TaggedPdf;
  y: number;
}

function newPage(cursor: Omit<PdfCursor, "page" | "y">): PdfCursor {
  const page = cursor.doc.addPage(PAGE_SIZE);
  cursor.tags.page(page);
  return { ...cursor, page, y: PAGE_SIZE[1] - MARGIN };
}

function ensureSpace(cursor: PdfCursor, needed: number): PdfCursor {
  if (cursor.y - needed < MARGIN) return newPage(cursor);
  return cursor;
}

export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.replace(/\r\n/g, "\n").split(/\s+/).flatMap(word => {
    if (font.widthOfTextAtSize(word, size) <= maxWidth) return [word];
    const pieces: string[] = [];
    let piece = "";
    for (const char of Array.from(word)) {
      if (piece && font.widthOfTextAtSize(piece + char, size) > maxWidth) { pieces.push(piece); piece = ""; }
      piece += char;
    }
    if (piece) pieces.push(piece);
    return pieces;
  });
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

type PdfText = string | PdfTextRun[];

function textBlock(cursor: PdfCursor, text: PdfText, role: "H1" | "H2" | "H3" | "P", language: PdfLanguage = "fr-CA"): PdfCursor {
  const runs = (typeof text === "string" ? [{ text, language }] : text).filter(run => run.text.length > 0);
  if (!runs.some(run => run.text.trim())) return cursor;
  const size = role === "H1" ? HEADING_SIZE : role === "P" ? BODY_SIZE : SUBHEADING_SIZE;
  const font = role === "P" ? cursor.font : cursor.bold;
  const lineHeight = role === "P" ? LINE_HEIGHT : size + 3;
  const lines = wrapPdfRuns(runs, value => font.widthOfTextAtSize(value, size), PAGE_SIZE[0] - MARGIN * 2);
  // Keep a heading with at least the first following text line.
  let c = role === "P" ? cursor : ensureSpace(cursor, lineHeight * lines.length + LINE_HEIGHT);
  const element = c.tags.element(role);
  const spans = runs.map(run => c.tags.element("Span", element, run.language));
  for (const line of lines) {
    c = ensureSpace(c, lineHeight);
    c.y -= lineHeight;
    let x = MARGIN;
    for (const fragment of line) {
      const page = c.page;
      const drawX = x;
      c.tags.content(page, spans[fragment.run], () => page.drawText(fragment.text, {
        x: drawX, y: c.y, size, font,
        color: role === "H2" || role === "H3" ? rgb(0.184, 0.29, 0.42) : rgb(0.106, 0.118, 0.137),
      }));
      x += font.widthOfTextAtSize(fragment.text, size);
    }
  }
  if (role !== "P") c.y -= LINE_HEIGHT * 0.3;
  return c;
}
function heading(cursor: PdfCursor, text: PdfText): PdfCursor { return textBlock(cursor, text, "H1"); }
function subheading(cursor: PdfCursor, text: PdfText): PdfCursor { return textBlock(cursor, text, "H2"); }
function paragraph(cursor: PdfCursor, text: PdfText, language: PdfLanguage = "fr-CA"): PdfCursor { return textBlock(cursor, text, "P", language); }

type FullExportRecord = Awaited<ReturnType<typeof buildExportRecord>>["record"];
type ExportRecord = Omit<FullExportRecord, "chronology" | "partyOutcomes" | "caseDetailsRevisions"> & {
  chronology?: FullExportRecord["chronology"];
  partyOutcomes?: FullExportRecord["partyOutcomes"];
  caseDetailsRevisions?: FullExportRecord["caseDetailsRevisions"];
};

export async function buildExportPdf(record: ExportRecord, options?: { partyView?: boolean }): Promise<Buffer> {
  const category = record.case.category;
  const doc = await PDFDocument.create();
  doc.setTitle(`Aequitas — ${record.case.referenceNumber}`);
  doc.setLanguage("fr-CA");
  doc.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    readFile(join(process.cwd(), "assets/fonts/DejaVuSans.ttf")),
    readFile(join(process.cwd(), "assets/fonts/DejaVuSans-Bold.ttf")),
  ]);
  const font = await doc.embedFont(regularBytes, { subset: true });
  const bold = await doc.embedFont(boldBytes, { subset: true });

  const tags = new TaggedPdf(doc);
  let cursor = newPage({ doc, font, bold, tags });

  const complainantTerm = { en: resolveRoleTerm(category, "complainant", "en-CA"), fr: resolveRoleTerm(category, "complainant", "fr-CA") };
  const respondentTerm = { en: resolveRoleTerm(category, "respondent", "en-CA"), fr: resolveRoleTerm(category, "respondent", "fr-CA") };

  cursor = heading(cursor, `Aequitas — ${record.case.referenceNumber}`);
  cursor = paragraph(
    cursor,
    options?.partyView
      ? [fr("Vue d'une partie / "), en(`Party view — exported ${record.exportedAt}. The other party's evidence and position are omitted. This file is not the sealed export.`)]
      : [fr("Dossier scellé / "), en(`Sealed case record — exported ${record.exportedAt}`)],
  );
  if (record.case.simulated) cursor = paragraph(cursor, bilingual("SIMULATED CASE — TRAINING DATA", "DOSSIER SIMULÉ — DONNÉES D'APPRENTISSAGE"));

  cursor = subheading(cursor, bilingual("Parties", "Parties"));
  cursor = paragraph(
    cursor,
    bilingual(capitalize(complainantTerm.en), capitalize(complainantTerm.fr), `: ${record.parties.complainant.displayName} (${record.parties.complainant.email})`, pdfLanguage(record.parties.complainant.locale))
  );
  cursor = paragraph(
    cursor,
    bilingual(capitalize(respondentTerm.en), capitalize(respondentTerm.fr), `: ${record.parties.respondent.displayName} (${record.parties.respondent.email})`, pdfLanguage(record.parties.respondent.locale))
  );
  if (record.parties.caseManager) {
    cursor = paragraph(cursor, bilingual("Case manager", "Gestionnaire de dossier", `: ${record.parties.caseManager.displayName} (${record.parties.caseManager.email})`, pdfLanguage(record.parties.caseManager.locale)));
  }
  cursor = paragraph(cursor, [...bilingual("Category", "Catégorie", `: ${record.case.category}    `), ...bilingual("State", "État", `: ${record.case.state}`)]);
  if (record.case.disputeDescription) {
    cursor = subheading(cursor, bilingual("Dispute", "Différend"));
    cursor = paragraph(cursor, record.case.disputeDescription, pdfLanguage(record.parties.complainant.locale));
  }
  if (typeof record.case.amountAtStakeCents === "number") {
    const amount = (record.case.amountAtStakeCents / 100).toFixed(2);
    cursor = paragraph(cursor, bilingual("Approximate amount at stake", "Montant approximatif en jeu", `: ${amount} CAD`));
  }

  cursor = subheading(cursor, bilingual("Case activity", "Activité du dossier"));
  for (const e of record.timeline) {
    cursor = paragraph(cursor, `#${e.seq}  ${e.createdAt}  ${e.type}  — ${e.actorName ?? e.actorId}`);
  }

  if (record.caseDetailsRevisions?.length) {
    cursor = subheading(cursor, bilingual("Dossier corrections", "Corrections au dossier"));
    for (const revision of record.caseDetailsRevisions) {
      cursor = paragraph(cursor, `${revision.createdAt} — ${revision.actorId} — ${revision.id}`);
      cursor = paragraph(cursor, bilingual("Before", "Avant", `: ${canonicalJson(revision.before)}`));
      cursor = paragraph(cursor, bilingual("After", "Après", `: ${canonicalJson(revision.after)}`));
    }
  }

  cursor = subheading(cursor, bilingual("Dispute chronology", "Chronologie du différend"));
  cursor = paragraph(cursor, bilingual("Party-reported events, not verified findings", "Événements rapportés par les parties, non vérifiés."));
  for (const entry of record.chronology ?? []) {
    cursor = paragraph(cursor, `${entry.occurredOn} - ${entry.title} - ${entry.submittedByName}`, pdfLanguage(entry.locale));
    cursor = paragraph(cursor, entry.description, pdfLanguage(entry.locale));
    cursor = paragraph(cursor, bilingual("Submitted", "Soumis", `: ${entry.createdAt} (${entry.locale})`));
  }

  cursor = subheading(cursor, bilingual("Evidence manifest", "Registre des pièces"));
  if (record.evidence.length === 0) cursor = paragraph(cursor, bilingual("(none", "aucune)"));
  for (const e of record.evidence) {
    cursor = paragraph(cursor, `[${e.kind}] "${e.title}" — ${e.submittedByName} — v${e.version} — ${e.scanStatus} — sha256:${e.sha256}`);
  }

  cursor = subheading(cursor, bilingual("Position statements", "Déclarations de position"));
  for (const p of record.positions) {
    cursor = paragraph(cursor, `${p.partyName} (v${p.version}, ${p.locale}, ${p.createdAt}):`);
    cursor = paragraph(cursor, p.body, pdfLanguage(p.locale));
  }

  cursor = subheading(cursor, bilingual("Recommendations", "Recommandations"));
  for (const r of record.recommendations) {
    cursor = paragraph(cursor, `Version ${r.version} — ${r.status} — model ${r.modelId} (${r.promptVersion}) — issued by ${r.issuedByName ?? "—"} at ${r.issuedAt ?? "—"}`, "en-CA");
    cursor = paragraph(cursor, bilingual("Summary", "Résumé", `: ${r.explanation.summary}`));
    cursor = paragraph(cursor, bilingual("Proposed outcome", "Résultat proposé", `: ${r.explanation.proposed_outcome}`));
    cursor = paragraph(cursor, bilingual("Reasoning", "Raisonnement", `: ${r.explanation.reasoning}`));
    for (const claim of r.explanation.claim_evidence ?? []) {
      const section = claim.section === "proposal" ? bilingual("Proposal basis", "Fondement de la proposition")
        : claim.section === "summary" ? bilingual("Summary claim", "Affirmation du résumé")
          : bilingual("Reasoning claim", "Affirmation du raisonnement");
      cursor = paragraph(cursor, [...section, fr(` [${claim.citation_ids.join(", ")}]: ${claim.text}`)]);
    }
    for (const citation of r.explanation.evidence_citations) {
      cursor = paragraph(cursor, `${citation.citation_id ?? "Citation"} — ${citation.evidence_item_id}: ${citation.relevance}`);
    }
    for (const limit of r.explanation.limits) cursor = paragraph(cursor, bilingual("Limit", "Limite", `: ${limit}`));
    for (const omitted of r.explanation.not_considered) cursor = paragraph(cursor, bilingual("Not considered", "Non considéré", `: ${omitted}`));
    if (r.explanation.conflict_knowledge) {
      const headings = new Map([
        ["Conflict knowledge map / Carte des connaissances du conflit", bilingual("Conflict knowledge map", "Carte des connaissances du conflit")],
        ["Competing interpretations / Interprétations concurrentes", bilingual("Competing interpretations", "Interprétations concurrentes")],
        ["Context and power / Contexte et pouvoir", bilingual("Context and power", "Contexte et pouvoir")],
        ["Reported experience / Vécu rapporté", bilingual("Reported experience", "Vécu rapporté")],
        ["Relationships / Relations", bilingual("Relationships", "Relations")],
        ["Triangulation / Triangulation", bilingual("Triangulation", "Triangulation")],
        ["Conditional synthesis / Synthèse conditionnelle", bilingual("Conditional synthesis", "Synthèse conditionnelle")],
        ["Repair paths / Pistes de réparation", bilingual("Repair paths", "Pistes de réparation")],
        ["Source snapshots / Sources conservées", bilingual("Source snapshots", "Sources conservées")],
      ]);
      const labels = [["Method", "Méthode"], ["Revision", "Révision"], ["Claims", "Affirmations"], ["Supported", "Appuyé"], ["Contested", "Contesté"], ["Addresses", "Concerne"]] as const;
      let inSnapshots = false;
      let language: PdfLanguage = "fr-CA";
      for (const line of knowledgeReportLines(r.explanation.conflict_knowledge, r.explanation.knowledge_sources ?? [])) {
        const section = headings.get(line);
        if (section) {
          cursor = textBlock(cursor, section, "H3");
          if (line === "Source snapshots / Sources conservées") inSnapshots = true;
          continue;
        }
        if (inSnapshots) {
          const source = r.explanation.knowledge_sources?.find(source => line.startsWith(`[${source.id}] ${source.kind} · ${source.record_id} · `));
          if (source) language = pdfLanguage(source.locale ?? undefined);
        }
        const label = labels.find(([english, french]) => line.startsWith(`${english} / ${french}: `));
        cursor = label
          ? paragraph(cursor, bilingual(label[0], label[1], line.slice(`${label[0]} / ${label[1]}`.length), language))
          : paragraph(cursor, line, language);
      }
    }
  }

  cursor = subheading(cursor, bilingual("Party-facing outcomes", "Résultats destinés aux parties"));
  const outcomes = record.partyOutcomes ?? [];
  if (outcomes.length === 0) cursor = paragraph(cursor, bilingual("(none", "aucun)"));
  for (const outcome of outcomes) {
    cursor = paragraph(cursor, `${outcome.partyName} — v${outcome.version} — ${outcome.status} — ${outcome.locale} — issued:${outcome.issuedAt ?? "—"}`, "en-CA");
    cursor = paragraph(cursor, outcome.body, pdfLanguage(outcome.locale));
    for (const citation of outcome.citations ?? []) {
      const relevance = citation.relevance ? ` — ${citation.relevance}` : "";
      cursor = paragraph(cursor, [...bilingual("Evidence citation", "Citation de preuve", `: ${citation.evidenceTitle}${relevance}`), en(` — extracted characters ${citation.startChar}-${citation.endChar} — source sha256:${citation.sourceSha256}`)]);
    }
  }

  cursor = subheading(cursor, bilingual("Consent history", "Historique du consentement"));
  for (const c of record.consent) {
    cursor = paragraph(
      cursor,
      `${c.partyName} — recommendation v${record.recommendations.find((r) => r.id === c.recommendationId)?.version ?? "?"} — ${c.state} — statement v${c.statementVersion.version} (${c.statementVersion.locale}) — given:${c.givenAt ?? "—"} declined:${c.declinedAt ?? "—"} revoked:${c.revokedAt ?? "—"}`,
      "en-CA",
    );
  }

  cursor = subheading(cursor, bilingual("Verification", "Vérification"));
  cursor = paragraph(cursor, "See verification.txt in this bundle for the hash-chain and evidence-integrity recomputation instructions.", "en-CA");
  cursor = paragraph(cursor, "Voir verification.txt dans cette archive pour les instructions de recalcul de la chaîne de hachage et de l'intégrité des pièces.");

  tags.finish();
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
