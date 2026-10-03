import { createHash, createHmac } from "node:crypto";
import { cfg } from "./config";

/** Re-implementation of src/lib/signedCookie.ts, used ONLY to forge/age tokens for negative tests. */
export function signRaw(body: unknown, secret = cfg.sessionSecret): string {
  const data = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}
export const signPayload = (payload: unknown, ttlSeconds: number, secret = cfg.sessionSecret) => signRaw({ payload, exp: Date.now() + ttlSeconds * 1000 }, secret);
export const sha256Hex = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const decodeToken = (token: string): { payload: Record<string, unknown>; exp: number } | null => {
  try { return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")); } catch { return null; }
};
