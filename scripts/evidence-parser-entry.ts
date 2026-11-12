import { rm } from "node:fs/promises";
import { parserHealthcheck, startEvidenceParserService } from "./evidence-parser-service";

async function main(): Promise<void> {
  const socketPath = process.env.AEQUITAS_EVIDENCE_PARSER_SOCKET;
  if (!socketPath) throw new Error("AEQUITAS_EVIDENCE_PARSER_SOCKET is required.");
  if (process.argv.includes("--healthcheck")) {
    await parserHealthcheck(socketPath);
    return;
  }
  const server = await startEvidenceParserService(socketPath);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => { void rm(socketPath, { force: true }); });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch(() => { process.exitCode = 1; });
