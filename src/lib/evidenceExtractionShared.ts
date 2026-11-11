export const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 12000;
export const MAX_EVIDENCE_FILES = 12;
export const MAX_CASE_EXTRACTED_CHARACTERS = 60000;
export const MAX_PDF_PAGES = 20;
export const MAX_IMAGE_PIXELS = 12_000_000;
export const MAX_IMAGE_DIMENSION = 12_000;

export const SUPPORTED_EVIDENCE_MIME_TYPES = [
  "text/plain", "application/pdf", "image/png", "image/jpeg", "image/tiff", "image/webp",
] as const;

export type SupportedEvidenceMime = typeof SUPPORTED_EVIDENCE_MIME_TYPES[number];

// TIFF remains a valid stored evidence type, but the isolated native parser
// must not decode it while the candidate image contains undispositioned
// libtiff findings. Unsupported TIFF extraction hands the case to staff.
export const AUTOMATICALLY_EXTRACTABLE_EVIDENCE_MIME_TYPES = [
  "application/pdf", "image/png", "image/jpeg", "image/webp",
] as const;

export type AutomaticallyExtractableEvidenceMime = typeof AUTOMATICALLY_EXTRACTABLE_EVIDENCE_MIME_TYPES[number];

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

export function isSupportedEvidenceMime(mime: string): mime is SupportedEvidenceMime {
  return (SUPPORTED_EVIDENCE_MIME_TYPES as readonly string[]).includes(mime);
}

export function isAutomaticallyExtractableEvidenceMime(mime: string): mime is AutomaticallyExtractableEvidenceMime {
  return (AUTOMATICALLY_EXTRACTABLE_EVIDENCE_MIME_TYPES as readonly string[]).includes(mime);
}

export function finishEvidenceText(text: string, method: EvidenceExtraction["method"], bounded = false): EvidenceExtraction {
  const shortened = text.length > MAX_EXTRACTED_CHARACTERS;
  return {
    status: !text.trim() ? "empty" : bounded || shortened ? "bounded" : "extracted",
    method,
    text: text.slice(0, MAX_EXTRACTED_CHARACTERS),
    note: !text.trim() ? "No readable text was extracted; visual inspection may still be required."
      : bounded || shortened ? "Only a bounded extract is available. Inspect the original for omitted content."
      : method === "tesseract"
        ? "OCR-extracted text may contain recognition errors. Verify quotations against the original; extraction does not verify factual claims."
        : "Machine-extracted text; verify quotations against the original. Extraction does not verify factual claims.",
  };
}

export function unsupportedEvidence(note: string): EvidenceExtraction {
  return { status: "unsupported", method: "none", text: "", note };
}

export function unavailableEvidence(note: string, method: EvidenceExtraction["method"] = "none"): EvidenceExtraction {
  return { status: "unavailable", method, text: "", note };
}

export function extractPlainTextEvidence(buffer: Buffer): EvidenceExtraction {
  if (buffer.length > MAX_EVIDENCE_BYTES) throw new Error("Evidence exceeds the extraction size limit.");
  const decoded = decodePlainText(buffer);
  return decoded === null
    ? unsupportedEvidence("The file is not valid UTF-8 text.")
    : finishEvidenceText(decoded, "utf8");
}
