// Issues a single-use invitation link for an account with no passkey yet
// (creating it if needed): the CLI twin of POST /api/auth/invite, for an
// operator on the server. Load the target environment first, e.g.
//   set -a; . ~/.config/aequitas-demo/env; set +a
//   npx tsx scripts/issue-invite.ts <email> <COMPLAINANT|RESPONDENT|CASE_MANAGER> "<Display name>" [fr-CA|en-CA]
// Prints the claim path; prefix it with the app origin (http://localhost:3417).
import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";
import { invitePath, issueInviteToken } from "../src/lib/invite";

const ROLES = ["COMPLAINANT", "RESPONDENT", "CASE_MANAGER"] as const;

async function main() {
  const [email, role, displayName, locale = "fr-CA"] = process.argv.slice(2);
  if (!email || !ROLES.includes(role as (typeof ROLES)[number])) {
    console.error('Usage: tsx scripts/issue-invite.ts <email> <COMPLAINANT|RESPONDENT|CASE_MANAGER> "<Display name>" [fr-CA|en-CA]');
    process.exit(1);
  }
  const existing = await prisma.user.findUnique({ where: { email }, include: { _count: { select: { credentials: true } } } });
  if (existing && existing.globalRole !== role) throw new Error("That email belongs to an account with a different role.");
  if (existing && existing._count.credentials > 0) throw new Error("That account has already been claimed with a passkey.");
  const user =
    existing ??
    (await prisma.user.create({ data: { email, displayName: displayName || email.split("@")[0], globalRole: role as (typeof ROLES)[number], locale } }));
  const { token, expiresAt } = issueInviteToken(user.id);
  console.log(invitePath(locale, token));
  console.error(`# ${user.email} (${user.globalRole}), expires ${expiresAt.toISOString()}`);
}

main()
  .catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
