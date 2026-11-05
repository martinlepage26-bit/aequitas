import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";
import { caseAgentEnabled, resolveCaseAgentModel, runCaseAgent } from "../src/domain/caseAgent/agent";
import { claimAgentCase, findEligibleAgentCases, releaseAgentCase } from "../src/domain/caseAgent/scheduler";

/**
 * Scheduled pass over agent-managed cases. It leases each case immediately
 * before processing, retries no sooner than ten minutes later, and prints
 * counts only. Model calls are billed to the deployment's provider account.
 */
async function main() {
  if (!caseAgentEnabled()) { console.log(JSON.stringify({ enabled: false })); return; }
  const resolved = resolveCaseAgentModel();
  if (!resolved.ok) {
    console.log(JSON.stringify({ enabled: true, modelConfigured: false, candidates: 0, claimed: 0, counts: { skipped_provider_unconfigured: 1 } }));
    return;
  }
  const model = resolved.model;
  const candidates = await findEligibleAgentCases();
  const counts: Record<string, number> = {};
  let claimed = 0;
  for (const candidate of candidates) {
    let lease: Awaited<ReturnType<typeof claimAgentCase>> = null;
    try {
      lease = await claimAgentCase(candidate);
      if (!lease) {
        counts.lease_conflict = (counts.lease_conflict ?? 0) + 1;
        continue;
      }
      claimed += 1;
      const result = await runCaseAgent({ caseId: lease.caseId, model });
      const key = result.status === "escalated" ? `escalated:${result.reason}` : result.status;
      counts[key] = (counts[key] ?? 0) + 1;
    } catch {
      counts.error = (counts.error ?? 0) + 1;
    } finally {
      if (lease) {
        try { await releaseAgentCase(lease); }
        catch { counts.lease_release_error = (counts.lease_release_error ?? 0) + 1; }
      }
    }
  }
  console.log(JSON.stringify({ enabled: true, modelConfigured: resolved.ok, candidates: candidates.length, claimed, counts }));
}

main().catch(() => { console.error("Case agent run failed."); process.exitCode = 1; }).finally(() => prisma.$disconnect());
