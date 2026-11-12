import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, DeleteObjectsCommand,
  GetObjectCommand, ListObjectVersionsCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listS3StoredKeys, purgeS3StoredObject } from "../../src/lib/storageErasure";

// This suite creates and removes its own bucket and refuses any hosted endpoint.
// It never operates on STORAGE_BUCKET or on any pre-existing bucket.
const endpoint = process.env.STORAGE_ENDPOINT;
const bucket = `aequitas-erasure-test-${randomUUID()}`;
const key = "simulated/owned-case/evidence";
const neighbor = `${key}-neighbor`;
let client: S3Client;
let created = false;

beforeAll(async () => {
  if (!endpoint || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname)) {
    throw new Error("Storage erasure integration tests require an isolated loopback MinIO endpoint.");
  }
  client = new S3Client({
    endpoint, region: process.env.STORAGE_REGION ?? "us-east-1", forcePathStyle: true,
    credentials: { accessKeyId: process.env.STORAGE_ACCESS_KEY ?? "", secretAccessKey: process.env.STORAGE_SECRET_KEY ?? "" },
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  created = true;
  await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
});

afterAll(async () => {
  try {
    if (created) {
      // Only this randomly named test-owned bucket can be cleaned up here.
      const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket }));
      if (versions.IsTruncated) throw new Error("Unexpected test inventory size; cleanup refused.");
      const objects = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].map(({ Key, VersionId }) => ({ Key, VersionId }));
      if (objects.length) {
        const result = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
        if (result.Errors?.length) throw new Error("Test-owned storage cleanup failed.");
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
  } finally { client?.destroy(); }
});

describe("real MinIO versioned-object erasure", () => {
  it("erases historical versions and a delete marker, preserves prefix neighbors, and safely retries", async () => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "synthetic version one" }));
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "synthetic version two" }));
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: neighbor, Body: "preserve this neighbor" }));
    expect(await listS3StoredKeys(client, bucket, ["simulated/owned-case/"])).toEqual([key, neighbor]);
    expect(await purgeS3StoredObject(client, bucket, key)).toEqual({ backend: "s3", deletedVersions: 3, verifiedAbsent: true });
    const remaining = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
    expect(remaining.IsTruncated).toBe(false);
    expect(remaining.DeleteMarkers ?? []).toHaveLength(0);
    expect(remaining.Versions?.map(version => version.Key)).toEqual([neighbor]);
    expect(await (await client.send(new GetObjectCommand({ Bucket: bucket, Key: neighbor }))).Body?.transformToString()).toBe("preserve this neighbor");
    expect(await purgeS3StoredObject(client, bucket, key)).toEqual({ backend: "s3", deletedVersions: 0, verifiedAbsent: true });
  });
});
