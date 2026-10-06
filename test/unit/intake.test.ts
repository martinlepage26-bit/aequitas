import { describe, expect, it } from "vitest";
import { DISPUTE_DESCRIPTION_MAX, missingIntakeFields, normalizeAmountAtStake, normalizeDisputeDescription } from "../../src/domain/intake";
import { attachmentContentDisposition, evidenceContentType, evidenceDownloadFilename, evidenceDownloadHeaders } from "../../src/domain/evidenceAccess";

describe("intake fields", () => {
  it("requires a short dispute description and keeps an optional amount", () => {
    expect(normalizeDisputeDescription(undefined)).toEqual({ ok: false, reason: "disputeDescription is required." });
    expect(normalizeDisputeDescription("   ")).toEqual({ ok: false, reason: "disputeDescription is required." });
    expect(normalizeDisputeDescription("x".repeat(DISPUTE_DESCRIPTION_MAX + 1)).ok).toBe(false);
    expect(normalizeDisputeDescription("  The deposit was not returned.  ")).toEqual({ ok: true, description: "The deposit was not returned." });
    expect(missingIntakeFields({ disputeDescription: null })).toEqual(["disputeDescription"]);
    expect(missingIntakeFields({ disputeDescription: "  " })).toEqual(["disputeDescription"]);
    expect(missingIntakeFields({ disputeDescription: "The deposit was not returned." })).toEqual([]);

    expect(normalizeAmountAtStake(undefined)).toEqual({ ok: true, cents: null });
    expect(normalizeAmountAtStake("")).toEqual({ ok: true, cents: null });
    expect(normalizeAmountAtStake(1500.5)).toEqual({ ok: true, cents: 150050 });
    expect(normalizeAmountAtStake(-1).ok).toBe(false);
    expect(normalizeAmountAtStake(Number.NaN).ok).toBe(false);
  });
});

describe("evidence download headers", () => {
  it("uses an attachment name and refuses to sniff the body", () => {
    const filename = evidenceDownloadFilename('Receipt\r\n"final"', "text/plain");
    expect(filename).not.toMatch(/[\r\n"]/);
    expect(filename.endsWith(".txt")).toBe(true);
    const disposition = attachmentContentDisposition(filename);
    expect(disposition.startsWith("attachment;")).toBe(true);
    expect(disposition).not.toMatch(/[\r\n]/);
    const headers = evidenceDownloadHeaders({ mimeType: evidenceContentType("text/html"), contentDisposition: disposition, byteLength: 4 });
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Content-Disposition"]).toBe(disposition);
    expect(headers["Cache-Control"]).toBe("private, no-store");
  });
});
