import { prisma } from "../../lib/prisma";

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Atomically reserves one outbound model-call attempt for the current UTC day.
 * PostgreSQL serializes concurrent upserts on the day key, so overlapping
 * workers cannot exceed the configured deployment-wide ceiling.
 */
export async function reserveCaseAgentModelCall(limit: number, now = new Date()): Promise<boolean> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_147_483_647) {
    throw new RangeError("The daily model-call limit must be a positive PostgreSQL integer.");
  }
  const day = utcDay(now);
  const rows = await prisma.$queryRaw<Array<{ modelCalls: number }>>`
    INSERT INTO "CaseAgentDailyUsage" ("utcDay", "modelCalls", "createdAt", "updatedAt")
    VALUES (${day}::date, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("utcDay") DO UPDATE
      SET "modelCalls" = "CaseAgentDailyUsage"."modelCalls" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "CaseAgentDailyUsage"."modelCalls" < ${limit}
    RETURNING "modelCalls"
  `;
  return rows.length === 1;
}

/** Aggregate-only count for operator status. No case or party data is stored. */
export async function caseAgentDailyModelUsage(now = new Date()): Promise<{ utcDay: string; used: number }> {
  const day = utcDay(now);
  const rows = await prisma.$queryRaw<Array<{ modelCalls: number }>>`
    SELECT "modelCalls" FROM "CaseAgentDailyUsage" WHERE "utcDay" = ${day}::date
  `;
  return { utcDay: day, used: rows[0]?.modelCalls ?? 0 };
}
