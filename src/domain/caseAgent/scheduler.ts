import { randomUUID } from "node:crypto";
import type { Case } from "../../generated/prisma";
import { prisma } from "../../lib/prisma";

export const CASE_AGENT_BATCH_LIMIT = 50;
export const CASE_AGENT_REVISIT_DELAY_MS = 10 * 60 * 1000;
export const CASE_AGENT_LEASE_DURATION_MS = 30 * 60 * 1000;

export type AgentScheduleCandidate = Pick<Case,
  "id" | "agentLastAttemptAt" | "agentNextRunAt" | "agentLeaseUntil" | "agentLeaseToken" | "createdAt"
>;

export type AgentScheduleLease = { caseId: string; token: string };

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return CASE_AGENT_BATCH_LIMIT;
  return Math.min(CASE_AGENT_BATCH_LIMIT, Math.max(1, Math.trunc(value)));
}

export async function findEligibleAgentCases(input: { now?: Date; limit?: number } = {}): Promise<AgentScheduleCandidate[]> {
  const now = input.now ?? new Date();
  return prisma.case.findMany({
    where: {
      agentManaged: true,
      agentEscalatedAt: null,
      state: { not: "CLOSED" },
      AND: [
        { OR: [{ agentNextRunAt: null }, { agentNextRunAt: { lte: now } }] },
        { OR: [{ agentLeaseUntil: null }, { agentLeaseUntil: { lte: now } }] },
      ],
    },
    select: {
      id: true,
      agentLastAttemptAt: true,
      agentNextRunAt: true,
      agentLeaseUntil: true,
      agentLeaseToken: true,
      createdAt: true,
    },
    orderBy: [
      { agentNextRunAt: { sort: "asc", nulls: "first" } },
      { agentLastAttemptAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" },
      { id: "asc" },
    ],
    take: boundedBatchSize(input.limit),
  });
}

/** Compare-and-set claim: overlapping scheduled runs cannot own the same lease. */
export async function claimAgentCase(candidate: AgentScheduleCandidate, now = new Date()): Promise<AgentScheduleLease | null> {
  const token = randomUUID();
  const result = await prisma.case.updateMany({
    where: {
      id: candidate.id,
      agentManaged: true,
      agentEscalatedAt: null,
      state: { not: "CLOSED" },
      agentLastAttemptAt: candidate.agentLastAttemptAt,
      agentNextRunAt: candidate.agentNextRunAt,
      agentLeaseUntil: candidate.agentLeaseUntil,
      agentLeaseToken: candidate.agentLeaseToken,
      AND: [
        { OR: [{ agentNextRunAt: null }, { agentNextRunAt: { lte: now } }] },
        { OR: [{ agentLeaseUntil: null }, { agentLeaseUntil: { lte: now } }] },
      ],
    },
    data: {
      agentLastAttemptAt: now,
      agentNextRunAt: new Date(now.getTime() + CASE_AGENT_REVISIT_DELAY_MS),
      agentLeaseUntil: new Date(now.getTime() + CASE_AGENT_LEASE_DURATION_MS),
      agentLeaseToken: token,
    },
  });
  return result.count === 1 ? { caseId: candidate.id, token } : null;
}

/** Expired leases recover after a process crash; an old worker cannot clear a newer lease. */
export async function releaseAgentCase(lease: AgentScheduleLease): Promise<void> {
  await prisma.case.updateMany({
    where: { id: lease.caseId, agentLeaseToken: lease.token },
    data: { agentLeaseUntil: null, agentLeaseToken: null },
  });
}
