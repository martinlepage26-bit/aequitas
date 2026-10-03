import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { cfg } from "./config";

/** Sanitised evidence writer. Secrets, tokens and cookie values are redacted before anything touches disk. */
const REDACTIONS: Array<[RegExp, string]> = [
  [/(aequitas_session|aequitas_webauthn_challenge)=[^;\s",]+/g, "$1=<redacted>"],
  [/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/g, "<signed-token>"],
  [/"challenge"\s*:\s*"[^"]+"/g, '"challenge":"<redacted>"'],
  [/"(publicKey|signature|attestationObject|clientDataJSON|authenticatorData|rawId)"\s*:\s*"[^"]+"/g, '"$1":"<redacted>"'],
  [/\b(sk-ant-|re_)[A-Za-z0-9_-]+/g, "<api-key>"],
  [/nonce-[A-Za-z0-9+/=]+/g, "nonce-<n>"],
];
export const scrub = (value: string): string => REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);

const KEEP_HEADERS = ["content-type", "location", "cache-control", "content-security-policy", "strict-transport-security", "x-content-type-options",
  "x-frame-options", "referrer-policy", "permissions-policy", "x-powered-by", "x-export-sha256", "content-disposition", "allow", "vary", "www-authenticate"];

const counts = new Map<string, number>();
export function writeJsonl(file: string, entry: unknown, cap = 4000) {
  const target = join(cfg.evidenceDir, file);
  const seen = (counts.get(target) ?? 0) + 1;
  counts.set(target, seen);
  if (seen > cap) return;
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, scrub(JSON.stringify(entry)) + "\n");
}

export function logExchange(suite: string, label: string, method: string, path: string, status: number, ms: number, headers: Headers | null, text: string) {
  const kept: Record<string, string> = {};
  headers?.forEach((value, key) => { if (KEEP_HEADERS.includes(key)) kept[key] = value; });
  const setCookie = headers?.getSetCookie?.() ?? [];
  writeJsonl(`http/${suite}.jsonl`, {
    t: new Date().toISOString(), actor: label, method, path, status, ms,
    headers: kept,
    setCookie: setCookie.map((line) => line.replace(/^([^=]+)=[^;]*/, "$1=<value>")),
    bodyPreview: text.slice(0, 300),
  });
}

/** A named observation: a fact a report line can cite. */
export function observe(suite: string, id: string, data: Record<string, unknown>) {
  writeJsonl(`observations/${suite}.jsonl`, { t: new Date().toISOString(), id, ...data }, 2000);
}
