import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEvidenceText } from "../../src/lib/evidenceText";

describe("native PDF and image extraction", () => {
  it("reads real PDF text and OCR text from a rendered page", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([600, 180]).drawText("POLICY REVIEW 2026", { x: 30, y: 90, size: 30, font });
    const buffer = Buffer.from(await pdf.save());
    const extracted = await extractEvidenceText(buffer, "application/pdf");
    expect(extracted.status).toBe("extracted");
    expect(extracted.text).toContain("POLICY REVIEW 2026");
    const dir = await mkdtemp(join(tmpdir(), "aequitas-ocr-test-"));
    try {
      await writeFile(join(dir, "source.pdf"), buffer);
      await promisify(execFile)("pdftoppm", ["-png", "-singlefile", "-r", "150", join(dir, "source.pdf"), join(dir, "page")], { timeout: 15000 });
      const image = await readFile(join(dir, "page.png"));
      const ocr = await extractEvidenceText(image, "image/png");
      expect(ocr.status).toBe("extracted");
      expect(ocr.text).toContain("POLICY REVIEW 2026");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30000);

  it("OCRs scanned pages in a mixed PDF while preserving its digital text", async () => {
    const source = await PDFDocument.create();
    const font = await source.embedFont(StandardFonts.Helvetica);
    source.addPage([600, 180]).drawText("SCANNED POLICY REVIEW 2026", { x: 30, y: 90, size: 28, font });
    const sourceBytes = Buffer.from(await source.save());
    const dir = await mkdtemp(join(tmpdir(), "aequitas-scanned-pdf-test-"));
    try {
      const sourcePath = join(dir, "source.pdf");
      await writeFile(sourcePath, sourceBytes);
      await promisify(execFile)("pdftoppm", ["-png", "-singlefile", "-r", "150", sourcePath, join(dir, "page")], { timeout: 15000 });
      const scannedPage = await readFile(join(dir, "page.png"));

      const mixed = await PDFDocument.create();
      const mixedFont = await mixed.embedFont(StandardFonts.Helvetica);
      mixed.addPage([600, 180]).drawText("DIGITAL PAGE MARKER 2026", { x: 30, y: 90, size: 28, font: mixedFont });
      const scannedPdfPage = mixed.addPage([600, 180]);
      const image = await mixed.embedPng(scannedPage);
      scannedPdfPage.drawImage(image, { x: 0, y: 0, width: 600, height: 180 });

      const extracted = await extractEvidenceText(Buffer.from(await mixed.save()), "application/pdf");
      expect(extracted.status).toBe("extracted");
      expect(extracted.method).toBe("tesseract");
      expect(extracted.text).toContain("DIGITAL PAGE MARKER 2026");
      expect(extracted.text).toContain("SCANNED POLICY REVIEW 2026");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60000);

  it("marks a PDF bounded only when it exceeds the twenty-page extraction cap", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let page = 1; page <= 21; page += 1) {
      pdf.addPage([300, 120]).drawText(`Page marker ${page}`, { x: 20, y: 60, size: 12, font });
    }
    const extracted = await extractEvidenceText(Buffer.from(await pdf.save()), "application/pdf");
    expect(extracted.status).toBe("bounded");
    expect(extracted.text).toContain("Page marker 1");
    expect(extracted.text).not.toContain("Page marker 21");
  }, 30000);
});
