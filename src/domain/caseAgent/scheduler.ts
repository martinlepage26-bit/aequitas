import { randomUUID } from "node:crypto";
import type { Case, Prisma } from "../../generated/prisma";
import { prisma } from "../../lib/prisma";

export const CASE_AGENT_BATCH_LIMIT = 50;
export const CASE_AGENT_REVISIT_DELAY_MS = 10 * 60 * 1000;
export const CASE_AGENT_LEASE_DURATION_MS = 30 * 60 * 1000;

export type AgentScheduleCandidate = Pick<Case,
  | "id" | "agentLastAttemptAt" | "agentNextRunAt" | "agentLeaseUntil" | "agentLeaseToken" | "createdAt"
  | "agentManaged" | "caseManagerId" | "state" | "category" | "amountAtStakeCents"
>;

export type AgentScheduleLease = { caseId: string; token: string };

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return CASE_AGENT_BATCH_LIMIT;
  return Math.min(CASE_AGENT_BATCH_LIMIT, Math.max(1, Math.trunc(value)));
}

export async function findEligibleAgentCases(input: { now?: Date; limit?: number; unassignedOpenMaxAmountCents?: number; caseIds?: string[] } = {}): Promise<AgentScheduleCandidate[]> {
  const now = input.now ?? new Date();
  const eligible: Prisma.CaseWhereInput[] = [{ agentManaged: true, state: { not: "CLOSED" } }];
  const cap = input.unassignedOpenMaxAmountCents;
  if (cap !== undefined && Number.isInteger(cap) && cap > 0) {
    eligible.push({
      agentManaged: false,
      caseManagerId: null,
      state: "OPEN",
      category: "RETAIL",
      amountAtStakeCents: { not: null, lte: cap },
    });
  }
  return prisma.case.findMany({
    where: {
      ...(input.caseIds ? { id: { in: input.caseIds } } : {}),
      deletionStartedAt: null,
      agentEscalatedAt: null,
      OR: eligible,
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
      agentManaged: true,
      caseManagerId: true,
      state: true,
      category: true,
      amountAtStakeCents: true,
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
  const workflow: Prisma.CaseWhereInput = candidate.agentManaged
    ? { agentManaged: true, caseManagerId: candidate.caseManagerId, state: candidate.state }
    : {
      agentManaged: false,
      caseManagerId: null,
      state: "OPEN",
      category: "RETAIL",
      amountAtStakeCents: candidate.amountAtStakeCents,
    };
  const result = await prisma.case.updateMany({
    where: {
      id: candidate.id,
      ...workflow,
      deletionStartedAt: null,
      agentEscalatedAt: null,
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
    where: { id: lease.caseId, agentLeaseToken: lease.token, deletionStartedAt: null },
    data: { agentLeaseUntil: null, agentLeaseToken: null },
  });
}
