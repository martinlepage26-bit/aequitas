import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { knowledgeReportLines } from "./knowledgeReport";
import { randomUUID } from "node:crypto";
import { ZipArchive } from "archiver";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { prisma } from "../lib/prisma";
import { rollbackBuffer, uploadBuffer } from "../lib/storage";
import { canonicalJson } from "./events";
import type { ExplanationRecord } from "./explanationRecord";
import { partySeesOutcomeEvent, projectPartyTimelineEvent } from "./eventTimeline";
import { filterExplanationForParty, type HiddenSubmissionIds } from "./submissionVisibility";
import { resolveRoleTerm } from "../i18n/categoryGlossary";

/**
 * Section 15: on case closure (and on demand for closed cases), generate a
 * bundle containing case-record.pdf, case-record.json, and
 * verification.txt, zipped into one archive whose SHA-256 is what
 * ExportBundle.sha256 (and close_case's exportBundleGeneratedAndHashed
 * guard) actually records — matching the schema's single storageKey/sha256
 * pair, rather than tracking three separate hashes.
 *
 * Scope, logged rather than silently implied to be more complete: the PDF
 * is a real, complete, bilingual rendering of the case record (parties,
 * timeline, evidence manifest, every recommendation version, full consent
 * history) but is not W3C PDF/UA semantically tagged — pdf-lib (the only
 * pure-JS PDF writer available without a native/headless-browser
 * dependency) does not support structure-tree tagging. Section 15's
 * "tagged/accessible" requirement is therefore only partly met; a real
 * screen-reader pass and, if needed, a tagging pass with different tooling
 * is a human/follow-up task, not silently claimed done here.
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

  const { sha256 } = await uploadBuffer({ storageKey, buffer: zipBuffer, mimeType: "application/zip" });

  try {
    await prisma.exportBundle.create({
      data: { caseId: input.caseId, generatedById: input.actorId, storageKey, sha256 },
    });
  } catch (error) { await rollbackBuffer(storageKey); throw error; }

  return { exportId, storageKey, sha256 };
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
}

export async function buildExportRecord(caseId: string) {
  const caseRow = await prisma.case.findUniqueOrThrow({
    where: { id: caseId },
    include: {
      complainant: { select: { id: true, displayName: true, email: true, locale: true } },
      respondent: { select: { id: true, displayName: true, email: true, locale: true } },
      caseManager: { select: { id: true, displayName: true, email: true, locale: true } },
    },
  });

  const [events, evidenceItems, positionStatements, recommendations, consentRecords, chronologyEntries, partyOutcomes] = await Promise.all([
    prisma.event.findMany({ where: { caseId }, orderBy: { seq: "asc" } }),
    prisma.evidenceItem.findMany({ where: { caseId }, include: { submittedBy: { select: { displayName: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.positionStatement.findMany({ where: { caseId }, include: { party: { select: { displayName: true } } }, orderBy: [{ partyId: "asc" }, { version: "asc" }] }),
    prisma.recommendation.findMany({ where: { caseId }, include: { issuedBy: { select: { displayName: true } } }, orderBy: { version: "asc" } }),
    prisma.consentRecord.findMany({ where: { caseId }, include: { party: { select: { displayName: true } }, statementVersion: true }, orderBy: { createdAt: "asc" } }),
    prisma.chronologyEntry.findMany({ where: { caseId }, include: { submittedBy: { select: { displayName: true } } }, orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }, { id: "asc" }] }),
    prisma.partyOutcome.findMany({
      where: { caseId },
      include: {
        party: { select: { displayName: true } },
        authoredBy: { select: { displayName: true } },
        citations: { include: { evidenceItem: { select: { title: true } } }, orderBy: { evidenceItemId: "asc" } },
      },
      orderBy: [{ partyId: "asc" }, { version: "asc" }],
    }),
  ]);

  const actorIds = [...new Set(events.map((e) => e.actorId))];
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } });
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
  return {
    ...record,
    evidence: record.evidence.filter((item) => item.submittedById === viewerId),
    positions: record.positions.filter((item) => item.partyId === viewerId),
    chronology: (record.chronology ?? []).filter((entry) => entry.submittedById === viewerId),
    timeline: record.timeline.flatMap((event) => {
      if (!partyCanSeeTimelineEvent(event, hidden, ownContestationIds, viewerId)) return [];
      const projected = projectPartyTimelineEvent(event, viewerId);
      return projected ? [projected] : [];
    }),
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
  y: number;
}

function newPage(cursor: Omit<PdfCursor, "page" | "y">): PdfCursor {
  const page = cursor.doc.addPage(PAGE_SIZE);
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

function heading(cursor: PdfCursor, text: string): PdfCursor {
  let c = ensureSpace(cursor, HEADING_SIZE + LINE_HEIGHT);
  c.y -= HEADING_SIZE;
  c.page.drawText(text, { x: MARGIN, y: c.y, size: HEADING_SIZE, font: c.bold, color: rgb(0.106, 0.118, 0.137) });
  c.y -= LINE_HEIGHT * 0.5;
  return c;
}

function subheading(cursor: PdfCursor, text: string): PdfCursor {
  let c = ensureSpace(cursor, SUBHEADING_SIZE + LINE_HEIGHT);
  c.y -= SUBHEADING_SIZE;
  c.page.drawText(text, { x: MARGIN, y: c.y, size: SUBHEADING_SIZE, font: c.bold, color: rgb(0.184, 0.29, 0.42) });
  c.y -= LINE_HEIGHT * 0.3;
  return c;
}

function paragraph(cursor: PdfCursor, text: string): PdfCursor {
  let c = cursor;
  const maxWidth = PAGE_SIZE[0] - MARGIN * 2;
  for (const line of wrapText(text, c.font, BODY_SIZE, maxWidth)) {
    c = ensureSpace(c, LINE_HEIGHT);
    c.y -= LINE_HEIGHT;
    c.page.drawText(line, { x: MARGIN, y: c.y, size: BODY_SIZE, font: c.font, color: rgb(0.106, 0.118, 0.137) });
  }
  return c;
}

type FullExportRecord = Awaited<ReturnType<typeof buildExportRecord>>["record"];
type ExportRecord = Omit<FullExportRecord, "chronology" | "partyOutcomes"> & {
  chronology?: FullExportRecord["chronology"];
  partyOutcomes?: FullExportRecord["partyOutcomes"];
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

  let cursor = newPage({ doc, font, bold });

  const complainantTerm = { en: resolveRoleTerm(category, "complainant", "en-CA"), fr: resolveRoleTerm(category, "complainant", "fr-CA") };
  const respondentTerm = { en: resolveRoleTerm(category, "respondent", "en-CA"), fr: resolveRoleTerm(category, "respondent", "fr-CA") };

  cursor = heading(cursor, `Aequitas — ${record.case.referenceNumber}`);
  cursor = paragraph(
    cursor,
    options?.partyView
      ? `Vue d'une partie / Party view — exported ${record.exportedAt}. The other party's evidence and position are omitted. This file is not the sealed export.`
      : `Dossier scellé / Sealed case record — exported ${record.exportedAt}`,
  );
  if (record.case.simulated) cursor = paragraph(cursor, "SIMULATED CASE — TRAINING DATA / DOSSIER SIMULÉ — DONNÉES D'APPRENTISSAGE");

  cursor = subheading(cursor, "Parties / Parties");
  cursor = paragraph(
    cursor,
    `${capitalize(complainantTerm.en)} / ${capitalize(complainantTerm.fr)}: ${record.parties.complainant.displayName} (${record.parties.complainant.email})`
  );
  cursor = paragraph(
    cursor,
    `${capitalize(respondentTerm.en)} / ${capitalize(respondentTerm.fr)}: ${record.parties.respondent.displayName} (${record.parties.respondent.email})`
  );
  if (record.parties.caseManager) {
    cursor = paragraph(cursor, `Case manager / Gestionnaire de dossier: ${record.parties.caseManager.displayName} (${record.parties.caseManager.email})`);
  }
  cursor = paragraph(cursor, `Category / Catégorie: ${record.case.category}    State / État: ${record.case.state}`);
  if (record.case.disputeDescription) {
    cursor = subheading(cursor, "Dispute / Différend");
    cursor = paragraph(cursor, record.case.disputeDescription);
  }
  if (typeof record.case.amountAtStakeCents === "number") {
    const amount = (record.case.amountAtStakeCents / 100).toFixed(2);
    cursor = paragraph(cursor, `Approximate amount at stake / Montant approximatif en jeu: ${amount} CAD`);
  }

  cursor = subheading(cursor, "Case activity / Activité du dossier");
  for (const e of record.timeline) {
    cursor = paragraph(cursor, `#${e.seq}  ${e.createdAt}  ${e.type}  — ${e.actorName ?? e.actorId}`);
  }

  cursor = subheading(cursor, "Dispute chronology / Chronologie du différend");
  cursor = paragraph(cursor, "Party-reported events, not verified findings / Événements rapportés par les parties, non vérifiés.");
  for (const entry of record.chronology ?? []) {
    cursor = paragraph(cursor, `${entry.occurredOn} - ${entry.title} - ${entry.submittedByName}`);
    cursor = paragraph(cursor, entry.description);
    cursor = paragraph(cursor, `Submitted / Soumis: ${entry.createdAt} (${entry.locale})`);
  }

  cursor = subheading(cursor, "Evidence manifest / Registre des pièces");
  if (record.evidence.length === 0) cursor = paragraph(cursor, "(none / aucune)");
  for (const e of record.evidence) {
    cursor = paragraph(cursor, `[${e.kind}] "${e.title}" — ${e.submittedByName} — v${e.version} — ${e.scanStatus} — sha256:${e.sha256}`);
  }

  cursor = subheading(cursor, "Position statements / Déclarations de position");
  for (const p of record.positions) {
    cursor = paragraph(cursor, `${p.partyName} (v${p.version}, ${p.locale}, ${p.createdAt}):`);
    cursor = paragraph(cursor, p.body);
  }

  cursor = subheading(cursor, "Recommendations / Recommandations");
  for (const r of record.recommendations) {
    cursor = paragraph(cursor, `Version ${r.version} — ${r.status} — model ${r.modelId} (${r.promptVersion}) — issued by ${r.issuedByName ?? "—"} at ${r.issuedAt ?? "—"}`);
    cursor = paragraph(cursor, `Summary / Résumé: ${r.explanation.summary}`);
    cursor = paragraph(cursor, `Proposed outcome / Résultat proposé: ${r.explanation.proposed_outcome}`);
    cursor = paragraph(cursor, `Reasoning / Raisonnement: ${r.explanation.reasoning}`);
    for (const claim of r.explanation.claim_evidence ?? []) {
      const section = claim.section === "proposal" ? "Proposal basis / Fondement de la proposition"
        : claim.section === "summary" ? "Summary claim / Affirmation du résumé"
          : "Reasoning claim / Affirmation du raisonnement";
      cursor = paragraph(cursor, `${section} [${claim.citation_ids.join(", ")}]: ${claim.text}`);
    }
    for (const citation of r.explanation.evidence_citations) {
      cursor = paragraph(cursor, `${citation.citation_id ?? "Citation"} — ${citation.evidence_item_id}: ${citation.relevance}`);
    }
    for (const limit of r.explanation.limits) cursor = paragraph(cursor, `Limit / Limite: ${limit}`);
    for (const omitted of r.explanation.not_considered) cursor = paragraph(cursor, `Not considered / Non considéré: ${omitted}`);
    if (r.explanation.conflict_knowledge) {
      for (const line of knowledgeReportLines(r.explanation.conflict_knowledge, r.explanation.knowledge_sources ?? [])) cursor = paragraph(cursor, line);
    }
  }

  cursor = subheading(cursor, "Party-facing outcomes / Résultats destinés aux parties");
  const outcomes = record.partyOutcomes ?? [];
  if (outcomes.length === 0) cursor = paragraph(cursor, "(none / aucun)");
  for (const outcome of outcomes) {
    cursor = paragraph(cursor, `${outcome.partyName} — v${outcome.version} — ${outcome.status} — ${outcome.locale} — issued:${outcome.issuedAt ?? "—"}`);
    cursor = paragraph(cursor, outcome.body);
    for (const citation of outcome.citations ?? []) {
      const relevance = citation.relevance ? ` — ${citation.relevance}` : "";
      cursor = paragraph(cursor, `Evidence citation / Citation de preuve: ${citation.evidenceTitle}${relevance} — extracted characters ${citation.startChar}-${citation.endChar} — source sha256:${citation.sourceSha256}`);
    }
  }

  cursor = subheading(cursor, "Consent history / Historique du consentement");
  for (const c of record.consent) {
    cursor = paragraph(
      cursor,
      `${c.partyName} — recommendation v${record.recommendations.find((r) => r.id === c.recommendationId)?.version ?? "?"} — ${c.state} — statement v${c.statementVersion.version} (${c.statementVersion.locale}) — given:${c.givenAt ?? "—"} declined:${c.declinedAt ?? "—"} revoked:${c.revokedAt ?? "—"}`
    );
  }

  cursor = subheading(cursor, "Verification / Vérification");
  cursor = paragraph(cursor, "See verification.txt in this bundle for the hash-chain and evidence-integrity recomputation instructions.");
  cursor = paragraph(cursor, "Voir verification.txt dans cette archive pour les instructions de recalcul de la chaîne de hachage et de l'intégrité des pièces.");

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
