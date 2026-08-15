import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless signed-cookie payloads: HMAC-SHA256 over base64url(JSON payload
 * + expiry), keyed by SESSION_SECRET. Used for both the short-lived WebAuthn
 * ceremony challenge and the post-auth session — Section 5's schema defines
 * no Session/Challenge table, so both are necessarily stateless rather than
 * DB-backed (see DECISIONS.md).
 */

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured.");
  return secret;
}

function sign(data: string): string {
  return createHmac("sha256", getSecret()).update(data).digest("base64url");
}

export function signPayload<T>(payload: T, ttlSeconds: number): string {
  const body = { payload, exp: Date.now() + ttlSeconds * 1000 };
  const data = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const signature = sign(data);
  return `${data}.${signature}`;
}

export function verifyPayload<T>(token: string): T | null {
  const [data, signature] = token.split(".");
  if (!data || !signature) return null;

  const expected = sign(data);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let body: { payload: T; exp: number };
  try {
    body = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (Date.now() > body.exp) return null;
  return body.payload;
}
