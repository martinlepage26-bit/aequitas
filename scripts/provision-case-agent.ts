import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";
import { CASE_AGENT_EMAIL } from "../src/domain/caseAgent/agent";

/**
 * Create the single CASE_AGENT service account, idempotently. It has no
 * passkey and no session can be issued for its role; it exists so the
 * agent's writes carry their own actor id.
 */
async function main() {
  const existing = await prisma.user.findUnique({ where: { email: CASE_AGENT_EMAIL } });
  if (existing && existing.globalRole !== "CASE_AGENT") throw new Error("The case agent email belongs to another role.");
  const others = await prisma.user.count({ where: { globalRole: "CASE_AGENT", email: { not: CASE_AGENT_EMAIL } } });
  if (others > 0) throw new Error("Another CASE_AGENT account exists.");
  const user = existing ?? await prisma.user.create({ data: { email: CASE_AGENT_EMAIL, displayName: "Assistant automatisé / Automated assistant", globalRole: "CASE_AGENT", locale: "fr-CA" } });
  console.log(JSON.stringify({ caseAgent: user.id, created: !existing }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Provisioning failed."); process.exitCode = 1; }).finally(() => prisma.$disconnect());
