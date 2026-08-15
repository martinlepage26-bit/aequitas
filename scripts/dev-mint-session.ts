#!/usr/bin/env node
// DEV/TEST UTILITY ONLY — never an HTTP endpoint, never shipped to prod.
//
// No hardware authenticator or CDP virtual-authenticator is available in
// this environment (see DECISIONS.md, M1), so a real WebAuthn ceremony
// can't be completed to obtain a session cookie for testing routes that
// require auth. This mints one directly with the same signing function
// session.ts uses (src/lib/signedCookie.ts) — it doesn't bypass any
// security property under test, it only skips the ceremony.
//
// Usage: tsx scripts/dev-mint-session.ts <email> [globalRole]
// Creates the user if they don't exist (no credential attached — this user
// cannot actually sign in via the real /auth/sign-in flow), prints a Cookie
// header value.

import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";
import { signPayload } from "../src/lib/signedCookie";
import { SESSION_COOKIE } from "../src/lib/session";

async function main() {
  const [email, roleArg] = process.argv.slice(2);
  if (!email) {
    console.error("Usage: tsx scripts/dev-mint-session.ts <email> [globalRole]");
    process.exit(1);
  }
  const globalRole = (roleArg ?? "COMPLAINANT") as "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER" | "ADMIN";

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, displayName: email.split("@")[0], globalRole },
  });

  const token = signPayload({ userId: user.id, globalRole: user.globalRole, authMethod: "dev-bypass" }, 60 * 60 * 24 * 7);
  console.log(`${SESSION_COOKIE}=${token}`);
  console.error(`# user: ${user.id} (${user.email}, ${user.globalRole})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
