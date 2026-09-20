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
    expect(extracted.status).toBe("bounded");
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
});
