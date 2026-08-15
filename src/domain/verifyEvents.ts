import type { PrismaClient } from "../generated/prisma";
import { computeEventHash, GENESIS_HASH } from "./events";
import { replayCaseState } from "./replay";

export interface VerifyIssue {
  referenceNumber: string;
  message: string;
}

/**
 * Recomputes one case's hash chain and projection, per Section 8's
 * verify job. Pure w.r.t. the DB read — takes a client, returns findings,
 * never mutates. Shared by scripts/verify-events.ts (CLI) and the tamper
 * integration test, so both exercise the exact same check.
 */
export async function verifyCase(
  prisma: PrismaClient,
  caseRow: { id: string; referenceNumber: string; state: string }
): Promise<VerifyIssue[]> {
  const issues: VerifyIssue[] = [];
  const events = await prisma.event.findMany({ where: { caseId: caseRow.id }, orderBy: { seq: "asc" } });

  let expectedPrevHash: string = GENESIS_HASH;
  let expectedSeq = 1;

  for (const event of events) {
    if (event.seq !== expectedSeq) {
      issues.push({ referenceNumber: caseRow.referenceNumber, message: `seq gap: expected ${expectedSeq}, found ${event.seq}` });
    }
    if (event.prevHash !== expectedPrevHash) {
      issues.push({ referenceNumber: caseRow.referenceNumber, message: `seq ${event.seq}: prevHash mismatch (chain broken)` });
    }

    const recomputed = computeEventHash({
      prevHash: event.prevHash,
      payload: event.payload,
      actorId: event.actorId,
      seq: event.seq,
      createdAtIso: event.createdAt.toISOString(),
    });
    if (recomputed !== event.hash) {
      issues.push({
        referenceNumber: caseRow.referenceNumber,
        message: `seq ${event.seq}: hash mismatch — stored=${event.hash} recomputed=${recomputed}`,
      });
    }

    expectedPrevHash = event.hash;
    expectedSeq += 1;
  }

  const replayedState = replayCaseState(events);
  if (replayedState !== null && replayedState !== caseRow.state) {
    issues.push({
      referenceNumber: caseRow.referenceNumber,
      message: `projection mismatch: events replay to ${replayedState}, stored Case.state is ${caseRow.state}`,
    });
  }

  return issues;
}

export async function verifyAllCases(prisma: PrismaClient): Promise<VerifyIssue[]> {
  const cases = await prisma.case.findMany({ select: { id: true, referenceNumber: true, state: true } });
  const results = await Promise.all(cases.map((c) => verifyCase(prisma, c)));
  return results.flat();
}
