import { request } from "node:http";
import {
  MAX_EVIDENCE_BYTES,
  MAX_EXTRACTED_CHARACTERS,
  unavailableEvidence,
  type EvidenceExtraction,
  type SupportedEvidenceMime,
} from "./evidenceExtractionShared";

const MAX_RESPONSE_BYTES = MAX_EXTRACTED_CHARACTERS * 8 + 8192;
const DEFAULT_TIMEOUT_MS = 100_000;

const VALID_STATUSES = new Set<EvidenceExtraction["status"]>([
  "extracted", "bounded", "empty", "unsupported", "unavailable",
]);
const VALID_METHODS = new Set<EvidenceExtraction["method"]>([
  "utf8", "pdftotext", "tesseract", "none",
]);

function isEvidenceExtraction(value: unknown): value is EvidenceExtraction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!VALID_STATUSES.has(candidate.status as EvidenceExtraction["status"])) return false;
  if (!VALID_METHODS.has(candidate.method as EvidenceExtraction["method"])
    || typeof candidate.text !== "string"
    || candidate.text.length > MAX_EXTRACTED_CHARACTERS
    || typeof candidate.note !== "string"
    || candidate.note.length > 2048) return false;
  if ((candidate.status === "unsupported" || candidate.status === "unavailable") && candidate.text !== "") return false;
  if (candidate.status === "empty" && candidate.text.trim() !== "") return false;
  if ((candidate.status === "extracted" || candidate.status === "bounded")
    && (candidate.method === "none" || !candidate.text.trim())) return false;
  return true;
}

/** Send only evidence bytes and their already-validated MIME type over the private Unix socket. */
export function requestEvidenceExtraction(buffer: Buffer, mime: SupportedEvidenceMime): Promise<EvidenceExtraction> {
  if (buffer.length > MAX_EVIDENCE_BYTES) throw new Error("Evidence exceeds the extraction size limit.");
  const socketPath = process.env.AEQUITAS_EVIDENCE_PARSER_SOCKET?.trim();
  if (!socketPath) {
    return Promise.resolve(unavailableEvidence("The isolated evidence parser is not configured; staff review is required."));
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: EvidenceExtraction) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const requestTimeoutMs = Number.parseInt(process.env.AEQUITAS_EVIDENCE_PARSER_TIMEOUT_MS ?? "", 10);
    const timeoutMs = Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 1000 && requestTimeoutMs <= 120_000
      ? requestTimeoutMs
      : DEFAULT_TIMEOUT_MS;
    const req = request({
      socketPath,
      path: "/extract",
      method: "POST",
      agent: false,
      headers: {
        "content-type": "application/octet-stream",
        "x-aequitas-evidence-mime": mime,
        "content-length": String(buffer.length),
        connection: "close",
      },
    }, (res) => {
      const contentLength = res.headers["content-length"];
      const responseLength = typeof contentLength === "string" && /^\d+$/.test(contentLength)
        ? Number(contentLength)
        : null;
      if (responseLength === null || responseLength > MAX_RESPONSE_BYTES) {
        res.destroy();
        finish(unavailableEvidence("The isolated evidence parser returned an invalid response; staff review is required."));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      let oversized = false;
      res.on("data", (chunk: Buffer | string) => {
        if (oversized) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > MAX_RESPONSE_BYTES) {
          oversized = true;
          res.destroy();
          finish(unavailableEvidence("The isolated evidence parser returned an invalid response; staff review is required."));
          return;
        }
        chunks.push(bytes);
      });
      res.on("end", () => {
        if (res.statusCode !== 200 || oversized || received !== responseLength) {
          finish(unavailableEvidence("The isolated evidence parser could not process this file; staff review is required."));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(isEvidenceExtraction(parsed)
            ? parsed
            : unavailableEvidence("The isolated evidence parser returned an invalid response; staff review is required."));
        } catch {
          finish(unavailableEvidence("The isolated evidence parser returned an invalid response; staff review is required."));
        }
      });
      res.on("error", () => finish(unavailableEvidence("The isolated evidence parser could not process this file; staff review is required.")));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Evidence parser request timed out.")));
    req.on("error", () => finish(unavailableEvidence("The isolated evidence parser is unavailable; staff review is required.")));
    req.end(buffer);
  });
}
