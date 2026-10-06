import { createHash } from "node:crypto";
import type { GlobalRole } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { downloadBuffer, evidenceObjectKey } from "../lib/storage";
import { caseReadAccess } from "./caseAccess";
import { appendEvent } from "./events";

const SERVEABLE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/tiff", "image/webp", "text/plain"]);

const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/tiff": ".tif",
  "image/webp": ".webp",
  "text/plain": ".txt",
};

/** A download name that cannot break a Content-Disposition header. */
export function evidenceDownloadFilename(title: string, mimeType: string): string {
  const ext = EXTENSIONS[mimeType] ?? ".bin";
  const cleaned = title
    .replace(/[\r\n\t"]/g, " ")
    .replace(/[^\p{L}\p{N} ._()\-]+/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
  const base = cleaned.length > 0 ? cleaned : "evidence";
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
}

export function attachmentContentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\;]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function evidenceContentType(mimeType: string): string {
  return SERVEABLE_TYPES.has(mimeType) ? mimeType : "application/octet-stream";
}

export function evidenceDownloadHeaders(input: { mimeType: string; contentDisposition: string; byteLength: number }): Record<string, string> {
  return {
    "Content-Type": input.mimeType,
    "Content-Disposition": input.contentDisposition,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Length": String(input.byteLength),
  };
}

export type EvidenceDownload =
  | { ok: true; body: Buffer; mimeType: string; contentDisposition: string }
  | { ok: false; status: 404 | 500 };

/**
 * Parties and the assigned case manager may read a CLEAN evidence file.
 * The storage key must be the one this case's simulated flag implies
 * (`live/` or `simulated/`). A hash mismatch or a failed audit write
 * refuses the bytes.
 */
export async function downloadCleanEvidence(input: {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
  evidenceId: string;
}): Promise<EvidenceDownload> {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return { ok: false, status: 404 };
  const access = caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole });
  if (access !== "party" && access !== "assigned-manager") return { ok: false, status: 404 };

  const item = await prisma.evidenceItem.findFirst({ where: { id: input.evidenceId, caseId: input.caseId } });
  if (!item || item.scanStatus !== "CLEAN") return { ok: false, status: 404 };
  if (item.simulated !== caseRow.simulated) return { ok: false, status: 404 };
  if (item.storageKey !== evidenceObjectKey(caseRow.simulated, caseRow.id, item.id)) return { ok: false, status: 404 };

  let body: Buffer;
  try {
    body = await downloadBuffer(item.storageKey);
  } catch {
    console.error("Evidence download failed.");
    return { ok: false, status: 500 };
  }

  const sha256 = createHash("sha256").update(body).digest("hex");
  if (sha256 !== item.sha256) {
    console.error("Evidence integrity check failed.");
    return { ok: false, status: 500 };
  }

  try {
    await prisma.$transaction((tx) =>
      appendEvent(tx, {
        caseId: input.caseId,
        type: "EVIDENCE_ACCESSED",
        actorId: input.actorId,
        payload: { evidenceItemId: item.id },
      })
    );
  } catch {
    console.error("Evidence access could not be recorded.");
    return { ok: false, status: 500 };
  }

  return {
    ok: true,
    body,
    mimeType: evidenceContentType(item.mimeType),
    contentDisposition: attachmentContentDisposition(evidenceDownloadFilename(item.title, item.mimeType)),
  };
}
