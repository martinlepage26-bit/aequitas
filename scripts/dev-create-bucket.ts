#!/usr/bin/env node
// DEV UTILITY — creates the local MinIO bucket. In staging/prod the bucket
// is provisioned by whatever manages the real S3-compatible service.
import "../src/lib/loadEnv";
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

async function main() {
  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error("STORAGE_BUCKET is not configured.");

  const client = new S3Client({
    endpoint: process.env.STORAGE_ENDPOINT,
    region: process.env.STORAGE_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY ?? "",
      secretAccessKey: process.env.STORAGE_SECRET_KEY ?? "",
    },
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`Bucket "${bucket}" already exists.`);
    return;
  } catch {
    // Falls through to create.
  }

  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`Created bucket "${bucket}".`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
