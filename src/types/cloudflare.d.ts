// Minimal, hand-written ambient types for the Cloudflare bindings this app
// actually uses (just R2, via src/lib/storage.ts). Deliberately NOT the
// full `wrangler types`-generated cloudflare-env.d.ts (15k+ lines) — that
// file redefines Request/Response/Buffer/net.Socket globally in ways that
// conflict with the DOM+Node types the rest of this app (local dev, tests,
// scripts) compiles against. See DECISIONS.md's Cloudflare-deploy entry.

interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2Bucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: { httpMetadata?: R2HTTPMetadata }
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
}

interface CloudflareEnv {
  EVIDENCE_BUCKET?: R2Bucket;
}
