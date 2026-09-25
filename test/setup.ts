import "../src/lib/loadEnv";
import { applyTestDatabase } from "./testDatabaseUrl";

// Runs before each test file is imported, so src/lib/prisma (which reads
// DATABASE_URL at import time) and any `next dev` a suite spawns (which
// inherits this process's env, and Next never overrides an already-set
// variable from .env.local) both see the test database, never dev.
applyTestDatabase();
