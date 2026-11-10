import { prisma } from "../../lib/prisma";
import { emailConfigured, notificationBacklog } from "../../lib/mail";
import { caseAgentProgram } from "./config";
import { resolveCaseAgentModel } from "./agent";
import { caseAgentDailyModelUsage } from "./modelBudget";
import { scheduledOperationHealth, SCHEDULED_OPERATIONS } from "../scheduledOperations";
import { caseAgentOperationallyReady } from "./statusReadiness";

/** Read-only deployment status. Only aggregate case and mail counts are returned. */
export async function readCaseAgentStatus(now = new Date()) {
  const program = caseAgentProgram();
  const model = resolveCaseAgentModel();
  const mailIsConfigured = emailConfigured();
  const serviceAccountCount = await prisma.user.count({ where: { globalRole: "CASE_AGENT" } });
  const modelUsageToday = await caseAgentDailyModelUsage(now);

  const [activeRows, escalationRows, unassignedEscalations, activeLeases, expiredLeases, latestAttempt, mailBacklog, heartbeatRows] = await Promise.all([
    prisma.case.groupBy({
      by: ["state"],
      where: { agentManaged: true, agentEscalatedAt: null, state: { not: "CLOSED" } },
      _count: { _all: true },
      orderBy: { state: "asc" },
    }),
    prisma.case.groupBy({
      by: ["agentEscalationReason"],
      where: { agentEscalatedAt: { not: null }, state: { not: "CLOSED" } },
      _count: { _all: true },
      orderBy: { agentEscalationReason: "asc" },
    }),
    prisma.case.count({ where: { agentEscalatedAt: { not: null }, caseManagerId: null, state: { not: "CLOSED" } } }),
    prisma.case.count({ where: { agentLeaseToken: { not: null }, agentLeaseUntil: { gt: now } } }),
    prisma.case.count({ where: { agentLeaseToken: { not: null }, agentLeaseUntil: { lte: now } } }),
    prisma.case.aggregate({ where: { agentLastAttemptAt: { not: null } }, _max: { agentLastAttemptAt: true } }),
    notificationBacklog(),
    prisma.scheduledOperationHeartbeat.findMany({ where: { name: { in: SCHEDULED_OPERATIONS.map((operation) => operation.name) } } }),
  ]);

  const heartbeats = new Map(heartbeatRows.map((row) => [row.name, row]));
  const scheduledOperations = SCHEDULED_OPERATIONS.map((operation) => {
    const heartbeat = heartbeats.get(operation.name);
    return {
      name: operation.name,
      intervalMinutes: operation.intervalMs / 60_000,
      health: scheduledOperationHealth(operation.intervalMs, heartbeat ?? null, now),
      lastStartedAt: heartbeat?.lastStartedAt?.toISOString() ?? null,
      lastHeartbeatAt: heartbeat?.lastHeartbeatAt?.toISOString() ?? null,
      lastFinishedAt: heartbeat?.lastFinishedAt?.toISOString() ?? null,
      lastSuccessfulAt: heartbeat?.lastSuccessfulAt?.toISOString() ?? null,
      lastExitCode: heartbeat?.lastExitCode ?? null,
    };
  });
  const caseAgentScheduler = scheduledOperations.find((operation) => operation.name === "case_agent");

  const eligibleOpenPool = program.ok
    ? await prisma.case.count({
      where: {
        agentManaged: false,
        caseManagerId: null,
        state: "OPEN",
        category: "RETAIL",
        amountAtStakeCents: { not: null, lte: program.program.maxAmountCents },
      },
    })
    : null;

  return {
    generatedAt: now.toISOString(),
    agent: {
      enabled: program.ok,
      missingProgramSettings: program.ok ? [] : program.missing,
      modelConfigured: model.ok,
      modelConfigurationBlocker: model.ok ? null : model.reason,
      serviceAccountCount,
      runtimeConfigured: program.ok && model.ok && serviceAccountCount === 1,
      readyForNewCases: caseAgentOperationallyReady({
        programConfigured: program.ok,
        modelConfigured: model.ok,
        serviceAccountCount,
        emailConfigured: mailIsConfigured,
        workerHealth: caseAgentScheduler?.health ?? "unknown",
      }),
      dailyModelCalls: {
        ...modelUsageToday,
        limit: program.ok ? program.program.maxModelCallsPerUtcDay : null,
        remaining: program.ok ? Math.max(0, program.program.maxModelCallsPerUtcDay - modelUsageToday.used) : null,
      },
    },
    cases: {
      unassignedRetailOpenWithinLimit: eligibleOpenPool,
      activeByState: Object.fromEntries(activeRows.map((row) => [row.state, row._count._all])),
      escalatedOpenByReason: Object.fromEntries(escalationRows.map((row) => [row.agentEscalationReason ?? "unspecified", row._count._all])),
      escalatedUnassigned: unassignedEscalations,
      leases: { active: activeLeases, expired: expiredLeases },
      latestAgentAttemptAt: latestAttempt._max.agentLastAttemptAt?.toISOString() ?? null,
    },
    email: { configured: mailIsConfigured, notifications: mailBacklog },
    scheduledOperations,
  };
}

export type CaseAgentStatus = Awaited<ReturnType<typeof readCaseAgentStatus>>;
