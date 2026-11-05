import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileTypeFromBuffer } from "file-type";
import { downloadBuffer } from "./storage";

const execute = promisify(execFile);
export const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 12000;
export const MAX_EVIDENCE_FILES = 12;
export const MAX_CASE_EXTRACTED_CHARACTERS = 60000;
export const MAX_PDF_PAGES = 20;
const SUPPORTED_EVIDENCE_MIME_TYPES = new Set([
  "text/plain", "application/pdf", "image/png", "image/jpeg", "image/tiff", "image/webp",
]);
const MAX_PDF_OCR_PAGE_IMAGE_BYTES = 16 * 1024 * 1024;
const PDF_OCR_TOTAL_TIMEOUT_MS = 90_000;
const PDF_OCR_RENDER_TIMEOUT_MS = 30_000;
const PDF_OCR_PAGE_TIMEOUT_MS = 8_000;
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
      : method === "tesseract"
        ? "OCR-extracted text may contain recognition errors. Verify quotations against the original; extraction does not verify factual claims."
        : "Machine-extracted text; verify quotations against the original. Extraction does not verify factual claims.",
  };
}

async function extractPdfText(input: string, dir: string, onOcr: () => void): Promise<EvidenceExtraction> {
  const pdfinfo = process.env.AEQUITAS_PDFINFO_PATH || "pdfinfo";
  const { stdout: info } = await execute(pdfinfo, [input], { timeout: 15000, maxBuffer: 64 * 1024, encoding: "utf8" });
  const totalPages = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1] ?? 0);
  if (!Number.isSafeInteger(totalPages) || totalPages < 1) throw new Error("PDF page count could not be established.");

  const pageCount = Math.min(totalPages, MAX_PDF_PAGES);
  const pdftotext = process.env.AEQUITAS_PDFTOTEXT_PATH || "pdftotext";
  const { stdout } = await execute(pdftotext, ["-f", "1", "-l", String(MAX_PDF_PAGES), "-enc", "UTF-8", input, "-"], {
    timeout: 15000, maxBuffer: 512 * 1024, encoding: "utf8",
  });
  const pageTexts = stdout.split("\f").slice(0, pageCount);
  while (pageTexts.length < pageCount) pageTexts.push("");
  const pagesNeedingOcr = pageTexts.flatMap((text, index) => text.trim() ? [] : [index + 1]);
  if (!pagesNeedingOcr.length) return finish(stdout, "pdftotext", totalPages > MAX_PDF_PAGES);

  const startedAt = Date.now();
  onOcr();
  const rasterizer = process.env.AEQUITAS_PDFTOPPM_PATH || "pdftoppm";
  const tesseract = process.env.AEQUITAS_TESSERACT_PATH || "tesseract";
  const languages = process.env.AEQUITAS_OCR_LANGUAGES || "eng+fra";
  let ocrIncomplete = false;
  for (const pageNumber of pagesNeedingOcr) {
    const remaining = PDF_OCR_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("PDF OCR exceeded its total time limit.");
    const prefix = join(dir, `ocr-page-${pageNumber}`);
    const imagePath = `${prefix}.png`;
    try {
      await execute(rasterizer, [
        "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", "-scale-to", "2000", "-png", input, prefix,
      ], { timeout: Math.min(PDF_OCR_RENDER_TIMEOUT_MS, remaining), maxBuffer: 64 * 1024, encoding: "utf8" });
      const imageBytes = (await stat(imagePath)).size;
      if (imageBytes > MAX_PDF_OCR_PAGE_IMAGE_BYTES) throw new Error(`Rendered PDF page ${pageNumber} exceeds the OCR size limit.`);
      const timeLeft = PDF_OCR_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
      if (timeLeft <= 0) throw new Error("PDF OCR exceeded its total time limit.");
      const { stdout: ocrText } = await execute(tesseract, [imagePath, "stdout", "-l", languages, "--psm", "6"], {
        timeout: Math.min(PDF_OCR_PAGE_TIMEOUT_MS, timeLeft),
        maxBuffer: 512 * 1024,
        encoding: "utf8",
        env: { ...process.env, OMP_THREAD_LIMIT: "1" },
      });
      pageTexts[pageNumber - 1] = ocrText.trimEnd();
      if (!ocrText.trim()) ocrIncomplete = true;
    } finally {
      await rm(imagePath, { force: true });
    }
  }
  return finish(pageTexts.join("\n\f\n"), "tesseract", totalPages > MAX_PDF_PAGES || ocrIncomplete);
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
  let method: EvidenceExtraction["method"] = pdf ? "pdftotext" : "tesseract";
  try {
    const input = join(dir, "source");
    await writeFile(input, buffer, { mode: 0o600 });
    if (pdf) {
      const pdfText = await extractPdfText(input, dir, () => { method = "tesseract"; });
      return pdfText;
    }
    const tesseract = process.env.AEQUITAS_TESSERACT_PATH || "tesseract";
    const { stdout } = await execute(tesseract, [input, "stdout", "-l", process.env.AEQUITAS_OCR_LANGUAGES || "eng+fra", "--psm", "6"], {
      timeout: 15000, maxBuffer: 512 * 1024, encoding: "utf8", env: { ...process.env, OMP_THREAD_LIMIT: "1" },
    });
    return finish(stdout, "tesseract");
  } catch {
    return { status: "unavailable", method, text: "", note: "Extraction failed or exceeded a resource limit. Check the configured binaries and language packs; metadata only." };
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
