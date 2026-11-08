import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_EVIDENCE_BYTES } from "../../src/lib/evidenceExtractionShared";
import { requestEvidenceExtraction } from "../../src/lib/evidenceParserClient";

const servers: Server[] = [];
const directories: string[] = [];

async function serveResponse(options: { status?: number; body?: string; contentLength?: string }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aequitas-parser-client-test-"));
  directories.push(directory);
  const socketPath = join(directory, "parser.sock");
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (options.contentLength) {
        res.writeHead(options.status ?? 200, { "content-length": options.contentLength, connection: "close" });
        res.flushHeaders();
        res.destroy();
        return;
      }
      const body = options.body ?? "";
      res.writeHead(options.status ?? 200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        connection: "close",
      });
      res.end(body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  vi.stubEnv("AEQUITAS_EVIDENCE_PARSER_SOCKET", socketPath);
  return socketPath;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("isolated evidence parser client", () => {
  it("fails closed when no parser socket is configured", async () => {
    vi.stubEnv("AEQUITAS_EVIDENCE_PARSER_SOCKET", "");
    await expect(requestEvidenceExtraction(Buffer.from("%PDF"), "application/pdf"))
      .resolves.toMatchObject({ status: "unavailable", method: "none", text: "" });
  });

  it("fails closed on malformed JSON and semantically invalid extraction", async () => {
    await serveResponse({ body: "{not-json" });
    await expect(requestEvidenceExtraction(Buffer.from("%PDF"), "application/pdf"))
      .resolves.toMatchObject({ status: "unavailable", method: "none", text: "" });

    await serveResponse({ body: JSON.stringify({ status: "extracted", method: "none", text: "invented", note: "bad" }) });
    await expect(requestEvidenceExtraction(Buffer.from("%PDF"), "application/pdf"))
      .resolves.toMatchObject({ status: "unavailable", method: "none", text: "" });
  });

  it("rejects an oversized parser response and oversized input", async () => {
    await serveResponse({ contentLength: "200000" });
    await expect(requestEvidenceExtraction(Buffer.from("%PDF"), "application/pdf"))
      .resolves.toMatchObject({ status: "unavailable", method: "none", text: "" });
    expect(() => requestEvidenceExtraction(Buffer.alloc(MAX_EVIDENCE_BYTES + 1), "application/pdf"))
      .toThrow("extraction size limit");
  });
});
