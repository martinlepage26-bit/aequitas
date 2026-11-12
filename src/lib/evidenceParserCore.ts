import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  decodePlainText,
  finishEvidenceText,
  isAutomaticallyExtractableEvidenceMime,
  MAX_EVIDENCE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_PDF_PAGES,
  type EvidenceExtraction,
} from "./evidenceExtractionShared";

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

const execute = promisify(execFile);
const MAX_PDF_OCR_PAGE_IMAGE_BYTES = 16 * 1024 * 1024;
const PDF_OCR_TOTAL_TIMEOUT_MS = 90_000;
const PDF_OCR_RENDER_TIMEOUT_MS = 30_000;
const PDF_OCR_PAGE_TIMEOUT_MS = 8_000;

/** Untrusted evidence parsers must not inherit database, model or email secrets. */
function executeEvidenceTool(
  file: string,
  args: string[],
  dir: string,
  limits: { timeout: number; maxBuffer: number },
) {
  return execute(file, args, {
    ...limits,
    encoding: "utf8",
    cwd: dir,
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: dir,
      TMPDIR: dir,
      LANG: "C",
      LC_ALL: "C",
      OMP_THREAD_LIMIT: "1",
      NODE_ENV: "production",
    },
  });
}

type RasterDimensions = { width: number; height: number };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read dimensions from container headers without decoding attacker-controlled raster data. */
function rasterDimensions(buffer: Buffer, mime: string): RasterDimensions | null {
  if (mime === "image/png") {
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
    if (buffer.readUInt32BE(8) !== 13) return null;
    // Animated PNGs can contain many frames. They are routed to staff instead
    // of allowing OCR cost to scale with attacker-controlled frame count.
    let offset = 8;
    let sawEnd = false;
    while (offset + 12 <= buffer.length) {
      const chunkLength = buffer.readUInt32BE(offset);
      if (chunkLength > buffer.length - offset - 12) return null;
      const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
      if (chunkType === "acTL") return null;
      if (chunkType === "IEND") {
        sawEnd = chunkLength === 0;
        break;
      }
      offset += chunkLength + 12;
    }
    if (!sawEnd) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (mime === "image/jpeg") {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) return null;
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === undefined) return null;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) return null;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
      const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame) {
        if (segmentLength < 7) return null;
        return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
      }
      offset += segmentLength;
    }
    return null;
  }

  if (mime === "image/webp") {
    if (buffer.length < 25 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      if (buffer[20] & 0x02) return null; // Animated WebP.
      return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    }
    if (chunk === "VP8L" && buffer[20] === 0x2f && buffer.length >= 25) {
      const packed = buffer.readUInt32LE(21);
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    return null;
  }

  return null;
}

function rasterWithinOcrBounds(dimensions: RasterDimensions | null): dimensions is RasterDimensions {
  return Boolean(
    dimensions
    && Number.isSafeInteger(dimensions.width) && dimensions.width > 0 && dimensions.width <= MAX_IMAGE_DIMENSION
    && Number.isSafeInteger(dimensions.height) && dimensions.height > 0 && dimensions.height <= MAX_IMAGE_DIMENSION
    && dimensions.width <= MAX_IMAGE_PIXELS / dimensions.height,
  );
}

async function extractPdfText(input: string, dir: string, onOcr: () => void): Promise<EvidenceExtraction> {
  const pdfinfo = process.env.AEQUITAS_PDFINFO_PATH || "pdfinfo";
  const { stdout: info } = await executeEvidenceTool(pdfinfo, [input], dir, { timeout: 15000, maxBuffer: 64 * 1024 });
  const totalPages = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1] ?? 0);
  if (!Number.isSafeInteger(totalPages) || totalPages < 1) throw new Error("PDF page count could not be established.");

  const pageCount = Math.min(totalPages, MAX_PDF_PAGES);
  const pdftotext = process.env.AEQUITAS_PDFTOTEXT_PATH || "pdftotext";
  const { stdout } = await executeEvidenceTool(pdftotext, ["-f", "1", "-l", String(MAX_PDF_PAGES), "-enc", "UTF-8", input, "-"], dir, {
    timeout: 15000, maxBuffer: 512 * 1024,
  });
  // A page can contain selectable text and an embedded scan at the same time.
  // OCR every page with image objects, then retain both text layers so OCR
  // omissions cannot silently discard text that Poppler already extracted.
  const pdfimages = process.env.AEQUITAS_PDFIMAGES_PATH || "pdfimages";
  const { stdout: imageList } = await executeEvidenceTool(pdfimages, ["-list", input], dir, {
    timeout: 15000, maxBuffer: 128 * 1024,
  });
  const pagesWithImages = new Set([...imageList.matchAll(/^\s*(\d+)\s+\d+\s+(?:image|smask)\b/gm)].map((match) => Number(match[1])));
  const pageTexts = stdout.split("\f").slice(0, pageCount);
  while (pageTexts.length < pageCount) pageTexts.push("");
  const pagesNeedingOcr = pageTexts.flatMap((text, index) => text.trim() && !pagesWithImages.has(index + 1) ? [] : [index + 1]);
  if (!pagesNeedingOcr.length) return finishEvidenceText(stdout, "pdftotext", totalPages > MAX_PDF_PAGES);

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
      await executeEvidenceTool(rasterizer, [
        "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", "-scale-to", "2000", "-png", input, prefix,
      ], dir, { timeout: Math.min(PDF_OCR_RENDER_TIMEOUT_MS, remaining), maxBuffer: 64 * 1024 });
      const imageBytes = (await stat(imagePath)).size;
      if (imageBytes > MAX_PDF_OCR_PAGE_IMAGE_BYTES) throw new Error(`Rendered PDF page ${pageNumber} exceeds the OCR size limit.`);
      const timeLeft = PDF_OCR_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
      if (timeLeft <= 0) throw new Error("PDF OCR exceeded its total time limit.");
      const { stdout: ocrText } = await executeEvidenceTool(tesseract, [imagePath, "stdout", "-l", languages, "--psm", "6"], dir, {
        timeout: Math.min(PDF_OCR_PAGE_TIMEOUT_MS, timeLeft),
        maxBuffer: 512 * 1024,
      });
      const normalizedOcr = ocrText.trimEnd();
      const selectableText = pageTexts[pageNumber - 1].trimEnd();
      pageTexts[pageNumber - 1] = [selectableText, normalizedOcr].filter((text) => text.trim()).join("\n");
      if (!ocrText.trim()) ocrIncomplete = true;
    } finally {
      await rm(imagePath, { force: true });
    }
  }
  return finishEvidenceText(pageTexts.join("\n\f\n"), "tesseract", totalPages > MAX_PDF_PAGES || ocrIncomplete);
}

/** Only called on CLEAN case evidence. Native tools have byte, page, time and output bounds. */
export async function extractEvidenceTextLocally(buffer: Buffer, mime: string): Promise<EvidenceExtraction> {
  if (buffer.length > MAX_EVIDENCE_BYTES) throw new Error("Evidence exceeds the extraction size limit.");
  if (mime === "text/plain") {
    const decoded = decodePlainText(buffer);
    return decoded === null
      ? { status: "unsupported", method: "none", text: "", note: "The file is not valid UTF-8 text." }
      : finishEvidenceText(decoded, "utf8");
  }
  const pdf = mime === "application/pdf";
  const image = isAutomaticallyExtractableEvidenceMime(mime) && mime.startsWith("image/");
  if (!pdf && !image) return { status: "unsupported", method: "none", text: "", note: "This file format has no configured text extractor; metadata only." };
  if (image && !rasterWithinOcrBounds(rasterDimensions(buffer, mime))) {
    return { status: "unavailable", method: "none", text: "", note: "Image dimensions could not be safely processed within the OCR limit; metadata only." };
  }
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
    const { stdout } = await executeEvidenceTool(tesseract, [input, "stdout", "-l", process.env.AEQUITAS_OCR_LANGUAGES || "eng+fra", "--psm", "6"], dir, {
      timeout: 15000, maxBuffer: 512 * 1024,
    });
    return finishEvidenceText(stdout, "tesseract");
  } catch {
    return { status: "unavailable", method, text: "", note: "Extraction failed or exceeded a resource limit. Check the configured binaries and language packs; metadata only." };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
