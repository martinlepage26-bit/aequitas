import dotenv from "dotenv";
import { defineConfig, env } from "prisma/config";

// Prisma CLI runs outside Next.js, so Next's automatic .env.local loading
// doesn't apply here — load it explicitly. Falls back to .env if present.
dotenv.config({ path: ".env.local" });
dotenv.config();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
