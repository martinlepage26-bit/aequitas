import { recordStaffAccess } from "../../../../../domain/staffAccess";
import { requireSession } from "../../../../../lib/session";
import { prisma } from "../../../../../lib/prisma";
import { caseReadAccess } from "../../../../../domain/caseAccess";
import { chronologyInputSchema } from "../../../../../domain/chronology";
import { mutationFailureResponse, submitChronology } from "../../../../../domain/mutate";

export async function GET(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const row = await prisma.case.findUnique({ where: { id: caseId } });
  if (!row || !caseReadAccess(row, auth.session)) return Response.json({ message: "Not found." }, { status: 404 });
  await recordStaffAccess(caseId, auth.session, "chronology");
  const entries = await prisma.chronologyEntry.findMany({
    where: { caseId }, orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: { submittedBy: { select: { displayName: true } } },
  });
  return Response.json({ entries }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const parsed = chronologyInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: "A valid date, title, description and locale are required." }, { status: 400 });
  const outcome = await submitChronology({
    ...parsed.data, caseId, actorId: auth.session.userId, actorRole: auth.session.globalRole,
  });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json({ caseId: outcome.data.caseId, state: outcome.data.toState }, { status: 201 });
}
