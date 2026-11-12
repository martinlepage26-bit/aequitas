import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DeleteObjectsCommand, HeadObjectCommand, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3";

export interface StorageErasureReceipt {
  backend: "local" | "s3";
  /** Versions (including delete markers) removed by this successful invocation. */
  deletedVersions: number;
  verifiedAbsent: true;
}

type ErasureErrorCode = "INVALID_KEY" | "LOCAL_UNSAFE_PATH" | "LOCAL_UNAVAILABLE" | "INVENTORY_UNVERIFIED" | "DELETE_FAILED" | "ABSENCE_UNVERIFIED";

/** Safe to include in a job receipt: no object keys, paths or provider messages. */
export class StorageErasureError extends Error {
  constructor(public readonly code: ErasureErrorCode) {
    super(`Storage erasure did not complete (${code}).`);
    this.name = "StorageErasureError";
  }
}

export function validateErasureKey(key: string): void {
  if (!key || key.startsWith("/") || key.includes("\\") || [...key].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || Buffer.byteLength(key, "utf8") > 1024 || key.split("/").some(part => !part || part === "." || part === "..")) {
    throw new StorageErasureError("INVALID_KEY");
  }
}

function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/**
 * The configured root is trusted; children are never followed through symlinks.
 * Its directory tree must be writable only by trusted deployment processes.
 * The coordinator must freeze case writers before erasure and retain that freeze.
 * Absence here concerns this live store, not filesystem snapshots or backups.
 */
export async function purgeLocalStoredObject(rootDirectory: string, key: string): Promise<StorageErasureReceipt> {
  validateErasureKey(key);
  try {
    // Resolve the configured root once (macOS /var may itself be an OS alias).
    const root = await realpath(/*turbopackIgnore: true*/ rootDirectory);
    const rootIdentity = await lstat(root);
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw new StorageErasureError("LOCAL_UNSAFE_PATH");
    const parts = key.split("/");
    const inspect = async () => {
      const currentRoot = await lstat(root);
      if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink()
        || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino) {
        throw new StorageErasureError("LOCAL_UNSAFE_PATH");
      }
      let path = root;
      for (let i = 0; i < parts.length; i += 1) {
        path = join(path, parts[i]);
        let entry;
        try { entry = await lstat(path); }
        catch (error) { if (missing(error)) return null; throw error; }
        if (entry.isSymbolicLink() || (i < parts.length - 1 ? !entry.isDirectory() : !entry.isFile())) {
          throw new StorageErasureError("LOCAL_UNSAFE_PATH");
        }
        // An extra hard link is an unaccounted content copy, not proof of erasure.
        if (i === parts.length - 1 && entry.nlink !== 1) throw new StorageErasureError("LOCAL_UNSAFE_PATH");
      }
      return path;
    };
    const path = await inspect();
    let deletedVersions = 0;
    if (path !== null) {
      try { await unlink(path); deletedVersions = 1; }
      catch (error) { if (!missing(error)) throw new StorageErasureError("DELETE_FAILED"); }
    }
    if (await inspect() !== null) throw new StorageErasureError("ABSENCE_UNVERIFIED");
    return { backend: "local", deletedVersions, verifiedAbsent: true };
  } catch (error) {
    if (error instanceof StorageErasureError) throw error;
    throw new StorageErasureError("LOCAL_UNAVAILABLE");
  }
}

type Version = { Key: string; VersionId: string };

/** Inventory is completed before any deletes so page markers cannot move under our own writes. */
async function objectVersions(client: S3Client, bucket: string, prefix: string, exactKey?: string): Promise<Version[]> {
  const versions: Version[] = [];
  const versionIds = new Set<string>();
  const markers = new Set<string>();
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  for (let page = 0; page < 10_000; page += 1) {
    const result = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket, Prefix: prefix, MaxKeys: 1000,
      ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
      ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }),
    }));
    if (typeof result.IsTruncated !== "boolean" || result.CommonPrefixes?.length
      || (result.Name !== undefined && result.Name !== bucket)
      || (result.Prefix !== undefined && result.Prefix !== prefix)
      || result.EncodingType !== undefined
      || (result.Versions !== undefined && !Array.isArray(result.Versions))
      || (result.DeleteMarkers !== undefined && !Array.isArray(result.DeleteMarkers))) {
      throw new StorageErasureError("INVENTORY_UNVERIFIED");
    }
    for (const entry of [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])]) {
      if (typeof entry.Key !== "string" || !entry.Key.startsWith(prefix)) throw new StorageErasureError("INVENTORY_UNVERIFIED");
      // Prefix is a query optimization, not an authorization or exact-key filter.
      if (exactKey !== undefined && entry.Key !== exactKey) continue;
      validateErasureKey(entry.Key);
      const identity = JSON.stringify([entry.Key, entry.VersionId]);
      if (typeof entry.VersionId !== "string" || !entry.VersionId || versionIds.has(identity)) {
        throw new StorageErasureError("INVENTORY_UNVERIFIED");
      }
      versionIds.add(identity);
      versions.push({ Key: entry.Key, VersionId: entry.VersionId });
    }
    if (!result.IsTruncated) return versions;
    if (typeof result.NextKeyMarker !== "string" || !result.NextKeyMarker
      || (result.NextVersionIdMarker !== undefined && typeof result.NextVersionIdMarker !== "string")) {
      throw new StorageErasureError("INVENTORY_UNVERIFIED");
    }
    const marker = JSON.stringify([result.NextKeyMarker, result.NextVersionIdMarker ?? null]);
    if (markers.has(marker)) throw new StorageErasureError("INVENTORY_UNVERIFIED");
    markers.add(marker);
    keyMarker = result.NextKeyMarker;
    versionMarker = result.NextVersionIdMarker;
  }
  throw new StorageErasureError("INVENTORY_UNVERIFIED");
}

function validateNamespace(prefix: string): void {
  if (!prefix.endsWith("/")) throw new StorageErasureError("INVALID_KEY");
  validateErasureKey(prefix.slice(0, -1));
}

/** Includes keys whose only remaining entries are historical versions or delete markers. */
export async function listS3StoredKeys(client: S3Client, bucket: string, prefixes: readonly string[]): Promise<string[]> {
  const keys = new Set<string>();
  try {
    for (const prefix of prefixes) {
      validateNamespace(prefix);
      for (const version of await objectVersions(client, bucket, prefix)) keys.add(version.Key);
    }
    return [...keys].sort();
  } catch (error) {
    if (error instanceof StorageErasureError) throw error;
    throw new StorageErasureError("INVENTORY_UNVERIFIED");
  }
}

/** The caller must first drain/freeze all case writers, as for purgeLocalStoredObject. */
export async function listLocalStoredKeys(rootDirectory: string, prefixes: readonly string[]): Promise<string[]> {
  const keys = new Set<string>();
  try {
    const root = await realpath(/*turbopackIgnore: true*/ rootDirectory);
    const rootIdentity = await lstat(root);
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw new StorageErasureError("LOCAL_UNSAFE_PATH");
    for (const prefix of prefixes) {
      validateNamespace(prefix);
      let current = root;
      let absent = false;
      for (const part of prefix.slice(0, -1).split("/")) {
        current = join(current, part);
        let entry;
        try { entry = await lstat(current); }
        catch (error) { if (missing(error)) { absent = true; break; } throw error; }
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new StorageErasureError("LOCAL_UNSAFE_PATH");
      }
      if (absent) continue;
      const directories = [prefix.slice(0, -1)];
      while (directories.length) {
        const directoryKey = directories.pop()!;
        const path = join(root, directoryKey);
        const before = await lstat(path);
        if (!before.isDirectory() || before.isSymbolicLink()) throw new StorageErasureError("LOCAL_UNSAFE_PATH");
        for (const name of await readdir(path)) {
          const key = `${directoryKey}/${name}`;
          validateErasureKey(key);
          const entry = await lstat(join(root, key));
          if (entry.isSymbolicLink()) throw new StorageErasureError("LOCAL_UNSAFE_PATH");
          if (entry.isDirectory()) directories.push(key);
          else if (entry.isFile() && entry.nlink === 1) keys.add(key);
          else throw new StorageErasureError("LOCAL_UNSAFE_PATH");
        }
        const after = await lstat(path);
        if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
          || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          throw new StorageErasureError("INVENTORY_UNVERIFIED");
        }
      }
    }
    const afterRoot = await lstat(root);
    if (!afterRoot.isDirectory() || afterRoot.isSymbolicLink()
      || rootIdentity.dev !== afterRoot.dev || rootIdentity.ino !== afterRoot.ino) {
      throw new StorageErasureError("LOCAL_UNSAFE_PATH");
    }
    return [...keys].sort();
  } catch (error) {
    if (error instanceof StorageErasureError) throw error;
    throw new StorageErasureError("INVENTORY_UNVERIFIED");
  }
}

/**
 * General-purpose S3-compatible buckets must support ListObjectVersions even
 * when versioning is disabled (the current object has VersionId "null").
 * A denied/unsupported/malformed inventory cannot fall back to an unversioned
 * delete, which would silently leave historical content. No retention bypass
 * or MFA override is sent. The caller must prevent subsequent writes.
 */
export async function purgeS3StoredObject(client: S3Client, bucket: string, key: string): Promise<StorageErasureReceipt> {
  validateErasureKey(key);
  let versions: Version[];
  try { versions = await objectVersions(client, bucket, key, key); }
  catch (error) {
    if (error instanceof StorageErasureError) throw error;
    throw new StorageErasureError("INVENTORY_UNVERIFIED");
  }
  for (let offset = 0; offset < versions.length; offset += 1000) {
    const batch = versions.slice(offset, offset + 1000);
    try {
      const result = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: false } }));
      if (result.Errors?.length) throw new StorageErasureError("DELETE_FAILED");
      const acknowledged = new Set((result.Deleted ?? []).map(entry => JSON.stringify([entry.Key, entry.VersionId])));
      if (batch.some(entry => !acknowledged.has(JSON.stringify([entry.Key, entry.VersionId])))) {
        throw new StorageErasureError("DELETE_FAILED");
      }
    } catch {
      // A previous batch or some entries may already be gone. Retrying the
      // persisted key inventories what remains; never turn a partial failure
      // into a completed receipt.
      throw new StorageErasureError("DELETE_FAILED");
    }
  }
  try {
    if ((await objectVersions(client, bucket, key, key)).length) throw new StorageErasureError("ABSENCE_UNVERIFIED");
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      if (error !== null && typeof error === "object" && "$metadata" in error
        && (error.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode === 404) {
        return { backend: "s3", deletedVersions: versions.length, verifiedAbsent: true };
      }
      throw new StorageErasureError("ABSENCE_UNVERIFIED");
    }
  } catch (error) {
    if (error instanceof StorageErasureError) throw error;
    throw new StorageErasureError("ABSENCE_UNVERIFIED");
  }
  throw new StorageErasureError("ABSENCE_UNVERIFIED");
}
