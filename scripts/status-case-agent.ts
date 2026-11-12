import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";
import { readCaseAgentStatus } from "../src/domain/caseAgent/status";

/** Aggregate-only operator status; case IDs, party data and secrets are never printed. */
async function main() {
  console.log(JSON.stringify(await readCaseAgentStatus()));
}

main()
  .catch(() => { console.error("Case agent status could not be read."); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
