// Idempotent setup step for both local dev and CI: creates the evidence
// storage bucket if it doesn't already exist. Not run automatically by the
// app itself (src/lib/storage.ts assumes the bucket already exists, same as
// a real S3 bucket in production is provisioned out of band, not by
// application code) — this script is the boring, explicit equivalent of
// that provisioning step for a local/CI MinIO instance.
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
    // Doesn't exist (or isn't reachable via HEAD) — fall through to create.
  }

  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`Created bucket "${bucket}".`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
