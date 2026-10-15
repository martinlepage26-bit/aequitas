import { randomUUID } from "node:crypto";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { signPayload } from "../../src/lib/signedCookie";
import { SESSION_COOKIE } from "../../src/lib/session";
import { createCase, openIntake, submitCase } from "../../src/domain/mutate";
import { startNextDev, type DevServer } from "../helpers/nextDevServer";

/**
 * Regression for security-audit finding 5.4 (aequitas-audit-run1, Area 5,
 * evidence/area5-storage.jsonl): the evidence route sniffs MIME by magic
 * number (good — the client Content-Type is never trusted) but then applies
 * NO allowlist. Confirmed in production mode (`next start`):
 *   - a PE executable (MZ header + PE signature) is accepted, scanned CLEAN
 *     and stored as application/x-msdownload;
 *   - 10 random bytes starting 0xFF 0xFE are sniffed as audio/mpeg and also
 *     stored CLEAN.
 * The supported formats are the ones the extraction pipeline actually
 * handles (docs/aequitas-core-backend.md: "UTF-8 text, PDF text
 * (pdftotext) and image OCR (tesseract) are supported"; src/lib/
 * evidenceText.ts extractEvidenceText): text/plain, application/pdf, and
 * image/png, image/jpeg, image/tiff, image/webp. Anything else must be a
 * 400 with nothing stored — no EvidenceItem row and no storage object.
 *
 * These tests protect the allowlist on both upload paths. The control test
 * also checks that supported formats still upload successfully.
 */
const PORT = 3432;

// A real, minimal valid 1x1 PNG (same fixture as rbac-http.test.ts).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const TINY_PDF = Buffer.from("%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Size 1>>\n%%EOF\n", "utf8");

// Realistic minimal PE: MZ header, e_lfanew at 0x3C pointing to a PE\0\0 signature.
const PE_EXE = Buffer.alloc(0x88);
PE_EXE.write("MZ", 0);
PE_EXE.writeUInt32LE(0x80, 0x3c);
PE_EXE.write("PE\0\0", 0x80);

const RANDOM_BINARY = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01, 0x80, 0x81, 0xfe, 0xff, 0x10]);

let server: DevServer;
let base: string;
let complainantId: string;
let respondentId: string;
let managerId: string;
let statementVersionId: string;

const s3 = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT, region: process.env.STORAGE_REGION, forcePathStyle: true,
  credentials: { accessKeyId: process.env.STORAGE_ACCESS_KEY!, secretAccessKey: process.env.STORAGE_SECRET_KEY! },
});
const objectsFor = async (caseId: string) =>
  (await s3.send(new ListObjectsV2Command({ Bucket: process.env.STORAGE_BUCKET, Prefix: `simulated/${caseId}/` }))).Contents ?? [];

const cookieFor = (userId: string, globalRole: string) =>
  `${SESSION_COOKIE}=${signPayload({ purpose: "session", userId, globalRole, authMethod: "dev-bypass" }, 3600)}`;

async function freshEvidenceIntakeCase(): Promise<string> {
  const created = await createCase({
    actorId: complainantId, actorRole: "COMPLAINANT",
    referenceNumber: `AE-REGR-MIME-${randomUUID().slice(0, 8)}`,
    complainantId, respondentId, simulated: true,
    disputeDescription: "The submitted evidence concerns a disputed agreement.",
    requestedStatementVersionId: statementVersionId, currentStatementVersionId: statementVersionId,
  });
  if (!created.ok) throw new Error("setup: createCase failed");
  const submitted = await submitCase({ actorId: complainantId, actorRole: "COMPLAINANT", caseId: created.data.caseId });
  if (!submitted.ok) throw new Error("setup: submitCase failed");
  const opened = await openIntake({ actorId: managerId, actorRole: "CASE_MANAGER", caseId: created.data.caseId, hasConflict: false });
  if (!opened.ok) throw new Error("setup: openIntake failed");
  return created.data.caseId;
}

function upload(caseId: string, content: Buffer, filename: string, priorEvidenceItemId?: string) {
  const form = new FormData();
  form.set("kind", "DOCUMENT");
  form.set("title", `mime probe ${filename}`);
  form.set("file", new Blob([new Uint8Array(content)], { type: "application/octet-stream" }), filename);
  const path = priorEvidenceItemId
    ? `/api/cases/${caseId}/evidence/${priorEvidenceItemId}/supersede`
    : `/api/cases/${caseId}/evidence`;
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { Cookie: cookieFor(complainantId, "COMPLAINANT") },
    body: form,
  });
}

beforeAll(async () => {
  server = await startNextDev(PORT);
  base = server.baseUrl;
  const [consumer, retailer, manager, statementVersion] = await Promise.all([
    prisma.user.create({ data: { email: `regr-mime-c-${randomUUID()}@example.com`, displayName: "Regression Consumer", globalRole: "COMPLAINANT" } }),
    prisma.user.create({ data: { email: `regr-mime-r-${randomUUID()}@example.com`, displayName: "Regression Retailer", globalRole: "RESPONDENT" } }),
    prisma.user.create({ data: { email: `regr-mime-m-${randomUUID()}@example.com`, displayName: "Regression Manager", globalRole: "CASE_MANAGER" } }),
    prisma.consentStatementVersion.create({
      data: { version: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) % 2_000_000_000, locale: "fr-CA", body: "Test.", effectiveFrom: new Date() },
    }),
  ]);
  complainantId = consumer.id;
  respondentId = retailer.id;
  managerId = manager.id;
  statementVersionId = statementVersion.id;
}, 240_000);

afterAll(async () => { s3.destroy(); await server?.stop(); await prisma.$disconnect(); });

describe("Evidence MIME allowlist (finding 5.4 regression)", () => {
  it("rejects a PE executable with 400 and stores nothing", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const res = await upload(caseId, PE_EXE, "setup.exe");
    expect(res.status).toBe(400);
    expect(await prisma.evidenceItem.count({ where: { caseId } })).toBe(0);
    expect(await objectsFor(caseId)).toHaveLength(0);
  }, 60_000);

  it("rejects random binary sniffed as an unsupported type with 400 and stores nothing", async () => {
    const caseId = await freshEvidenceIntakeCase();
    const res = await upload(caseId, RANDOM_BINARY, "blob.bin");
    expect(res.status).toBe(400);
    expect(await prisma.evidenceItem.count({ where: { caseId } })).toBe(0);
    expect(await objectsFor(caseId)).toHaveLength(0);
  }, 60_000);

  it("rejects unsupported replacement evidence without superseding the original", async () => {
    const caseId = await freshEvidenceIntakeCase();
    expect((await upload(caseId, Buffer.from("Original evidence", "utf8"), "original.txt")).status).toBe(200);
    const original = await prisma.evidenceItem.findFirstOrThrow({ where: { caseId } });
    const beforeObjects = await objectsFor(caseId);
    const res = await upload(caseId, PE_EXE, "replacement.exe", original.id);
    expect(res.status).toBe(400);
    expect(await prisma.evidenceItem.count({ where: { caseId } })).toBe(1);
    expect((await objectsFor(caseId)).map(item => item.Key).sort()).toEqual(beforeObjects.map(item => item.Key).sort());
  }, 60_000);

  it("control: small valid PNG, PDF and UTF-8 text uploads are still accepted CLEAN", async () => {
    const caseId = await freshEvidenceIntakeCase();
    for (const [content, filename] of [[TINY_PNG, "ok.png"], [TINY_PDF, "ok.pdf"], [Buffer.from("Texte UTF-8 valide.", "utf8"), "ok.txt"]] as const) {
      const res = await upload(caseId, content, filename);
      expect(res.status).toBe(200);
    }
    const items = await prisma.evidenceItem.findMany({ where: { caseId } });
    expect(items).toHaveLength(3);
    expect(items.every(i => i.scanStatus === "CLEAN")).toBe(true);
    expect(items.map(i => i.mimeType).sort()).toEqual(["application/pdf", "image/png", "text/plain"]);
  }, 60_000);
});
