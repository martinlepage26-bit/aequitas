import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
const download = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/storage", () => ({ downloadBuffer: download }));
// This suite isolates extraction/integrity; DB-backed fencing has its own concurrency tests.
vi.mock("../../src/lib/caseOperation", () => ({
  withCaseOperation: (_caseId: string, _kind: string, fn: () => Promise<unknown>) => fn(),
  caseOperationExternalIO: (_caseId: string, fn: () => Promise<unknown>) => fn(),
}));
import {
  decodePlainText,
  detectEvidenceMime,
  extractEvidenceText,
  extractStoredEvidence,
  MAX_EXTRACTED_CHARACTERS,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
} from "../../src/lib/evidenceText";

function pngHeader(width: number, height: number) {
  const buffer = Buffer.alloc(57);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.write("IDAT", 37, "ascii");
  buffer.write("IEND", 49, "ascii");
  return buffer;
}

function jpegHeader(width: number, height: number) {
  const buffer = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ]);
  return buffer;
}

function webpHeader(width: number, height: number) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

describe("source text extraction", () => {
  it("recognizes UTF-8 text without trusting a client MIME declaration", async () => {
    expect(await detectEvidenceMime(Buffer.from("Équité et révision\nPolicy record"))).toBe("text/plain");
    expect(decodePlainText(Buffer.from([0, 1, 2, 255]))).toBeNull();
    expect(await detectEvidenceMime(Buffer.from([0, 1, 2, 255]))).toBeNull();
  });
  it("preserves exact bilingual text and records truncation", async () => {
    const original = "Équité et révision\nPolicy record\n";
    expect((await extractEvidenceText(Buffer.from(original), "text/plain")).text).toBe(original);
    const bounded = await extractEvidenceText(Buffer.from("a".repeat(MAX_EXTRACTED_CHARACTERS + 1)), "text/plain");
    expect(bounded.status).toBe("bounded");
    expect(bounded.text).toHaveLength(MAX_EXTRACTED_CHARACTERS);
  });
  it.each(["application/zip", "image/tiff"])("never fabricates extracted text for %s", async (mime) => {
    const result = await extractEvidenceText(Buffer.from("synthetic evidence"), mime);
    expect(result).toMatchObject({ status: "unsupported", method: "none", text: "" });
    if (mime === "image/tiff") expect(result.note).toContain("staff must review");
  });
  it.each([
    ["PNG", "image/png", pngHeader, MAX_IMAGE_PIXELS + 1, 1],
    ["JPEG", "image/jpeg", jpegHeader, 4000, 4000],
    ["WebP", "image/webp", webpHeader, MAX_IMAGE_PIXELS + 1, 1],
  ])("rejects %s rasters over the decoded-pixel limit before OCR", async (_name, mime, makeHeader, width, height) => {
    const result = await extractEvidenceText(makeHeader(width, height), mime);
    expect(result).toMatchObject({ status: "unavailable", method: "none", text: "" });
    expect(result.note).toMatch(/dimensions could not be safely processed/);
  });
  it("rejects a raster with one axis beyond the OCR dimension limit", async () => {
    const result = await extractEvidenceText(pngHeader(MAX_IMAGE_DIMENSION + 1, 1), "image/png");
    expect(result).toMatchObject({ status: "unavailable", method: "none", text: "" });
  });
  it("refuses malformed raster headers without starting OCR", async () => {
    const result = await extractEvidenceText(Buffer.alloc(24), "image/png");
    expect(result).toMatchObject({ status: "unavailable", method: "none", text: "" });
  });
  it("does not pass application secrets to the OCR subprocess", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aequitas-ocr-env-test-"));
    const executable = join(dir, "tesseract");
    await writeFile(executable, [
      "#!/bin/sh",
      "printf '%s|%s|%s|%s|%s' \"${GEMINI_API_KEY:-missing}\" \"${DATABASE_URL:-missing}\" \"${HOME:-missing}\" \"${TMPDIR:-missing}\" \"$PWD\"",
      "",
    ].join("\n"), { mode: 0o700 });
    vi.stubEnv("GEMINI_API_KEY", "synthetic-provider-secret");
    vi.stubEnv("DATABASE_URL", "postgres://synthetic-database-secret");
    vi.stubEnv("AEQUITAS_TESSERACT_PATH", executable);
    try {
      const result = await extractEvidenceText(pngHeader(100, 100), "image/png");
      expect(result.status).toBe("extracted");
      const [providerKey, databaseUrl, home, temp, workingDirectory] = result.text.split("|");
      expect(providerKey).toBe("missing");
      expect(databaseUrl).toBe("missing");
      expect(home).toMatch(/\/aequitas-extract-[^/]+$/);
      expect(temp).toBe(home);
      expect(basename(workingDirectory)).toBe(basename(home));
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("routes animated PNG and WebP to staff", async () => {
    const png = pngHeader(100, 100);
    const animationControl = Buffer.alloc(20);
    animationControl.writeUInt32BE(8, 0);
    animationControl.write("acTL", 4, "ascii");
    animationControl.writeUInt32BE(2, 8);
    const animatedPng = Buffer.concat([png.subarray(0, 33), animationControl, png.subarray(33)]);
    const animatedWebp = webpHeader(100, 100);
    animatedWebp[20] = 0x02;
    for (const [mime, body] of [
      ["image/png", animatedPng],
      ["image/webp", animatedWebp],
    ] as const) {
      expect(await extractEvidenceText(body, mime)).toMatchObject({ status: "unavailable", method: "none", text: "" });
    }
  });
  it("retains selectable PDF text when OCR also reads an embedded image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aequitas-pdf-extraction-test-"));
    const environmentLog = join(dir, "child-environment.log");
    const environmentProbe = "printf '%s|%s|%s|%s|%s|%s\\n' \"${GEMINI_API_KEY:-missing}\" \"${DATABASE_URL:-missing}\" \"${RESEND_API_KEY:-missing}\" \"${HOME:-missing}\" \"${TMPDIR:-missing}\" \"$PWD\" >> '" + environmentLog + "'";
    const executable = async (name: string, body: string) => {
      const path = join(dir, name);
      await writeFile(path, `#!/bin/sh\nset -eu\n${environmentProbe}\n${body}\n`, { mode: 0o700 });
      return path;
    };
    try {
      const pdfinfo = await executable("pdfinfo", "printf 'Pages: 1\\n'");
      const pdftotext = await executable("pdftotext", "printf 'SELECTABLE_TEXT\\n'");
      const pdfimages = await executable("pdfimages", "printf '1 0 image 100 100 8 300 300 3 rgb\\n'");
      const pdftoppm = await executable("pdftoppm", "for arg do last=\"$arg\"; done\nprintf 'png' > \"$last.png\"");
      const tesseract = await executable("tesseract", "printf 'OCR_VISIBLE_TEXT\\n'");
      vi.stubEnv("AEQUITAS_PDFINFO_PATH", pdfinfo);
      vi.stubEnv("AEQUITAS_PDFTOTEXT_PATH", pdftotext);
      vi.stubEnv("AEQUITAS_PDFIMAGES_PATH", pdfimages);
      vi.stubEnv("AEQUITAS_PDFTOPPM_PATH", pdftoppm);
      vi.stubEnv("AEQUITAS_TESSERACT_PATH", tesseract);
      vi.stubEnv("GEMINI_API_KEY", "synthetic-provider-secret");
      vi.stubEnv("DATABASE_URL", "postgres://synthetic-database-secret");
      vi.stubEnv("RESEND_API_KEY", "synthetic-email-secret");

      const result = await extractEvidenceText(Buffer.from("%PDF-synthetic"), "application/pdf");
      expect(result.status).toBe("extracted");
      expect(result.text).toContain("SELECTABLE_TEXT");
      expect(result.text).toContain("OCR_VISIBLE_TEXT");
      const observations = (await readFile(environmentLog, "utf8")).trim().split("\n").map((line) => line.split("|"));
      expect(observations).toHaveLength(5);
      for (const [providerKey, databaseUrl, emailKey, home, temp, workingDirectory] of observations) {
        expect([providerKey, databaseUrl, emailKey]).toEqual(["missing", "missing", "missing"]);
        expect(home).toMatch(/\/aequitas-extract-[^/]+$/);
        expect(temp).toBe(home);
        expect(basename(workingDirectory)).toBe(basename(home));
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("verifies byte size and intake hash before parsing", async () => {
    const body = Buffer.from("Authentic source text.");
    download.mockResolvedValue(body);
    const item = { caseId: "test-case", storageKey: "simulated/test/file", byteSize: body.length, sha256: createHash("sha256").update(body).digest("hex"), mimeType: "text/plain" };
    expect((await extractStoredEvidence(item)).text).toBe(body.toString());
    await expect(extractStoredEvidence({ ...item, sha256: "0".repeat(64) })).rejects.toThrow("integrity check failed");
    await expect(extractStoredEvidence({ ...item, byteSize: 1 })).rejects.toThrow("integrity check failed");
  });
  it("reports unavailable parsers without storing invented content", async () => {
    vi.stubEnv("AEQUITAS_PDFTOTEXT_PATH", "/nonexistent/aequitas-parser");
    try { expect(await extractEvidenceText(Buffer.from("%PDF-1.7"), "application/pdf")).toMatchObject({ status: "unavailable", text: "" }); }
    finally { vi.unstubAllEnvs(); }
  });
});
