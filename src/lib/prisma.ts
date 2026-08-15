import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma";

// Standard Next.js dev-mode singleton: avoids exhausting the Postgres
// connection pool across hot-reloads, which create a fresh module scope
// per reload but share the same Node process.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
