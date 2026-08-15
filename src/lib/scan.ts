import { Socket } from "node:net";

/**
 * Real ClamAV scanning via clamd's INSTREAM protocol (Section 3: "ClamAV
 * sidecar (dev)"). Hand-rolled rather than an npm wrapper — the wire
 * protocol is a handful of well-documented steps and stable for years, so
 * this avoids taking on an unfamiliar dependency's API surface for
 * something this small:
 *
 *   1. Send "nINSTREAM\n"
 *   2. Send the payload as <4-byte big-endian length><chunk> pairs
 *   3. Send a zero-length chunk to signal EOF
 *   4. Read one response line: "stream: OK" or "stream: <sig> FOUND"
 */

const CHUNK_SIZE = 64 * 1024;

export interface ScanResult {
  clean: boolean;
  signature: string | null;
}

export function scanBuffer(buffer: Buffer): Promise<ScanResult> {
  const host = process.env.CLAMAV_HOST ?? "localhost";
  const port = Number(process.env.CLAMAV_PORT ?? "3310");

  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let response = "";

    socket.setTimeout(30_000);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("ClamAV scan timed out."));
    });
    socket.on("error", (error) => reject(error));

    socket.connect(port, host, () => {
      socket.write("nINSTREAM\n");

      for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
        const chunk = buffer.subarray(offset, offset + CHUNK_SIZE);
        const sizeHeader = Buffer.alloc(4);
        sizeHeader.writeUInt32BE(chunk.byteLength, 0);
        socket.write(sizeHeader);
        socket.write(chunk);
      }

      const zeroChunk = Buffer.alloc(4); // length 0 signals EOF
      socket.write(zeroChunk);
    });

    socket.on("data", (data) => {
      response += data.toString("utf8");
    });

    socket.on("close", () => {
      const trimmed = response.trim();
      if (trimmed.endsWith("OK")) {
        resolve({ clean: true, signature: null });
        return;
      }
      const foundMatch = trimmed.match(/stream:\s*(.+)\s+FOUND$/);
      if (foundMatch) {
        resolve({ clean: false, signature: foundMatch[1] });
        return;
      }
      reject(new Error(`Unexpected ClamAV response: "${trimmed}"`));
    });
  });
}
