#!/usr/bin/env node
// Re-hash every stored evidence file and compare with EvidenceItem.sha256 and
// byteSize. Used after a data move (Railway -> CT920) and before cutover.
// Exits non-zero on any missing file or mismatch. Local-dir storage only
// (STORAGE_LOCAL_DIR), which is what production uses.
import "../src/lib/loadEnv";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma";

async function main() {
  const dir = process.env.STORAGE_LOCAL_DIR;
  if (!dir) throw new Error("STORAGE_LOCAL_DIR is not set; this check covers local-dir storage only.");
  const items = await prisma.evidenceItem.findMany({ select: { id: true, storageKey: true, sha256: true, byteSize: true } });
  let ok = 0;
  const problems: string[] = [];
  for (const item of items) {
    try {
      const buf = await readFile(join(dir, item.storageKey));
      const hash = createHash("sha256").update(buf).digest("hex");
      if (hash !== item.sha256) problems.push(`${item.id}: sha256 mismatch`);
      else if (buf.byteLength !== item.byteSize) problems.push(`${item.id}: size mismatch`);
      else ok++;
    } catch {
      problems.push(`${item.id}: file missing (${item.storageKey})`);
    }
  }
  for (const p of problems) console.error(p);
  console.log(`Evidence files: ${items.length} in DB, ${ok} verified, ${problems.length} problem(s).`);
  if (problems.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
