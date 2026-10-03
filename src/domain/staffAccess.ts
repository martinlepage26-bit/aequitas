import { prisma } from "../lib/prisma";
import { appendEvent } from "./events";
import type { SessionPayload } from "../lib/session";

/** Called after authorization and before returning any case-specific administrative read. */
export async function recordStaffAccess(caseId: string, session: SessionPayload, surface: string) {
  if (session.globalRole !== "ADMIN") return;
  await prisma.$transaction(tx => appendEvent(tx, { caseId, type: "ACCESS_STAFF_GRANTED", actorId: session.userId, payload: { surface, authMethod: session.authMethod } }));
}
