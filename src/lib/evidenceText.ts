import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileTypeFromBuffer } from "file-type";
import { downloadBuffer } from "./storage";

const execute = promisify(execFile);
export const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 12000;
const SUPPORTED_EVIDENCE_MIME_TYPES = new Set([
  "text/plain", "application/pdf", "image/png", "image/jpeg", "image/tiff", "image/webp",
]);
export type EvidenceExtraction = {
  status: "extracted" | "bounded" | "empty" | "unsupported" | "unavailable";
  method: "utf8" | "pdftotext" | "tesseract" | "none";
  text: string;
  note: string;
};

/** Plain text has no magic number. Accept valid UTF-8 without binary control bytes. */
export function decodePlainText(buffer: Buffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return /[\u0000-\u0008\u000b\u000e-\u001f]/.test(text) ? null : text;
  } catch { return null; }
}

export async function detectEvidenceMime(buffer: Buffer): Promise<string | null> {
  const sniffed = await fileTypeFromBuffer(buffer);
  if (sniffed) return sniffed.mime;
  return buffer.length > 0 && decodePlainText(buffer) !== null ? "text/plain" : null;
}

export function isSupportedEvidenceMime(mime: string): boolean {
  return SUPPORTED_EVIDENCE_MIME_TYPES.has(mime);
}

function finish(text: string, method: EvidenceExtraction["method"], bounded = false): EvidenceExtraction {
  // Store the parser's exact text; excerpt matching uses this same snapshot.
  const shortened = text.length > MAX_EXTRACTED_CHARACTERS;
  return {
    status: !text.trim() ? "empty" : bounded || shortened ? "bounded" : "extracted",
    method, text: text.slice(0, MAX_EXTRACTED_CHARACTERS),
    note: !text.trim() ? "No readable text was extracted; visual inspection may still be required."
      : bounded || shortened ? "Only a bounded extract is available. Inspect the original for omitted content."
      : "Machine-extracted text; verify quotations against the original. Extraction does not verify factual claims.",
  };
}

/** Only called on CLEAN case evidence. Native tools have byte, page, time and output bounds. */
export async function extractEvidenceText(buffer: Buffer, mime: string): Promise<EvidenceExtraction> {
  if (buffer.length > MAX_EVIDENCE_BYTES) throw new Error("Evidence exceeds the extraction size limit.");
  if (mime === "text/plain") {
    const decoded = decodePlainText(buffer);
    return decoded === null ? { status: "unsupported", method: "none", text: "", note: "The file is not valid UTF-8 text." } : finish(decoded, "utf8");
  }
  const pdf = mime === "application/pdf";
  const image = isSupportedEvidenceMime(mime) && mime.startsWith("image/");
  if (!pdf && !image) return { status: "unsupported", method: "none", text: "", note: "This file format has no configured text extractor; metadata only." };
  const dir = await mkdtemp(join(tmpdir(), "aequitas-extract-"));
  try {
    const input = join(dir, "source");
    await writeFile(input, buffer, { mode: 0o600 });
    const command = pdf ? process.env.AEQUITAS_PDFTOTEXT_PATH || "pdftotext" : process.env.AEQUITAS_TESSERACT_PATH || "tesseract";
    const args = pdf ? ["-f", "1", "-l", "20", "-enc", "UTF-8", input, "-"]
      : [input, "stdout", "-l", process.env.AEQUITAS_OCR_LANGUAGES || "eng", "--psm", "6"];
    const { stdout } = await execute(command, args, { timeout: 15000, maxBuffer: 512 * 1024, encoding: "utf8", env: { ...process.env, OMP_THREAD_LIMIT: "1" } });
    return finish(stdout, pdf ? "pdftotext" : "tesseract", pdf);
  } catch {
    return { status: "unavailable", method: pdf ? "pdftotext" : "tesseract", text: "", note: "Extraction failed or exceeded a resource limit. Check the configured binary and language packs; metadata only." };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function extractStoredEvidence(item: { storageKey: string; sha256: string; byteSize: number; mimeType: string }): Promise<EvidenceExtraction> {
  if (item.byteSize > MAX_EVIDENCE_BYTES) throw new Error("Evidence exceeds the extraction size limit.");
  const buffer = await downloadBuffer(item.storageKey);
  if (buffer.length !== item.byteSize || createHash("sha256").update(buffer).digest("hex") !== item.sha256) {
    throw new Error("Evidence integrity check failed. The stored file does not match its intake record.");
  }
  return extractEvidenceText(buffer, item.mimeType);
}
