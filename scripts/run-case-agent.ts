import "../src/lib/loadEnv";
import { assertRetentionRestoreSafe } from "../src/domain/retentionLedger";
import { prisma } from "../src/lib/prisma";
import { resolveCaseAgentModel, runCaseAgent } from "../src/domain/caseAgent/agent";
import { caseAgentProgram } from "../src/domain/caseAgent/config";
import { claimAgentCase, findEligibleAgentCases, releaseAgentCase } from "../src/domain/caseAgent/scheduler";
import { recordScheduledOperationProgress } from "../src/lib/scheduledOperationProgress";

/**
 * Scheduled pass over agent-managed cases. It leases each case immediately
 * before processing, retries no sooner than ten minutes later, and prints
 * counts only. Model calls are billed to the deployment's provider account.
 */
async function main() {
  await assertRetentionRestoreSafe();
  const program = caseAgentProgram();
  const resolved = resolveCaseAgentModel();
  const mayTakeNewCases = program.ok && resolved.ok;
  const candidates = await findEligibleAgentCases({
    ...(mayTakeNewCases ? { unassignedOpenMaxAmountCents: program.program.maxAmountCents } : {}),
  });
  const model = resolved.ok ? resolved.model : null;
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
      await recordScheduledOperationProgress("case_agent");
    }
  }
  console.log(JSON.stringify({
    enabled: program.ok,
    missingProgramSettings: program.ok ? [] : program.missing,
    modelConfigured: resolved.ok,
    modelConfigurationBlocker: resolved.ok ? null : resolved.reason,
    candidates: candidates.length,
    claimed,
    counts,
  }));
}

main().catch(() => { console.error("Case agent run failed."); process.exitCode = 1; }).finally(() => prisma.$disconnect());
