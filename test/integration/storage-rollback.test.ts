import { randomUUID } from "node:crypto";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { submitEvidence } from "../../src/domain/mutate";
import type { EvidenceKind } from "../../src/generated/prisma";

let caseId: string;
let actorId: string;
const s3 = new S3Client({ endpoint: process.env.STORAGE_ENDPOINT, region: process.env.STORAGE_REGION, forcePathStyle: true, credentials: { accessKeyId: process.env.STORAGE_ACCESS_KEY!, secretAccessKey: process.env.STORAGE_SECRET_KEY! } });
const objects = async () => (await s3.send(new ListObjectsV2Command({ Bucket: process.env.STORAGE_BUCKET, Prefix: `simulated/${caseId}/` }))).Contents ?? [];
beforeAll(async () => {
  const actor = await prisma.user.create({ data: { email: `storage-actor-${randomUUID()}@example.com`, displayName: "Storage actor", globalRole: "COMPLAINANT" } });
  const respondent = await prisma.user.create({ data: { email: `storage-r-${randomUUID()}@example.com`, displayName: "Respondent", globalRole: "RESPONDENT" } });
  actorId = actor.id;
  const row = await prisma.case.create({ data: { referenceNumber: `STORAGE-${randomUUID()}`, state: "EVIDENCE_INTAKE", simulated: true, complainantId: actorId, respondentId: respondent.id } });
  caseId = row.id;
});
afterAll(async () => { s3.destroy(); await prisma.$disconnect(); });

describe("Evidence storage rollback against MinIO and ClamAV", () => {
  const fields = { actorRole: "COMPLAINANT" as const, title: "Rollback test", buffer: Buffer.from("Harmless test evidence."), mimeType: "text/plain" };
  it("removes the new object when a domain write fails after a successful upload", async () => {
    await expect(submitEvidence({ ...fields, caseId, actorId, kind: "INVALID" as EvidenceKind })).rejects.toThrow();
    expect(await objects()).toHaveLength(0);
    expect(await prisma.evidenceItem.count({ where: { caseId } })).toBe(0);
  });
  it("does not upload anything when the virus scanner is unavailable", async () => {
    vi.stubEnv("CLAMAV_PORT", "9");
    try { expect((await submitEvidence({ ...fields, caseId, actorId, kind: "DOCUMENT" })).ok).toBe(false); }
    finally { vi.unstubAllEnvs(); }
    expect(await objects()).toHaveLength(0);
  });
});
