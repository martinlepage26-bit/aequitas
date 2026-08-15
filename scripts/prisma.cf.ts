import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/edge";

/**
 * Cloudflare-build-only variant of src/lib/prisma.ts — imports the /edge
 * entry point explicitly. The bare `../generated/prisma` import resolves
 * package.json's "#main-entry-point" conditions, which (at least in this
 * Prisma/esbuild/OpenNext version combination) end up bundling BOTH
 * index.js's and edge.js's WASM query-compiler chains rather than
 * resolving to exactly one — 4 duplicate copies of a 3.6MB WASM blob, ~14MB
 * of pure waste, blowing the Worker size limit. Importing /edge directly
 * eliminates the ambiguity and the duplication (26.5MB raw / 8.4MB gzip ->
 * 7.7MB raw / 1.98MB gzip). It breaks under Vitest/Node (its WASM loader
 * expects a Workers-style `import()` of a .wasm module), so it's swapped
 * in by scripts/cf-build.sh for the Cloudflare build only, never used
 * locally. Singleton pattern intentionally dropped — Workers don't reuse
 * module scope the way Next.js dev-mode hot-reload does.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not configured.");

export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
