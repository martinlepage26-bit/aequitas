import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { downloadBuffer } from "./storage";
import {
  decodePlainText,
  extractPlainTextEvidence,
  isSupportedEvidenceMime,
  MAX_EVIDENCE_BYTES,
  unsupportedEvidence,
  type EvidenceExtraction,
} from "./evidenceExtractionShared";
import { requestEvidenceExtraction } from "./evidenceParserClient";

export {
  decodePlainText,
  isSupportedEvidenceMime,
  MAX_CASE_EXTRACTED_CHARACTERS,
  MAX_EVIDENCE_BYTES,
  MAX_EVIDENCE_FILES,
  MAX_EXTRACTED_CHARACTERS,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_PDF_PAGES,
  type EvidenceExtraction,
} from "./evidenceExtractionShared";

export async function detectEvidenceMime(buffer: Buffer): Promise<string | null> {
  const sniffed = await fileTypeFromBuffer(buffer);
  if (sniffed) return sniffed.mime;
  return buffer.length > 0 && decodePlainText(buffer) !== null ? "text/plain" : null;
}

/** Plain text needs no native parser; PDFs and images are sent to the isolated service. */
export async function extractEvidenceText(buffer: Buffer, mime: string): Promise<EvidenceExtraction> {
  if (buffer.length > MAX_EVIDENCE_BYTES) throw new Error("Evidence exceeds the extraction size limit.");
  if (mime === "text/plain") return extractPlainTextEvidence(buffer);
  if (!isSupportedEvidenceMime(mime)) {
    return unsupportedEvidence("This file format has no configured text extractor; metadata only.");
  }
  return requestEvidenceExtraction(buffer, mime);
}

export async function extractStoredEvidence(item: { storageKey: string; sha256: string; byteSize: number; mimeType: string }): Promise<EvidenceExtraction> {
  if (item.byteSize > MAX_EVIDENCE_BYTES) throw new Error("Evidence exceeds the extraction size limit.");
  const buffer = await downloadBuffer(item.storageKey);
  if (buffer.length !== item.byteSize || createHash("sha256").update(buffer).digest("hex") !== item.sha256) {
    throw new Error("Evidence integrity check failed. The stored file does not match its intake record.");
  }
  return extractEvidenceText(buffer, item.mimeType);
}
