import { request as nodeRequest } from "node:http";
import { cfg } from "./config";
import { logExchange } from "./evidence";

export interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  setCookies: string[];
  ms: number;
}

export interface ReqOpts {
  json?: unknown;
  form?: FormData;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  cookies?: boolean;
  redirect?: "manual" | "follow";
  timeoutMs?: number;
}

let suiteName = "unnamed";
export const setSuite = (name: string) => { suiteName = name; };

const parseJson = (text: string) => { try { return JSON.parse(text); } catch { return null; } };

/** Minimal cookie-aware client. Cookies are tracked manually because the server marks them Secure while we speak plain HTTP. */
export class Client {
  jar = new Map<string, string>();
  lastSetCookies: string[] = [];
  constructor(readonly label: string, readonly base = cfg.base) {}

  cookie(name: string) { return this.jar.get(name); }
  setCookie(name: string, value: string) { this.jar.set(name, value); }
  dropCookie(name: string) { this.jar.delete(name); }
  clone(label: string) { const copy = new Client(label, this.base); this.jar.forEach((v, k) => copy.jar.set(k, v)); return copy; }
  header() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }

  absorb(setCookies: string[]) {
    this.lastSetCookies = setCookies;
    for (const line of setCookies) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = /max-age=0/i.test(line) || /expires=Thu, 01 Jan 1970/i.test(line);
      if (!value || expired) this.jar.delete(name); else this.jar.set(name, value);
    }
  }

  async request(method: string, path: string, opts: ReqOpts = {}): Promise<Res> {
    const headers: Record<string, string> = { connection: "close", ...(opts.headers ?? {}) };
    let body: BodyInit | undefined;
    if (opts.json !== undefined && !["GET", "HEAD"].includes(method)) { headers["content-type"] ??= "application/json"; body = JSON.stringify(opts.json); }
    else if (opts.form) body = opts.form;
    else if (opts.body !== undefined) body = opts.body as BodyInit;
    if (opts.cookies !== false && this.jar.size && !headers.cookie) headers.cookie = this.header();
    const started = Date.now();
    const res = await fetch(this.base + path, {
      method, headers, body, redirect: opts.redirect ?? "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
    const text = await res.text();
    const setCookies = res.headers.getSetCookie();
    if (opts.cookies !== false) this.absorb(setCookies); else this.lastSetCookies = setCookies;
    const ms = Date.now() - started;
    logExchange(suiteName, this.label, method, path.replace(/\/invite\/[^/?#]+/, "/invite/<token>"), res.status, ms, res.headers, text);
    return { status: res.status, headers: res.headers, text, json: parseJson(text), setCookies, ms };
  }
  /** Binary-safe GET (export ZIPs). */
  async bytes(path: string, opts: ReqOpts = {}): Promise<{ status: number; headers: Headers; body: Buffer }> {
    const headers: Record<string, string> = { connection: "close", ...(opts.headers ?? {}) };
    if (this.jar.size && !headers.cookie) headers.cookie = this.header();
    const res = await fetch(this.base + path, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
    const body = Buffer.from(await res.arrayBuffer());
    logExchange(suiteName, this.label, "GET", path, res.status, 0, res.headers, `<${body.length} bytes>`);
    return { status: res.status, headers: res.headers, body };
  }
  get(path: string, opts?: ReqOpts) { return this.request("GET", path, opts); }
  post(path: string, json?: unknown, opts: ReqOpts = {}) { return this.request("POST", path, { ...opts, json }); }
  patch(path: string, json?: unknown, opts: ReqOpts = {}) { return this.request("PATCH", path, { ...opts, json }); }
  del(path: string, json?: unknown, opts: ReqOpts = {}) { return this.request("DELETE", path, { ...opts, json }); }
}

/** Parse a Set-Cookie line into name/value/attributes for attribute assertions. */
export function parseSetCookie(line: string) {
  const [pair, ...attrs] = line.split(";").map((part) => part.trim());
  const index = pair.indexOf("=");
  const attributes: Record<string, string | true> = {};
  for (const attr of attrs) {
    const eq = attr.indexOf("=");
    if (eq === -1) attributes[attr.toLowerCase()] = true; else attributes[attr.slice(0, eq).toLowerCase()] = attr.slice(eq + 1);
  }
  return { name: pair.slice(0, index), value: pair.slice(index + 1), attributes };
}

/** Raw HTTP/1.1 request whose path is sent byte-for-byte (fetch/URL would normalise it). */
export function rawRequest(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  const url = new URL(cfg.base);
  return new Promise((resolve, reject) => {
    const req = nodeRequest({ host: url.hostname, port: Number(url.port), method: opts.method ?? "GET", path: opts.path, headers: opts.headers, timeout: opts.timeoutMs ?? 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        logExchange(suiteName, "raw", opts.method ?? "GET", opts.path, res.statusCode ?? 0, 0, null, text);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
      });
    });
    req.on("timeout", () => req.destroy(new Error("raw request timed out")));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
