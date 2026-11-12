import { createServer, request, type Server } from "node:http";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isAutomaticallyExtractableEvidenceMime,
  MAX_EVIDENCE_BYTES,
  type EvidenceExtraction,
} from "../src/lib/evidenceExtractionShared";
import { extractEvidenceTextLocally } from "../src/lib/evidenceParserCore";
import { unavailableEvidence } from "../src/lib/evidenceExtractionShared";

const SOCKET_PATH = process.env.AEQUITAS_EVIDENCE_PARSER_SOCKET;
const MAX_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 100_000;

function respond(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(bytes);
}

function isParserMime(value: string | string[] | undefined): value is string {
  return typeof value === "string" && isAutomaticallyExtractableEvidenceMime(value);
}

export async function startEvidenceParserService(socketPath = SOCKET_PATH): Promise<Server> {
  if (!socketPath) throw new Error("AEQUITAS_EVIDENCE_PARSER_SOCKET is required.");
  await mkdir(dirname(socketPath), { recursive: true });
  try {
    const previous = await lstat(socketPath);
    if (!previous.isSocket()) throw new Error("Evidence parser socket path exists and is not a socket.");
    await rm(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let active = false;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      respond(res, 200, { status: "ok" });
      return;
    }
    if (req.method !== "POST" || req.url !== "/extract") {
      req.resume();
      respond(res, 404, { error: "not_found" });
      return;
    }
    if (active) {
      req.resume();
      respond(res, 503, { error: "busy" });
      return;
    }
    const mime = req.headers["x-aequitas-evidence-mime"];
    if (!isParserMime(mime)) {
      req.resume();
      respond(res, 415, { error: "unsupported_mime" });
      return;
    }
    const contentLength = req.headers["content-length"];
    const declaredLength = typeof contentLength === "string" && /^\d+$/.test(contentLength)
      ? Number(contentLength)
      : null;
    if (declaredLength === null || !Number.isSafeInteger(declaredLength)) {
      req.resume();
      respond(res, 411, { error: "content_length_required" });
      return;
    }
    if (declaredLength > MAX_EVIDENCE_BYTES) {
      req.resume();
      respond(res, 413, { error: "too_large" });
      return;
    }

    active = true;
    let totalBytes = 0;
    let oversized = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      if (oversized) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > MAX_EVIDENCE_BYTES) {
        oversized = true;
        chunks.length = 0;
        respond(res, 413, { error: "too_large" });
        return;
      }
      chunks.push(bytes);
    });
    let parsing = false;
    req.on("aborted", () => { if (!parsing) active = false; });
    req.on("error", () => { if (!parsing) active = false; });
    req.on("end", async () => {
      parsing = true;
      try {
        if (oversized) return;
        if (Number.isSafeInteger(declaredLength) && declaredLength !== totalBytes) {
          respond(res, 400, { error: "invalid_length" });
          return;
        }
        let result: EvidenceExtraction;
        try {
          result = await extractEvidenceTextLocally(Buffer.concat(chunks, totalBytes), mime);
        } catch {
          result = unavailableEvidence("Extraction failed or exceeded a resource limit. Staff review is required.");
        }
        const response = Buffer.from(JSON.stringify(result));
        if (response.length > MAX_RESPONSE_BYTES) {
          respond(res, 500, { error: "response_too_large" });
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(response.length),
          "cache-control": "no-store",
          connection: "close",
        });
        res.end(response);
      } finally {
        active = false;
      }
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.maxHeadersCount = 16;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o660);
  return server;
}

export async function parserHealthcheck(socketPath = SOCKET_PATH): Promise<void> {
  if (!socketPath) throw new Error("Evidence parser socket is not configured.");
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, path: "/health", method: "GET", agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode === 200 && body === JSON.stringify({ status: "ok" })) resolve();
        else reject(new Error("Evidence parser is unhealthy."));
      });
    });
    req.setTimeout(1000, () => req.destroy(new Error("Evidence parser healthcheck timed out.")));
    req.once("error", reject);
    req.end();
  });
}
