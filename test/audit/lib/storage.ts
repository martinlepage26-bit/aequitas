import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { cfg } from "./config";

/** Direct inspection of the object store behind the server (MinIO or the local-disk backend). */
const s3 = () => new S3Client({ endpoint: cfg.s3.endpoint, region: cfg.s3.region, forcePathStyle: true, credentials: { accessKeyId: cfg.s3.accessKey, secretAccessKey: cfg.s3.secretKey } });

function walk(dir: string, base: string, out: string[]) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out); else out.push(full.slice(base.length + 1));
  }
}

export async function listKeys(prefix: string): Promise<string[]> {
  if (cfg.storage === "local") { const out: string[] = []; walk(join(cfg.localDir, prefix), cfg.localDir, out); return out.sort(); }
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3().send(new ListObjectsV2Command({ Bucket: cfg.s3.bucket, Prefix: prefix, ContinuationToken: token }));
    keys.push(...(res.Contents ?? []).map((o) => o.Key!));
    token = res.NextContinuationToken;
  } while (token);
  return keys.sort();
}
export async function getObject(key: string): Promise<Buffer | null> {
  try {
    if (cfg.storage === "local") return readFileSync(join(cfg.localDir, key));
    const res = await s3().send(new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  } catch { return null; }
}
export async function putObject(key: string, body: Buffer) {
  if (cfg.storage === "local") { mkdirSync(dirname(join(cfg.localDir, key)), { recursive: true }); writeFileSync(join(cfg.localDir, key), body); return; }
  await s3().send(new PutObjectCommand({ Bucket: cfg.s3.bucket, Key: key, Body: body }));
}
export async function deleteObject(key: string) {
  if (cfg.storage === "local") { rmSync(join(cfg.localDir, key), { force: true }); return; }
  await s3().send(new DeleteObjectCommand({ Bucket: cfg.s3.bucket, Key: key }));
}
/** Every object the app could have written for a case: evidence (live|simulated) and exports. */
export async function keysForCase(caseId: string) {
  const parts = await Promise.all([`live/${caseId}/`, `simulated/${caseId}/`, `exports/live/${caseId}/`, `exports/simulated/${caseId}/`].map(listKeys));
  return parts.flat().sort();
}
