import { requireSession } from "../../../../../lib/session";
import { prisma } from "../../../../../lib/prisma";
import { requestCaseDeletion, RetentionError } from "../../../../../domain/retention";
const headers = { "Cache-Control": "private, no-store" };

/** Authenticated party request only. Destructive actions require the separate
 * operator workflow and credential; this endpoint cannot execute them. */
export async function POST(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  try {
    const job = await requestCaseDeletion((await params).caseId, auth.session.userId);
    return Response.json({ id: job.id, status: job.status, eligibleAt: job.eligibleAt, holdState: job.holdState }, { headers, status: 202 });
  } catch (error) {
    if (error instanceof RetentionError) return Response.json({ code: error.code }, { headers, status: error.code === "FORBIDDEN" ? 403 : 409 });
    return Response.json({ code: "DELETION_REQUEST_FAILED" }, { headers, status: 500 });
  }
}
export async function GET(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const [job, c] = await Promise.all([
    prisma.caseDeletion.findUnique({ where: { caseId }, include: { copies: { select: { store: true, status: true } } } }),
    prisma.case.findUnique({ where: { id: caseId }, select: { complainantId: true, respondentId: true } }),
  ]);
  if (!job || !(auth.session.globalRole === "ADMIN" || job.requestedById === auth.session.userId || (c && [c.complainantId, c.respondentId].includes(auth.session.userId)))) return Response.json({ code: "NOT_FOUND" }, { headers, status: 404 });
  return Response.json({ id: job.id, status: job.status, holdState: job.holdState, eligibleAt: job.eligibleAt, localPurgedAt: job.localPurgedAt, completedAt: job.completedAt, copies: job.copies }, { headers });
}
