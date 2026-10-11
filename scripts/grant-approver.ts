import "../src/lib/loadEnv";
// Phase 3 (P3-D2): grants or revokes the approver capability on a case-manager
// account. Martin is the sole approver until a mediator exists.
//   npx tsx scripts/grant-approver.ts <email> [--revoke]
// Administrators cannot hold it (handoff §4 separation of duties).
import { prisma } from "../src/lib/prisma";

async function main() {
  const [email, flag] = process.argv.slice(2);
  if (!email) {
    console.error("Usage: tsx scripts/grant-approver.ts <email> [--revoke]");
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error("No account with that email.");
  if (user.globalRole !== "CASE_MANAGER") throw new Error("Only a CASE_MANAGER account can be an approver.");
  const isApprover = flag !== "--revoke";
  await prisma.user.update({ where: { id: user.id }, data: { isApprover } });
  console.log(`${user.email}: isApprover=${isApprover}`);
}

main()
  .catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
