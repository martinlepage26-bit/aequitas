// Loaded into the Next.js PRODUCTION server with NODE_OPTIONS=--import. It does two things:
//  1. rewrites fetch() calls to https://api.resend.com/* to the local audit stub, because src/lib/mail.ts
//     hard-codes that URL (no base-URL override exists), and
//  2. blocks every other non-loopback fetch(), so the audit provably cannot reach a real external service.
// Blocked attempts are appended (host only) to AUDIT_DENY_LOG so the report can show that none happened.
import { appendFileSync } from "node:fs";

const STUB = process.env.AUDIT_STUB_URL;
const DENY_LOG = process.env.AUDIT_DENY_LOG;
const realFetch = globalThis.fetch;

globalThis.fetch = async function auditFetch(input, init) {
  let urlString;
  try { urlString = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; } catch { urlString = ""; }
  let u = null;
  try { u = new URL(urlString); } catch { /* relative or invalid: let the real fetch reject it */ }
  if (u && u.hostname === "api.resend.com") {
    if (!STUB) throw new TypeError("audit preload: AUDIT_STUB_URL is not set");
    const target = `${STUB}/resend${u.pathname}${u.search}`;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const headers = init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined);
    const body = init?.body ?? undefined;
    return realFetch(target, { method, headers, body, signal: init?.signal });
  }
  if (u && !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    if (DENY_LOG) { try { appendFileSync(DENY_LOG, `${new Date().toISOString()} blocked outbound fetch to host=${u.hostname}\n`); } catch { /* */ } }
    throw new TypeError(`audit preload: outbound fetch to ${u.hostname} is blocked`);
  }
  return realFetch(input, init);
};
