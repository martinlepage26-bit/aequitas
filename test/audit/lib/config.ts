import { randomBytes } from "node:crypto";

/**
 * Black-box audit configuration. Everything comes from the environment prepared by
 * audit/backend-e2e-20261003/harness/run-suite.sh; nothing here can reach a real service.
 */
const need = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required. Run the audit suites through audit/backend-e2e-20261003/harness/run-suite.sh`);
  return value;
};

export const cfg = {
  base: process.env.AUDIT_BASE_URL ?? "http://127.0.0.1:3457",
  stub: process.env.AUDIT_STUB_URL ?? "http://127.0.0.1:4581",
  origin: process.env.AUDIT_WEBAUTHN_ORIGIN ?? "https://aequitas-audit.invalid",
  rpId: process.env.AUDIT_WEBAUTHN_RP_ID ?? "aequitas-audit.invalid",
  sessionSecret: need("AUDIT_SESSION_SECRET"),
  dbUrl: need("AUDIT_DATABASE_URL"),
  storage: (process.env.AUDIT_STORAGE ?? "s3") as "s3" | "local",
  localDir: process.env.AUDIT_LOCAL_DIR ?? "",
  s3: {
    endpoint: process.env.AUDIT_S3_ENDPOINT ?? "http://127.0.0.1:9010",
    bucket: process.env.AUDIT_S3_BUCKET ?? "aequitas-audit-evidence",
    region: process.env.AUDIT_S3_REGION ?? "ca-central-1",
    accessKey: process.env.AUDIT_S3_ACCESS_KEY ?? "",
    secretKey: process.env.AUDIT_S3_SECRET_KEY ?? "",
  },
  evidenceDir: process.env.AUDIT_EVIDENCE_DIR ?? "audit/backend-e2e-20261003/evidence",
  ipSalt: process.env.AUDIT_IP_HASH_SALT ?? "",
  denyLog: process.env.AUDIT_DENY_LOG ?? "",
  releaseCommit: process.env.AUDIT_RELEASE_COMMIT ?? "9c772f16e6eef79c0952188e8c05df92bbb5249a",
  genesis: "0".repeat(64),
  run: randomBytes(3).toString("hex"),
};

let counter = 0;
/** Reserved .test TLD: never routable, never a real mailbox. */
export const syntheticEmail = (tag: string) => `${tag}.${cfg.run}.${++counter}@audit.example.test`.toLowerCase();
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
