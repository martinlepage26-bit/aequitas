import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeleteObjectsCommand, HeadObjectCommand, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evidenceObjectKey, isCaseStorageKey, listStoredKeysForCase, purgeStoredObject } from "../../src/lib/storage";
import { listS3StoredKeys, purgeS3StoredObject, StorageErasureError } from "../../src/lib/storageErasure";

const key = "live/case/evidence";
const bucket = "synthetic-erasure-test";
const absent = () => Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } });
const version = (VersionId: string, Key = key) => ({ Key, VersionId });
const inventory = (Versions: ReturnType<typeof version>[] = [], extra: Record<string, unknown> = {}) => ({ IsTruncated: false, Versions, ...extra });

function fakeS3(responses: (object | Error)[]) {
  const remaining = [...responses];
  const send = vi.fn(async (_command: unknown) => {
    if (!remaining.length) throw new Error("Unexpected storage request");
    const response = remaining.shift()!;
    if (response instanceof Error) throw response;
    return response;
  });
  return { client: { send } as unknown as S3Client, send };
}

const directories: string[] = [];
async function localStorage() {
  const root = await mkdtemp(join(tmpdir(), "aequitas-erasure-"));
  directories.push(root);
  vi.stubEnv("STORAGE_LOCAL_DIR", root);
  await mkdir(join(root, "live/case"), { recursive: true });
  return root;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("complete case namespace inventory", () => {
  it("follows a custom simulated evidence prefix while exports retain their own convention", async () => {
    const root = await localStorage();
    vi.stubEnv("STORAGE_SIMULATED_PREFIX", "pilot/evidence/");
    vi.resetModules();
    const customStorage = await import("../../src/lib/storage");
    const evidence = customStorage.evidenceObjectKey(true, "case", "object");
    await mkdir(join(root, "pilot/evidence/case"), { recursive: true });
    await mkdir(join(root, "exports/simulated/case"), { recursive: true });
    await writeFile(join(root, evidence), "synthetic");
    await writeFile(join(root, "exports/simulated/case/file.zip"), "synthetic");
    expect(customStorage.isCaseStorageKey(evidence, "case", true)).toBe(true);
    expect(customStorage.isCaseStorageKey("simulated/case/object", "case", true)).toBe(false);
    expect(await customStorage.listStoredKeysForCase("case", true)).toEqual(["exports/simulated/case/file.zip", evidence]);
  });

  it("identifies only the exact configured case namespaces", () => {
    expect(isCaseStorageKey(evidenceObjectKey(true, "case", "evidence"), "case", true)).toBe(true);
    expect(isCaseStorageKey("exports/simulated/case/bundle.zip", "case", true)).toBe(true);
    expect(isCaseStorageKey("exports/live/case/bundle.zip", "case", false)).toBe(true);
    for (const wrong of ["live/case-2/evidence", "simulated/case/evidence", "exports/live/case-2/bundle.zip", "live/case/../other", "live/case/", "live/case//evidence"]) {
      expect(isCaseStorageKey(wrong, "case", false)).toBe(false);
    }
    expect(isCaseStorageKey("live/case/evidence", "case/..", false)).toBe(false);
  });

  it("inventories local evidence and export orphans recursively, leaving sibling cases outside the inventory", async () => {
    const root = await localStorage();
    await mkdir(join(root, "live/case/nested"));
    await mkdir(join(root, "exports/live/case"), { recursive: true });
    await mkdir(join(root, "live/case-neighbor"));
    const own = [key, "live/case/nested/orphan", "exports/live/case/orphan.zip"];
    for (const objectKey of [...own, "live/case-neighbor/evidence"]) await writeFile(join(root, objectKey), "synthetic");
    expect(await listStoredKeysForCase("case", false)).toEqual(own.sort());
    expect(await listStoredKeysForCase("missing-case", false)).toEqual([]);
  });

  it("rejects a symlink hidden inside an otherwise valid namespace", async () => {
    const root = await localStorage();
    await writeFile(join(root, key), "synthetic");
    await symlink(join(root, key), join(root, "live/case/orphan-link"));
    await expect(listStoredKeysForCase("case", false)).rejects.toMatchObject({ code: "LOCAL_UNSAFE_PATH" });
  });

  it("rejects symlinked namespace parents and an unavailable storage root", async () => {
    const root = await localStorage();
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(root, "exports"));
    await expect(listStoredKeysForCase("case", false)).rejects.toMatchObject({ code: "LOCAL_UNSAFE_PATH" });
    vi.stubEnv("STORAGE_LOCAL_DIR", join(root, "unmounted"));
    await expect(listStoredKeysForCase("case", false)).rejects.toMatchObject({ code: "INVENTORY_UNVERIFIED" });
  });

  it("includes historical-only and delete-marker-only S3 objects across all pages, deduplicated by key", async () => {
    const exportKey = "exports/live/case/bundle.zip";
    const { client, send } = fakeS3([
      inventory([version("old"), version("older")], { IsTruncated: true, NextKeyMarker: key, NextVersionIdMarker: "older" }),
      inventory([], { DeleteMarkers: [version("marker-only", "live/case/orphan")] }),
      inventory([version("null", exportKey)]),
    ]);
    expect(await listS3StoredKeys(client, bucket, ["live/case/", "exports/live/case/"])).toEqual([exportKey, key, "live/case/orphan"]);
    expect((send.mock.calls[1][0] as ListObjectVersionsCommand).input).toMatchObject({ Prefix: "live/case/", KeyMarker: key, VersionIdMarker: "older" });
    expect(send.mock.calls.every(([command]) => command instanceof ListObjectVersionsCommand)).toBe(true);
  });

  it("refuses an out-of-namespace provider result or an incomplete version inventory", async () => {
    for (const result of [inventory([version("v", "live/case-neighbor/object")]), inventory([{ Key: key } as ReturnType<typeof version>])]) {
      const { client } = fakeS3([result]);
      await expect(listS3StoredKeys(client, bucket, ["live/case/"])).rejects.toMatchObject({ code: "INVENTORY_UNVERIFIED" });
    }
  });
});

describe("local exact-object erasure", () => {
  it("removes only the selected object, verifies absence and is idempotent", async () => {
    const root = await localStorage();
    await writeFile(join(root, key), "private synthetic evidence");
    await writeFile(join(root, `${key}-neighbor`), "keep");
    expect(await purgeStoredObject(key)).toEqual({ backend: "local", deletedVersions: 1, verifiedAbsent: true });
    await expect(lstat(join(root, key))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, `${key}-neighbor`), "utf8")).toBe("keep");
    expect(await purgeStoredObject(key)).toEqual({ backend: "local", deletedVersions: 0, verifiedAbsent: true });
    expect(await purgeStoredObject("missing/parent/object")).toMatchObject({ deletedVersions: 0, verifiedAbsent: true });
  });

  it.each(["", "../outside", "/absolute", "live/../outside", "live/./case", "live\\case", "live//case", "live/case/", "live/\u0000key", "x".repeat(1025)])("rejects unsafe or ambiguous key %j", async badKey => {
    await localStorage();
    await expect(purgeStoredObject(badKey)).rejects.toMatchObject({ code: "INVALID_KEY" });
  });

  it("refuses symlinked parent directories and leaves the outside file intact", async () => {
    const root = await localStorage();
    const outside = await mkdtemp(join(tmpdir(), "aequitas-erasure-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "outside.txt"), "keep outside");
    await symlink(outside, join(root, "escape"));
    await expect(purgeStoredObject("escape/outside.txt")).rejects.toMatchObject({ code: "LOCAL_UNSAFE_PATH" });
    expect(await readFile(join(outside, "outside.txt"), "utf8")).toBe("keep outside");
  });

  it("refuses leaf symlinks, hard-linked content and directory targets", async () => {
    const root = await localStorage();
    await writeFile(join(root, "original"), "keep");
    await symlink(join(root, "original"), join(root, "linked"));
    await link(join(root, "original"), join(root, "hardlink"));
    for (const target of ["linked", "hardlink", "live/case"]) {
      await expect(purgeStoredObject(target)).rejects.toMatchObject({ code: "LOCAL_UNSAFE_PATH" });
    }
    expect(await readFile(join(root, "original"), "utf8")).toBe("keep");
  });

  it("does not call a missing storage mount successful erasure", async () => {
    const root = await localStorage();
    vi.stubEnv("STORAGE_LOCAL_DIR", join(root, "missing-mount"));
    await expect(purgeStoredObject(key)).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
  });
});

describe("S3 exact-object version erasure", () => {
  it("deletes the null version, historical versions and delete markers, excluding prefix neighbors", async () => {
    const target = [version("old"), version("null"), version("deleted")];
    const { client, send } = fakeS3([
      inventory([...target.slice(0, 2), version("neighbor-version", `${key}-neighbor`)], { DeleteMarkers: [target[2], version("neighbor-marker", `${key}/child`)] }),
      { Deleted: target }, inventory([version("neighbor-version", `${key}-neighbor`)]), absent(),
    ]);
    expect(await purgeS3StoredObject(client, bucket, key)).toEqual({ backend: "s3", deletedVersions: 3, verifiedAbsent: true });
    const deletion = send.mock.calls[1][0] as DeleteObjectsCommand;
    expect(deletion).toBeInstanceOf(DeleteObjectsCommand);
    expect(deletion.input).toEqual({ Bucket: bucket, Delete: { Objects: target, Quiet: false } });
    expect(send.mock.calls[3][0]).toBeInstanceOf(HeadObjectCommand);
  });

  it("completes inventory pagination before deleting in batches of at most 1000", async () => {
    const first = Array.from({ length: 1000 }, (_, i) => version(`v${i}`));
    const last = version("v1000");
    const { client, send } = fakeS3([
      inventory(first, { IsTruncated: true, NextKeyMarker: key, NextVersionIdMarker: "v999" }), inventory([last]),
      { Deleted: first }, { Deleted: [last] }, inventory(), absent(),
    ]);
    expect(await purgeS3StoredObject(client, bucket, key)).toMatchObject({ deletedVersions: 1001, verifiedAbsent: true });
    expect(send.mock.calls[0][0]).toBeInstanceOf(ListObjectVersionsCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(ListObjectVersionsCommand);
    expect((send.mock.calls[1][0] as ListObjectVersionsCommand).input).toMatchObject({ KeyMarker: key, VersionIdMarker: "v999", Prefix: key });
    expect((send.mock.calls[2][0] as DeleteObjectsCommand).input.Delete?.Objects).toHaveLength(1000);
    expect((send.mock.calls[3][0] as DeleteObjectsCommand).input.Delete?.Objects).toHaveLength(1);
  });

  it("is idempotent when the exact key is already absent", async () => {
    const { client, send } = fakeS3([inventory(), inventory(), absent()]);
    expect(await purgeS3StoredObject(client, bucket, key)).toMatchObject({ deletedVersions: 0, verifiedAbsent: true });
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectsCommand)).toBe(false);
  });

  it("fails a partial Object Lock/access denial and safely retries only the remaining version", async () => {
    const first = version("first"); const retained = version("retained");
    const { client, send } = fakeS3([
      inventory([first, retained]), { Deleted: [first], Errors: [{ ...retained, Code: "AccessDenied", Message: "sensitive provider text" }] },
      inventory([retained]), { Deleted: [retained] }, inventory(), absent(),
    ]);
    const failure = await purgeS3StoredObject(client, bucket, key).catch(error => error);
    expect(failure).toBeInstanceOf(StorageErasureError);
    expect(failure).toMatchObject({ code: "DELETE_FAILED" });
    expect(failure.message).not.toContain("sensitive provider text");
    expect(await purgeS3StoredObject(client, bucket, key)).toMatchObject({ deletedVersions: 1, verifiedAbsent: true });
    expect((send.mock.calls[3][0] as DeleteObjectsCommand).input.Delete?.Objects).toEqual([retained]);
    for (const [command] of send.mock.calls) {
      if (command instanceof DeleteObjectsCommand) {
        expect(command.input).not.toHaveProperty("BypassGovernanceRetention");
        expect(command.input).not.toHaveProperty("MFA");
      }
    }
  });

  it.each([
    new Error("AccessDenied: private provider detail"),
    {},
    { IsTruncated: "false" },
    inventory([{ Key: key } as ReturnType<typeof version>]),
    inventory([version("one"), version("one")]),
    inventory([], { IsTruncated: true }),
    inventory([], { CommonPrefixes: [{ Prefix: key }] }),
    inventory([], { EncodingType: "url" }),
    inventory([], { Name: "another-bucket" }),
  ])("refuses unverifiable inventories before any destructive call: %j", async response => {
    const { client, send } = fakeS3([response]);
    await expect(purgeS3StoredObject(client, bucket, key)).rejects.toMatchObject({ code: "INVENTORY_UNVERIFIED" });
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectsCommand)).toBe(false);
  });

  it("refuses nonadvancing pagination without deleting an incomplete inventory", async () => {
    const page = inventory([], { IsTruncated: true, NextKeyMarker: key, NextVersionIdMarker: "same" });
    const { client, send } = fakeS3([page, page]);
    await expect(purgeS3StoredObject(client, bucket, key)).rejects.toMatchObject({ code: "INVENTORY_UNVERIFIED" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([new Error("request interrupted"), {}, { Deleted: [] }])("refuses incomplete deletion acknowledgement: %j", async response => {
    const { client } = fakeS3([inventory([version("one")]), response]);
    await expect(purgeS3StoredObject(client, bucket, key)).rejects.toMatchObject({ code: "DELETE_FAILED" });
  });

  it("does not claim success if a version remains or reappears after deletion", async () => {
    const v = version("one");
    const { client } = fakeS3([inventory([v]), { Deleted: [v] }, inventory([version("new-write")])]);
    await expect(purgeS3StoredObject(client, bucket, key)).rejects.toMatchObject({ code: "ABSENCE_UNVERIFIED" });
  });

  it.each([{}, Object.assign(new Error("forbidden"), { $metadata: { httpStatusCode: 403 } }), new Error("NotFound")])("requires an actual 404 for final live-object absence: %j", async head => {
    const { client } = fakeS3([inventory(), inventory(), head]);
    await expect(purgeS3StoredObject(client, bucket, key)).rejects.toMatchObject({ code: "ABSENCE_UNVERIFIED" });
  });

  it("fails when the post-delete version inventory becomes unavailable", async () => {
    const v = version("one");
    const { client } = fakeS3([inventory([v]), { Deleted: [v] }, new Error("inventory permission lost")]);
    await expect(purgeS3StoredObject(client, bucket, key)).rejects.toMatchObject({ code: "ABSENCE_UNVERIFIED" });
  });
});
