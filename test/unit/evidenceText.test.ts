import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
const download = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/storage", () => ({ downloadBuffer: download }));
import { decodePlainText, detectEvidenceMime, extractEvidenceText, extractStoredEvidence, MAX_EXTRACTED_CHARACTERS } from "../../src/lib/evidenceText";

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
  it("never fabricates extracted text for unsupported files", async () => {
    expect(await extractEvidenceText(Buffer.from("unused"), "application/zip")).toMatchObject({ status: "unsupported", text: "" });
  });
  it("verifies byte size and intake hash before parsing", async () => {
    const body = Buffer.from("Authentic source text.");
    download.mockResolvedValue(body);
    const item = { storageKey: "simulated/test/file", byteSize: body.length, sha256: createHash("sha256").update(body).digest("hex"), mimeType: "text/plain" };
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
