import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";
import { caseAgentEnabled, resolveCaseAgentModel, runCaseAgent } from "../src/domain/caseAgent/agent";

/**
 * Scheduled pass over agent-managed cases (for example every 10 minutes).
 * Prints counts by result only: no case content, party names, or provider
 * errors. Model calls are billed to the deployment's own provider account.
 */
async function main() {
  if (!caseAgentEnabled()) { console.log(JSON.stringify({ enabled: false })); return; }
  const resolved = resolveCaseAgentModel();
  const model = resolved.ok ? resolved.model : null;
  // Cases the agent manages, plus submitted cases nobody has taken yet (eligibility is checked per case).
  const cases = await prisma.case.findMany({
    where: { agentEscalatedAt: null, OR: [{ agentManaged: true, state: { not: "CLOSED" } }, { agentManaged: false, state: "OPEN", caseManagerId: null }] },
    select: { id: true }, take: 50, orderBy: { createdAt: "asc" },
  });
  const counts: Record<string, number> = {};
  for (const row of cases) {
    try {
      const result = await runCaseAgent({ caseId: row.id, model });
      const key = result.status === "escalated" ? `escalated:${result.reason}` : result.status;
      counts[key] = (counts[key] ?? 0) + 1;
    } catch {
      counts.error = (counts.error ?? 0) + 1;
    }
  }
  console.log(JSON.stringify({ enabled: true, modelConfigured: resolved.ok, cases: cases.length, counts }));
}

main().catch(() => { console.error("Case agent run failed."); process.exitCode = 1; }).finally(() => prisma.$disconnect());
