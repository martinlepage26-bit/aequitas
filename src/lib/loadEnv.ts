import dotenv from "dotenv";

// Next.js loads .env.local automatically; standalone scripts (verify-events,
// tests) run outside Next.js and need it loaded explicitly. Must be the
// FIRST import in any entrypoint that also imports src/lib/prisma — ESM
// hoists all imports in a file above any code between them, so a module
// that reads process.env.DATABASE_URL at import time (prisma.ts does, via
// createClient()) will run before a same-file `dotenv.config()` call
// unless this module is imported first and does the loading as its own
// module-level side effect.
dotenv.config({ path: ".env.local" });
dotenv.config();
